# find-stream — Project Plan

> **Goal:** A phone app that shows the streams and small waterways near the user's current location. It builds the map from recent satellite imagery, so it shows where water is now and not only where an old map says it should be.

Status: **v0.1 built (free GEE route)** · Last updated: 2026-11-22

## ✅ Decisions (2026-11-22)
| Question | Decision |
|---|---|
| Region | **Thailand + Laos** |
| Platform | **Android beta**, delivered as a Google Earth Engine web app and added to the home screen from Chrome |
| Cost | **US$0**: GEE noncommercial (Academia & Research) tier; no server, no Play Store fee |
| Field-sample logging | Not needed |
| Funding | None yet |

**Chosen build:** `gee/find-stream.js` (see `gee/README.md`). The FastAPI/Expo architecture in §6 is kept as a **future option**, in case the app ever needs offline mode, a Play Store listing, or commercial use that GEE's free terms don't allow.

---

## 1. Problem & value

Static maps such as Google Maps and OpenStreetMap draw streams as fixed lines. In practice:

- Many small streams are **seasonal**. They run in the rainy season and are dry or gone the rest of the year. This matters a lot in monsoon climates such as Northeast Thailand.
- Channels **move**, new ponds and canals get dug, and old maps miss small streams entirely.
- Field users need to know **"is there water there now?"** These include researchers sampling water or microbes, farmers, hikers, and survey teams.

**find-stream** answers three questions:

1. *Where is the nearest stream?*
2. *Does it have water now?*
3. *How recent is the image that says so?*

## 2. Target users & core use cases

| User | Use case |
|---|---|
| Field researcher (ecology, molecular sampling, eDNA) | Find accessible flowing water near a site; log GPS and date with each sample |
| Farmer / irrigation | Check which nearby channels hold water this week |
| Hiker / outdoor | Find water sources along a route |
| Survey / local government | Spot new or changed waterways |

## 3. Features

### MVP (v0.1)
1. **Locate me**: gets the GPS position and lets the user pick a search radius (1, 5, 10 or 25 km).
2. **Stream map**: shows stream lines and water areas on a base map, colored by status:
   - 🔵 *Water detected* in the latest clear satellite image
   - 🟡 *Known channel, water uncertain*: cloudy image, or the stream is narrower than the image resolution
   - ⚪ *Known channel, dry* in the latest image
3. **Nearest-streams list**: sorted by straight-line distance. Each entry shows its name (if known), distance, status, and image date.
4. **Image freshness**: every result shows its satellite acquisition date and cloud cover.
5. **Tap to navigate**: opens the point in Google Maps or Apple Maps.

### v0.2+
- **Seasonal history** for each stream: months with water over the past 1–5 years.
- **Offline mode**: download one area before going into the field.
- **Field log**: drop a pin with a photo, a note, and "water present yes/no". These reports are ground truth for improving detection.
- **Radar fallback** (Sentinel-1) for cloudy monsoon periods.
- Export to GPX, GeoJSON or CSV.
- Thai and English interface.

## 4. Data sources (all free unless noted)

| Source | Resolution | Revisit | Role |
|---|---|---|---|
| **Sentinel-2 L2A** (ESA Copernicus) | 10 m (B3/B8), 20 m (B11) | ~5 days | **Primary** optical water detection [1] |
| **Landsat 8/9 C2 L2** (USGS) | 30 m | ~8 days combined | Gap-filling, long history |
| **Sentinel-1 GRD** (SAR) | 10 m | ~6–12 days | Sees through clouds, for the rainy season [2] |
| **JRC Global Surface Water** | 30 m | Static + monthly history | Long-term water occurrence prior [3] |
| **Dynamic World** | 10 m | Per S2 scene | Near-real-time ML "water" class probability [4] |
| **HydroRIVERS / HydroSHEDS** | Vector | Static | Global river network backbone [5] |
| **OpenStreetMap `waterway=*`** | Vector | Live | Names and small streams |
| **Copernicus DEM GLO-30** | 30 m | Static | Flow accumulation to infer where small streams run |
| PlanetScope *(paid, optional)* | 3 m | Daily | Future premium tier for narrow streams |

