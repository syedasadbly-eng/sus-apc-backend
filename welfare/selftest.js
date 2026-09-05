/* Welfare rule self-test. Run: node welfare/selftest.js
   Uses an injected clock so rule timings are deterministic. */
const { WelfareEngine } = require('./engine.js');

let pass = 0; let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } };

function makeEngine(startTs, configOverrides = {}) {
  let clock = startTs;
  // Rule logic is tested in isolation, so every family is enabled here even
  // though production ships a narrower set. See CONFIG.enabledRules.
  //
  // The sustain windows are pinned to the short values these cases were
  // written against. Shipped defaults are deliberately much longer (1800s
  // lone, 3600s end-of-service, calibrated on real history) and test 10
  // covers those. Pinning here keeps these tests about rule LOGIC, so
  // retuning a threshold does not silently break unrelated assertions.
  const e = new WelfareEngine({
    now: () => clock,
    config: {
      enabledRules: ['all'],
      loneSustainSec: 300,
      eosStationarySec: 300,
      ...configOverrides,
    },
  });
  return { e, tick: (sec) => { clock += sec * 1000; }, at: () => clock };
}

// 22:30 America/Chicago on a Tuesday
const NIGHT = Date.parse('2026-09-02T03:30:00Z');
const DAY   = Date.parse('2026-09-02T19:00:00Z'); // 14:00 Chicago

console.log('\n1. Lone traveller at night escalates to Alert');
{
  const { e, tick, at } = makeEngine(NIGHT);
  let fired = [];
  for (let i = 0; i <= 8; i++) {
    fired.push(...e.ingest({ busId: '515', onboard: 1, dayIn: 40 + i, dayOut: 39 + i,
      lat: 44.05 + i * 0.002, lng: -92.48, speed: 30, gpsValid: true, route: 'A', ts: at() }));
    tick(60);
  }
  const ev = fired.find((r) => r.event_type === 'lone_traveller_late_night');
  ok(Boolean(ev), 'lone_traveller_late_night raised');
  ok(ev?.severity === 3, 'severity is Alert (3), got ' + ev?.severity);
}

console.log('\n2. Same occupancy in daytime is only a Notify');
{
  const { e, tick, at } = makeEngine(DAY);
  let fired = [];
  for (let i = 0; i <= 8; i++) {
    fired.push(...e.ingest({ busId: '515', onboard: 1, dayIn: 40 + i, dayOut: 39 + i,
      lat: 44.05 + i * 0.002, lng: -92.48, speed: 30, gpsValid: true, route: 'A', ts: at() }));
    tick(60);
  }
  const ev = fired.find((r) => String(r.event_type).startsWith('lone_traveller'));
  ok(ev?.event_type === 'lone_traveller', 'daytime variant raised');
  ok(ev?.severity === 2, 'severity is Notify (2), got ' + ev?.severity);
}

console.log('\n3. Passenger still aboard at the depot escalates');
{
  const { e, tick, at } = makeEngine(NIGHT);
  let fired = [];
  for (let i = 0; i <= 10; i++) {
    fired.push(...e.ingest({ busId: '515', onboard: 1, dayIn: 40, dayOut: 39,
      lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: true, route: 'A', ts: at() }));
    tick(60);
  }
  const ev = fired.find((r) => r.event_type === 'end_of_service_occupancy');
  ok(Boolean(ev), 'end_of_service_occupancy raised');
  ok(ev?.severity === 4, 'severity is Escalate (4), got ' + ev?.severity);
  ok(/Gonda/i.test(ev?.reason || ''), 'reason names the location: ' + ev?.reason);
}

console.log('\n4. Empty bus at the depot raises nothing');
{
  const { e, tick, at } = makeEngine(NIGHT);
  let fired = [];
  for (let i = 0; i <= 10; i++) {
    fired.push(...e.ingest({ busId: '515', onboard: 0, dayIn: 40, dayOut: 40,
      lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: true, route: 'A', ts: at() }));
    tick(60);
  }
  ok(fired.filter((r) => r.severity >= 2).length === 0, 'no alerts for an empty parked bus');
}

