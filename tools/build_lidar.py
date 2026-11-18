#!/usr/bin/env python3
"""Build Stadium Stack's lidar height files from USGS 3DEP lidar (Entwine Point Tiles on AWS).

For venues where Google only has a blurry 3D model, the page draws its own 3D view (lidar3d.js) from one of
these files instead. Usage:

    python tools/build_lidar.py tools/lidar_venues.json models [venue ...]

Each venue in the config gives the EPT dataset, a center, a detailed core grid (highest return per cell, so the
stands keep their edges) and a coarse outer grid (average height, for the land around it). Optionally, a track
outline marks an infield where anything taller than a few meters above the infield floor is dropped (cranes, the
hanging video board), since a height map can only draw it as a solid tower.

File layout ('SSL1'): magic, uint32 header length, JSON header, then one zlib block per grid. Each block holds
int16 values in rows from the north edge; after a row's first value, each is stored as the difference from its
west neighbour. A value's lowest bit marks trees; height = zbase + (value without that bit) * zscale. Grids are
centered on the venue, in meters east and north along Web Mercator divided by its scale factor at the center,
so they line up with Web Mercator imagery tiles.
"""
import concurrent.futures as cf
import datetime as dt
import io
import json
import math
import struct
import sys
import time
import urllib.request
import zlib
from pathlib import Path

import laspy
import numpy as np
from scipy import ndimage

R = 6378137.0
ZSCALE = 0.05
NOISE = (7, 18)


