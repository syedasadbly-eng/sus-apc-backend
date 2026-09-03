/* Derived occupancy selftest.
   Run with: FEATURE_WELFARE=true node welfare/occupancy.selftest.js  */

'use strict';

process.env.FEATURE_WELFARE = 'true';
delete process.env.WELFARE_DERIVED_OCCUPANCY;

const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

const occ = require('./occupancy');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE records (
    id INTEGER PRIMARY KEY, date TEXT, bus_id TEXT, evt_in INT, evt_out INT);`);
  return db;
}

// ---------------------------------------------------------------------------
console.log('\n1. Seeded factors carry a fresh database');
// ---------------------------------------------------------------------------
{
  const db = freshDb();
  ok(occ.initOccupancy(db, { capacity: 16, today: '2026-09-03' }) === true, 'init returns true');
  ok(occ.factorFor('515') === 1.483, `bus 515 seeded to 1.483, got ${occ.factorFor('515')}`);
  ok(occ.factorFor('419') === 0.875, `bus 419 seeded to 0.875, got ${occ.factorFor('419')}`);
  ok(occ.factorFor('999') === 1, 'an unknown bus falls back to 1 (no adjustment)');
}

// ---------------------------------------------------------------------------
console.log('\n2. The model unpins bus 515 from the capacity clamp');
// ---------------------------------------------------------------------------
{
  // Real figures from today: 196 boardings, 122 alightings.
  const m = occ.derive({ busId: '515', dayIn: 196, dayOut: 122, onboardRaw: 16 });
  ok(m.derived === true, 'reading is marked as modelled');
  ok(m.onboard_raw === 16, 'measured counter preserved at 16');
  ok(m.unmatched_raw === 74, `raw unmatched is 74, got ${m.unmatched_raw}`);
  ok(m.onboard === 15, `modelled onboard 15 (196 - 122*1.483 = 15.1), got ${m.onboard}`);
  ok(m.clamped_at_capacity === false, 'no longer pinned at the clamp');
  console.log(`         raw 16 (pinned)  ->  modelled ${m.onboard}, residual ${m.residual}`);
}

// ---------------------------------------------------------------------------
console.log('\n3. A balanced day lands near zero');
// ---------------------------------------------------------------------------
{
  // If the sensor under-reports by exactly the seeded factor, the day closes out.
  const dayIn = 300;
  const dayOut = Math.round(dayIn / 1.483); // 202
  const m = occ.derive({ busId: '515', dayIn, dayOut, onboardRaw: 16 });
  ok(Math.abs(m.residual) <= 1, `residual within 1 of zero, got ${m.residual}`);
  ok(m.onboard === 0, `modelled onboard returns to 0, got ${m.onboard}`);
}

// ---------------------------------------------------------------------------
console.log('\n4. Bounds hold');
// ---------------------------------------------------------------------------
{
  const over = occ.derive({ busId: '419', dayIn: 6, dayOut: 15, onboardRaw: 0 });
  ok(over.onboard === 0, `never negative, got ${over.onboard}`);
  ok(over.clamped_at_zero === true, 'flags that the model went negative');

  const under = occ.derive({ busId: '515', dayIn: 500, dayOut: 0, onboardRaw: 16 });
  ok(under.onboard === 16, 'still clamps at capacity when nobody alights');
  ok(under.clamped_at_capacity === true, 'flags the capacity clamp');

  const f = occ._internals.clampFactor;
  ok(f(99) === 4, 'absurd factor clamped to 4.0');
  ok(f(0.01) === 0.5, 'absurd factor clamped to 0.5');
  ok(f(0) === null && f(-2) === null && f(NaN) === null, 'zero, negative and NaN rejected');
}

// ---------------------------------------------------------------------------
console.log('\n5. Live history overrides the seed once there is enough of it');
// ---------------------------------------------------------------------------
{
  const db = freshDb();
  const ins = db.prepare('INSERT INTO records (date, bus_id, evt_in, evt_out) VALUES (?,?,?,?)');
  // 10 prior days, 2:1 in/out on bus 515. Well past the 200-alighting minimum.
  for (let d = 1; d <= 10; d++) {
    ins.run(`2026-08-${String(20 + d).padStart(2, '0')}`, '515', 100, 50);
  }
  occ.initOccupancy(db, { capacity: 16, today: '2026-09-03' });
  const st = occ.state();
  ok(st.factors['515'].source === 'live_history', 'bus 515 now calibrated from live history');
  ok(occ.factorFor('515') === 2, `factor is 2.0, got ${occ.factorFor('515')}`);
  ok(st.factors['419'].source === 'seed_68d_history', 'bus 419 still seeded — too little data');
}

// ---------------------------------------------------------------------------
console.log('\n6. Thin samples are ignored');
// ---------------------------------------------------------------------------
{
  const db = freshDb();
  db.prepare('INSERT INTO records (date, bus_id, evt_in, evt_out) VALUES (?,?,?,?)')
    .run('2026-09-01', '515', 400, 10); // only 10 alightings — ratio 40, noise
  occ.initOccupancy(db, { capacity: 16, today: '2026-09-03' });
  ok(occ.state().factors['515'].source === 'seed_68d_history',
    'a 10-alighting sample does not move the factor');
}

// ---------------------------------------------------------------------------
console.log('\n7. Today is excluded from calibration');
// ---------------------------------------------------------------------------
{
  const db = freshDb();
  const ins = db.prepare('INSERT INTO records (date, bus_id, evt_in, evt_out) VALUES (?,?,?,?)');
  for (let d = 1; d <= 10; d++) ins.run(`2026-08-${String(20 + d).padStart(2, '0')}`, '515', 100, 50);
  ins.run('2026-09-03', '515', 9000, 30); // today, wildly skewed
  occ.initOccupancy(db, { capacity: 16, today: '2026-09-03' });
  ok(occ.factorFor('515') === 2, `today ignored, factor still 2.0, got ${occ.factorFor('515')}`);
  // Otherwise the model would be circular: dayIn - dayOut*(dayIn/dayOut) == 0 always.
}

// ---------------------------------------------------------------------------
console.log('\n8. Failure paths');
// ---------------------------------------------------------------------------
{
  const bad = occ.derive({ busId: '515', dayIn: undefined, dayOut: null, onboardRaw: 7 });
  ok(bad.derived === false && bad.onboard === 7, 'missing totals pass the raw count through');

  const db = freshDb();
  occ.initOccupancy(db, { capacity: 16, today: '2026-09-03' });
  const beforeF = occ.factorFor('515');
  db.close();
  let threw = false;
  try { occ.calibrate({ force: true }); } catch { threw = true; }
  ok(!threw, 'a closed database does not throw');
  ok(occ.factorFor('515') === beforeF, 'previous factors retained on failure');

  // A table without the expected columns is the other realistic break.
  const db2 = new Database(':memory:');
  db2.exec('CREATE TABLE records (id INTEGER PRIMARY KEY)');
  threw = false;
  try { occ.initOccupancy(db2, { capacity: 16, today: '2026-09-03' }); } catch { threw = true; }
  ok(!threw, 'a records table missing evt_in/evt_out does not throw');
  ok(occ.factorFor('515') === 1.483, 'falls back to the seed');
}

// ---------------------------------------------------------------------------
console.log('\n9. The kill switch works');
// ---------------------------------------------------------------------------
{
  delete require.cache[require.resolve('./occupancy')];
  process.env.WELFARE_DERIVED_OCCUPANCY = 'false';
  const off = require('./occupancy');
  ok(off.ENABLED === false, 'module disabled');
  ok(off.initOccupancy(freshDb(), { capacity: 16 }) === false, 'init returns false');
  const m = off.derive({ busId: '515', dayIn: 196, dayOut: 122, onboardRaw: 16 });
  ok(m.derived === false && m.onboard === 16, 'raw count passes through untouched');
  delete process.env.WELFARE_DERIVED_OCCUPANCY;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