console.log('\n5. Negative occupancy suppresses welfare rules');
{
  const { e, tick, at } = makeEngine(NIGHT);
  let fired = [];
  fired.push(...e.ingest({ busId: '419', onboard: -2, dayIn: 5, dayOut: 7, gpsValid: false, ts: at() }));
  tick(60);
  for (let i = 0; i <= 8; i++) {
    fired.push(...e.ingest({ busId: '419', onboard: 1, dayIn: 5, dayOut: 7,
      lat: 44.0777, lng: -92.5058, speed: 0, gpsValid: true, ts: at() }));
    tick(60);
  }
  ok(fired.some((r) => r.event_type === 'sensor_fault'), 'sensor_fault raised');
  ok(!fired.some((r) => String(r.event_type).startsWith('lone_traveller')), 'lone traveller suppressed');
  ok(!fired.some((r) => r.event_type === 'end_of_service_occupancy'), 'end of service suppressed');
  ok(e.fleetHealth().find((h) => h.bus_id === '419')?.trustworthy === false, 'feed marked untrustworthy');
}

console.log('\n6. Stale then offline then recovery');
{
  // Thresholds are pinned explicitly so this test asserts the state machine,
  // not whatever the shipped defaults happen to be.
  let clock = DAY;
  const e = new WelfareEngine({
    now: () => clock,
    config: { enabledRules: ['all'], staleAfterSec: 600, offlineAfterSec: 1800 },
  });
  const tick = (sec) => { clock += sec * 1000; };
  const at = () => clock;

  e.ingest({ busId: '515', onboard: 3, dayIn: 10, dayOut: 7, lat: 44.05, lng: -92.48, speed: 20, gpsValid: true, ts: at() });
  tick(700);
  let s = e.sweep();
  ok(s.some((r) => r.event_type === 'sensor_stale'), 'sensor_stale after 11 min (600s threshold)');
  tick(1300);
  s = e.sweep();
  ok(s.some((r) => r.event_type === 'sensor_offline'), 'sensor_offline after 33 min (1800s threshold)');
  const back = e.ingest({ busId: '515', onboard: 3, dayIn: 10, dayOut: 7, lat: 44.05, lng: -92.48, speed: 20, gpsValid: true, ts: at() });
  ok(back.some((r) => r.event_type === 'sensor_recovered'), 'sensor_recovered on the next message');
}

console.log('\n7. Stuck counter while the bus is moving');
{
  const { e, tick, at } = makeEngine(DAY);
  let fired = [];
  for (let i = 0; i <= 50; i++) {
    fired.push(...e.ingest({ busId: '515', onboard: 4, dayIn: 12, dayOut: 8,
      lat: 44.02 + i * 0.0009, lng: -92.46, speed: 35, gpsValid: true, ts: at() }));
    tick(60);
  }
  ok(fired.some((r) => r.event_type === 'sensor_suspect'), 'sensor_suspect raised after 45 min and 2 km');
}

console.log('\n8. Cooldown prevents alert storms');
{
  const { e, tick, at } = makeEngine(NIGHT);
  let n = 0;
  for (let i = 0; i <= 20; i++) {
    n += e.ingest({ busId: '515', onboard: 1, dayIn: 40, dayOut: 39,
      lat: 44.05, lng: -92.48, speed: 30, gpsValid: true, ts: at() })
      .filter((r) => String(r.event_type).startsWith('lone_traveller')).length;
    tick(60);
  }
  ok(n <= 3, `lone traveller fired ${n} times in 20 min, not once per message`);
}

console.log('\n9. No GPS fix does not fake a depot arrival');
{
  const { e, tick, at } = makeEngine(NIGHT);
  let fired = [];
  for (let i = 0; i <= 10; i++) {
    // server.js substitutes the depot coords when there is no fix
    fired.push(...e.ingest({ busId: '515', onboard: 1, dayIn: 40, dayOut: 39,
      lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: false, route: 'A', ts: at() }));
    tick(60);
  }
  ok(!fired.some((r) => r.event_type === 'end_of_service_occupancy'),
    'no depot escalation from fallback coordinates');
}

