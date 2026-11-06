/* ============================================
   WEATHER MODULE — outside conditions for the APC dashboard
   Smart Urban Sensing

   Pulls outside weather (temperature, humidity, feels-like, rain, snow,
   wind, cloud) for the service area from Open-Meteo and keeps an hourly
   history next to the passenger data, so ridership can be read against
   the weather.

   Safety properties:
     - Additive only. One new table (weather_hourly), no change to records /
       hourly_summary / daily_summary / bus_state or any existing query.
     - On by default; set FEATURE_WEATHER=false to switch it off completely
       (no table, no routes, no timers).
     - Every network call is wrapped and time-limited. A weather fault can
       never break MQTT ingest or the dashboard — the strip just shows
       "unavailable".

   Data source:
     - Current:  https://api.open-meteo.com/v1/forecast  (current=…)
     - Recent:   same endpoint, past_days (last 7 days, hourly)
     - History:  https://archive-api.open-meteo.com/v1/archive (older than ~5 days)
     Open-Meteo's free API is for non-commercial use. For a paid customer
     deployment set WEATHER_API_KEY — requests then go to the customer-*
     hosts as Open-Meteo requires.

   Environment:
     FEATURE_WEATHER        'false' to disable (default on)
     WEATHER_LAT/WEATHER_LNG/WEATHER_LABEL  service-area point (default: caller)
     WEATHER_POLL_MIN       current-conditions refresh, minutes (default 15)
     WEATHER_BACKFILL_DAYS  max history to fill on start, days (default 366)
     WEATHER_API_KEY        Open-Meteo commercial key (optional)
   ============================================ */

'use strict';

const ENABLED = process.env.FEATURE_WEATHER !== 'false';
const API_KEY = process.env.WEATHER_API_KEY || '';
const POLL_MIN = Math.max(5, Number(process.env.WEATHER_POLL_MIN) || 15);
const BACKFILL_DAYS = Math.min(730, Math.max(0, Number(process.env.WEATHER_BACKFILL_DAYS ?? 366)));
const FETCH_TIMEOUT_MS = 15000;

const FORECAST_HOST = API_KEY ? 'https://customer-api.open-meteo.com' : 'https://api.open-meteo.com';
const ARCHIVE_HOST = API_KEY ? 'https://customer-archive-api.open-meteo.com' : 'https://archive-api.open-meteo.com';

const VARS = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
  'precipitation', 'rain', 'snowfall', 'weather_code',
  'wind_speed_10m', 'wind_gusts_10m', 'cloud_cover', 'is_day',
];

// WMO weather interpretation codes -> plain label + lucide icon name.
const WMO = {
  0: ['Clear', 'sun'], 1: ['Mainly clear', 'sun'], 2: ['Partly cloudy', 'cloud-sun'], 3: ['Overcast', 'cloud'],
  45: ['Fog', 'cloud-fog'], 48: ['Freezing fog', 'cloud-fog'],
  51: ['Light drizzle', 'cloud-drizzle'], 53: ['Drizzle', 'cloud-drizzle'], 55: ['Heavy drizzle', 'cloud-drizzle'],
  56: ['Freezing drizzle', 'cloud-drizzle'], 57: ['Freezing drizzle', 'cloud-drizzle'],
  61: ['Light rain', 'cloud-rain'], 63: ['Rain', 'cloud-rain'], 65: ['Heavy rain', 'cloud-rain'],
  66: ['Freezing rain', 'cloud-hail'], 67: ['Freezing rain', 'cloud-hail'],
  71: ['Light snow', 'cloud-snow'], 73: ['Snow', 'cloud-snow'], 75: ['Heavy snow', 'cloud-snow'], 77: ['Snow grains', 'cloud-snow'],
  80: ['Rain showers', 'cloud-rain'], 81: ['Rain showers', 'cloud-rain'], 82: ['Violent showers', 'cloud-rain'],
  85: ['Snow showers', 'cloud-snow'], 86: ['Heavy snow showers', 'cloud-snow'],
  95: ['Thunderstorm', 'cloud-lightning'], 96: ['Thunderstorm, hail', 'cloud-lightning'], 99: ['Thunderstorm, hail', 'cloud-lightning'],
};
function describe(code, isDay) {
  const d = WMO[code] || ['Unknown', 'cloud'];
  let icon = d[1];
  if (isDay === 0 && (code === 0 || code === 1)) icon = 'moon';
  if (isDay === 0 && code === 2) icon = 'cloud-moon';
  return { condition: d[0], icon };
}

