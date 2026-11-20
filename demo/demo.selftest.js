/* Self-test for demo mode. Run: node demo/demo.selftest.js
   Checks the properties the demo is sold on, without starting the server. */
'use strict';

process.env.DEMO_MODE = 'true';
const assert = require('assert');
const path = require('path');
const demo = require('./index');
const I = demo._internal;

const stops = require(path.join(__dirname, '..', 'data', 'stops.json'));
for (const [key, r] of Object.entries(stops.routes)) {
  I.STOPS[key] = r.stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng }));
  I.LOOP_MIN[key] = r.loop_minutes;
}
I.setTz('America/Chicago');
I.setEpoch('2025-11-01');

const CAP = 16;
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

ok('alightings are ~99% of boardings over 60 service days', () => {
  let b = 0, a = 0;
  for (let i = 0; i < 60; i++) {
    const d = I.addDays('2026-09-01', i);
    for (const bus of ['515', '419']) {
      const p = I.planDay(bus, d, CAP);
      p.visits.forEach((v) => { b += v.countedIn; a += v.countedOut; });
    }
  }
  const ratio = a / b;
  console.log(`      boardings ${b}, alightings ${a}, ratio ${(ratio * 100).toFixed(2)}%`);
  assert(ratio > 0.985 && ratio < 0.996, `ratio ${ratio}`);
});

ok('every full day lands between 97.5% and 100%', () => {
  for (let i = 0; i < 30; i++) {
    const d = I.addDays('2026-10-01', i);
    let b = 0, a = 0;
    for (const bus of ['515', '419']) I.planDay(bus, d, CAP).visits.forEach((v) => { b += v.countedIn; a += v.countedOut; });
    if (!b) continue;
    assert(a / b >= 0.975 && a / b <= 1, `${d}: ${a}/${b}`);
  }
});

ok('true onboard never exceeds capacity and ends the day empty', () => {
  for (let i = 0; i < 20; i++) {
    const d = I.addDays('2026-08-01', i);
    for (const bus of ['515', '419']) {
      const p = I.planDay(bus, d, CAP);
      p.visits.forEach((v) => assert(v.onboard >= 0 && v.onboard <= CAP));
      if (p.visits.length) assert.strictEqual(p.visits[p.visits.length - 1].onboard, 0);
    }
  }
});

ok('plans are deterministic', () => {
  const a = JSON.stringify(I.planDay('515', '2026-06-10', CAP).visits.slice(0, 5));
  const b = JSON.stringify(I.planDay('515', '2026-06-10', CAP).visits.slice(0, 5));
  assert.strictEqual(a, b);
});

ok('welfare incidents cover falls, loud noise, altercations and more', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) I.welfareDay(I.addDays('2026-07-01', i), CAP).forEach((x) => seen.add(x.row.event_type));
  ['fall', 'sound_classification', 'violence', 'violence_disruption', 'overcrowding',
    'dwell_distress_unresponsive', 'dwell_no_alighting', 'stationary_with_occupants', 'lone_traveller']
    .forEach((t) => assert(seen.has(t), `missing ${t}`));
});

ok('local time conversion respects DST', () => {
  // 08:00 Central in July is 13:00Z (CDT), in January 14:00Z (CST)
  assert.strictEqual(new Date(I.localToUtcMs('2026-07-15', 8 * 60)).toISOString().slice(11, 16), '13:00');
  assert.strictEqual(new Date(I.localToUtcMs('2026-01-15', 8 * 60)).toISOString().slice(11, 16), '14:00');
});

console.log(`demo self-test: ${pass} passed`);