**Access:** Sentinel-2, Landsat and Sentinel-1 data are available as Cloud-Optimized GeoTIFFs through public STAC catalogs: Element 84 Earth Search on AWS, Microsoft Planetary Computer, and Copernicus Data Space. This avoids downloading whole scenes. Google Earth Engine is another option, but commercial use requires a paid license.

## 5. Detection method

```
            ┌──────────────── user location + radius ────────────────┐
            ▼                                                         ▼
  STAC search: latest S2 scenes            Vector priors: OSM + HydroRIVERS
  (cloud < 40%, last 30 days)              + DEM-derived flow lines
            │                                                         │
  Cloud/shadow mask (SCL band)                                        │
            │                                                         │
  Water indices:                                                      │
    NDWI  = (Green − NIR) / (Green + NIR)      [6]                     │
    MNDWI = (Green − SWIR1) / (Green + SWIR1) [7]                     │
            │                                                         │
  Threshold (Otsu per tile, fallback 0.0)                             │
            │                                                         │
  Water mask ──► vectorize polygons ──► buffer-match to stream lines ◄┘
            │
  Per stream segment: % pixels water / % clouded / image date
            │
  Status = WATER | DRY | UNCERTAIN  (+ confidence score)
```

**Key limitation:** a 10 m pixel cannot resolve a stream that is 1–3 m wide. Such streams show up only as mixed pixels or not at all. The plan handles this as follows:
- **Detect** water directly where the channel or pool is wider than about 10–20 m. Larger rivers were mapped this way globally at 30 m [8].
- **Infer** where small streams run from the DEM flow network and OSM. Assign their *wet/dry status* from nearby water pixels, riparian NDVI and SAR backscatter, and label them `UNCERTAIN` with a confidence score.
- Use field-log reports (v0.2) to calibrate the thresholds for each region.

## 6. Architecture

```
┌──────────── Mobile app (Expo / React Native, TypeScript) ────────────┐
│  MapLibre GL map · GPS · results list · offline tile cache (SQLite)  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ HTTPS  GET /streams?lat=&lon=&r=
┌──────────────────────────────▼───────────────────────────────────────┐
│  API (Python · FastAPI)                                              │
│   ├─ STAC client (pystac-client) → Earth Search / Planetary Computer │
│   ├─ Raster processing (rasterio, xarray, odc-stac, numpy)           │
│   ├─ Vector ops (shapely, geopandas) + OSM/HydroRIVERS in PostGIS    │
│   ├─ TiTiler → NDWI/true-color XYZ tiles for the map overlay         │
│   └─ Cache: results keyed by (H3 cell res-7, scene ID)               │
└──────────────────────────────┬───────────────────────────────────────┘
        Nightly job: pre-compute water masks for active H3 cells
        when new scenes arrive (cron / Cloud Run job)
```

**Why these choices**
- **Expo + MapLibre**: a single codebase for Android and iOS, and MapLibre is free to use (unlike Mapbox).
- **Server-side processing**: phones should not download satellite bands that run to hundreds of MB. The API returns small GeoJSON results (tens of KB).
- **H3-cell caching**: users near each other share computed results, which keeps cloud costs low.

**Hosting estimate (MVP):** one small VM or Cloud Run instance plus managed Postgres/PostGIS, about US$20–50/month at pilot scale. Imagery reads from AWS open data cost nothing extra.

## 7. API sketch

```
GET /v1/streams?lat=16.24&lon=103.25&radius_km=5
→ {
    "image": {"source":"sentinel-2-l2a","date":"2026-11-18","cloud_pct":12},
    "streams":[
      {"id":"osm:123","name":"Huai Kho","distance_m":840,
       "status":"WATER","confidence":0.86,
       "geometry":{...LineString...},"nearest_point":[103.256,16.243]}
    ]
  }
GET /v1/tiles/ndwi/{z}/{x}/{y}.png?date=latest
GET /v1/streams/{id}/history          (v0.2)
POST /v1/reports                      (v0.2 field log)
```