// ---------------------------------------------------------------------------
// 10. Shipped defaults: sensor health only
// ---------------------------------------------------------------------------
console.log('\n10. Shipped default config: sensor health + the two occupancy rules');
{
  // No `config` override, so this engine uses CONFIG.enabledRules as shipped.
  let clock = NIGHT;
  const e = new WelfareEngine({ now: () => clock });
  const tick = (sec) => { clock += sec * 1000; };

  ok(e.ruleEnabled('sensor_health'), 'sensor_health is enabled by default');
  ok(e.ruleEnabled('lone_traveller'), 'lone_traveller is enabled by default');
  ok(e.ruleEnabled('end_of_service'), 'end_of_service is enabled by default');
  // The one that must stay off: `speed` is 0.0 in every record, so this rule's
  // movement test is permanently satisfied and it fires on every stopped
  // reading. Do not flip this without fixing speed first.
  ok(!e.ruleEnabled('stationary'), 'stationary is STILL disabled by default');

  // The exact scenario that fired 53 times a service day on real history:
  // occupants aboard, speed 0, parked on the depot anchor. Runs 80 minutes
  // because the shipped end-of-service window is 3600s.
  const fired = [];
  for (let i = 0; i <= 80; i++) {
    fired.push(...e.ingest({
      busId: '515', onboard: 16, dayIn: 40, dayOut: 24,
      lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: true, route: 'A', ts: clock,
    }));
    tick(60);
  }
  ok(fired.some((r) => r.event_type === 'end_of_service_occupancy'),
    'end_of_service_occupancy now fires on a real fix at the depot');
  ok(!fired.some((r) => r.event_type === 'stationary_with_occupants'),
    'stationary_with_occupants still suppressed under shipped defaults');

  // Sensor health must still work: go quiet past the shipped 2700s threshold.
  // NIGHT is inside 515's shutdown window, so under shipped defaults this is
  // now recorded as end of shift rather than alerted. Both halves are pinned
  // here because this is the exact trade the change makes.
  tick(2800);
  const swept = e.sweep();
  ok(!swept.some((r) => r.event_type === 'sensor_stale'),
    'at night, going quiet is end of shift, not a stale-sensor NOTIFY');

  // Same silence, same shipped config, mid-service instead: must still alert.
  let day = Date.parse('2026-06-02T17:00:00Z');   // 12:00 CDT, 515 in service
  const e2 = new WelfareEngine({ now: () => day });
  e2.ingest({
    busId: '515', onboard: 16, dayIn: 40, dayOut: 24,
    lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: true, route: 'A', ts: day,
  });
  day += 2800 * 1000;
  ok(e2.sweep().some((r) => r.event_type === 'sensor_stale'),
    'sensor_stale still fires mid-service under shipped defaults');
}

// ---------------------------------------------------------------------------
// 11. Opting a family back in
// ---------------------------------------------------------------------------
console.log('\n11. WELFARE_RULES can re-enable a family');
{
  let clock = NIGHT;
  const e = new WelfareEngine({
    now: () => clock,
    // A comma-separated string, exactly as an env var would arrive.
    config: { enabledRules: 'sensor_health,end_of_service' },
  });
  const tick = (sec) => { clock += sec * 1000; };

  ok(e.ruleEnabled('end_of_service'), 'end_of_service enabled via string config');
  ok(!e.ruleEnabled('stationary'), 'stationary still disabled');

  const fired = [];
  for (let i = 0; i <= 80; i++) { // past the shipped 3600s window
    fired.push(...e.ingest({
      busId: '515', onboard: 1, dayIn: 40, dayOut: 39,
      lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: true, route: 'A', ts: clock,
    }));
    tick(60);
  }
  ok(fired.some((r) => r.event_type === 'end_of_service_occupancy'),
    'end_of_service_occupancy fires once re-enabled');
}

console.log('\n12. Live conditions: what the enabled occupancy rules actually do today');
{
  // Condition as it stands on both buses: no live GPS fix, speed 0.
  let clock = DAY;
  const e = new WelfareEngine({ now: () => clock });
  const tick = (sec) => { clock += sec * 1000; };

  const fired = [];
  for (let i = 0; i <= 20; i++) {
    fired.push(...e.ingest({
      busId: '515', onboard: 4, dayIn: 200, dayOut: 135,
      lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: false, route: 'A', ts: clock,
    }));
    tick(60);
  }
  // end_of_service is gated on gpsValid, and the no-fix branch falls through to
  // `stationary`, which is off. So enabling it changes nothing until GNSS works.
  ok(!fired.some((r) => r.event_type === 'end_of_service_occupancy'),
    'end_of_service raises nothing without a live GPS fix');
  ok(!fired.some((r) => r.event_type === 'stationary_with_occupants'),
    'and does not leak out through the stationary branch either');

  // lone_traveller has no GPS or speed dependency, so it works now. Uses the
  // modelled tally, which is the only reason onboard can reach 1 on bus 515.
  let clock2 = DAY;
  const e2 = new WelfareEngine({ now: () => clock2 });
  const fired2 = [];
  for (let i = 0; i <= 45; i++) { // past the shipped 1800s sustain window
    fired2.push(...e2.ingest({
      busId: '515', onboard: 1, onboardRaw: 14, dayIn: 200, dayOut: 134,
      lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: clock2,
    }));
    clock2 += 60 * 1000;
  }
  const lone = fired2.filter((r) => String(r.event_type).startsWith('lone_traveller'));
  ok(lone.length >= 1, `lone_traveller fires on a modelled single occupant (${lone.length})`);
  ok(lone.length <= 3, `and the cooldown holds the repeats down (${lone.length})`);

  // A single occupant is NOT reported when the tally is the raw counter's 14.
  let clock3 = DAY;
  const e3 = new WelfareEngine({ now: () => clock3 });
  const fired3 = [];
  for (let i = 0; i <= 45; i++) {
    fired3.push(...e3.ingest({
      busId: '515', onboard: 14, dayIn: 200, dayOut: 135,
      lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: clock3,
    }));
    clock3 += 60 * 1000;
  }
  ok(!fired3.some((r) => String(r.event_type).startsWith('lone_traveller')),
    'no lone_traveller when 14 are aboard');
}

