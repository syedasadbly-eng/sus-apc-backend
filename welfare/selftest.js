/* Welfare rule self-test. Run: node welfare/selftest.js
   Uses an injected clock so rule timings are deterministic. */
const { WelfareEngine } = require('./engine.js');

let pass = 0; let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } };

function makeEngine(startTs) {
  let clock = startTs;
  // Rule logic is tested in isolation, so every family is enabled here even
  // though production ships with sensor_health only. See CONFIG.enabledRules.
  const e = new WelfareEngine({ now: () => clock, config: { enabledRules: ['all'] } });
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
console.log('\n10. Shipped default config enables sensor health only');
{
  // No `config` override, so this engine uses CONFIG.enabledRules as shipped.
  let clock = NIGHT;
  const e = new WelfareEngine({ now: () => clock });
  const tick = (sec) => { clock += sec * 1000; };

  ok(e.ruleEnabled('sensor_health'), 'sensor_health is enabled by default');
  ok(!e.ruleEnabled('end_of_service'), 'end_of_service is disabled by default');
  ok(!e.ruleEnabled('stationary'), 'stationary is disabled by default');
  ok(!e.ruleEnabled('lone_traveller'), 'lone_traveller is disabled by default');

  // The exact scenario that fired 53 times a service day on real history:
  // occupants aboard, speed 0, parked on the depot anchor.
  const fired = [];
  for (let i = 0; i <= 20; i++) {
    fired.push(...e.ingest({
      busId: '515', onboard: 16, dayIn: 40, dayOut: 24,
      lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: true, route: 'A', ts: clock,
    }));
    tick(60);
  }
  ok(!fired.some((r) => r.event_type === 'end_of_service_occupancy'),
    'no end_of_service_occupancy under shipped defaults');
  ok(!fired.some((r) => r.event_type === 'stationary_with_occupants'),
    'no stationary_with_occupants under shipped defaults');

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
  for (let i = 0; i <= 10; i++) {
    fired.push(...e.ingest({
      busId: '515', onboard: 1, dayIn: 40, dayOut: 39,
      lat: 44.02302, lng: -92.46657, speed: 0, gpsValid: true, route: 'A', ts: clock,
    }));
    tick(60);
  }
  ok(fired.some((r) => r.event_type === 'end_of_service_occupancy'),
    'end_of_service_occupancy fires once re-enabled');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