## 8. Milestones

| # | Phase | Duration | Deliverable |
|---|---|---|---|
| M0 | **Feasibility spike** | 1 wk | Jupyter notebook: NDWI/MNDWI water mask for a test site (e.g., around Maha Sarakham), checked against OSM streams and a field visit |
| M1 | Backend MVP | 2–3 wk | `/streams` endpoint, STAC search, cloud masking, status per segment, PostGIS with OSM + HydroRIVERS for Thailand |
| M2 | Mobile MVP | 2–3 wk | Expo app: GPS, map, colored streams, list, navigate-to |
| M3 | Pilot | 2 wk | 5–10 field users; collect ground-truth reports; measure accuracy |
| M4 | v0.2 | 4 wk | Sentinel-1 fallback, seasonal history, offline areas, field log |

## 9. Success metrics
- **Detection accuracy** against field checks: ≥85% correct WATER/DRY for streams wider than 10 m, and ≥70% for inferred small streams.
- **Latency**: under 3 s for a cached cell, under 20 s for a cold computation.
- **Freshness**: median image age under 10 days in the dry season. Report the rainy-season figure separately.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Clouds during the monsoon (May–Oct) | Sentinel-1 SAR fallback; show "last clear image" date honestly |
| Streams narrower than a pixel | DEM/OSM inference + `UNCERTAIN` label; optional Planet tier |
| Rice paddies and wet fields flagged as water | Restrict to a buffer along the channel network; use Dynamic World class probabilities; mask paddies by seasonal pattern |
| Shadows from terrain or buildings flagged as water | SCL shadow mask + MNDWI (more robust to shadow than NDWI) |
| User safety (flooding, private land) | Disclaimer; never present the data as safe drinking water or a legal right of access |
| Data licensing | Copernicus (free, attribution), OSM (ODbL, attribution), HydroSHEDS (attribution); avoid GEE for commercial use |

## 11. Open questions (to decide before M1)
1. **Region**: Thailand only at first, or global? (This sets PostGIS size and vector-data preparation.)
2. **Platform priority**: Android first, iOS first, or both via Expo?
3. **Stream size**: which width matters most? Small streams under 5 m push towards paid imagery.
4. **Field-sampling features**: should the app log sample IDs and metadata for water or eDNA collection?
5. **Monetization or funding**: free research tool, grant-funded, or a paid tier?

---

## References
1. Drusch M, et al. (2012). Sentinel-2: ESA's optical high-resolution mission for GMES operational services. *Remote Sensing of Environment* 120:25–36. https://doi.org/10.1016/j.rse.2011.11.026
2. Torres R, et al. (2012). GMES Sentinel-1 mission. *Remote Sensing of Environment* 120:9–24. https://doi.org/10.1016/j.rse.2011.05.028
3. Pekel J-F, Cottam A, Gorelick N, Belward AS. (2016). High-resolution mapping of global surface water and its long-term changes. *Nature* 540:418–422. https://doi.org/10.1038/nature20584
4. Brown CF, et al. (2022). Dynamic World, near real-time global 10 m land use land cover mapping. *Scientific Data* 9:251. https://doi.org/10.1038/s41597-022-01307-4
5. Lehner B, Grill G. (2013). Global river hydrography and network routing: baseline data and new approaches to study the world's large river systems. *Hydrological Processes* 27:2171–2186. https://doi.org/10.1002/hyp.9740
6. McFeeters SK. (1996). The use of the Normalized Difference Water Index (NDWI) in the delineation of open water features. *International Journal of Remote Sensing* 17(7):1425–1432. https://doi.org/10.1080/01431169608948714
7. Xu H. (2006). Modification of normalised difference water index (NDWI) to enhance open water features in remotely sensed imagery. *International Journal of Remote Sensing* 27(14):3025–3033. https://doi.org/10.1080/01431160600589179
8. Allen GH, Pavelsky TM. (2018). Global extent of rivers and streams. *Science* 361:585–588. https://doi.org/10.1126/science.aat0636