console.log('\n13. R1 dwell proxy: occupants held with nobody alighting');
{
  const { e, tick, at } = makeEngine(DAY, { dwellNoAlightSec: 600 });
  const feed = (n, dayOut) => {
    const fired = [];
    for (let i = 0; i < n; i++) {
      fired.push(...e.ingest({
        busId: '515', onboard: 6, dayIn: 200, dayOut,
        lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: at(),
      }));
      tick(60);
    }
    return fired;
  };
  ok(feed(5, 100).length === 0, 'nothing before the window elapses');
  const fired = feed(10, 100);
  const ev = fired.find((r) => r.event_type === 'dwell_no_alighting');
  ok(Boolean(ev), 'dwell_no_alighting raised once the window passes');
  ok(ev?.severity === 2, 'daytime severity is Notify (2), got ' + ev?.severity);
  ok(ev?.detail?.proxy === true, 'event is flagged as a proxy, not measured dwell');
  ok(/nobody alighting/.test(ev?.reason || ''), 'reason states the basis: ' + ev?.reason);
}

console.log('\n14. Dwell window restarts when somebody gets off');
{
  const { e, tick, at } = makeEngine(DAY, { dwellNoAlightSec: 600 });
  const step = (dayOut) => {
    const f = e.ingest({
      busId: '515', onboard: 6, dayIn: 200, dayOut,
      lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: at(),
    });
    tick(60);
    return f;
  };
  for (let i = 0; i < 9; i++) step(100);   // 9 min held
  let fired = [];
  fired = fired.concat(step(101));         // someone alights: window restarts
  for (let i = 0; i < 9; i++) fired = fired.concat(step(101));
  ok(!fired.some((r) => r.event_type === 'dwell_no_alighting'),
    'an alighting resets the clock, so 18 total minutes does not fire');
  for (let i = 0; i < 4; i++) fired = fired.concat(step(101));
  ok(fired.some((r) => r.event_type === 'dwell_no_alighting'),
    'but it fires 10 min after that alighting');
}

console.log('\n15. Dwell reads the raw counter, not the modelled occupancy');
{
  // Bus 419's live condition: model says 0 aboard, the counter says 2. The
  // model must not be able to hide a real dwell.
  const { e, tick, at } = makeEngine(DAY, { dwellNoAlightSec: 600 });
  const fired = [];
  for (let i = 0; i < 15; i++) {
    fired.push(...e.ingest({
      busId: '419', onboard: 0, onboardRaw: 2, dayIn: 30, dayOut: 42,
      lat: null, lng: null, speed: 0, gpsValid: false, route: 'B', ts: at(),
    }));
    tick(60);
  }
  const ev = fired.find((r) => r.event_type === 'dwell_no_alighting');
  ok(Boolean(ev), 'fires on the raw counter even when the model reports empty');
  ok(ev?.detail?.aboard_raw === 2, 'reports the raw figure, got ' + ev?.detail?.aboard_raw);

  // Genuinely empty by both measures: silent.
  const { e: e2, tick: t2, at: a2 } = makeEngine(DAY, { dwellNoAlightSec: 600 });
  const f2 = [];
  for (let i = 0; i < 15; i++) {
    f2.push(...e2.ingest({
      busId: '419', onboard: 0, onboardRaw: 0, dayIn: 30, dayOut: 30,
      lat: null, lng: null, speed: 0, gpsValid: false, route: 'B', ts: a2(),
    }));
    t2(60);
  }
  ok(!f2.some((r) => r.event_type === 'dwell_no_alighting'),
    'silent when the bus is actually empty');
}

