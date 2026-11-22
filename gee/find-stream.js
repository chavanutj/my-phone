/**
 * find-stream — Google Earth Engine App (Thailand + Laos)
 *
 * Finds streams near you and shows whether water is visible in the most
 * recent clear satellite image.
 *
 *   Optical : Sentinel-2 L2A (10–20 m), clouds removed with Cloud Score+
 *   Radar   : Sentinel-1 GRD VV (10 m) fills cloudy gaps (monsoon)
 *   Rivers  : HydroSHEDS / HydroRIVERS-based Free Flowing Rivers (≥10 km² catchment)
 *   Small   : MERIT Hydro upstream area ≥ 1 km² (modelled small channels)
 *   History : JRC Global Surface Water occurrence (1984–2021)
 *
 * Free for non-commercial / research use with a registered Earth Engine
 * Cloud project. Paste into https://code.earthengine.google.com, Run, then
 * Apps → New App to publish.
 */

// ---------------------------------------------------------------------------
// Settings (tune after field checks)
// ---------------------------------------------------------------------------
var CONFIG = {
  csThreshold: 0.60,      // Cloud Score+ cs_cdf: pixel is "clear" if >= this
  mndwiThreshold: 0.0,    // MNDWI > this  → water (Xu 2006)
  s1WaterDb: -16,         // Sentinel-1 VV backscatter < this (dB) → water
  s1LookbackDays: 12,
  segBufferM: 30,         // buffer around each river segment for statistics
  statsScale: 20,         // m; MNDWI uses 20 m SWIR band
  waterFracMin: 0.10,     // ≥10 % of clear pixels in buffer are water → "Water seen"
  validFracMin: 0.30,     // <30 % of buffer has clear data → "Uncertain"
  smallChannelUpaKm2: 1,  // MERIT upstream area threshold for modelled channels
  maxResults: 10
};

// Approximate Thailand + Laos extent (used only to warn users outside scope).
var SCOPE = {w: 97.3, s: 5.6, e: 107.7, n: 22.6};

var STATUS = {
  WATER:     {label: 'Water seen',     color: '1E88E5', emoji: '🔵'},
  DRY:       {label: 'No water seen',  color: 'E0E0E0', emoji: '⚪'},
  UNCERTAIN: {label: 'Uncertain (cloud / no data)', color: 'FBC02D', emoji: '🟡'}
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
var S2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED');
var CS_PLUS = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
var S1 = ee.ImageCollection('COPERNICUS/S1_GRD');
var RIVERS = ee.FeatureCollection('WWF/HydroSHEDS/v1/FreeFlowingRivers');
var MERIT = ee.Image('MERIT/Hydro/v1_0_1');
var JRC = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');

/** Latest clear Sentinel-2 pixel per location (newest on top). */
function sentinel2Latest(area, end, lookbackDays) {
  var col = S2.filterBounds(area)
    .filterDate(end.advance(-lookbackDays, 'day'), end)
    .linkCollection(CS_PLUS, ['cs_cdf']);

  var prepared = col.map(function (img) {
    var clear = img.select('cs_cdf').gte(CONFIG.csThreshold);
    var mndwi = img.normalizedDifference(['B3', 'B11']).rename('mndwi');
    var ndwi = img.normalizedDifference(['B3', 'B8']).rename('ndwi');
    var day = ee.Image.constant(
      ee.Number(img.get('system:time_start')).divide(86400000)
    ).float().rename('day');
    return img.select(['B4', 'B3', 'B2']).float()
      .addBands([mndwi, ndwi, day])
      .updateMask(clear)
      .copyProperties(img, ['system:time_start']);
  });

  // Fully-masked placeholder at the bottom so an empty window never breaks the app.
  var empty = ee.Image.constant([0, 0, 0, 0, 0, 0]).float()
    .rename(['B4', 'B3', 'B2', 'mndwi', 'ndwi', 'day']).updateMask(0);
  return {
    collection: col,
    latest: ee.ImageCollection([empty])
      .merge(prepared.sort('system:time_start')).mosaic()
  };
}

/** Sentinel-1 radar water (sees through cloud). */
function sentinel1Water(area, end) {
  var col = S1.filterBounds(area)
    .filterDate(end.advance(-CONFIG.s1LookbackDays, 'day'), end)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .select('VV');
  var empty = ee.Image.constant(0).float().rename('VV').updateMask(0);
  var latest = ee.ImageCollection([empty]).merge(col.map(function (img) {
    return img.focalMedian(30, 'circle', 'meters').float()
      .copyProperties(img, ['system:time_start']);
  }).sort('system:time_start')).mosaic();
  return {collection: col, water: latest.lt(CONFIG.s1WaterDb).rename('water')};
}

/** Combined water mask: Sentinel-2 where clear, otherwise Sentinel-1. */
function buildWater(area, end, lookbackDays) {
  var s2 = sentinel2Latest(area, end, lookbackDays);
  var s1 = sentinel1Water(area, end);
  var s2water = s2.latest.select('mndwi').gt(CONFIG.mndwiThreshold).rename('water');
  // Band 'src': 2 = Sentinel-2, 1 = Sentinel-1
  var water = ee.ImageCollection([
    s1.water.addBands(ee.Image(1).byte().rename('src').updateMask(s1.water.mask())),
    s2water.addBands(ee.Image(2).byte().rename('src').updateMask(s2water.mask()))
  ]).mosaic();
  return {s2: s2, s1: s1, water: water};
}

/** Per-segment statistics and status. */
function analyseRivers(point, area, water) {
  var stack = water.select('water').unmask(0).rename('water')
    .addBands(water.select('water').mask().rename('valid'))
    .addBands(JRC.select('occurrence').unmask(0).divide(100).rename('occ'));

  return RIVERS.filterBounds(area).map(function (f) {
    var stats = ee.Dictionary(stack.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: f.geometry().buffer(CONFIG.segBufferM),
      scale: CONFIG.statsScale,
      maxPixels: 1e8,
      bestEffort: true
    }));
    var valid = ee.Number(stats.get('valid'));
    var frac = ee.Number(stats.get('water')).divide(valid.max(1e-6));
    var status = ee.Algorithms.If(valid.lt(CONFIG.validFracMin), 'UNCERTAIN',
      ee.Algorithms.If(frac.gte(CONFIG.waterFracMin), 'WATER', 'DRY'));
    return f.set({
      dist_m: f.geometry().distance(point, 1),
      valid_frac: valid,
      water_frac: frac,
      hist_occ: stats.get('occ'),
      status: status
    });
  });
}

