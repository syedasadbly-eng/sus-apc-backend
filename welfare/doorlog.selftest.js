/* Per-door logging selftest. Runs against a throwaway in-memory database.
   Run with: FEATURE_WELFARE=true node welfare/doorlog.selftest.js          */

'use strict';

process.env.FEATURE_WELFARE = 'true';
delete process.env.WELFARE_DOORLOG;

const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); }
};

const doorlog = require('./doorlog');

// ---------------------------------------------------------------------------
console.log('\n1. Topic parsing');
// ---------------------------------------------------------------------------
ok(doorlog.doorFromTopic('bus/002/door1/telemetry') === 'door1', 'door1 extracted');
ok(doorlog.doorFromTopic('bus/001/door2/telemetry') === 'door2', 'door2 extracted');
ok(doorlog.doorFromTopic('bus/003/telemetry') === null, 'single-door topic yields null');
ok(doorlog.doorFromTopic(undefined) === null, 'undefined topic does not throw');
ok(doorlog.doorFromTopic(12345) === null, 'non-string topic does not throw');

// ---------------------------------------------------------------------------
console.log('\n2. Recording is a no-op before init');
// ---------------------------------------------------------------------------
let threw = false;
try { doorlog.recordDoor({ topic: 'bus/001/door1/x', busId: '515', deltaIn: 1, deltaOut: 0 }); } catch { threw = true; }
ok(!threw, 'recordDoor before init does not throw');
ok(doorlog.isEnabled() === false, 'reports disabled before init');

// ---------------------------------------------------------------------------
console.log('\n3. Init creates the table without touching existing ones');
// ---------------------------------------------------------------------------
const db = new Database(':memory:');
db.exec(`CREATE TABLE records (id INTEGER PRIMARY KEY, bus_id TEXT, evt_in INT, evt_out INT);
         INSERT INTO records (bus_id, evt_in, evt_out) VALUES ('515', 3, 1);`);
const before = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;

ok(doorlog.initDoorLog(db) === true, 'initDoorLog returns true when enabled');
ok(doorlog.isEnabled() === true, 'reports enabled after init');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
ok(tables.includes('door_counts'), 'door_counts table created');
ok(db.prepare('SELECT COUNT(*) AS n FROM records').get().n === before, 'records table untouched');

// ---------------------------------------------------------------------------
console.log('\n4. Deltas are attributed to the right door');
// ---------------------------------------------------------------------------
const at = new Date('2026-09-04T12:00:00.000Z');
// Door 1 behaves normally. Door 2 is inverted: it only ever counts boardings.
for (let i = 0; i < 10; i++) {
  doorlog.recordDoor({ topic: 'bus/001/door1/telemetry', busId: '515', deltaIn: 2, deltaOut: 2, msgType: 'trigger', at });
  doorlog.recordDoor({ topic: 'bus/002/door2/telemetry', busId: '515', deltaIn: 3, deltaOut: 0, msgType: 'trigger', at });
}
doorlog.recordDoor({ topic: 'bus/003/telemetry', busId: '419', deltaIn: 5, deltaOut: 6, msgType: 'trigger', at });

const s = doorlog.summary({});
const d1 = s.doors.find((d) => d.door === 'door1');
const d2 = s.doors.find((d) => d.door === 'door2');
const b419 = s.doors.find((d) => d.bus_id === '419');

ok(s.doors.length === 3, `three doors tracked, got ${s.doors.length}`);
ok(d1 && d1.evt_in === 20 && d1.evt_out === 20, `door1 totals 20/20, got ${d1?.evt_in}/${d1?.evt_out}`);
ok(d2 && d2.evt_in === 30 && d2.evt_out === 0, `door2 totals 30/0, got ${d2?.evt_in}/${d2?.evt_out}`);
ok(d1 && d1.in_out_ratio === 1, `door1 ratio 1.00, got ${d1?.in_out_ratio}`);
ok(d2 && d2.in_out_ratio === null, 'door2 ratio null when it never counts out');
ok(d2 && d2.one_directional === true, 'door2 flagged one_directional');
ok(d1 && d1.one_directional === false, 'door1 not flagged');
ok(b419 && b419.door === null, 'single-door bus recorded with door=null');
ok(d1 && d1.messages === 10, `door1 message count 10, got ${d1?.messages}`);