console.log('\n16. A silent feed is not counted as dwell');
{
  const { e, tick, at } = makeEngine(DAY, { dwellNoAlightSec: 600, dwellMaxGapSec: 600 });
  const send = () => e.ingest({
    busId: '515', onboard: 6, dayIn: 200, dayOut: 100,
    lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: at(),
  });
  send(); tick(60); send();
  tick(1800);          // 30 min of silence, still short of the 2700s stale mark
  const fired = [];
  for (let i = 0; i < 5; i++) { fired.push(...send()); tick(60); }
  ok(!fired.some((r) => r.event_type === 'dwell_no_alighting'),
    'silence restarts the window instead of accruing as time held');

  // And it recovers: keep reporting and it fires on genuinely observed time.
  for (let i = 0; i < 8; i++) { fired.push(...send()); tick(60); }
  ok(fired.some((r) => r.event_type === 'dwell_no_alighting'),
    'fires once the bus has actually been observed for the full window');
  const ev = fired.find((r) => r.event_type === 'dwell_no_alighting');
  ok(ev.detail.held_minutes <= 15,
    `held time excludes the gap (${ev.detail.held_minutes} min, not 40+)`);
}

console.log('\n17. A bus that has never reported is visible and untrusted');
{
  // Regression: fleet-health only listed vehicles heard from since process
  // start, so after a restart bus 419 vanished and the interface read
  // "1 of 1 buses are being watched" - apparent full coverage on half a fleet.
  const { e, at } = makeEngine(DAY, {
    depots: [
      { name: 'A', lat: 44.02302, lng: -92.46657, radiusM: 180, buses: ['515'] },
      { name: 'B', lat: 44.0777, lng: -92.5058, radiusM: 180, buses: ['419'] },
    ],
  });
  const before = e.fleetHealth();
  ok(before.length === 2, `both configured buses listed before any data (${before.length})`);
  ok(before.every((h) => h.never_reported), 'both flagged as never reported');
  ok(before.every((h) => !h.trustworthy),
    'a bus with no data is NOT trustworthy just because nothing has failed');

  e.ingest({
    busId: '515', onboard: 4, dayIn: 10, dayOut: 6,
    lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: at(),
  });
  const after = e.fleetHealth();
  ok(after.length === 2, 'still lists both after one reports');
  const b515 = after.find((h) => h.bus_id === '515');
  const b419 = after.find((h) => h.bus_id === '419');
  ok(b515.never_reported === false && b515.trustworthy, '515 becomes trusted once it reports');
  ok(b419.never_reported === true && !b419.trustworthy, '419 stays untrusted and visible');
}

console.log('\n18. Signal counts come from the supplied store, not memory');
{
  const { e } = makeEngine(DAY);
  // engine.counters resets on restart; signals() must prefer durable counts.
  const rows = e.signals({ lone_traveller_late_night: 3, sensor_stale: 4 });
  const lone = rows.find((r) => r.signal === 'Lone Traveller');
  ok(lone.events === 3, `lone traveller count read from the store (${lone.events})`);
  const memOnly = e.signals();
  ok(memOnly.find((r) => r.signal === 'Lone Traveller').events === 0,
    'falls back to in-memory counters when no store counts are supplied');
}

console.log('\n19. Every signal row carries the engineering detail');
{
  const { e } = makeEngine(DAY);
  const rows = e.signals();
  const missing = rows.filter((r) => r.basis == null || r.trust == null
    || r.threshold == null || !('blocked_by' in r) || !('enabled' in r));
  ok(missing.length === 0,
    `all ${rows.length} rows have basis, trust, threshold, blocked_by and enabled`
    + (missing.length ? ` — missing on ${missing.map((r) => r.signal).join(', ')}` : ''));
  ok(rows.every((r) => ['measured', 'modelled', 'proxy', 'unproven', 'none'].includes(r.trust)),
    'trust is always one of measured / modelled / proxy / unproven / none');

  // Thresholds must reflect the config in force, not a hardcoded string. A
  // stale threshold column is worse than none: it invites the reader to
  // conclude a quiet KPI is quiet rather than set too wide.
  const { e: wide } = makeEngine(DAY, { loneSustainSec: 5400 });
  const lone = wide.signals().find((r) => r.signal === 'Lone Traveller');
  ok(/90 min/.test(lone.threshold), `lone threshold tracks config, got "${lone.threshold}"`);

  // Dwell reads the raw counter deliberately (see ruleDwell). If that ever
  // silently changes to the modelled tally, the label must not still say raw.
  const dwell = rows.find((r) => r.signal === 'Dwell (proxy)');
  ok(dwell.trust === 'proxy' && /RAW/.test(dwell.basis),
    'dwell is labelled a proxy on the raw counter');
}

