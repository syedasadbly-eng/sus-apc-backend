/* ============================================
   WEATHER — outside conditions on the APC dashboard
   Smart Urban Sensing

   - Weather strip on the Dashboard (#weatherStripOverview) and the Welfare
     Console (#weatherStripWelfare), refreshed every 5 minutes from
     /api/weather/current.
   - "Ridership vs Weather" panel on the Ridership page, called by
     loadRidershipData() with the same date window and bus filter.

   Everything here is optional: if the backend has weather switched off
   (FEATURE_WEATHER=false) or is an older deploy, the strip stays hidden and
   the ridership panel shows a short note. Nothing else on the page depends
   on this file.
   ============================================ */
(function () {
  'use strict';

  const REFRESH_MS = 5 * 60 * 1000;
  const STRIP_IDS = ['weatherStripOverview', 'weatherStripWelfare'];
  let wxChart = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 0) => (n == null || Number.isNaN(Number(n)) ? '–' : Number(n).toFixed(d));
  const tempPair = (f, c) => `${num(f)}°F <span class="wx-sub">/ ${num(c, 1)}°C</span>`;

  async function getJson(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    return `${h}h ago`;
  }

  function icon(name) {
    return `<i data-lucide="${esc(name)}"></i>`;
  }

  function stat(iconName, label, valueHtml) {
    return `<div class="wx-stat">${icon(iconName)}<div><div class="wx-label">${esc(label)}</div><div class="wx-value">${valueHtml}</div></div></div>`;
  }

  // ---------------------------------------------------------------------
  // Weather strip
  // ---------------------------------------------------------------------
  function renderStrip(el, w) {
    if (!w || w.enabled === false) { el.hidden = true; return; }
    el.hidden = false;
    if (!w.available) {
      el.innerHTML = `<div class="wx-main">${icon('cloud-off')}<div><div class="wx-label">Outside weather</div><div class="wx-value wx-muted">Unavailable right now</div></div></div>`;
      if (window.lucide) window.lucide.createIcons();
      return;
    }
    const precip = (w.snow_cm || 0) > 0
      ? `${num(w.snow_cm, 1)} cm snow`
      : `${num(w.precip_mm, 1)} mm`;
    el.innerHTML = `
      <div class="wx-main">
        ${icon(w.icon || 'cloud')}
        <div>
          <div class="wx-label">Outside &middot; ${esc((w.location && w.location.label) || 'Service area')}</div>
          <div class="wx-temp">${tempPair(w.temp_f, w.temp_c)}</div>
          <div class="wx-cond">${esc(w.condition || '')}</div>
        </div>
      </div>
      ${stat('thermometer', 'Feels like', tempPair(w.apparent_f, w.apparent_c))}
      ${stat('droplets', 'Humidity', `${num(w.humidity)}%`)}
      ${stat('wind', 'Wind', `${num(w.wind_mph)} mph <span class="wx-sub">gusts ${num(w.gust_mph)}</span>`)}
      ${stat((w.snow_cm || 0) > 0 ? 'snowflake' : 'umbrella', 'Precipitation (15 min)', precip)}
      <div class="wx-meta${w.stale ? ' wx-stale' : ''}">Open-Meteo &middot; updated ${esc(timeAgo(w.fetched_at))}${w.stale ? ' &middot; stale' : ''}</div>`;
    if (window.lucide) window.lucide.createIcons();
  }

  async function refreshStrips() {
    const els = STRIP_IDS.map((id) => document.getElementById(id)).filter(Boolean);
    if (!els.length) return;
    let w = null;
    try { w = await getJson('/api/weather/current'); } catch (_) { w = null; }
    els.forEach((el) => {
      if (!w) { el.hidden = true; return; }   // older backend without weather routes
      renderStrip(el, w);
    });
  }

  // ---------------------------------------------------------------------
  // Ridership vs Weather
  // ---------------------------------------------------------------------
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function renderSummary(el, s) {
    if (!el) return;
    if (!s || !s.served_days) {
      el.innerHTML = '<div class="wx-note">No service days with weather in this period yet.</div>';
      return;
    }
    const chip = (title, val, sub) => `<div class="wx-chip"><div class="wx-label">${esc(title)}</div><div class="wx-value">${val}</div><div class="wx-sub">${esc(sub)}</div></div>`;
    const avg = (g) => (g.avg_boardings == null ? '–' : g.avg_boardings.toLocaleString());
    let diffNote = '';
    if (s.dry.avg_boardings && s.wet.avg_boardings) {
      const pct = Math.round(((s.wet.avg_boardings - s.dry.avg_boardings) / s.dry.avg_boardings) * 100);
      diffNote = `${pct > 0 ? '+' : ''}${pct}% on wet days`;
    }
    const bands = s.temp_bands.filter((b) => b.days > 0)
      .map((b) => chip(b.label, avg(b), `${b.days} day${b.days === 1 ? '' : 's'} · avg boardings`)).join('');
    el.innerHTML =
      chip('Dry days', avg(s.dry), `${s.dry.days} day${s.dry.days === 1 ? '' : 's'} · avg boardings`) +
      chip('Wet days', avg(s.wet), `${s.wet.days} day${s.wet.days === 1 ? '' : 's'}${diffNote ? ' · ' + diffNote : ''}`) +
      bands +
      `<div class="wx-note">${esc(s.wet_rule)}. Small samples are indicative only.</div>`;
  }

  async function loadRidership(from, to, busId) {
    const section = document.getElementById('ridershipWeatherSection');
    const canvas = document.getElementById('chartRidershipWeather');
    const summaryEl = document.getElementById('ridershipWeatherSummary');
    if (!section || !canvas || typeof Chart === 'undefined') return;

    let data = null;
    try {
      const q = new URLSearchParams({ from, to });
      if (busId && busId !== 'all') q.set('bus_id', busId);
      data = await getJson('/api/weather/ridership?' + q.toString());
    } catch (_) { data = null; }

    if (!data) {
      section.hidden = true; // backend without weather (older deploy or switched off)
      return;
    }
    section.hidden = false;
    renderSummary(summaryEl, data.summary);

    const days = data.days || [];
    const labels = days.map((d) => {
      const dt = new Date(d.date + 'T12:00:00Z');
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    });
    const boardings = days.map((d) => d.boardings);
    const temps = days.map((d) => (d.weather ? d.weather.temp_avg_f : null));
    const precip = days.map((d) => (d.weather ? Math.round(((d.weather.precip_mm || 0) / 25.4) * 100) / 100 : null));

    const primary = cssVar('--color-primary', '#3b82f6');
    const warn = cssVar('--color-warning', '#f59e0b');
    const info = cssVar('--color-info', '#06b6d4');
    const muted = cssVar('--color-text-muted', '#8b8ea5');
    const grid = cssVar('--color-border', '#323554');

    if (wxChart) { wxChart.destroy(); wxChart = null; }
    wxChart = new Chart(canvas.getContext('2d'), {
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'Boardings', data: boardings, yAxisID: 'y', backgroundColor: primary + '99', borderRadius: 3, order: 3 },
          { type: 'line', label: 'Avg temp (°F)', data: temps, yAxisID: 'yTemp', borderColor: warn, backgroundColor: warn, pointRadius: days.length > 40 ? 0 : 2, tension: 0.3, spanGaps: true, order: 1 },
          { type: 'bar', label: 'Rain/snow (in)', data: precip, yAxisID: 'yPrecip', backgroundColor: info + 'cc', borderRadius: 2, barPercentage: 0.4, order: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: muted, boxWidth: 12, usePointStyle: true } },
          tooltip: {
            callbacks: {
              afterBody: (items) => {
                const d = days[items[0].dataIndex];
                if (!d || !d.weather) return 'No weather recorded';
                const w = d.weather;
                return [
                  `${w.condition} · ${w.temp_min_f}–${w.temp_max_f}°F (${w.temp_min_c}–${w.temp_max_c}°C)`,
                  `Humidity ${w.humidity_avg}% · Rain ${w.precip_mm} mm${w.snow_cm ? ` · Snow ${w.snow_cm} cm` : ''}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: muted, maxRotation: 0, autoSkip: true }, grid: { display: false } },
          y: { position: 'left', beginAtZero: true, title: { display: true, text: 'Boardings', color: muted }, ticks: { color: muted }, grid: { color: grid } },
          yTemp: { position: 'right', title: { display: true, text: '°F', color: muted }, ticks: { color: muted }, grid: { display: false } },
          yPrecip: { position: 'right', display: false, beginAtZero: true, suggestedMax: 2 },
        },
      },
    });
  }

  // ---------------------------------------------------------------------
  function start() {
    refreshStrips();
    setInterval(refreshStrips, REFRESH_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.SUSWeather = { refresh: refreshStrips, loadRidership };
})();
