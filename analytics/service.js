/* ============================================
   SERVICE PERFORMANCE — load profile, crowding, time between buses

   Built only from what the counters already send: one record per door event,
   tagged with the stop it was matched to and the load left on board.

     GET /api/service-analytics?from=YYYY-MM-DD&to=YYYY-MM-DD[&bus_id=515]

   For each route in the stop registry:
     load      ons, offs and the average / highest load leaving every stop, in
               the order the bus drives them, plus the busiest point.
     crowding  how full each loop got (average peak load against capacity),
               loops that filled up, time spent 80%+ full, and a weekday x
               hour heatmap of how full buses left stops.
     gaps      time between buses at each stop against the timetable target,
               the wait a passenger turning up at random can expect, and how
               often the gap stayed within target + 5 min.
     loops     how long a full loop took, by hour.

   Records at the same stop from the same bus less than VISIT_GAP_MS apart are
   one stop visit (a sensor can send several door events per stop).
   ============================================ */

'use strict';

const VISIT_GAP_MS = 5 * 60 * 1000;
const BUSY_SHARE = 0.8;            // "busy" = 80% of capacity or more
const IN_SERVICE_MAX_MS = 30 * 60 * 1000; // longer than this between stops = not in service
const ON_TARGET_SLACK_MIN = 5;     // gap counts as on target up to target + 5 min
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function round(n, dp = 1) {
  if (n == null || !isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

/** Local hour (0-23) and weekday (0 = Mon) for a timestamp in the display zone. */
function makeLocalPartsFn(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const cache = new Map();
  return (ms) => {
    // Cache per 15 minutes: a zone offset never changes inside that.
    const k = Math.floor(ms / 900000);
    let v = cache.get(k);
    if (!v) {
      const parts = fmt.formatToParts(new Date(ms));
      const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;
      const wd = parts.find((p) => p.type === 'weekday').value;
      v = { hour, dow: Math.max(0, DOW.indexOf(wd.slice(0, 3))) };
      cache.set(k, v);
    }
    return v;
  };
}

/** Collapse raw records (one bus, time order) into stop visits. */
function toVisits(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const ts = Date.parse(r.timestamp);
    if (!isFinite(ts)) continue;
    if (cur && cur.stop === r.stop && ts - cur.lastTs <= VISIT_GAP_MS) {
      cur.ons += r.evt_in || 0;
      cur.offs += r.evt_out || 0;
      cur.load = r.onboard || 0;
      cur.lastTs = ts;
      continue;
    }
    cur = { bus: String(r.bus_id), stop: r.stop, ts, lastTs: ts, date: r.date, ons: r.evt_in || 0, offs: r.evt_out || 0, load: r.onboard || 0 };
    out.push(cur);
  }
  return out;
}

/**
 * Pure analysis for one route.
 * @param {object} route   { key, name, loop_minutes, headway_minutes?, buses_in_service?, bus_ids, stops:[{name}] }
 *                          loop_minutes      one bus's time round the loop
 *                          headway_minutes   published frequency at each stop (optional)
 *                          buses_in_service  buses running the route, sensors or not (optional)
 * @param {Array}  rows    records for this route, any order
 * @param {object} opts    { capacity, tz }
 */
function analyseRoute(route, rows, { capacity, tz }) {
  const cap = Math.max(1, Number(capacity) || 16);
  const local = makeLocalPartsFn(tz);
  const order = (route.stops || []).map((s) => s.name);
  const idxOf = new Map(order.map((n, i) => [n, i]));

  // Visits per bus, in time order.
  const byBus = new Map();
  rows.filter((r) => r.stop && r.stop !== '-' && idxOf.has(r.stop))
    .sort((a, b) => (String(a.bus_id).localeCompare(String(b.bus_id))) || (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
    .forEach((r) => {
      const k = String(r.bus_id);
      if (!byBus.has(k)) byBus.set(k, []);
      byBus.get(k).push(r);
    });
  const visitsByBus = new Map();
  for (const [bus, list] of byBus) visitsByBus.set(bus, toVisits(list));
  const allVisits = [...visitsByBus.values()].flat();
  const buses = [...visitsByBus.keys()].sort();

  // ---------------- load profile ----------------
  const stops = order.map((name) => ({ name, visits: 0, ons: 0, offs: 0, loadSum: 0, maxLoad: 0, busy: 0 }));
  for (const v of allVisits) {
    const s = stops[idxOf.get(v.stop)];
    s.visits += 1; s.ons += v.ons; s.offs += v.offs; s.loadSum += v.load;
    if (v.load > s.maxLoad) s.maxLoad = v.load;
    if (v.load >= BUSY_SHARE * cap) s.busy += 1;
  }
  const loadStops = stops.map((s) => ({
    name: s.name,
    visits: s.visits,
    ons: s.ons,
    offs: s.offs,
    avg_on: s.visits ? round(s.ons / s.visits, 2) : 0,
    avg_off: s.visits ? round(s.offs / s.visits, 2) : 0,
    avg_load: s.visits ? round(s.loadSum / s.visits, 2) : 0,
    max_load: s.maxLoad,
    busy_share: s.visits ? round((s.busy / s.visits) * 100, 0) : 0,
  }));
  let busiest = -1;
  loadStops.forEach((s, i) => { if (s.visits && (busiest < 0 || s.avg_load > loadStops[busiest].avg_load)) busiest = i; });

  // ---------------- crowding ----------------
  const firstStop = order[0];
  const loopMax = [];
  let busyMs = 0; let serviceMs = 0;
  const heatSum = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const heatN = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const heatMax = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const list of visitsByBus.values()) {
    let curMax = null;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const lp = local(v.ts);
      heatSum[lp.dow][lp.hour] += v.load; heatN[lp.dow][lp.hour] += 1;
      if (v.load > heatMax[lp.dow][lp.hour]) heatMax[lp.dow][lp.hour] = v.load;

      const nxt = list[i + 1];
      if (nxt) {
        const dt = nxt.ts - v.lastTs;
        if (dt > 0 && dt <= IN_SERVICE_MAX_MS) {
          serviceMs += dt;
          if (v.load >= BUSY_SHARE * cap) busyMs += dt;
        }
      }
      // A loop starts each time the bus leaves the first stop.
      const newDay = i > 0 && list[i - 1].date !== v.date;
      if (v.stop === firstStop || newDay) {
        if (curMax != null) loopMax.push(curMax);
        curMax = v.load;
      } else if (curMax != null) {
        curMax = Math.max(curMax, v.load);
      }
    }
    if (curMax != null) loopMax.push(curMax);
  }
  const heat = heatSum.map((row, d) => row.map((s, h) => (heatN[d][h] ? round((s / heatN[d][h] / cap) * 100, 0) : null)));
  const heatPeak = heatMax.map((row, d) => row.map((m, h) => (heatN[d][h] ? round((m / cap) * 100, 0) : null)));
  const hoursWithData = [];
  for (let h = 0; h < 24; h++) if (heatN.some((row) => row[h] > 0)) hoursWithData.push(h);
  const crowding = {
    capacity: cap,
    loops: loopMax.length,
    peak_load_factor: loopMax.length ? round((mean(loopMax) / cap) * 100, 0) : null,
    loops_full: loopMax.filter((m) => m >= cap).length,
    loops_busy: loopMax.filter((m) => m >= BUSY_SHARE * cap).length,
    busy_hours: round(busyMs / 3600000, 1),
    service_hours: round(serviceMs / 3600000, 1),
    busy_share: serviceMs ? round((busyMs / serviceMs) * 100, 0) : null,
    heat: { days: DOW, hours: hoursWithData, avg: heat, peak: heatPeak },
  };

  // ---------------- time between buses ----------------
  // Buses with sensors (the only ones whose gaps we can see) vs buses running
  // the route. When they differ, observed gaps are judged against the tracked
  // buses' own spacing (loop / tracked) and the published frequency is
  // reported separately.
  const nBuses = Math.max(1, (route.bus_ids && route.bus_ids.length) || buses.length || 1);
  const loopMin = Number(route.loop_minutes) || null;
  const headwayCfg = Number(route.headway_minutes) || null;
  const fleetCfg = Number(route.buses_in_service) || null;
  const inService = Math.max(nBuses, fleetCfg || (headwayCfg && loopMin ? Math.round(loopMin / headwayCfg) : nBuses));
  const headway = headwayCfg || (loopMin ? loopMin / inService : null);
  const target = loopMin ? loopMin / nBuses : headway;
  // Anything longer than this is a break in service, not a gap a passenger waits through.
  const breakMin = Math.max(90, target ? target * 3 : 0);
  const gapAll = [];
  const gapByHour = Array.from({ length: 24 }, () => []);
  const gapStops = order.map((name) => {
    const ts = allVisits.filter((v) => v.stop === name).map((v) => v.ts).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ts.length; i++) {
      const g = (ts[i] - ts[i - 1]) / 60000;
      if (g <= 0 || g > breakMin) continue;
      gaps.push(g);
      gapAll.push(g);
      gapByHour[local(ts[i]).hour].push(g);
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const sum = gaps.reduce((s, x) => s + x, 0);
    const sumSq = gaps.reduce((s, x) => s + x * x, 0);
    return {
      name,
      gaps: gaps.length,
      avg: round(mean(gaps), 1),
      median: round(pct(sorted, 50), 1),
      p90: round(pct(sorted, 90), 1),
      wait: sum ? round(sumSq / (2 * sum), 1) : null,
      on_target: target && gaps.length ? round((gaps.filter((g) => g <= target + ON_TARGET_SLACK_MIN).length / gaps.length) * 100, 0) : null,
    };
  });
  const sortedAll = [...gapAll].sort((a, b) => a - b);
  const sumAll = gapAll.reduce((s, x) => s + x, 0);
  const sumSqAll = gapAll.reduce((s, x) => s + x * x, 0);
  const gaps = {
    buses: nBuses,
    buses_in_service: inService,
    partial: inService > nBuses,
    headway: headway != null ? round(headway, 1) : null,
    // Wait if every bus on the route keeps to the published frequency.
    timetable_wait: headway != null ? round(headway / 2, 1) : null,
    target: target != null ? round(target, 1) : null,
    count: gapAll.length,
    avg: round(mean(gapAll), 1),
    median: round(pct(sortedAll, 50), 1),
    p90: round(pct(sortedAll, 90), 1),
    // Expected wait for someone who turns up at a random time: E[h^2] / 2E[h].
    // Equals half the gap when buses are perfectly even, and grows as they bunch.
    wait: sumAll ? round(sumSqAll / (2 * sumAll), 1) : null,
    on_target: target && gapAll.length ? round((gapAll.filter((g) => g <= target + ON_TARGET_SLACK_MIN).length / gapAll.length) * 100, 0) : null,
    bunched: nBuses > 1 && target ? gapAll.filter((g) => g < target * 0.25).length : null,
    by_stop: gapStops,
    by_hour: gapByHour.map((a) => round(mean(a), 1)),
  };

  // ---------------- loop time ----------------
  const loopTimes = [];
  const loopByHour = Array.from({ length: 24 }, () => []);
  for (const list of visitsByBus.values()) {
    const starts = list.filter((v) => v.stop === firstStop);
    for (let i = 1; i < starts.length; i++) {
      const m = (starts[i].ts - starts[i - 1].ts) / 60000;
      if (loopMin && (m < loopMin * 0.5 || m > loopMin * 3)) continue;
      if (!loopMin && m > 180) continue;
      loopTimes.push(m);
      loopByHour[local(starts[i - 1].ts).hour].push(m);
    }
  }
  const loopSorted = [...loopTimes].sort((a, b) => a - b);
  const loops = {
    scheduled: loopMin,
    count: loopTimes.length,
    avg: round(mean(loopTimes), 1),
    median: round(pct(loopSorted, 50), 1),
    p90: round(pct(loopSorted, 90), 1),
    by_hour: loopByHour.map((a) => round(mean(a), 1)),
  };

  return {
    route: String(route.key),
    name: route.name || `Route ${route.key}`,
    buses,
    visits: allVisits.length,
    load: { capacity: cap, stops: loadStops, busiest },
    crowding,
    gaps,
    loops,
  };
}

function createServiceRouter({ express, db, getRegistry, capacity, tz }) {
  const router = express.Router();
  const re = /^\d{4}-\d{2}-\d{2}$/;
  router.get('/service-analytics', (req, res) => {
    try {
      const to = re.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
      const from = re.test(req.query.from || '') ? req.query.from : to;
      const busFilter = req.query.bus_id ? String(req.query.bus_id) : null;
      const registry = getRegistry() || {};
      const stmt = db.prepare(`SELECT timestamp, date, bus_id, stop, evt_in, evt_out, onboard
        FROM records
        WHERE date BETWEEN @from AND @to AND stop != '-' AND msg_type != 'RESET'
          AND (route = @route OR bus_id IN (SELECT value FROM json_each(@buses)))
        ORDER BY bus_id, timestamp`);
      const routes = [];
      for (const [key, r] of Object.entries(registry.routes || {})) {
        const busIds = (r.bus_ids || []).map(String);
        if (busFilter && busFilter !== String(key) && !busIds.includes(busFilter)) continue;
        const rows = stmt.all({ from, to, route: String(key), buses: JSON.stringify(busIds) });
        routes.push(analyseRoute({ key, ...r }, rows, { capacity, tz }));
      }
      routes.sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }));
      res.json({ from, to, tz, capacity, routes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  return router;
}

module.exports = { analyseRoute, toVisits, createServiceRouter, _test: { makeLocalPartsFn, pct } };