// ---------------------------------------------------------------------------
// Client-side helpers
// ---------------------------------------------------------------------------
function nearestOnLine(lon0, lat0, geom) {
  var k = Math.cos(lat0 * Math.PI / 180);
  var lines = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
  var best = null, bestD = Infinity;
  lines.forEach(function (coords) {
    for (var i = 0; i < coords.length - 1; i++) {
      var ax = coords[i][0] * k, ay = coords[i][1];
      var bx = coords[i + 1][0] * k, by = coords[i + 1][1];
      var px = lon0 * k, py = lat0;
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      var qx = ax + t * dx, qy = ay + t * dy;
      var d = (qx - px) * (qx - px) + (qy - py) * (qy - py);
      if (d < bestD) { bestD = d; best = [qx / k, qy]; }
    }
  });
  return best;
}

function fmtDist(m) {
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
}

function fmtDate(ms) {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

function pct(x) {
  return (x === null || x === undefined) ? '—' : Math.round(x * 100) + '%';
}

function inScope(lon, lat) {
  return lon >= SCOPE.w && lon <= SCOPE.e && lat >= SCOPE.s && lat <= SCOPE.n;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
ui.root.clear();
var map = ui.Map();
map.setOptions('HYBRID');
map.setControlVisibility({layerList: true, zoomControl: true, mapTypeControl: false,
  fullscreenControl: false, drawingToolsControl: false, scaleControl: true});
map.setCenter(102.5, 15.5, 6);
map.style().set('cursor', 'crosshair');
ui.root.add(map);

var panel = ui.Panel({style: {
  position: 'bottom-left', width: '330px', maxHeight: '55%', padding: '6px 8px'
}});
var body = ui.Panel();

var title = ui.Label('💧 find-stream', {fontSize: '20px', fontWeight: 'bold', margin: '2px 0'});
var hideBtn = ui.Button({label: '▾', style: {margin: '0 0 0 auto', padding: '0'}});
var bodyShown = true;
hideBtn.onClick(function () {
  bodyShown = !bodyShown;
  body.style().set('shown', bodyShown);
  hideBtn.setLabel(bodyShown ? '▾' : '▴');
});
panel.add(ui.Panel([title, hideBtn], ui.Panel.Layout.flow('horizontal'), {stretch: 'horizontal'}));
panel.add(body);

body.add(ui.Label('Streams near you from the latest clear satellite image (Thailand & Laos).',
  {fontSize: '12px', color: '555', margin: '0 0 6px 0'}));

var radiusSel = ui.Select({items: ['1 km', '2 km', '5 km', '10 km'], value: '2 km',
  style: {margin: '0 4px 0 0'}});
var daysSel = ui.Select({items: ['15 days', '30 days', '60 days', '90 days'], value: '30 days'});
body.add(ui.Panel([ui.Label('Radius', {margin: '8px 4px 0 0'}), radiusSel,
  ui.Label('Images', {margin: '8px 4px 0 0'}), daysSel],
  ui.Panel.Layout.flow('horizontal')));

var locBtn = ui.Button({label: '📍 Use my location', style: {stretch: 'horizontal'}});
body.add(locBtn);
body.add(ui.Label('…or tap anywhere on the map.', {fontSize: '11px', color: '777', margin: '0 0 4px 8px'}));

var status = ui.Label('', {fontSize: '12px', color: '333', whiteSpace: 'pre-wrap'});
body.add(status);
var results = ui.Panel();
body.add(results);

// Legend
function legendRow(color, text) {
  return ui.Panel([
    ui.Label('', {backgroundColor: '#' + color, padding: '6px 10px', margin: '2px 6px 2px 0'}),
    ui.Label(text, {fontSize: '11px', margin: '3px 0'})
  ], ui.Panel.Layout.flow('horizontal'));
}
var legend = ui.Panel([
  ui.Label('Legend', {fontWeight: 'bold', fontSize: '12px', margin: '6px 0 2px 0'}),
  legendRow(STATUS.WATER.color, 'River: water seen'),
  legendRow(STATUS.DRY.color, 'River: no water seen'),
  legendRow(STATUS.UNCERTAIN.color, 'River: uncertain (cloud / no data)'),
  legendRow('00E5FF', 'Water pixels in latest image'),
  legendRow('80DEEA', 'Small channels (modelled, ≥1 km² catchment)')
]);
body.add(legend);
body.add(ui.Label(
  'Small streams (<10 m wide) may be invisible to 10–20 m satellite pixels, so ' +
  '"No water seen" ≠ dry. Always check on the ground. Not a guide to safe drinking water or land access.',
  {fontSize: '10px', color: '888', margin: '6px 0 0 0'}));
body.add(ui.Label('Data: Copernicus Sentinel-1/2 (ESA), HydroSHEDS/WWF, MERIT Hydro, JRC GSW, Google Cloud Score+.',
  {fontSize: '10px', color: '888'}));

map.add(panel);

// ---------------------------------------------------------------------------
// Main search
// ---------------------------------------------------------------------------
var busy = false;

function setBusy(on, msg) {
  busy = on;
  locBtn.setDisabled(on);
  if (msg !== undefined) status.setValue(msg);
}

function search(lon, lat) {
  if (busy) return;
  results.clear();
  if (!inScope(lon, lat)) {
    status.setValue('⚠️ This location is outside Thailand/Laos. Results may still work but are not tuned for this area.');
  }
  setBusy(true, '⏳ Searching satellite images…');

  var radiusM = parseFloat(radiusSel.getValue()) * 1000;
  var days = parseFloat(daysSel.getValue());
  var point = ee.Geometry.Point([lon, lat]);
  var area = point.buffer(radiusM);
  var end = ee.Date(Date.now());

  var w = buildWater(area, end, days);
  var rivers = analyseRivers(point, area, w.water);

  // --- map layers ---
  map.layers().reset();
  map.centerObject(area);
  map.addLayer(w.s2.latest.select(['B4', 'B3', 'B2']).clip(area),
    {min: 0, max: 3000}, 'Latest clear Sentinel-2 (true colour)', false);
  map.addLayer(JRC.select('occurrence').selfMask().clip(area),
    {min: 0, max: 100, palette: ['FFF9C4', '0D47A1']}, 'Historic water 1984–2021 (JRC)', false);
  map.addLayer(MERIT.select('upa').gte(CONFIG.smallChannelUpaKm2).selfMask().clip(area),
    {palette: ['80DEEA']}, 'Small channels (modelled)', true, 0.7);
  map.addLayer(w.water.select('water').selfMask().clip(area),
    {palette: ['00E5FF']}, 'Water pixels (latest)', true, 0.8);
  map.addLayer(rivers.map(function (f) {
    var color = ee.Dictionary({
      WATER: STATUS.WATER.color, DRY: STATUS.DRY.color, UNCERTAIN: STATUS.UNCERTAIN.color
    }).get(f.get('status'));
    return f.set('style', {color: color, width: 4});
  }).style({styleProperty: 'style'}), {}, 'Rivers by status');
  map.addLayer(area, {color: 'FFFFFF'}, 'Search area', false);
  map.addLayer(point, {color: 'FF1744'}, 'You');

  // --- image info ---
  var s2n = w.s2.collection.size();
  var s1n = w.s1.collection.size();
  var info = ee.Dictionary({
    s2_count: s2n,
    s2_last: ee.Algorithms.If(s2n.gt(0), w.s2.collection.aggregate_max('system:time_start'), null),
    s2_cloud: ee.Algorithms.If(s2n.gt(0), ee.Image(w.s2.collection
      .sort('system:time_start', false).first()).get('CLOUDY_PIXEL_PERCENTAGE'), null),
    s1_last: ee.Algorithms.If(s1n.gt(0), w.s1.collection.aggregate_max('system:time_start'), null),
    clear_frac: w.water.select('water').mask().reduceRegion({
      reducer: ee.Reducer.mean(), geometry: area, scale: 60, bestEffort: true
    }).get('water'),
    n_rivers: rivers.size()
  });

  var top = rivers.sort('dist_m').limit(CONFIG.maxResults);

  info.evaluate(function (inf, err) {
    if (err) { setBusy(false, '❌ ' + err); return; }
    var lines = [];
    lines.push('🛰️ Sentinel-2: ' + inf.s2_count + ' image(s) in last ' + days + ' days, newest ' +
      fmtDate(inf.s2_last) + (inf.s2_cloud !== null && inf.s2_cloud !== undefined ? ' (' + Math.round(inf.s2_cloud) + '% cloud)' : ''));
    lines.push('📡 Sentinel-1 radar newest: ' + fmtDate(inf.s1_last));
    lines.push('Area with clear data: ' + pct(inf.clear_frac));
    if (inf.s2_count === 0) lines.push('No Sentinel-2 images: try a longer image window.');
    status.setValue(lines.join('\n') + '\n⏳ Checking ' + inf.n_rivers + ' river segment(s)…');

    top.evaluate(function (fc, err2) {
      setBusy(false);
      if (err2) { status.setValue(status.getValue() + '\n❌ ' + err2); return; }
      status.setValue(lines.join('\n'));
      showResults(fc.features, lon, lat);
    });
  });
}

function showResults(features, lon, lat) {
  results.clear();
  if (!features.length) {
    results.add(ui.Label('No mapped rivers (≥10 km² catchment) in this radius. ' +
      'See light-blue modelled small channels and bright water pixels on the map, or increase the radius.',
      {fontSize: '12px'}));
    return;
  }
  results.add(ui.Label('Nearest streams', {fontWeight: 'bold', margin: '6px 0 2px 0'}));
  features.forEach(function (f, i) {
    var p = f.properties;
    var s = STATUS[p.status] || STATUS.UNCERTAIN;
    var target = nearestOnLine(lon, lat, f.geometry) || [lon, lat];
    var detail = s.emoji + ' ' + s.label +
      (p.status === 'UNCERTAIN' ? '' : ' — ' + pct(p.water_frac) + ' of clear pixels') +
      '\nCatchment ' + (p.UPLAND_SKM ? Math.round(p.UPLAND_SKM) + ' km²' : '—') +
      ' · avg flow ' + (p.DIS_AV_CMS !== undefined && p.DIS_AV_CMS !== null ? p.DIS_AV_CMS.toFixed(1) + ' m³/s' : '—') +
      ' · historic water ' + pct(p.hist_occ);

    var showBtn = ui.Button({label: (i + 1) + '. ' + fmtDist(p.dist_m), style: {margin: '2px 4px 0 0'}});
    showBtn.onClick(function () { map.setCenter(target[0], target[1], 16); });
    var nav = ui.Label('Directions ↗', {fontSize: '12px', color: '1565C0', margin: '10px 0 0 0'},
      'https://www.google.com/maps/dir/?api=1&destination=' +
      target[1].toFixed(6) + ',' + target[0].toFixed(6));
    results.add(ui.Panel([showBtn, nav], ui.Panel.Layout.flow('horizontal')));
    results.add(ui.Label(detail, {fontSize: '11px', color: '444', whiteSpace: 'pre-wrap', margin: '0 0 4px 8px'}));
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
locBtn.onClick(function () {
  setBusy(true, '📍 Getting your location…');
  ui.util.getCurrentPosition(function (pt) {
    setBusy(false);
    pt.coordinates().evaluate(function (c) { search(c[0], c[1]); });
  }, function (e) {
    setBusy(false, '⚠️ Could not get location (' + e + '). Tap the map instead.');
  });
});

map.onClick(function (c) { search(c.lon, c.lat); });
