/* ============================================
   CAMERA INGEST SELF-TEST
   Smart Urban Sensing

   Exercises the real HTTP path — a live express server, real requests over a
   socket — rather than calling the handler directly. The failure modes that
   matter here are transport-shaped: a body parser rejecting a content type the
   camera actually sends, an auth header the camera actually forms, a non-2xx
   the camera would treat as a delivery failure. None of those are visible from
   a direct function call.

   Run: node welfare/camera.selftest.js
   ============================================ */

'use strict';

process.env.WELFARE_CAMERA_TOKEN = 'test-token';
process.env.WELFARE_CAMERA_COOLDOWN_SEC = '2';
process.env.WELFARE_CAMERA_BUS = 'lab-rig';
process.env.WELFARE_CAMERA_MAP = '{"127.0.0.1":"515"}';
process.env.WELFARE_CAMERA_COMPOUND_SEC = '60';

const express = require('express');
const camera = require('./camera');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Minimal in-memory stand-in for the SQLite store. */
function fakeStore() {
  const rows = [];
  return { rows, insert(row) { rows.push(row); } };
}

/** Minimal stand-in for the engine, including a vehicle with a live fix. */
function fakeEngine() {
  const vehicles = new Map();
  vehicles.set('515', {
    id: '515', route: 'Route 1', lat: 53.4808, lng: -2.2426,
    gpsValid: true, onboard: 3, health: 'healthy', occupancyModel: null,
  });
  return {
    vehicles,
    counters: {},
    recent: [],
    recentLimit: 200,
    emitted: [],
    emit(event, row) { this.emitted.push({ event, row }); },
  };
}

