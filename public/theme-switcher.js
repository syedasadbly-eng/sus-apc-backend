/* ============================================
   SUS APC DASHBOARD — THEME SWITCHER
   Two colour schemes:
     • "original"         — the existing dark dashboard (default, untouched)
     • "glossy-platinum"  — light silver canvas, glossy platinum KPI cards,
                            white chart panels, black metallic header/sidebar
   The choice is stored per browser (localStorage) and only changes styling.
   Data, MQTT, alerts and dashboard functions are not affected.
   ============================================ */
(function () {
  'use strict';

  var KEY = 'sus-dashboard-skin';
  var GLOSSY = 'glossy-platinum';
  var OPTIONS = [
    ['original', 'Original dark'],
    [GLOSSY, 'Glossy Platinum']
  ];
  var root = document.documentElement;

  function isGlossy() { return root.getAttribute('data-skin') === GLOSSY; }

  // Apply the saved skin as early as possible to avoid a flash of the wrong theme.
  var saved = 'original';
  try { saved = localStorage.getItem(KEY) === GLOSSY ? GLOSSY : 'original'; } catch (e) {}
  if (saved === GLOSSY) root.setAttribute('data-skin', GLOSSY);

  // Load the glossy stylesheet (all rules are scoped to html[data-skin="glossy-platinum"]).
  if (!document.getElementById('susGlossyCss')) {
    var link = document.createElement('link');
    link.id = 'susGlossyCss';
    link.rel = 'stylesheet';
    link.href = './theme-glossy-platinum.css';
    document.head.appendChild(link);
  }

  /* ---------- Chart.js: remap hard-coded dark-theme text/grid colours ---------- */
  // app.js sets light-grey tick/legend colours and white grid lines suited to the
  // dark theme. In Glossy Platinum these are swapped for dark equivalents; the
  // originals are remembered and restored when switching back.

  function parseColor(c) {
    if (typeof c !== 'string') return null;
    var s = c.trim().toLowerCase(), m;
    if ((m = s.match(/^#([0-9a-f]{3})$/))) {
      var h = m[1];
      return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 };
    }
    if ((m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/))) {
      return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    }
    if ((m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/))) {
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    }
    return null;
  }

  function lum(p) { return (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b) / 255; }
  function isNeutral(p) { return Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b) < 40; }

  // Only neutral light greys/whites are remapped; brand/series colours are kept.
  function toGlossy(c, kind) {
    var p = parseColor(c);
    if (!p || !isNeutral(p)) return c;
    var L = lum(p);
    if (kind === 'grid') {
      if (L > 0.6 && p.a < 0.5) return 'rgba(22,28,38,' + Math.min(0.14, Math.max(0.07, p.a * 2.2)).toFixed(3) + ')';
      return c;
    }
    if (kind === 'series') {
      if (L > 0.6) return 'rgba(31,37,46,' + Math.max(0.55, p.a).toFixed(2) + ')';
      return c;
    }
    if (L > 0.78) return 'rgba(31,37,46,1)';
    if (L > 0.5) return 'rgba(61,70,83,1)';
    if (L > 0.3) return 'rgba(90,100,112,1)';
    return c;
  }

  // Chart.js rebuilds option objects on update, so originals are tracked by value:
  // each original colour gets a unique glossy colour, which can be reversed exactly.
  var fwd = {}, rev = {};
  function glossyFor(orig, kind) {
    var id = kind + '|' + orig;
    if (id in fwd) return fwd[id];
    var base = toGlossy(orig, kind);
    if (base === orig) { fwd[id] = orig; return orig; }
    var p = parseColor(base), out, n = 0;
    do {
      out = 'rgba(' + p.r + ',' + p.g + ',' + Math.min(255, p.b + n) + ',' + p.a + ')';
      n++;
    } while (out in rev && rev[out] !== orig);
    fwd[id] = out; rev[out] = orig;
    return out;
  }

  function remapKey(obj, key, kind, glossy) {
    if (!obj || typeof obj !== 'object') return;
    var cur = obj[key];
    if (typeof cur !== 'string') return;
    if (glossy) {
      if (cur in rev) return; // already themed
      var next = glossyFor(cur, kind);
      if (next !== cur) obj[key] = next;
    } else if (cur in rev) {
      obj[key] = rev[cur];
    }
  }

  function remapChart(chart, glossy) {
    var o = chart && chart.config && chart.config.options;
    if (!o) return;
    var scales = o.scales || {};
    Object.keys(scales).forEach(function (k) {
      var sc = scales[k];
      if (!sc) return;
      if (sc.ticks) remapKey(sc.ticks, 'color', 'text', glossy);
      if (sc.title) remapKey(sc.title, 'color', 'text', glossy);
      if (sc.pointLabels) remapKey(sc.pointLabels, 'color', 'text', glossy);
      if (sc.grid) remapKey(sc.grid, 'color', 'grid', glossy);
      if (sc.angleLines) remapKey(sc.angleLines, 'color', 'grid', glossy);
      if (sc.border) remapKey(sc.border, 'color', 'grid', glossy);
    });
    var pl = o.plugins || {};
    if (pl.legend && pl.legend.labels) remapKey(pl.legend.labels, 'color', 'text', glossy);
    if (pl.title) remapKey(pl.title, 'color', 'text', glossy);
    if (pl.subtitle) remapKey(pl.subtitle, 'color', 'text', glossy);
    if (pl.datalabels) remapKey(pl.datalabels, 'color', 'text', glossy);
    // Neutral near-white series (e.g. the dashed "Total" line) would vanish on white panels.
    var ds = (chart.config.data && chart.config.data.datasets) || [];
    ds.forEach(function (d) {
      ['borderColor', 'backgroundColor', 'pointBackgroundColor', 'pointBorderColor'].forEach(function (k) {
        remapKey(d, k, 'series', glossy);
      });
    });
  }

  var chartDefaultsOriginal = null;
  function applyChartDefaults(glossy) {
    if (!window.Chart || !Chart.defaults) return;
    if (!chartDefaultsOriginal) chartDefaultsOriginal = { color: Chart.defaults.color, borderColor: Chart.defaults.borderColor };
    Chart.defaults.color = glossy ? '#3d4653' : chartDefaultsOriginal.color;
    Chart.defaults.borderColor = glossy ? 'rgba(22,28,38,0.10)' : chartDefaultsOriginal.borderColor;
  }

  var pluginRegistered = false;
  function registerChartPlugin() {
    if (pluginRegistered || !window.Chart || !Chart.register) return;
    pluginRegistered = true;
    Chart.register({
      id: 'susThemeSkin',
      beforeUpdate: function (chart) { remapChart(chart, isGlossy()); }
    });
  }

  function refreshCharts() {
    if (!window.Chart) return;
    registerChartPlugin();
    applyChartDefaults(isGlossy());
    var inst = Chart.instances || {};
    Object.keys(inst).forEach(function (k) {
      var c = inst[k];
      if (!c) return;
      try { remapChart(c, isGlossy()); c.update('none'); } catch (e) {}
    });
  }

  /* ---------- Leaflet: swap CARTO dark basemap for the light version ---------- */
  var tileLayers = [];
  function patchLeaflet() {
    if (!window.L || !L.TileLayer || L.TileLayer.__susSkinPatched) return;
    L.TileLayer.__susSkinPatched = true;
    var origInit = L.TileLayer.prototype.initialize;
    L.TileLayer.prototype.initialize = function () {
      origInit.apply(this, arguments);
      if (typeof this._url === 'string' && /basemaps\.cartocdn\.com\/dark_all/.test(this._url)) {
        this._susDarkUrl = this._url;
        tileLayers.push(this);
        if (isGlossy()) this._url = this._susDarkUrl.replace('dark_all', 'light_all');
      }
    };
  }
  function refreshTiles() {
    tileLayers.forEach(function (layer) {
      var want = isGlossy() ? layer._susDarkUrl.replace('dark_all', 'light_all') : layer._susDarkUrl;
      if (layer._url !== want) { try { layer.setUrl(want); } catch (e) {} }
    });
  }
  patchLeaflet();

  /* ---------- Apply + selector ---------- */
  function apply(value) {
    var glossy = value === GLOSSY;
    if (glossy) root.setAttribute('data-skin', GLOSSY); else root.removeAttribute('data-skin');
    try { localStorage.setItem(KEY, glossy ? GLOSSY : 'original'); } catch (e) {}
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', glossy ? '#0b0c0e' : '#0f1117');
    refreshCharts();
    refreshTiles();
    window.dispatchEvent(new Event('resize'));
  }

  function mount() {
    var host = document.querySelector('.header-right');
    if (!host || document.getElementById('susThemeSelect')) return;
    var wrap = document.createElement('label');
    wrap.className = 'sus-theme-select';
    wrap.title = 'Dashboard colour scheme';
    var icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'palette');
    var sel = document.createElement('select');
    sel.id = 'susThemeSelect';
    sel.setAttribute('aria-label', 'Dashboard colour scheme');
    OPTIONS.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.value = isGlossy() ? GLOSSY : 'original';
    sel.addEventListener('change', function () { apply(sel.value); });
    wrap.appendChild(icon);
    wrap.appendChild(sel);
    host.insertBefore(wrap, host.firstChild);
    if (window.lucide && lucide.createIcons) { try { lucide.createIcons(); } catch (e) {} }
  }

  function init() { mount(); refreshCharts(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.addEventListener('load', refreshCharts);

  window.SUSTheme = { set: apply, get: function () { return isGlossy() ? GLOSSY : 'original'; } };
})();