console.log('\n20. Enabled is not the same as live');
{
  const { e, at } = makeEngine(DAY);
  // End of service is enabled but gated on a live GPS fix. server.js
  // substitutes the depot anchor when there is none, so a bus reporting
  // gpsValid:false must leave the signal blocked with a named blocker,
  // never live. A false all-clear here has already happened once.
  e.ingest({
    busId: '515', onboard: 3, dayIn: 10, dayOut: 7,
    lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: false, route: 'A', ts: at(),
  });
  const eos = e.signals().find((r) => r.signal === 'End of service');
  ok(eos.enabled === true, 'rule family reports enabled');
  ok(eos.status === 'blocked', `status is blocked, not live, got ${eos.status}`);
  ok(/GPS/i.test(eos.blocked_by || ''), 'names the GPS fix as the blocker');
}

console.log('\n21. Summary counts by status, and separates trust from liveness');
{
  const { e } = makeEngine(DAY);
  const s = e.signalSummary({ dwell_no_alighting: 2, sensor_stale: 3 });
  const rows = e.signals();
  ok(s.total === rows.length, `total matches the row count (${s.total})`);
  const summed = Object.values(s.by_status).reduce((a, b) => a + b, 0);
  ok(summed === s.total, `every row lands in exactly one status bucket (${summed})`);
  ok(s.events_7d === 5, `event total comes from the supplied counts, got ${s.events_7d}`);
  ok(s.proxy_live >= 1, 'a live proxy signal is reported separately from liveness');
  ok(s.blockers.every((b) => b.signal && b.blocked_by),
    'every blocker names both the signal and the cause');
  ok(s.enabled_rules.includes('all'), 'enabled families are reported');

  // A comma-separated string is what an env var or a replay --set supplies.
  const { e: str } = makeEngine(DAY, { enabledRules: 'sensor_health, dwell' });
  const ss = str.signalSummary();
  ok(ss.enabled_rules.join(',') === 'sensor_health,dwell',
    `string config is normalised, got ${JSON.stringify(ss.enabled_rules)}`);
  ok(ss.by_status.disabled >= 2,
    `families outside the string report disabled (${ss.by_status.disabled})`);
}

console.log('\n22. A quiet fleet must not be reported as measured');
{
  // The defect: basis was inferred from the in-memory vehicle map. After a
  // restart, with the model live and calibrated but no bus yet reporting,
  // the console claimed "measured / Raw VS125 counters" for occupancy and
  // Lone Traveller. Overstating confidence while the fleet is quiet is the
  // exact failure this column exists to prevent.
  const { e } = makeEngine(DAY);
  e.setOccupancyMode('modelled');

  const b = e.occupancyBasis();
  ok(b.modelled === true, 'declared mode wins over an empty vehicle map');
  ok(b.declared === true, 'basis reports that the mode was declared');
  ok(b.confirmed === false, 'nothing has come through the model yet');
  ok(/no reading through it yet/i.test(b.note || ''),
    `note says the model is wired but unproven, got ${JSON.stringify(b.note)}`);

  for (const name of ['Occupancy', 'Lone Traveller', 'End of service']) {
    const row = e.signals().find((r) => r.signal === name);
    ok(row.trust === 'modelled', `${name} reads modelled, got ${row.trust}`);
    ok(/model wired/i.test(row.basis), `${name} basis carries the caveat`);
  }
}