async function main() {
  const store = fakeStore();
  const engine = fakeEngine();

  const app = express();
  app.use('/api/welfare', camera.createCameraRouter(engine, store));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/welfare`;

  const call = async (path, opts = {}) => {
    const res = await fetch(`${base}${path}`, opts);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };

  console.log('\nCAMERA INGEST SELF-TEST\n');

  // --- auth -----------------------------------------------------------------
  console.log('Authentication');
  let r = await call('/camera/fall?bus=515');
  check('no token is refused', r.status === 401, `got ${r.status}`);

  r = await call('/camera/fall?bus=515&token=wrong');
  check('wrong token is refused', r.status === 401, `got ${r.status}`);

  // The camera's HTTP Notification User Name / Password fields produce Basic
  // auth, so the password half must be accepted as the token.
  const basic = Buffer.from('admin:test-token').toString('base64');
  r = await call('/camera/violence?bus=515', { headers: { authorization: `Basic ${basic}` } });
  check('Basic auth password is accepted as the token', r.status === 200 && r.body.accepted === true,
    JSON.stringify(r.body));

  // --- transport shapes -----------------------------------------------------
  console.log('\nTransport shapes the camera can produce');

  // GET with no body at all — the simplest camera configuration.
  r = await call('/camera/fall?bus=515&token=test-token');
  check('bare GET is accepted', r.status === 200 && r.body.accepted === true, JSON.stringify(r.body));
  check('event was stored', store.rows.some((x) => x.event_type === 'fall'), 'no fall row');

  await new Promise((res) => setTimeout(res, 2100)); // clear the 2s cooldown

  // POST with a body that is not valid JSON must still land. A 400 here would
  // be a silently lost detection in the field.
  r = await call('/camera/fall?bus=515&token=test-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });
  check('malformed JSON body still accepted', r.status === 200 && r.body.accepted === true,
    JSON.stringify(r.body));

  await new Promise((res) => setTimeout(res, 2100));

  r = await call('/camera/fall?bus=515&token=test-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'fall', device_name: 'AI Pro Dome', time: '2026-09-04T21:40:00' }),
  });
  check('JSON body accepted', r.status === 200 && r.body.accepted === true, JSON.stringify(r.body));
  const jsonRow = store.rows[store.rows.length - 1];
  check('payload preserved verbatim in detail',
    jsonRow.detail.payload && jsonRow.detail.payload.device_name === 'AI Pro Dome',
    JSON.stringify(jsonRow.detail.payload));

  // --- classification -------------------------------------------------------
  console.log('\nSignal classification');
  const fallRow = store.rows.find((x) => x.event_type === 'fall');
  const violenceRow = store.rows.find((x) => x.event_type === 'violence');
  check('fall maps to severity 3 / use case 2',
    fallRow.severity === 3 && fallRow.use_case === 2, `${fallRow.severity}/${fallRow.use_case}`);
  check('violence maps to severity 4 / use case 7',
    violenceRow.severity === 4 && violenceRow.use_case === 7,
    `${violenceRow.severity}/${violenceRow.use_case}`);
  check('source is camera, not vs125', fallRow.source === 'camera', fallRow.source);

  r = await call('/camera/nonsense?bus=515&token=test-token');
  check('unknown signal is 404, not a silent write', r.status === 404, `got ${r.status}`);
  check('unknown signal still captured for diagnosis',
    camera._internal.state.captures.some((x) => x.outcome === 'unknown_signal'));

  // --- vehicle context ------------------------------------------------------
  console.log('\nVehicle context');
  check('route carried from the counting feed', fallRow.route === 'Route 1', String(fallRow.route));
  check('position carried when the fix is valid',
    fallRow.lat === 53.4808 && fallRow.lng === -2.2426, `${fallRow.lat},${fallRow.lng}`);
  check('occupancy carried', fallRow.onboard === 3, String(fallRow.onboard));

  // A bus the counting feed has never reported must not be invented in the
  // fleet map just because a camera named it.
  await new Promise((res) => setTimeout(res, 2100));
  r = await call('/camera/fall?bus=999&token=test-token');
  check('unknown bus accepted', r.status === 200 && r.body.accepted === true, JSON.stringify(r.body));
  check('unknown bus not added to the vehicle map', !engine.vehicles.has('999'));

  // --- bus resolution -------------------------------------------------------
  console.log('\nBus resolution');
  await new Promise((res) => setTimeout(res, 2100));
  r = await call('/camera/violence?token=test-token'); // no bus= → IP map
  check('falls back to the IP map when bus is not given',
    r.body.bus_id === '515', String(r.body.bus_id));

  // --- cooldown -------------------------------------------------------------
  console.log('\nRepeat suppression');
  await new Promise((res) => setTimeout(res, 2100));
  const first = await call('/camera/fall?bus=515&token=test-token');
  const second = await call('/camera/fall?bus=515&token=test-token');
  check('first of a burst accepted', first.body.accepted === true);
  check('immediate repeat suppressed', second.body.accepted === false && second.body.reason === 'cooldown',
    JSON.stringify(second.body));
  check('suppressed repeat still returns 200 so the camera sees delivery success',
    second.status === 200, `got ${second.status}`);

  // A different signal on the same bus must not be caught by the fall cooldown.
  const other = await call('/camera/sound?bus=515&token=test-token');
  check('a different signal is not blocked by another signal cooldown',
    other.body.accepted === true, JSON.stringify(other.body));

  // --- compound rule --------------------------------------------------------
  // Violence and sound on one bus inside the window is the only camera claim
  // this console makes on its own evidence rather than on assigned severity,
  // so it is tested end to end rather than as a unit.
  console.log('\nCompound rule: violence corroborated by sound');

  const before = store.rows.length;
  await call('/camera/sound?bus=compound-rig&token=test-token');
  const pair = await call('/camera/violence?bus=compound-rig&token=test-token');
  const compoundRows = store.rows.slice(before).filter((x) => x.event_type === 'violence_disruption');

  check('violence after sound raises a compound event',
    compoundRows.length === 1, `${compoundRows.length} raised`);
  check('the compound event id is returned to the camera',
    typeof pair.body.compound_event_id === 'string', JSON.stringify(pair.body));
  check('compound event escalates',
    compoundRows[0]?.severity === 4 && compoundRows[0]?.severity_name === 'escalate');
  check('compound event is use case 7', compoundRows[0]?.use_case === 7);
  check('compound event names both detectors',
    JSON.stringify(compoundRows[0]?.detail?.corroborated_by ?? []) === '["violence","sound"]');
  check('compound event records the observed order',
    compoundRows[0]?.detail?.order === 'sound then violence', compoundRows[0]?.detail?.order);
  check('compound event points back at what triggered it',
    compoundRows[0]?.detail?.triggered_by_event === pair.body.event_id);

  // The originals must survive untouched: they are what the detectors actually
  // reported, and the false-alarm rate is measured from them.
  const originals = store.rows.slice(before).filter((x) => x.source === 'camera' && x.event_type !== 'violence_disruption');
  check('the two source events are still recorded separately',
    originals.length === 2 && originals.some((x) => x.event_type === 'violence')
      && originals.some((x) => x.event_type === 'sound_classification'),
    originals.map((x) => x.event_type).join(','));

  // A sustained fight re-fires both detectors. One incident, one compound row.
  const mid = store.rows.length;
  await new Promise((res) => setTimeout(res, 2100));
  await call('/camera/sound?bus=compound-rig&token=test-token');
  await call('/camera/violence?bus=compound-rig&token=test-token');
  check('a second pair inside the window does not raise a second compound event',
    store.rows.slice(mid).filter((x) => x.event_type === 'violence_disruption').length === 0);

  // Fall is deliberately not corroborated by sound: a fall is already an Alert
  // and a nearby noise says nothing useful about it.
  const fallMark = store.rows.length;
  await call('/camera/sound?bus=fall-rig&token=test-token');
  await call('/camera/fall?bus=fall-rig&token=test-token');
  check('fall plus sound does not compound',
    store.rows.slice(fallMark).filter((x) => x.event_type === 'violence_disruption').length === 0);

  // Unit-level, because proving expiry over HTTP would mean sleeping out the
  // whole window in a test that already runs long.
  const st = camera._internal.state;
  st.lastAlertTs['expiry-rig:sound'] = Date.now() - (camera.COMPOUND_SEC + 5) * 1000;
  check('a sound outside the window does not corroborate',
    camera._internal.compoundEvent('violence', 'expiry-rig', Date.now(), { event_id: 'x' }, {}) === null);

  check('a signal with no partner never compounds',
    camera._internal.compoundEvent('fall', 'nobody-rig', Date.now(), { event_id: 'x' }, {}) === null);

  r = await call('/camera/status');
  check('status reports the compound window', r.body.compound_window_sec === 60, String(r.body.compound_window_sec));
  // Not a fixed number: the bus-resolution block earlier in this file posts a
  // violence and then a sound on 515, which is a genuine corroboration and is
  // correctly counted. The invariant that matters is that the counter agrees
  // with what actually reached the store.
  const storedCompounds = store.rows.filter((x) => x.event_type === 'violence_disruption').length;
  check('status counter agrees with the compound events written',
    r.body.compound_raised === storedCompounds,
    `counter ${r.body.compound_raised} vs stored ${storedCompounds}`);

  // --- capture and status ---------------------------------------------------
  console.log('\nDiagnostics');
  r = await call('/camera/last?limit=5');
  check('capture ring readable', Array.isArray(r.body.captures) && r.body.captures.length > 0);
  check('token redacted in captures',
    r.body.captures.every((x) => x.query.token === undefined || x.query.token === '[redacted]'));

  r = await call('/camera/status');
  check('status reports connected once a request has arrived', r.body.connected === true);
  check('status counts accepted events', r.body.accepted > 0, String(r.body.accepted));
  check('status counts suppressed events', r.body.suppressed > 0, String(r.body.suppressed));

  // --- engine notification --------------------------------------------------
  check('alert emitted to the console listener',
    engine.emitted.some((e) => e.event === 'alert' && e.row.event_type === 'violence'));
  check('counters incremented', (engine.counters.fall ?? 0) > 0);

  server.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('self-test crashed:', err);
  process.exit(1);
});
