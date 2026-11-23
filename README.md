# Stadium Stack

Satellite and Google 3D views of the world's big stadiums, with every field pinned to the same spot at true scale.

**Live:** https://wernerkw.github.io/stadium-stack/

- Swipe, fade or blink between two stadiums, or see them all side by side in a same-scale lineup.
- 47 venues built in: the big college football bowls, NFL venues, world football grounds, plus Strahov, the MCG and Narendra Modi Stadium. Add any other stadium by name.
- Places that aren't stadiums at all, with their track or arena outlined: Indianapolis, Daytona and Bristol (with the 2016 Battle at Bristol football field dashed in), Churchill Downs, Plaza México, the Colosseum and the Circus Maximus. The view zooms out for the big ones and back in afterward.
- **Google 3D:** both stadiums share one synced camera. The site uses the shared key in `config.js` when one is set; otherwise paste your own free [Maps Demo Key](https://developers.google.com/maps/demo-key). Your own key is saved only in your browser and always takes priority.
- **Lidar 3D where Google's is blurry:** Google only has a rough model of Bristol Motor Speedway, so the site draws its own there from the USGS 3DEP lidar scan (2016) with Esri imagery on top, synced to the same camera. `tools/build_lidar.py` makes the height files in `models/`; the *Build lidar models* GitHub Action runs it whenever `tools/lidar_venues.json` changes, since the lidar lives on AWS. Any US venue with 3DEP coverage can be added there.

Field centers and directions come from OpenStreetMap field outlines. Field heights for the 3D view were measured in Google's 3D model.

Credits: satellite imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community · field outlines © OpenStreetMap contributors · 3D © Google · Bristol 3D from USGS 3DEP lidar · ground heights from the Copernicus DEM via Open-Meteo.
