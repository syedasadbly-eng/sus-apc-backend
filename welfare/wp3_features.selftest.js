// welfare/wp3_features.selftest.js
// Verification of Work Package 3 features:
// 1. Overcrowding rule (R5_overcrowding)
// 2. Incident SLA and resolution lifecycle (Open -> Acknowledged -> Resolved)
// 3. 5-minute SLA breach tracking on critical alerts

process.env.FEATURE_WELFARE = 'true';

const assert = require('assert');
const { WelfareEngine } = require('./engine');
const { initWelfare } = require('./index');
const Database = require('better-sqlite3');

console.log('Testing WP3 Features: Overcrowding & Resolution Workflow...');

// 1. Overcrowding rule verification
{
  let now = Date.parse('2026-09-29T12:00:00Z');
  const engine = new WelfareEngine({
    now: () => now,
    config: {
      enabledRules: ['sensor_health', 'overcrowding'],
      busCapacity: 16,
      overcrowdThresholdPercent: 100,
      overcrowdSustainSec: 60,
    },
  });

  // First message: bus 515 has 18 passengers (capacity 16 -> 113%)
  const r1 = engine.ingest({
    busId: '515',
    onboard: 18,
    lat: 44.02,
    lng: -92.46,
    gpsValid: true,
  }, now);
  assert.strictEqual(r1.length, 0, 'No overcrowding alert before sustain window passes');

  // Advance time by 70s
  now += 70000;
  // Second message: 70 seconds later with 18 passengers still aboard
  const r2 = engine.ingest({
    busId: '515',
    onboard: 18,
    lat: 44.021,
    lng: -92.461,
    gpsValid: true,
  }, now);

  assert.strictEqual(r2.length, 1, 'Overcrowding alert fired');
  assert.strictEqual(r2[0].event_type, 'overcrowding');
  assert.strictEqual(r2[0].rule, 'R5_overcrowding');
  assert.strictEqual(r2[0].severity, 3);
  assert.strictEqual(r2[0].use_case, 5);
  console.log('  PASS  Overcrowding rule (R5_overcrowding) fires when capacity >= 100%');
}

// 2. Incident Resolution & SLA Workflow
{
  const db = new Database(':memory:');
  const dummyApp = { use: () => {} };
  const engine = initWelfare(dummyApp, db, {
    meta: { startedAt: new Date().toISOString() },
  });

  // Insert a mock Level 4 Escalate event
  const eventId = 'test-evt-001';
  engine.store.insert({
    event_id: eventId,
    detected_at: new Date(Date.now() - 400000).toISOString(), // 400 seconds ago (>300s SLA)
    bus_id: '515',
    source: 'camera',
    event_type: 'fall',
    severity: 4,
    rule: 'camera_fall',
    reason: 'Passenger fall detected',
    use_case: 2,
  });

  // Verify initial open state and SLA breach (>300s unacknowledged)
  let stats = engine.store.stats();
  assert.strictEqual(stats.totals.open_real, 1, 'Event is open');
  assert.strictEqual(stats.totals.sla_breaches_urgent, 1, 'SLA breach detected for unacknowledged Level 4 incident > 5 min');
  console.log('  PASS  5-minute SLA breach accurately counted for unacknowledged Level 4 incident');

  // Acknowledge the event
  const ackOk = engine.store.acknowledge(eventId, 'operator-01');
  assert.strictEqual(ackOk, true, 'Event acknowledged successfully');
  stats = engine.store.stats();
  assert.strictEqual(stats.totals.open_real, 0, 'Event is no longer open');
  assert.strictEqual(stats.totals.sla_breaches_urgent, 0, 'SLA breach cleared on acknowledgement');
  console.log('  PASS  Acknowledgement clears open and SLA breach counters');

  // Resolve the event
  const resOk = engine.store.resolve(eventId, 'keyworker-42', 'Passenger assisted by station officer; no ambulance needed');
  assert.strictEqual(resOk, true, 'Event resolved successfully');

  const evts = engine.store.query({ limit: 5 });
  assert.strictEqual(evts[0].resolved, 1, 'Resolved flag set to 1');
  assert.strictEqual(evts[0].resolved_by, 'keyworker-42');
  assert.strictEqual(evts[0].resolution_notes, 'Passenger assisted by station officer; no ambulance needed');
  console.log('  PASS  Resolution workflow persists resolver identity and notes');
}

console.log('All WP3 feature tests passed successfully!');