def fetch(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except Exception as e:  # network hiccups: retry with backoff
            if k == tries - 1:
                raise RuntimeError(f'{url}: {e}') from e
            time.sleep(2 * (k + 1))


def merc(lat, lon):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


class EPT:
    def __init__(self, url):
        self.base = url.rsplit('/', 1)[0] + '/'
        self.info = json.loads(fetch(url))
        srs = self.info.get('srs') or {}
        if str(srs.get('horizontal')) != '3857':
            raise SystemExit(f'Expected Web Mercator (3857) data, got {srs}')
        self.B = self.info['bounds']
        self.size0 = self.B[3] - self.B[0]
        self.pages = {}

    def page(self, key):
        if key not in self.pages:
            self.pages[key] = json.loads(fetch(f'{self.base}ept-hierarchy/{key}.json'))
        return self.pages[key]

    def box(self, key):
        d, x, y, _ = map(int, key.split('-'))
        s = self.size0 / 2 ** d
        return d, self.B[0] + x * s, self.B[1] + y * s, s

    def nodes(self, rect, max_depth):
        """Keys of nodes down to max_depth whose footprint meets rect (minx, miny, maxx, maxy), with point counts."""
        out = {}

        def walk(key, page):
            d, nx, ny, s = self.box(key)
            if nx >= rect[2] or nx + s <= rect[0] or ny >= rect[3] or ny + s <= rect[1]:
                return
            cnt = page.get(key)
            if cnt == -1:
                page = self.page(key)
                cnt = page.get(key)
            if not cnt:
                return
            out[key] = cnt
            if d >= max_depth:
                return
            _, x, y, z = map(int, key.split('-'))
            for dx in (0, 1):
                for dy in (0, 1):
                    for dz in (0, 1):
                        kid = f'{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}'
                        if kid in page:
                            walk(kid, page)

        walk('0-0-0-0', self.page('0-0-0-0'))
        return out

    def points(self, key):
        las = laspy.read(io.BytesIO(fetch(f'{self.base}ept-data/{key}.laz')))
        keep = ~np.isin(np.asarray(las.classification), NOISE)
        rn = np.asarray(las.return_number)[keep]
        nr = np.asarray(las.number_of_returns)[keep]
        return (np.asarray(las.x)[keep], np.asarray(las.y)[keep], np.asarray(las.z)[keep],
                ((nr >= 2) & (rn < nr)).astype(np.uint8))


def fill_holes(z):
    """Give empty cells (NaN) the height of the nearest filled cell."""
    bad = np.isnan(z)
    if not bad.any():
        return z
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return z[tuple(idx)]


def polygon_mask(u, v, shape, margin):
    """Cells inside a closed outline, at least margin meters from its edge."""
    inside = np.zeros(u.shape, bool)
    dist = np.full(u.shape, np.inf)
    n = len(shape)
    for i in range(n):
        (u1, v1), (u2, v2) = shape[i], shape[i - 1]
        cross = ((v1 > v) != (v2 > v)) & (u < (u2 - u1) * (v - v1) / ((v2 - v1) or 1e-12) + u1)
        inside ^= cross
        du, dv = u2 - u1, v2 - v1
        t = np.clip(((u - u1) * du + (v - v1) * dv) / (du * du + dv * dv), 0, 1)
        dist = np.minimum(dist, np.hypot(u - u1 - t * du, v - v1 - t * dv))
    return inside & (dist > margin)


def build(venue, cfg, outdir):
    t0 = time.time()
    ept = EPT(cfg['ept'])
    lat, lon = cfg['lat'], cfg['lon']
    X0, Y0 = merc(lat, lon)
    k = 1 / math.cos(math.radians(lat))
    core, outer = cfg['core'], cfg['outer']

    def rect(half):
        h = half * k
        return (X0 - h, Y0 - h, X0 + h, Y0 + h)

    want = {}
    for key, cnt in ept.nodes(rect(core['half']), core['depth']).items():
        want[key] = cnt
    for key, cnt in ept.nodes(rect(outer['half']), outer['depth']).items():
        want[key] = cnt
    print(f'{venue}: {len(want)} nodes, {sum(want.values()):,} points', flush=True)

    cw = int(round(2 * core['half'] / core['res']))
    ow = int(round(2 * outer['half'] / outer['res']))
    ctop = np.full(cw * cw, -np.inf)
    cmul = np.zeros(cw * cw, np.uint8)
    osum = np.zeros(ow * ow)
    ocnt = np.zeros(ow * ow)

    def cells(e, n, half, res, w):
        i = np.floor((e + half) / res).astype(np.int64)
        j = np.floor((half - n) / res).astype(np.int64)
        ok = (i >= 0) & (j >= 0) & (i < w) & (j < w)
        return j * w + i, ok

    keys = sorted(want, key=lambda s: tuple(map(int, s.split('-'))))   # fixed order, so rebuilds match byte for byte
    with cf.ThreadPoolExecutor(8) as pool:
        for key, (x, y, z, mul) in zip(keys, pool.map(ept.points, keys)):
            depth = int(key.split('-')[0])
            e, n = (x - X0) / k, (y - Y0) / k
            if depth <= core['depth']:
                idx, ok = cells(e, n, core['half'], core['res'], cw)
                idx, zz, mm = idx[ok], z[ok], mul[ok]
                if len(idx):
                    order = np.lexsort((zz, idx))            # by cell, then height
                    idx, zz, mm = idx[order], zz[order], mm[order]
                    last = np.r_[idx[1:] != idx[:-1], True]  # highest return in each cell
                    idx, zz, mm = idx[last], zz[last], mm[last]
                    better = zz > ctop[idx]
                    ctop[idx[better]] = zz[better]
                    cmul[idx[better]] = mm[better]
            if depth <= outer['depth']:
                idx, ok = cells(e, n, outer['half'], outer['res'], ow)
                np.add.at(osum, idx[ok], z[ok])
                np.add.at(ocnt, idx[ok], 1)

    # Core: highest return, holes filled, poles and wires opened away, tree crowns softened.
    cz = ctop.reshape(cw, cw)
    cz[~np.isfinite(cz)] = np.nan
    empty = float(np.isnan(cz).mean())
    cz = fill_holes(cz)
    cz = ndimage.grey_opening(cz, size=(3, 3))
    veg = ndimage.uniform_filter(cmul.reshape(cw, cw).astype(float), 5, mode='nearest') * 25 >= 7
    for _ in range(2):
        cz = np.where(veg, ndimage.uniform_filter(cz, 3, mode='nearest'), cz)

    res_c = core['res']
    e = -core['half'] + (np.arange(cw) + 0.5) * res_c
    n = core['half'] - (np.arange(cw) + 0.5) * res_c
    E, N = np.meshgrid(e, n)
    stats = {'empty_core': round(empty, 4), 'veg_core': round(float(veg.mean()), 4)}
    clean = cfg.get('clean')
    if clean:
        b = math.radians(clean['brg'])
        U, V = E * math.sin(b) + N * math.cos(b), E * math.cos(b) - N * math.sin(b)
        inf = polygon_mask(U, V, clean['shape'], clean['margin'])
        floor = float(np.percentile(cz[inf], 30))
        drop = inf & (cz > floor + clean['above'])
        cz = np.where(drop, floor, cz)
        veg &= ~drop
        stats.update(floor=round(floor, 2), dropped=int(drop.sum()), infield=int(inf.sum()))

    # Outer: average height, filled and smoothed.
    oz = np.where(ocnt > 0, osum / np.maximum(ocnt, 1), np.nan).reshape(ow, ow)
    oz = fill_holes(oz)
    kern = np.outer([1, 2, 1], [1, 2, 1]) / 16
    for _ in range(2):
        oz = ndimage.convolve(oz, kern, mode='nearest')

    # Feather the core's edge into the outer grid so there is no step between them.
    res_o, oh = outer['res'], outer['half']
    fi = (E + oh) / res_o - 0.5
    fj = (oh - N) / res_o - 0.5
    under = ndimage.map_coordinates(oz, [fj, fi], order=1, mode='nearest')
    edge = core['half'] - np.maximum(np.abs(E), np.abs(N))
    band = cfg.get('feather', 50)
    t = np.clip(1 - edge / band, 0, 1)
    s = t * t * (3 - 2 * t)
    cz = cz * (1 - s) + under * s
    veg |= s > 0.6

    zbase = cfg['zbase']

    def encode(z, vg):
        q = np.round((z - zbase) / ZSCALE).astype(np.int64)
        q = (q & ~1) | vg.astype(np.int64)
        if q.min() < -32768 or q.max() > 32767:
            raise SystemExit(f'{venue}: heights out of range for zbase {zbase}')
        d = q.copy()
        d[:, 1:] = q[:, 1:] - q[:, :-1]
        if d.min() < -32768 or d.max() > 32767:
            raise SystemExit(f'{venue}: height step too large to store')
        return zlib.compress(d.astype('<i2').tobytes(), 9)

    blocks, grids, off = [], [], 0
    for name, z, vg, g in (('core', cz, veg, core), ('outer', oz, np.ones_like(oz, bool), outer)):
        blob = encode(z, vg)
        w = z.shape[1]
        grids.append({'name': name, 'half': g['half'], 'res': g['res'], 'w': w, 'h': z.shape[0], 'offset': off, 'length': len(blob)})
        blocks.append(blob)
        off += len(blob)
    head = json.dumps({'lat': lat, 'lon': lon, 'zbase': zbase, 'zscale': ZSCALE, 'source': cfg.get('source', ''),
                       'built': dt.date.today().isoformat(), 'grids': grids}, separators=(',', ':')).encode()
    out = Path(outdir) / f'{venue}.lidar'
    out.write_bytes(b'SSL1' + struct.pack('<I', len(head)) + head + b''.join(blocks))
    stats.update(core_min=round(float(cz.min()), 2), core_max=round(float(cz.max()), 2),
                 outer_min=round(float(oz.min()), 2), outer_max=round(float(oz.max()), 2),
                 bytes=out.stat().st_size)
    print(f'{venue}: wrote {out} in {time.time() - t0:.1f} s {json.dumps(stats)}', flush=True)
    return stats


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    cfg = json.loads(Path(sys.argv[1]).read_text())
    outdir = Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    names = sys.argv[3:] or list(cfg)
    report = {name: build(name, cfg[name], outdir) for name in names}
    (outdir / 'build.json').write_text(json.dumps(report, indent=1) + '\n')


if __name__ == '__main__':
    main()