const cToF = (c) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
const kmhToMph = (k) => (k == null ? null : Math.round(k * 0.621371 * 10) / 10);
const round1 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'sus-apc-backend/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function buildUrl(host, pathName, params) {
  const u = new URL(pathName, host);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  if (API_KEY) u.searchParams.set('apikey', API_KEY);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createStore(db) {
  db.exec(`
    -- One row per UTC hour of outside weather for the service area.
    -- date = calendar date in DISPLAY_TZ and hour = UTC hour, matching the
    -- keys hourly_summary already uses, so the two join directly.
    CREATE TABLE IF NOT EXISTS weather_hourly (
      ts_utc       TEXT PRIMARY KEY,           -- 'YYYY-MM-DDTHH:00' UTC
      date         TEXT NOT NULL,
      hour         INTEGER NOT NULL,
      temp_c       REAL,
      humidity     REAL,
      apparent_c   REAL,
      precip_mm    REAL,
      rain_mm      REAL,
      snow_cm      REAL,
      weather_code INTEGER,
      wind_kmh     REAL,
      gust_kmh     REAL,
      cloud_pct    REAL,
      is_day       INTEGER,
      source       TEXT NOT NULL DEFAULT 'forecast',  -- 'archive' | 'forecast'
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_weather_date ON weather_hourly(date);
  `);

  const upsert = db.prepare(`
    INSERT INTO weather_hourly (ts_utc, date, hour, temp_c, humidity, apparent_c, precip_mm, rain_mm, snow_cm,
                                weather_code, wind_kmh, gust_kmh, cloud_pct, is_day, source, updated_at)
    VALUES (@ts_utc, @date, @hour, @temp_c, @humidity, @apparent_c, @precip_mm, @rain_mm, @snow_cm,
            @weather_code, @wind_kmh, @gust_kmh, @cloud_pct, @is_day, @source, @updated_at)
    ON CONFLICT(ts_utc) DO UPDATE SET
      date = excluded.date, hour = excluded.hour, temp_c = excluded.temp_c, humidity = excluded.humidity,
      apparent_c = excluded.apparent_c, precip_mm = excluded.precip_mm, rain_mm = excluded.rain_mm,
      snow_cm = excluded.snow_cm, weather_code = excluded.weather_code, wind_kmh = excluded.wind_kmh,
      gust_kmh = excluded.gust_kmh, cloud_pct = excluded.cloud_pct, is_day = excluded.is_day,
      source = excluded.source, updated_at = excluded.updated_at
    -- Archive (reanalysis) values are final; never let a later forecast pass overwrite them.
    WHERE weather_hourly.source != 'archive' OR excluded.source = 'archive'
  `);

  return { db, upsert };
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

function hourlyRows(json, source, displayDateStr) {
  const h = json && json.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  const nowMs = Date.now();
  const out = [];
  const at = new Date().toISOString();
  for (let i = 0; i < h.time.length; i++) {
    const ts = h.time[i]; // 'YYYY-MM-DDTHH:00' in GMT
    const d = new Date(ts + ':00Z');
    if (Number.isNaN(d.getTime()) || d.getTime() > nowMs) continue; // observed hours only
    if (h.temperature_2m[i] == null) continue;
    out.push({
      ts_utc: ts,
      date: displayDateStr(d),
      hour: d.getUTCHours(),
      temp_c: h.temperature_2m[i],
      humidity: h.relative_humidity_2m[i],
      apparent_c: h.apparent_temperature[i],
      precip_mm: h.precipitation[i],
      rain_mm: h.rain[i],
      snow_cm: h.snowfall[i],
      weather_code: h.weather_code[i],
      wind_kmh: h.wind_speed_10m[i],
      gust_kmh: h.wind_gusts_10m[i],
      cloud_pct: h.cloud_cover[i],
      is_day: h.is_day ? h.is_day[i] : null,
      source,
      updated_at: at,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 * @param {{lat:number,lng:number,label:string,timezone:string,displayDateStr:(d?:Date)=>string}} opts
 */
function initWeather(app, db, opts) {
  if (!ENABLED) {
    app.get('/api/weather/current', (req, res) => res.json({ enabled: false }));
    console.log('[WEATHER] Disabled (FEATURE_WEATHER=false)');
    return null;
  }

  const loc = {
    lat: Number(process.env.WEATHER_LAT) || opts.lat,
    lng: Number(process.env.WEATHER_LNG) || opts.lng,
    label: process.env.WEATHER_LABEL || opts.label,
  };
  const displayDateStr = opts.displayDateStr;
  const store = createStore(db);
  const writeMany = db.transaction((rows) => { for (const r of rows) store.upsert.run(r); });

  let current = null;       // last good current-conditions payload
  let lastError = null;
  let lastFetchAt = null;

  async function refreshCurrent() {
    try {
      const json = await getJson(buildUrl(FORECAST_HOST, '/v1/forecast', {
        latitude: loc.lat, longitude: loc.lng, current: VARS.join(','),
        timezone: 'GMT', wind_speed_unit: 'kmh',
      }));
      const c = json.current;
      if (!c || c.temperature_2m == null) throw new Error('no current block');
      const desc = describe(c.weather_code, c.is_day);
      current = {
        observed_at: new Date(c.time + ':00Z').toISOString(),
        temp_c: round1(c.temperature_2m),
        temp_f: cToF(c.temperature_2m),
        apparent_c: round1(c.apparent_temperature),
        apparent_f: cToF(c.apparent_temperature),
        humidity: c.relative_humidity_2m,
        precip_mm: round1(c.precipitation),
        rain_mm: round1(c.rain),
        snow_cm: round1(c.snowfall),
        weather_code: c.weather_code,
        condition: desc.condition,
        icon: desc.icon,
        wind_kmh: round1(c.wind_speed_10m),
        wind_mph: kmhToMph(c.wind_speed_10m),
        gust_kmh: round1(c.wind_gusts_10m),
        gust_mph: kmhToMph(c.wind_gusts_10m),
        cloud_pct: c.cloud_cover,
        is_day: c.is_day,
      };
      lastFetchAt = new Date().toISOString();
      lastError = null;
    } catch (err) {
      lastError = err.message;
      console.warn('[WEATHER] current refresh failed:', err.message);
    }
  }

  async function refreshRecentHours() {
    try {
      const json = await getJson(buildUrl(FORECAST_HOST, '/v1/forecast', {
        latitude: loc.lat, longitude: loc.lng, hourly: VARS.join(','),
        past_days: 7, forecast_days: 1, timezone: 'GMT', wind_speed_unit: 'kmh',
      }));
      const rows = hourlyRows(json, 'forecast', displayDateStr);
      writeMany(rows);
      return rows.length;
    } catch (err) {
      console.warn('[WEATHER] recent hourly refresh failed:', err.message);
      return 0;
    }
  }

  // Fill history back to the first day of passenger data (capped), using the
  // archive for anything older than 6 days. Only asks for days not already
  // held as archive rows, so restarts are cheap.
  async function backfill() {
    if (BACKFILL_DAYS === 0) return;
    try {
      const first = db.prepare('SELECT MIN(date) AS d FROM daily_summary').get();
      if (!first || !first.d) return;
      const capStart = new Date(Date.now() - BACKFILL_DAYS * 86400000).toISOString().slice(0, 10);
      // Pad one day earlier: a Central date spans two UTC dates.
      const firstPad = new Date(new Date(first.d + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
      const start = firstPad > capStart ? firstPad : capStart;
      const end = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
      if (start > end) return;

      const have = db.prepare(`
        SELECT substr(ts_utc,1,10) AS d, COUNT(*) AS n FROM weather_hourly
        WHERE source = 'archive' AND ts_utc >= @start AND ts_utc < @endNext GROUP BY d
      `).all({ start, endNext: end + 'T99' });
      const complete = new Set(have.filter((r) => r.n >= 24).map((r) => r.d));
      let s = start;
      while (s <= end && complete.has(s)) s = new Date(new Date(s + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
      if (s > end) return;

      const json = await getJson(buildUrl(ARCHIVE_HOST, '/v1/archive', {
        latitude: loc.lat, longitude: loc.lng, hourly: VARS.join(','),
        start_date: s, end_date: end, timezone: 'GMT', wind_speed_unit: 'kmh',
      }));
      const rows = hourlyRows(json, 'archive', displayDateStr);
      writeMany(rows);
      console.log(`[WEATHER] Backfilled ${rows.length} archive hours (${s} → ${end})`);
    } catch (err) {
      console.warn('[WEATHER] backfill failed:', err.message);
    }
  }

  // ---- daily aggregation (calendar date in DISPLAY_TZ) ----
  const dailyStmt = db.prepare(`
    SELECT date,
           COUNT(*)                         AS hours,
           ROUND(AVG(temp_c), 1)            AS temp_avg_c,
           ROUND(MIN(temp_c), 1)            AS temp_min_c,
           ROUND(MAX(temp_c), 1)            AS temp_max_c,
           ROUND(AVG(apparent_c), 1)        AS apparent_avg_c,
           ROUND(AVG(humidity), 0)          AS humidity_avg,
           ROUND(SUM(precip_mm), 1)         AS precip_mm,
           ROUND(SUM(snow_cm), 1)           AS snow_cm,
           ROUND(MAX(wind_kmh), 1)          AS wind_max_kmh,
           MAX(weather_code)                AS worst_code
    FROM weather_hourly
    WHERE date >= @from AND date <= @to
    GROUP BY date ORDER BY date
  `);

  function withF(row) {
    const d = describe(row.worst_code, 1);
    return {
      ...row,
      temp_avg_f: cToF(row.temp_avg_c), temp_min_f: cToF(row.temp_min_c), temp_max_f: cToF(row.temp_max_c),
      condition: d.condition, icon: d.icon,
      wet: (row.precip_mm || 0) >= 1 || (row.snow_cm || 0) > 0,
    };
  }

  // ---- routes ----
  app.get('/api/weather/current', (req, res) => {
    const staleAfterMs = (POLL_MIN * 3) * 60000;
    const stale = !lastFetchAt || (Date.now() - new Date(lastFetchAt).getTime()) > staleAfterMs;
    res.json({
      enabled: true,
      available: !!current,
      stale,
      location: loc,
      fetched_at: lastFetchAt,
      error: current ? null : lastError,
      source: 'Open-Meteo',
      ...(current || {}),
    });
  });

  app.get('/api/weather/hourly', (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : displayDateStr();
    const rows = db.prepare('SELECT * FROM weather_hourly WHERE date = ? ORDER BY ts_utc').all(date);
    res.json({ date, location: loc, hourly: rows.map((r) => ({ ...r, temp_f: cToF(r.temp_c), apparent_f: cToF(r.apparent_c) })) });
  });

  app.get('/api/weather/daily', (req, res) => {
    const to = isDate(req.query.to) ? req.query.to : displayDateStr();
    const from = isDate(req.query.from) ? req.query.from : to;
    res.json({ from, to, location: loc, daily: dailyStmt.all({ from, to }).map(withF) });
  });

  // Ridership joined to weather, per day, plus simple comparisons the
  // dashboard can show without any statistics knowledge.
  app.get('/api/weather/ridership', (req, res) => {
    const to = isDate(req.query.to) ? req.query.to : displayDateStr();
    const from = isDate(req.query.from) ? req.query.from : to;
    const busId = req.query.bus_id && req.query.bus_id !== 'all' ? String(req.query.bus_id) : null;

    const rides = db.prepare(`
      SELECT date, SUM(total_in) AS boardings, SUM(total_out) AS alightings
      FROM daily_summary WHERE date >= @from AND date <= @to ${busId ? 'AND bus_id = @busId' : ''}
      GROUP BY date
    `).all({ from, to, busId });
    const wx = new Map(dailyStmt.all({ from, to }).map((r) => [r.date, withF(r)]));

    const days = rides.map((r) => ({ date: r.date, boardings: r.boardings || 0, alightings: r.alightings || 0, weather: wx.get(r.date) || null }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    // Only days with real service count towards comparisons.
    const served = days.filter((d) => d.boardings > 0 && d.weather);
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, d) => s + d.boardings, 0) / arr.length) : null);
    const dry = served.filter((d) => !d.weather.wet);
    const wet = served.filter((d) => d.weather.wet);
    const bands = [
      { key: 'freezing', label: 'Below 0°C (32°F)', test: (t) => t < 0 },
      { key: 'cold', label: '0–10°C (32–50°F)', test: (t) => t >= 0 && t < 10 },
      { key: 'mild', label: '10–20°C (50–68°F)', test: (t) => t >= 10 && t < 20 },
      { key: 'warm', label: '20°C+ (68°F+)', test: (t) => t >= 20 },
    ].map((b) => {
      const ds = served.filter((d) => d.weather.temp_avg_c != null && b.test(d.weather.temp_avg_c));
      return { key: b.key, label: b.label, days: ds.length, avg_boardings: avg(ds) };
    });

    res.json({
      from, to, bus_id: busId || 'all', location: loc,
      days,
      summary: {
        served_days: served.length,
        dry: { days: dry.length, avg_boardings: avg(dry) },
        wet: { days: wet.length, avg_boardings: avg(wet) },
        wet_rule: 'Wet = at least 1 mm of rain or any snow that day',
        temp_bands: bands,
      },
    });
  });

  // ---- timers ----
  (async () => {
    await refreshCurrent();
    await refreshRecentHours();
    await backfill();
  })();
  setInterval(refreshCurrent, POLL_MIN * 60000).unref();
  setInterval(refreshRecentHours, 60 * 60000).unref();
  setInterval(backfill, 24 * 60 * 60000).unref();

  console.log(`[WEATHER] Enabled for ${loc.label} (${loc.lat}, ${loc.lng}) — current every ${POLL_MIN} min${API_KEY ? ', commercial key' : ''}`);
  return { refreshCurrent, refreshRecentHours, backfill, describe };
}

module.exports = { initWeather, describe, hourlyRows, _internal: { cToF, kmhToMph } };
