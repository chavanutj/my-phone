# find-stream: Google Earth Engine app (free route)

`find-stream.js` is the whole app. It runs on Google Earth Engine, which is free for **noncommercial and research** use. You need no server, no API keys, and no paid account.

## What it does
1. You tap **📍 Use my location** or tap the map.
2. It takes the newest **cloud-free Sentinel-2** pixels from the last 15–90 days. **Sentinel-1 radar** fills in where it is cloudy.
3. It marks a pixel as water where **MNDWI** > 0 (optical) or **VV** < −16 dB (radar).
4. It checks every mapped river segment (HydroRIVERS, catchment of 10 km² or more) within the radius. Each one is marked 🔵 *Water seen*, ⚪ *No water seen*, or 🟡 *Uncertain* (too much cloud or no data).
5. It lists the 10 nearest segments with distance, catchment size, mean flow, and historic water frequency. Each has a **Directions ↗** link that opens Google Maps.
6. It shows **modelled small channels** (MERIT Hydro, catchment of 1 km² or more) as a light-blue layer, for streams too small for the river dataset.

## One-time setup (free)
1. Go to <https://code.earthengine.google.com/register> and sign in with a Google account. Your university Google account works.
2. Create or choose a **Cloud project**, and pick **Unpaid usage → Academia & Research**. Do not enable billing; it is not needed.
3. Open the **Code Editor** at <https://code.earthengine.google.com>. Click **New → File**, paste in all of `find-stream.js`, save it as `find-stream`, then click **Run**.
4. Click on a place in Thailand or Laos and check that the results appear.

## Publish as a web app
1. In the Code Editor, click **Apps → New App**.
2. Name it `find-stream` and select the saved script as the source. Set access to **public**.
3. Click **Publish**. The URL will look like `https://<your-project>.projects.earthengine.app/view/find-stream`. The first publish can take a few minutes before it goes live.

## Android beta (free, no Play Store)
1. Open the app URL in **Chrome** on Android.
2. Open the ⋮ menu and choose **Add to Home screen**. The app gets an icon like a normal app.
3. Allow **location** when Chrome asks.

Send the URL to beta testers. They don't need an Earth Engine account. If you later want a real Play Store listing, that requires a one-time US$25 developer fee. A free alternative is a sideloaded APK wrapper, which I can build later.

## Tuning
Every threshold is in the `CONFIG` block at the top of the script.

| Setting | Default | Change it if… |
|---|---|---|
| `mndwiThreshold` | 0.0 | Rice paddies show as water → raise it to 0.1–0.2 |
| `s1WaterDb` | −16 | Radar misses water → raise it to −15; too much false water → lower it to −18 |
| `waterFracMin` | 0.10 | Narrow streams are often marked "No water seen" → lower it to 0.05 |
| `csThreshold` | 0.60 | Cloud edges leak in → raise it to 0.65–0.70 |
| `segBufferM` | 30 | Wider valleys or rivers → 50–60 |

## Known limits
- Streams narrower than about 10 m are often invisible to 10–20 m pixels. "No water seen" does **not** mean dry.
- The river list only covers HydroRIVERS (catchment of 10 km² or more). Smaller streams appear only as the modelled light-blue layer.
- The app needs an internet connection; there is no offline mode.
- Earth Engine noncommercial terms apply: no selling the app or its data.
- Large radii (10 km) in hilly, dense networks can take 20–60 s.
