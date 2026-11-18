/* Stadium Stack: a stand-in for Google's 3D view where Google only has a blurry model.
   <lidar-map-3d> draws a height map built from USGS 3DEP lidar, wrapped in Esri imagery, and answers to the
   same camera properties and gmp-* events as Google's <gmp-map-3d>, so the page can drive and sync it the same way.

   Height file (.lidar): 'SSL1', uint32 header length, JSON header, then one deflate block per grid.
   Each block holds int16 values in rows from the north edge, every value after a row's first stored as the
   difference from its west neighbour. A value's lowest bit marks trees; height = zbase + (value without that bit)
   * zscale. Grids are centered on the venue, in meters east and north measured along Web Mercator (so they line
   up with the imagery tiles). */
(() => {
  if (window.LidarMap3D) return;
  const R = 6378137, DEG = Math.PI / 180;
  const TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/';
  const merc = (lat, lon) => [R * lon * DEG, R * Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2))];
  const unmerc = (x, y) => [Math.atan(Math.sinh(y / R)) / DEG, x / R / DEG];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const norm360 = h => ((h % 360) + 360) % 360;

  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  /* Read a .lidar file into { lat, lon, zbase, grids: { core, outer } } with heights in meters above zbase. */
  async function loadLidar(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn’t load ${url} (${res.status})`);
    const buf = await res.arrayBuffer(), dv = new DataView(buf);
    if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'SSL1') throw new Error('Not a height file');
    const hlen = dv.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
    const body = 8 + hlen, grids = {};
    for (const g of head.grids) {
      const raw = await inflate(new Uint8Array(buf, body + g.offset, g.length));
      const q = new Int16Array(raw.buffer, raw.byteOffset, g.w * g.h);
      const z = new Float32Array(g.w * g.h), veg = new Uint8Array(g.w * g.h);
      for (let j = 0; j < g.h; j++) {
        let acc = 0;
        for (let i = 0; i < g.w; i++) { const k = j * g.w + i; acc = i ? acc + q[k] : q[k]; veg[k] = acc & 1; z[k] = (acc & ~1) * head.zscale; }
      }
      grids[g.name] = { half: g.half, res: g.res, w: g.w, h: g.h, z, veg };
    }
    return { lat: head.lat, lon: head.lon, zbase: head.zbase, grids, source: head.source };
  }

  /* Imagery for a grid: Esri tiles drawn into one canvas that covers the grid's square exactly. */
  function imagery(lat, lon, half, zoom, size, onTile) {
    const [X0, Y0] = merc(lat, lon), k = 1 / Math.cos(lat * DEG);
    const scale = 256 * 2 ** zoom / (2 * Math.PI * R);
    const x0 = (X0 - half * k + Math.PI * R) * scale, y0 = (Math.PI * R - (Y0 + half * k)) * scale;
    const span = 2 * half * k * scale, f = size / span;
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const c = cv.getContext('2d'); c.fillStyle = '#6f7a6a'; c.fillRect(0, 0, size, size);
    const jobs = [];
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + span) / 256); tx++) {
      for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + span) / 256); ty++) {
        jobs.push(new Promise(res => {
          const im = new Image(); im.crossOrigin = 'anonymous';
          im.onload = () => { c.drawImage(im, (tx * 256 - x0) * f, (ty * 256 - y0) * f, 256 * f + 0.6, 256 * f + 0.6); onTile && onTile(); res(); };
          im.onerror = () => res();
          im.src = `${TILE}${zoom}/${ty}/${tx}`;
        }));
      }
    }
    return { canvas: cv, ready: Promise.all(jobs), count: jobs.length };
  }

  const VS = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D uH;
uniform ivec2 uN;        // grid size (vertices)
uniform vec3 uGeo;       // west cell center (m), north cell center (m), spacing (m)
uniform float uSkirt;    // >0: one extra ring of vertices around the grid, dropped this far
uniform mat4 uMVP;
out vec3 vPos; out vec2 vUV; out float vVeg;
void main() {
  int W = uN.x, H = uN.y;
  int ring = uSkirt > 0.0 ? 1 : 0;
  int cols = W + 2 * ring;
  int i = gl_VertexID % cols - ring, j = gl_VertexID / cols - ring;
  bool edge = i < 0 || j < 0 || i >= W || j >= H;
  int ci = clamp(i, 0, W - 1), cj = clamp(j, 0, H - 1);
  vec2 hv = texelFetch(uH, ivec2(ci, cj), 0).rg;
  float z = hv.r - (edge ? uSkirt : 0.0);
  vVeg = hv.g;
  vec3 p = vec3(uGeo.x + float(ci) * uGeo.z, uGeo.y - float(cj) * uGeo.z, z);
  vPos = p;
  vUV = vec2((float(ci) + 0.5) / float(W), (float(cj) + 0.5) / float(H));
  gl_Position = uMVP * vec4(p, 1.0);
}`;
  const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec3 uSun; uniform vec3 uSky; uniform vec2 uFade;
in vec3 vPos; in vec2 vUV; in float vVeg;
out vec4 o;
void main() {
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
  if (n.z < 0.0) n = -n;
  vec3 c = texture(uTex, vUV).rgb;
  // Walls: photos taken from above smear down steep faces, so paint them a plain concrete tone instead.
  // (not trees or grass banks, which keep the photo's green)
  float green = smoothstep(0.012, 0.06, c.g - max(c.r, c.b));
  float steep = smoothstep(0.62, 0.28, n.z);
  c = mix(c, vec3(0.70, 0.69, 0.66), steep * 0.8 * (1.0 - max(vVeg, green)));
  c *= 0.64 + 0.46 * max(dot(n, uSun), 0.0);
  float f = smoothstep(uFade.x, uFade.y, length(vPos.xy));
  o = vec4(mix(c, uSky, f), 1.0);
}`;

  function mat4Persp(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function mat4LookAt(e, t, u) {
    let z = [e[0] - t[0], e[1] - t[1], e[2] - t[2]]; const zl = Math.hypot(...z); z = z.map(v => v / zl);
    let x = [u[1] * z[2] - u[2] * z[1], u[2] * z[0] - u[0] * z[2], u[0] * z[1] - u[1] * z[0]]; const xl = Math.hypot(...x); x = x.map(v => v / xl);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]), -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]), -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]), 1];
  }
  function mat4Mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function mat4Inv(m) {
    const a = m, inv = new Array(16);
    inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    det = 1 / det;
    return inv.map(v => v * det);
  }

  class LidarMap3D extends HTMLElement {
    constructor() {
      super();
      this._lat = 0; this._lng = 0; this._alt = 0; this._heading = 0; this._tilt = 60; this._range = 800; this.fov = 35;
      this._data = null; this._gl = null; this._dirty = false; this._ptrs = new Map();
      this.description = '';
      const sh = this.attachShadow({ mode: 'open' });
      sh.innerHTML = `<style>
        :host { display: block; position: relative; width: 100%; height: 100%; overflow: hidden; background: #cfd9e1; touch-action: none; }
        canvas { display: block; width: 100%; height: 100%; cursor: grab; }
        canvas.dragging { cursor: grabbing; }
        .msg { position: absolute; inset: 0; display: grid; place-items: center; font: 600 13px/1.4 system-ui, sans-serif; color: #24303a; text-align: center; padding: 20px; pointer-events: none; }
        .credit { position: absolute; left: 8px; bottom: 6px; font: 500 10.5px/1.3 system-ui, sans-serif; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.8); pointer-events: none; max-width: 70%; }
      </style><canvas></canvas><div class="msg">Building the 3D model from lidar…</div><div class="credit"></div>`;
      this._cv = sh.querySelector('canvas'); this._msg = sh.querySelector('.msg'); this._credit = sh.querySelector('.credit');
      this._cv.addEventListener('contextmenu', e => e.preventDefault());
      this._cv.addEventListener('pointerdown', e => this._down(e));
      this._cv.addEventListener('pointermove', e => this._move(e));
      this._cv.addEventListener('pointerup', e => this._up(e));
      this._cv.addEventListener('pointercancel', e => this._up(e));
      this._cv.addEventListener('wheel', e => this._wheel(e), { passive: false });
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this);
    }
    /* Camera, the same way Google's 3D map describes it. */
    get center() { return { lat: this._lat, lng: this._lng, altitude: this._alt }; }
    set center(c) {
      if (!c) return;
      const lat = typeof c.lat === 'function' ? c.lat() : Number(c.lat), lng = typeof c.lng === 'function' ? c.lng() : Number(c.lng);
      if (Number.isFinite(lat)) this._lat = lat;
      if (Number.isFinite(lng)) this._lng = lng;
      if (Number.isFinite(Number(c.altitude))) this._alt = Number(c.altitude);
      this._kick();
    }
    get heading() { return this._heading; }
    set heading(v) { if (Number.isFinite(v)) { this._heading = norm360(v); this._kick(); } }
    get tilt() { return this._tilt; }
    set tilt(v) { if (Number.isFinite(v)) { this._tilt = clamp(v, 0, 88); this._kick(); } }
    get range() { return this._range; }
    set range(v) { if (Number.isFinite(v)) { this._range = clamp(v, 20, 20000); this._kick(); } }

    /* Start loading: src is a .lidar file, or pass already-built grids as data. */
    async load({ src, data, credit }) {
      this._credit.textContent = credit || '';
      try {
        this._data = data || await loadLidar(src);
        const d = this._data, [X0, Y0] = merc(d.lat, d.lon);
        d.X0 = X0; d.Y0 = Y0; d.k = 1 / Math.cos(d.lat * DEG);
        this._setupGL();
        this._msg.textContent = '';
        this._kick();
        this.dispatchEvent(new Event('lidar-ready'));
      } catch (err) {
        this._msg.textContent = 'This 3D model didn’t load. ' + (err && err.message ? err.message : '');
        this.dispatchEvent(new CustomEvent('gmp-error', { detail: err }));
      }
    }

    _setupGL() {
      const gl = this._cv.getContext('webgl2', { antialias: true, alpha: false });
      if (!gl) throw new Error('This browser has no WebGL 2.');
      this._gl = gl;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      this._prog = p;
      this._u = {};
      for (const n of ['uH', 'uN', 'uGeo', 'uSkirt', 'uMVP', 'uTex', 'uSun', 'uSky', 'uFade']) this._u[n] = gl.getUniformLocation(p, n);
      this._vao = gl.createVertexArray();
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      const d = this._data;
      this._meshes = [];
      const order = [['outer', 16, 2048, 0], ['core', 18, 2048, 8]];
      for (const [name, zoom, size, skirt] of order) {
        const g = d.grids[name]; if (!g) continue;
        const hTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, hTex);
        const hv = new Float32Array(g.w * g.h * 2);
        for (let i = 0; i < g.w * g.h; i++) { hv[2 * i] = g.z[i]; hv[2 * i + 1] = g.veg ? g.veg[i] : 0; }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, g.w, g.h, 0, gl.RG, gl.FLOAT, hv);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // Index buffer: rows of triangles; the outer grid leaves a hole where the detailed core sits.
        const ring = skirt > 0 ? 1 : 0, cols = g.w + 2 * ring, rows = g.h + 2 * ring;
        const core = d.grids.core, hole = name === 'outer' && core ? core.half - g.res * 1.5 : -1;
        const idx = [];
        for (let j = 0; j < rows - 1; j++) {
          for (let i = 0; i < cols - 1; i++) {
            if (hole > 0) {
              const e0 = -g.half + (i + 0.5) * g.res, e1 = e0 + g.res, n0 = g.half - (j + 0.5) * g.res, n1 = n0 - g.res;
              if (e0 > -hole && e1 < hole && n1 > -hole && n0 < hole) continue;
            }
            const a = j * cols + i, b = a + 1, c = a + cols, e = c + 1;
            idx.push(a, c, b, b, c, e);
          }
        }
        const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
        // Re-upload the photo a few times a second while its tiles stream in, not once per tile.
        const img = imagery(d.lat, d.lon, g.half, zoom, size, () => {
          if (this._texTimer) return;
          this._texTimer = setTimeout(() => { this._texTimer = 0; this._texDirty = true; this._kick(); }, 350);
        });
        const cTex = gl.createTexture();
        const mesh = { name, g, hTex, ib, count: idx.length, cTex, img, skirt, zoom };
        const upload = () => {
          gl.bindTexture(gl.TEXTURE_2D, cTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img.canvas);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
        };
        mesh.upload = upload; upload();
        img.ready.then(() => { upload(); this._kick(); });
        this._meshes.push(mesh);
      }
      this._resize();
    }
    _resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1), r = this.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (this._cv.width !== w || this._cv.height !== h) { this._cv.width = w; this._cv.height = h; }
      this._kick();
    }
    _kick() { if (!this._dirty) { this._dirty = true; requestAnimationFrame(() => this._draw()); } }

    /* Camera in local meters (east, north, up from the data's zbase), as Google's 3D map frames it. */
    _camera() {
      const d = this._data, [X, Y] = merc(this._lat, this._lng);
      const t = [(X - d.X0) / d.k, (Y - d.Y0) / d.k, this._alt - d.zbase];
      const h = this._heading * DEG, ti = this._tilt * DEG, r = this._range;
      const dir = [Math.sin(h) * Math.sin(ti), Math.cos(h) * Math.sin(ti), -Math.cos(ti)];
      const eye = [t[0] - dir[0] * r, t[1] - dir[1] * r, t[2] - dir[2] * r];
      const up = [Math.sin(h) * Math.cos(ti), Math.cos(h) * Math.cos(ti), Math.sin(ti)];
      const aspect = this._cv.width / this._cv.height;
      const near = Math.max(0.5, r * 0.002), far = r + 9000;
      const P = mat4Persp(this.fov * DEG, aspect, near, far), V = mat4LookAt(eye, t, up);
      return { eye, target: t, MVP: mat4Mul(P, V), P, V };
    }
    _draw() {
      this._dirty = false;
      const gl = this._gl; if (!gl || !this._data) return;
      if (this._texDirty) { this._texDirty = false; for (const m of this._meshes) m.upload(); }
      gl.viewport(0, 0, this._cv.width, this._cv.height);
      const sky = [0.81, 0.85, 0.88];
      gl.clearColor(sky[0], sky[1], sky[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(this._prog); gl.bindVertexArray(this._vao);
      const cam = this._camera();
      gl.uniformMatrix4fv(this._u.uMVP, false, new Float32Array(cam.MVP));
      const sa = 205 * DEG, se = 50 * DEG;   // afternoon sun from the south-southwest
      gl.uniform3f(this._u.uSun, Math.sin(sa) * Math.cos(se), Math.cos(sa) * Math.cos(se), Math.sin(se));
      gl.uniform3f(this._u.uSky, ...sky);
      const outer = this._data.grids.outer || this._data.grids.core;
      gl.uniform2f(this._u.uFade, outer.half * 0.72, outer.half * 0.98);
      for (const m of this._meshes) {
        const g = m.g;
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, m.hTex); gl.uniform1i(this._u.uH, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, m.cTex); gl.uniform1i(this._u.uTex, 1);
        gl.uniform2i(this._u.uN, g.w, g.h);
        gl.uniform3f(this._u.uGeo, -g.half + g.res / 2, g.half - g.res / 2, g.res);
        gl.uniform1f(this._u.uSkirt, m.skirt);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
      }
    }

    /* Height of the model at a local point, from the finest grid that covers it. */
    _heightAt(x, y) {
      for (const name of ['core', 'outer']) {
        const g = this._data.grids[name]; if (!g) continue;
        const fi = (x + g.half) / g.res - 0.5, fj = (g.half - y) / g.res - 0.5;
        if (fi < 0 || fj < 0 || fi > g.w - 1 || fj > g.h - 1) continue;
        const i = Math.min(g.w - 2, Math.floor(fi)), j = Math.min(g.h - 2, Math.floor(fj)), u = fi - i, v = fj - j;
        const z = g.z, w = g.w;
        return (z[j * w + i] * (1 - u) + z[j * w + i + 1] * u) * (1 - v) + (z[(j + 1) * w + i] * (1 - u) + z[(j + 1) * w + i + 1] * u) * v;
      }
      return null;
    }
    /* The ray through a pixel, in local meters. */
    _ray(px, py) {
      const cam = this._camera(), inv = mat4Inv(cam.MVP);
      const r = this._cv.getBoundingClientRect();
      const nx = (px - r.left) / r.width * 2 - 1, ny = 1 - (py - r.top) / r.height * 2;
      const un = (x, y, z) => { const v = [x, y, z, 1], o = [0, 0, 0, 0]; for (let rr = 0; rr < 4; rr++) for (let c = 0; c < 4; c++) o[rr] += inv[c * 4 + rr] * v[c]; return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]; };
      const a = un(nx, ny, -1), b = un(nx, ny, 1);
      const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...dir);
      return { o: cam.eye, d: dir.map(v => v / L), cam };
    }
    _hitModel(px, py) {
      const { o, d } = this._ray(px, py);
      let prev = 0, step = 1.5;
      for (let t = 1; t < 12000; t += step) {
        const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
        const h = this._heightAt(x, y);
        if (h !== null && z <= h) {
          let lo = prev, hi = t;
          for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2, hm = this._heightAt(o[0] + d[0] * m, o[1] + d[1] * m); if (hm !== null && o[2] + d[2] * m <= hm) hi = m; else lo = m; }
          return [o[0] + d[0] * hi, o[1] + d[1] * hi, o[2] + d[2] * hi];
        }
        prev = t; step = Math.max(1.5, t * 0.004);
      }
      return null;
    }
    _hitPlane(px, py, z0) {
      const { o, d } = this._ray(px, py);
      if (Math.abs(d[2]) < 1e-6) return null;
      const t = (z0 - o[2]) / d[2];
      return t > 0 ? [o[0] + d[0] * t, o[1] + d[1] * t, z0] : null;
    }
    _toLatLng(x, y) { const d = this._data; const [lat, lng] = unmerc(d.X0 + x * d.k, d.Y0 + y * d.k); return { lat, lng }; }
    _local() { const d = this._data, [X, Y] = merc(this._lat, this._lng); return [(X - d.X0) / d.k, (Y - d.Y0) / d.k]; }
    _setLocal(x, y) { const ll = this._toLatLng(x, y); this._lat = ll.lat; this._lng = ll.lng; }
    _emit(...names) { for (const n of names) this.dispatchEvent(new Event('gmp-' + n + 'change')); this._kick(); }

    /* Mouse and touch, close to Google's: drag pans, right-drag or Ctrl/⌘/Shift-drag turns and tilts, wheel or pinch zooms. */
    _down(e) {
      if (!this._data || !this._gl) return;
      this._cv.setPointerCapture(e.pointerId);
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._cv.classList.add('dragging');
      const rot = e.button === 2 || e.ctrlKey || e.metaKey || e.shiftKey;
      this._drag = { mode: this._ptrs.size >= 2 ? 'pinch' : rot ? 'rotate' : 'pan', x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, startH: this._heading, startT: this._tilt };
      if (this._drag.mode === 'pan') this._drag.grab = this._hitPlane(e.clientX, e.clientY, this._alt - this._data.zbase);
      if (this._drag.mode === 'pinch') this._pinchStart();
    }
    _pinchStart() {
      const [p, q] = [...this._ptrs.values()];
      this._pinch = { dist: Math.hypot(q.x - p.x, q.y - p.y), ang: Math.atan2(q.y - p.y, q.x - p.x), my: (p.y + q.y) / 2, range: this._range, heading: this._heading, tilt: this._tilt };
    }
    _move(e) {
      if (!this._drag || !this._ptrs.has(e.pointerId)) return;
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const D = this._drag;
      D.moved = Math.max(D.moved, Math.hypot(e.clientX - D.x, e.clientY - D.y));
      if (D.mode === 'pinch' && this._ptrs.size >= 2) {
        const [p, q] = [...this._ptrs.values()], P0 = this._pinch;
        const dist = Math.hypot(q.x - p.x, q.y - p.y), ang = Math.atan2(q.y - p.y, q.x - p.x), my = (p.y + q.y) / 2;
        this._range = clamp(P0.range * P0.dist / Math.max(10, dist), 20, 20000);
        this._heading = norm360(P0.heading - (ang - P0.ang) / DEG);
        this._tilt = clamp(P0.tilt - (my - P0.my) * 0.25, 0, 88);
        this._emit('range', 'heading', 'tilt');
      } else if (D.mode === 'rotate') {
        this._heading = norm360(D.startH - (e.clientX - D.x) * 0.3);
        this._tilt = clamp(D.startT - (e.clientY - D.y) * 0.3, 0, 88);
        this._emit('heading', 'tilt');
      } else if (D.mode === 'pan' && D.grab) {
        const now = this._hitPlane(e.clientX, e.clientY, D.grab[2]);
        if (now) { const [x, y] = this._local(); this._setLocal(x + D.grab[0] - now[0], y + D.grab[1] - now[1]); this._emit('center'); }
      }
    }
    _up(e) {
      if (!this._ptrs.has(e.pointerId)) return;
      this._ptrs.delete(e.pointerId);
      const D = this._drag;
      if (this._ptrs.size === 1 && D && D.mode === 'pinch') {   // one finger left: keep panning from here
        const [p] = [...this._ptrs.values()];
        this._drag = { mode: 'pan', x: p.x, y: p.y, t: performance.now(), moved: 99, grab: this._hitPlane(p.x, p.y, this._alt - this._data.zbase) };
        return;
      }
      if (this._ptrs.size) return;
      this._cv.classList.remove('dragging');
      this._drag = null;
      if (D && D.moved < 5 && performance.now() - D.t < 500 && D.mode !== 'pinch') {
        const hit = this._hitModel(e.clientX, e.clientY);
        if (hit) {
          const ll = this._toLatLng(hit[0], hit[1]);
          const ev = new Event('gmp-click'); ev.position = { lat: ll.lat, lng: ll.lng, altitude: hit[2] + this._data.zbase };
          this.dispatchEvent(ev);
        }
      }
    }
    _wheel(e) {
      if (!this._data) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      this._range = clamp(this._range * Math.exp(dy * 0.0012), 20, 20000);
      this._emit('range');
    }
    disconnectedCallback() { /* keep GPU resources: the page may put this element back */ }
  }
  customElements.define('lidar-map-3d', LidarMap3D);
  window.LidarMap3D = LidarMap3D;
  window.LidarMap3D.loadLidar = loadLidar;
})();
