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
  tick(2800);
  const swept = e.sweep();
  ok(swept.some((r) => r.event_type === 'sensor_stale'),
    'sensor_stale still fires under shipped defaults');
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