// ---------------------------------------------------------------------------
console.log('\n5. Per-bus roll-up matches the door detail');
// ---------------------------------------------------------------------------
const buses = doorlog.byBus({});
const bus515 = buses.find((b) => b.bus_id === '515');
ok(bus515 && bus515.evt_in === 50 && bus515.evt_out === 20,
  `bus 515 rolls up to 50/20, got ${bus515?.evt_in}/${bus515?.evt_out}`);
ok(bus515 && bus515.in_out_ratio === 2.5, `bus 515 ratio 2.50, got ${bus515?.in_out_ratio}`);
ok(bus515 && bus515.doors === 2, 'bus 515 has 2 doors');

// ---------------------------------------------------------------------------
console.log('\n6. Zero-delta messages are not recorded');
// ---------------------------------------------------------------------------
const rowsBefore = db.prepare('SELECT SUM(messages) AS n FROM door_counts').get().n;
doorlog.recordDoor({ topic: 'bus/001/door1/telemetry', busId: '515', deltaIn: 0, deltaOut: 0, msgType: 'periodic', at });
const rowsAfter = db.prepare('SELECT SUM(messages) AS n FROM door_counts').get().n;
ok(rowsBefore === rowsAfter, 'a zero-delta heartbeat adds nothing');

// ---------------------------------------------------------------------------
console.log('\n7. Hourly aggregation keeps growth bounded');
// ---------------------------------------------------------------------------
const distinct = db.prepare('SELECT COUNT(*) AS n FROM door_counts').get().n;
ok(distinct === 3, `21 messages collapsed into 3 hourly rows, got ${distinct}`);
const later = new Date('2026-09-04T13:00:00.000Z');
doorlog.recordDoor({ topic: 'bus/001/door1/telemetry', busId: '515', deltaIn: 1, deltaOut: 1, msgType: 'trigger', at: later });
ok(db.prepare('SELECT COUNT(*) AS n FROM door_counts').get().n === 4, 'a new hour opens a new row');

// ---------------------------------------------------------------------------
console.log('\n8. Faults are contained');
// ---------------------------------------------------------------------------
threw = false;
try { doorlog.recordDoor(null); } catch { threw = true; }
ok(!threw, 'null argument does not throw');
threw = false;
try { doorlog.recordDoor({ topic: 'bus/001/door1/x', busId: '515', deltaIn: 'abc', deltaOut: undefined }); } catch { threw = true; }
ok(!threw, 'non-numeric deltas do not throw');

// A closed database is the realistic runtime failure. It must be swallowed.
const db2 = new Database(':memory:');
doorlog.initDoorLog(db2);
db2.close();
threw = false;
try { doorlog.recordDoor({ topic: 'bus/001/door1/x', busId: '515', deltaIn: 1, deltaOut: 1 }); } catch { threw = true; }
ok(!threw, 'a closed database is swallowed, not thrown');

// ---------------------------------------------------------------------------
console.log('\n9. WELFARE_DOORLOG=false disables it');
// ---------------------------------------------------------------------------
{
  delete require.cache[require.resolve('./doorlog')];
  process.env.WELFARE_DOORLOG = 'false';
  const off = require('./doorlog');
  ok(off.ENABLED === false, 'module reports disabled');
  const db3 = new Database(':memory:');
  ok(off.initDoorLog(db3) === false, 'initDoorLog returns false');
  const t = db3.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  ok(t.length === 0, 'no table created when disabled');
  delete process.env.WELFARE_DOORLOG;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