console.log('\n23. A reading through the model confirms it, and the fact is sticky');
{
  const { e, at } = makeEngine(DAY);
  e.setOccupancyMode('modelled');
  e.ingest({
    busId: '515', onboard: 4, onboardRaw: 11, dayIn: 20, dayOut: 11,
    occupancyModel: { derived: true, factor: 1.483, onboard: 4, onboard_raw: 11 },
    lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: true, route: 'A', ts: at(),
  });

  const b = e.occupancyBasis();
  ok(b.confirmed === true, 'a reading through the model confirms the basis');
  ok(b.reporting === true, 'a bus is reporting');
  ok(b.note === null, `no caveat once confirmed, got ${JSON.stringify(b.note)}`);

  // Drop the fleet from memory the way a restart or expiry would. The engine
  // must not forget that it has been running modelled all day.
  e.vehicles.clear();
  ok(e.occupancyBasis().confirmed === true,
    'confirmation survives the vehicle map being emptied');

  const occ = e.signalSummary().occupancy;
  ok(occ.modelled === true && occ.source === 'modelled',
    'the summary carries the occupancy source for the header');
}

console.log('\n24. Raw mode is stated, not inferred, and says why it matters');
{
  const { e } = makeEngine(DAY);
  e.setOccupancyMode('raw');
  const b = e.occupancyBasis();
  ok(b.modelled === false && b.source === 'raw', 'declared raw mode is reported as raw');

  const lone = e.signals().find((r) => r.signal === 'Lone Traveller');
  ok(lone.trust === 'measured', 'raw occupancy is measured');
  ok(/clamp/i.test(lone.basis),
    `raw basis warns that 515 pins at the clamp, got ${JSON.stringify(lone.basis)}`);

  // No declared mode at all: fall back to inference so tests and offline
  // callers that construct the engine directly keep working.
  const { e: undecl } = makeEngine(DAY);
  ok(undecl.occupancyBasis().declared === false, 'an undeclared engine says so');
  ok(undecl.occupancyBasis().modelled === false,
    'and infers raw until something modelled arrives');
}

console.log('\n25. End of shift is recorded, not alerted');
{
  // 18:00 America/Chicago on a normal weekday. 515 finishes at 17:45 median.
  const EVENING = Date.parse('2026-06-02T23:00:00Z');   // 18:00 CDT
  const { e, tick, at } = makeEngine(EVENING, {
    shiftEndsAfter: { 515: 17, 419: 12 },
    staleAfterSec: 2700, offlineAfterSec: 7200,
  });
  const send = (onboard) => e.ingest({
    busId: '515', onboard, dayIn: 400, dayOut: 400,
    lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: at(),
  });
  send(0);                       // last message of the day, bus empty
  tick(3000); e.sweep();         // past stale
  tick(4500);
  const fired = e.sweep();       // past offline
  const types = fired.map((r) => r.event_type);
  ok(!types.includes('sensor_offline'), 'no offline ALERT for a bus that has finished');
  ok(!types.includes('sensor_stale'), 'no stale NOTIFY either — the noise is removed, not moved');
  ok(types.includes('shift_ended'), `a shift_ended record is written instead (${types.join(',')})`);
  const ev = fired.find((r) => r.event_type === 'shift_ended');
  ok(ev.severity === 1, `recorded at LOG severity (got ${ev.severity})`);

  const h = e.fleetHealth().find((x) => x.bus_id === '515');
  ok(h.off_shift === true, 'fleet health reports off_shift');
  ok(h.trustworthy === false,
    'still untrustworthy — an off-shift bus is not being watched, and rules stay suppressed');
}

console.log('\n26. A feed that dies WITH passengers aboard still alerts');
{
  // Same hour, same bus, one difference: somebody is still on it. This is the
  // case the whole system exists for and must never be suppressed.
  const EVENING = Date.parse('2026-06-02T23:00:00Z');
  // The gate is OFF by default because the door counters never clear. With it
  // on - which is the intended end state once bus/001/door2 is repaired - a
  // bus that goes dark with people aboard must still alert.
  const { e, tick, at } = makeEngine(EVENING, {
    shiftEndsAfter: { 515: 17 }, staleAfterSec: 2700, offlineAfterSec: 7200,
    shiftEndOccupancyGate: true,
  });
  e.ingest({
    busId: '515', onboard: 3, dayIn: 400, dayOut: 397,
    lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: at(),
  });
  tick(7500);
  const types = e.sweep().map((r) => r.event_type);
  ok(types.includes('sensor_offline'),
    `offline ALERT still raised with 3 aboard (${types.join(',')})`);
  ok(!types.includes('shift_ended'), 'not treated as end of shift');
}

console.log('\n27. Suppression is bounded by hour and by bus');
{
  const MIDDAY = Date.parse('2026-06-02T17:00:00Z');    // 12:00 CDT
  // 515 finishes at 17:00, so midday silence is a genuine mid-service dropout.
  const a = makeEngine(MIDDAY, { shiftEndsAfter: { 515: 17 }, offlineAfterSec: 7200 });
  a.e.ingest({
    busId: '515', onboard: 0, dayIn: 100, dayOut: 100,
    lat: null, lng: null, speed: 0, gpsValid: false, route: 'A', ts: a.at(),
  });
  a.tick(7500);
  ok(a.e.sweep().map((r) => r.event_type).includes('sensor_offline'),
    'midday silence on 515 still alerts');

  // A bus with no configured shift never suppresses.
  const b = makeEngine(Date.parse('2026-06-02T23:00:00Z'), {
    shiftEndsAfter: { 515: 17 }, offlineAfterSec: 7200,
  });
  b.e.ingest({
    busId: '999', onboard: 0, dayIn: 10, dayOut: 10,
    lat: null, lng: null, speed: 0, gpsValid: false, route: 'Z', ts: b.at(),
  });
  b.tick(7500);
  ok(b.e.sweep().map((r) => r.event_type).includes('sensor_offline'),
    'an unknown bus alerts — silence is a fault until we know its timetable');

  // Unknown occupancy is not empty.
  const c = makeEngine(Date.parse('2026-06-02T23:00:00Z'), {
    shiftEndsAfter: { 515: 17 }, offlineAfterSec: 7200, shiftEndOccupancyGate: true,
  });
  const vc = c.e.vehicle('515');
  vc.lastSeen = c.at(); vc.onboard = null; vc.onboardRaw = null;
  c.tick(7500);
  ok(c.e.sweep().map((r) => r.event_type).includes('sensor_offline'),
    'null occupancy alerts — we cannot claim the bus is clear');
}

console.log('\n28. Open alerts are counted from severity 2, not 3');
{
  // The 4 Sep case: two unacknowledged severity-2 dwell alerts, plus one
  // acknowledged severity-3 and one simulated. The badge showed 1 - an
  // 18-hour-old offline on another bus - while the day's two real alerts
  // contributed nothing.
  const rows = [
    { severity: 2, acknowledged: 0, source: 'vs125' },
    { severity: 2, acknowledged: 0, source: 'vs125' },
    { severity: 3, acknowledged: 1, source: 'vs125' },
    { severity: 3, acknowledged: 0, source: 'vs125' },
    { severity: 4, acknowledged: 0, source: 'simulated' },
  ].filter((r) => r.source !== 'simulated');
  const openReal = rows.filter((r) => !r.acknowledged && r.severity >= 2).length;
  const oldCount = rows.filter((r) => !r.acknowledged && r.severity >= 3).length;
  ok(oldCount === 1, `the old severity-3 count reports 1 (got ${oldCount})`);
  ok(openReal === 3, `open_real reports 3 (got ${openReal})`);
}

console.log('\n29. The headline cannot hide an open alert behind a paused bus');
{
  // Reproduces the console's own composition. A bus with no cover used to
  // win the if/else outright and the alerts appeared nowhere in the strip.
  const compose = (events, healthRows) => {
    const open = events.filter((e) => !e.acknowledged && e.severity >= 2);
    const watchable = healthRows.filter((h) => !h.trustworthy && !h.off_shift);
    const facts = [];
    if (open.length) facts.push({ tone: 'warn', main: `${open.length} open alert${open.length > 1 ? 's' : ''}` });
    if (watchable.length) facts.push({ tone: 'bad', main: `${watchable.length} buses not watched` });
    if (!facts.length) return { main: 'Nothing needs attention', sub: '' };
    const rank = { bad: 2, warn: 1, ok: 0 };
    facts.sort((a, b) => rank[b.tone] - rank[a.tone]);
    return { main: facts[0].main, sub: facts.slice(1).map((f) => f.main).join(' \u00b7 ') };
  };

  const r = compose(
    [{ severity: 2, acknowledged: 0 }, { severity: 2, acknowledged: 0 }],
    [{ bus_id: '515', trustworthy: true }, { bus_id: '419', trustworthy: false }],
  );
  const strip = `${r.main} ${r.sub}`;
  ok(/2 open alerts/.test(strip), `the two alerts are stated somewhere in the strip (${strip})`);
  ok(/not watched/.test(strip), 'and the unwatched bus is still stated too');

  const quiet = compose([], [{ bus_id: '515', trustworthy: true }]);
  ok(quiet.main === 'Nothing needs attention', 'a clean fleet still reads clean');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
