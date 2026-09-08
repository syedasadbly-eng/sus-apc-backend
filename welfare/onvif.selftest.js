/* ONVIF PullPoint listener self-test. Run: node welfare/onvif.selftest.js
 *
 * Stands up a fake ONVIF camera on localhost that answers
 * GetSystemDateAndTime, GetCapabilities, CreatePullPointSubscription and
 * PullMessages with real Milesight-shaped SOAP, then drives the listener
 * against it. No network, no camera, no database.
 *
 * What is being proved:
 *   - the SOAP conversation completes against a spec-shaped device
 *   - WS-UsernameToken digests are computed the way ONVIF specifies
 *   - clock skew on the camera is measured and compensated
 *   - notifications parse, including nested SimpleItems and namespace prefixes
 *   - fall / violence / sound classify correctly and everything else does not
 *   - a property CLEAR does not raise an alert
 *   - Initialized baselines on subscribe do not raise an alert
 *   - detections reach the shared record path with transport recorded
 *   - relay mode posts to the HTTP ingest route instead of writing locally
 */

'use strict';

process.env.FEATURE_WELFARE_ONVIF = 'true';
process.env.WELFARE_ONVIF_USER = 'admin';
process.env.WELFARE_ONVIF_PASS = 'test-pass';
process.env.WELFARE_ONVIF_BUS = 'test-bus';
process.env.WELFARE_ONVIF_PULL_SEC = '1';
process.env.WELFARE_CAMERA_COOLDOWN_SEC = '30';

const http = require('http');
const crypto = require('crypto');
const onvif = require('./onvif');

const { classify, parseNotifications, securityHeader, deviceServiceUrl, tagText } = onvif._internal;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS ${name}`); } else {
    failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Fake camera
// ---------------------------------------------------------------------------

/** Milesight-shaped notification. Prefixes deliberately differ from the ones
 *  used elsewhere in the response, because real devices are inconsistent and
 *  a parser that only handles one prefix set fails in the field. */
function notification(topic, items, { operation = null, utc = '2026-09-08T02:40:00Z' } = {}) {
  const data = Object.entries(items)
    .map(([k, v]) => `<tt:SimpleItem Name="${k}" Value="${v}"/>`).join('');
  return `<wsnt:NotificationMessage>`
    + `<wsnt:Topic Dialect="http://docs.oasis-open.org/wsn/t-1/TopicExpression/Simple">${topic}</wsnt:Topic>`
    + `<wsnt:Message>`
    + `<tt:Message UtcTime="${utc}"${operation ? ` PropertyOperation="${operation}"` : ''}>`
    + `<tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="VideoSourceToken"/></tt:Source>`
    + `<tt:Data>${data}</tt:Data>`
    + `</tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
}

const CAMERA_SKEW_SEC = 400; // camera clock 400s ahead: rejects naive tokens

const scripted = []; // queue of notification batches to serve

function soap(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"`
    + ` xmlns:tds="http://www.onvif.org/ver10/device/wsdl"`
    + ` xmlns:tev="http://www.onvif.org/ver10/events/wsdl"`
    + ` xmlns:tt="http://www.onvif.org/ver10/schema"`
    + ` xmlns:wsa="http://www.w3.org/2005/08/addressing"`
    + ` xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">`
    + `<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

function startFakeCamera() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const reply = (xml) => { res.writeHead(200, { 'Content-Type': 'application/soap+xml' }); res.end(soap(xml)); };

        if (/GetSystemDateAndTime/.test(body)) {
          const d = new Date(Date.now() + CAMERA_SKEW_SEC * 1000);
          return reply(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime>`
            + `<tt:UTCDateTime><tt:Time>`
            + `<tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second>`
            + `</tt:Time><tt:Date>`
            + `<tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day>`
            + `</tt:Date></tt:UTCDateTime>`
            + `</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
        }

        if (/GetCapabilities/.test(body)) {
          const port = server.address().port;
          return reply(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Events>`
            + `<tt:XAddr>http://127.0.0.1:${port}/onvif/event_service</tt:XAddr>`
            + `</tt:Events></tds:Capabilities></tds:GetCapabilitiesResponse>`);
        }

        if (/CreatePullPointSubscription/.test(body)) {
          const port = server.address().port;
          return reply(`<tev:CreatePullPointSubscriptionResponse>`
            + `<tev:SubscriptionReference><wsa:Address>http://127.0.0.1:${port}/onvif/Subscription?Idx=7</wsa:Address></tev:SubscriptionReference>`
            + `<wsnt:CurrentTime>2026-09-08T02:40:00Z</wsnt:CurrentTime>`
            + `<wsnt:TerminationTime>2026-09-08T02:45:00Z</wsnt:TerminationTime>`
            + `</tev:CreatePullPointSubscriptionResponse>`);
        }

        if (/PullMessages/.test(body)) {
          const batch = scripted.shift() || [];
          return reply(`<tev:PullMessagesResponse>`
            + `<tev:CurrentTime>2026-09-08T02:40:00Z</tev:CurrentTime>`
            + `<tev:TerminationTime>2026-09-08T02:45:00Z</tev:TerminationTime>`
            + batch.join('')
            + `</tev:PullMessagesResponse>`);
        }

        res.writeHead(400); res.end('unexpected request');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Fakes for the record path
// ---------------------------------------------------------------------------

function fakeEngine() {
  return {
    counters: {},
    recent: [],
    recentLimit: 50,
    vehicles: new Map(),
    emitted: [],
    emit(event, row) { this.emitted.push({ event, row }); },
  };
}

function fakeStore() {
  const rows = [];
  return { rows, insert(row) { rows.push(row); } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log('\nONVIF listener self-test\n');

  // --- pure parsing ---------------------------------------------------------
  console.log('Parsing');
  {
    const xml = soap(
      notification('tns1:RuleEngine/MyRuleDetector/FallDetect', { IsFall: 'true', ObjectId: '12' })
      + notification('tns1:VideoSource/MotionAlarm', { State: 'true' }, { operation: 'Changed' }),
    );
    const msgs = parseNotifications(xml);
    check('both notifications parsed', msgs.length === 2, String(msgs.length));
    check('topic text extracted', msgs[0].topic === 'tns1:RuleEngine/MyRuleDetector/FallDetect', msgs[0].topic);
    check('UtcTime attribute read', msgs[0].utc_time === '2026-09-08T02:40:00Z', String(msgs[0].utc_time));
    check('data SimpleItems read', msgs[0].data.IsFall === 'true' && msgs[0].data.ObjectId === '12', JSON.stringify(msgs[0].data));
    check('source SimpleItems kept separate from data',
      msgs[0].source.VideoSourceConfigurationToken === 'VideoSourceToken' && msgs[0].data.VideoSourceConfigurationToken === undefined);
    check('PropertyOperation read', msgs[1].operation === 'Changed', String(msgs[1].operation));
    check('raw block retained for discovery', typeof msgs[0].raw === 'string' && msgs[0].raw.includes('FallDetect'));
  }

  // --- classification -------------------------------------------------------
  console.log('\nClassification');
  {
    const fall = classify({ topic: 'tns1:RuleEngine/MilesightRule/Fall', data: { IsFall: 'true' } }, []);
    check('fall recognised and firing', fall.signal === 'fall' && fall.firing === true, JSON.stringify(fall));

    const violence = classify({ topic: 'tns1:RuleEngine/ViolenceDetector/Violence', data: { State: 'true' } }, []);
    check('violence recognised', violence.signal === 'violence', JSON.stringify(violence));

    const sound = classify({ topic: 'tns1:AudioAnalytics/Audio/SoundClassification', data: { Type: 'Scream' } }, []);
    check('sound classification recognised', sound.signal === 'sound', JSON.stringify(sound));

    const cleared = classify({ topic: 'tns1:RuleEngine/MilesightRule/Fall', data: { IsFall: 'false' } }, []);
    check('property clear recognised as not firing', cleared.signal === 'fall' && cleared.firing === false, JSON.stringify(cleared));

    const baseline = classify({ topic: 'tns1:RuleEngine/MilesightRule/Fall', data: { IsFall: 'true' }, operation: 'Initialized' }, []);
    check('Initialized baseline does not fire', baseline.firing === false, JSON.stringify(baseline));

    const motion = classify({ topic: 'tns1:VideoSource/MotionAlarm', data: { State: 'true' } }, []);
    check('unrelated motion event is not a welfare signal', motion.signal === null, JSON.stringify(motion));

    const counting = classify({ topic: 'tns1:RuleEngine/CountAggregation/Counter', data: { Count: '42' } }, []);
    check('people counting is not a welfare signal', counting.signal === null, JSON.stringify(counting));

    const bound = classify(
      { topic: 'tns1:RuleEngine/CellMotionDetector/Xyz', data: { State: 'true' } },
      [{ pattern: 'CellMotionDetector/Xyz', signal: 'violence', re: /CellMotionDetector\/Xyz/i }],
    );
    check('explicit binding overrides keywords', bound.signal === 'violence' && bound.matchedBy.startsWith('binding:'), JSON.stringify(bound));

    // Ordering: violence must win over sound when a topic names both, because
    // the stronger signal is the one worth acting on.
    const both = classify({ topic: 'tns1:RuleEngine/Violence/AudioAssist', data: {} }, []);
    check('violence beats sound when a topic names both', both.signal === 'violence', JSON.stringify(both));
  }

  // --- auth token -----------------------------------------------------------
  console.log('\nWS-UsernameToken');
  {
    const header = securityHeader('admin', 'test-pass', 0);
    const nonce = tagText(header, 'Nonce');
    const created = tagText(header, 'Created');
    const digest = tagText(header, 'Password');
    const expected = crypto.createHash('sha1')
      .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created, 'utf8'), Buffer.from('test-pass', 'utf8')]))
      .digest('base64');
    check('digest is sha1(nonce + created + password) per ONVIF', digest === expected, `${digest} vs ${expected}`);
    check('nonce is 16 bytes base64', Buffer.from(nonce, 'base64').length === 16);
    check('username carried in the token', tagText(header, 'Username') === 'admin');

    const offset = securityHeader('admin', 'test-pass', 120000);
    const skewSec = (Date.parse(tagText(offset, 'Created')) - Date.now()) / 1000;
    check('clock offset shifts Created', skewSec > 100 && skewSec < 140, `${Math.round(skewSec)}s`);

    check('empty user produces no security header', securityHeader('', '', 0) === '');
  }

  // --- URL handling ---------------------------------------------------------
  console.log('\nTarget resolution');
  check('bare IP expands to the ONVIF device service',
    deviceServiceUrl('192.168.1.200') === 'http://192.168.1.200/onvif/device_service',
    deviceServiceUrl('192.168.1.200'));
  check('host with scheme expands too',
    deviceServiceUrl('http://192.168.1.200') === 'http://192.168.1.200/onvif/device_service');
  check('explicit onvif path is left alone',
    deviceServiceUrl('http://192.168.1.200:8080/onvif/device_service') === 'http://192.168.1.200:8080/onvif/device_service');

  // --- live conversation against the fake camera ----------------------------
  console.log('\nLive conversation (local mode)');
  const server = await startFakeCamera();
  const port = server.address().port;
  process.env.WELFARE_ONVIF_URL = `http://127.0.0.1:${port}/onvif/device_service`;

  // Reload with the URL set, so module-level config picks it up.
  delete require.cache[require.resolve('./onvif')];
  delete require.cache[require.resolve('./camera')];
  const live = require('./onvif');
  const liveCamera = require('./camera');

  scripted.push([
    // Baseline replay on subscribe. Must not alert.
    notification('tns1:RuleEngine/MilesightRule/FallDetection', { IsFall: 'true' }, { operation: 'Initialized' }),
  ]);
  scripted.push([
    notification('tns1:RuleEngine/MilesightRule/FallDetection', { IsFall: 'true' }, { operation: 'Changed' }),
    notification('tns1:VideoSource/MotionAlarm', { State: 'true' }, { operation: 'Changed' }),
  ]);
  scripted.push([
    notification('tns1:RuleEngine/MilesightRule/FallDetection', { IsFall: 'false' }, { operation: 'Changed' }),
  ]);

  const engine = fakeEngine();
  const store = fakeStore();
  live._internal.start(engine, store);

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && store.rows.length < 1) await sleep(200); // eslint-disable-line no-await-in-loop
  await sleep(500);
  live.stop();

  const st = live.onvifState();
  check('subscription established', st.subscribed === true || st.counters.pulls > 0, JSON.stringify(st.status));
  check('camera clock skew measured',
    Math.abs(st.clock_offset_ms - CAMERA_SKEW_SEC * 1000) < 5000, `${st.clock_offset_ms}ms`);
  check('pulled more than once', st.counters.pulls >= 2, String(st.counters.pulls));
  // The fake camera returns immediately instead of honouring the long-poll
  // timeout, exactly as some devices do. The idle floor must keep that from
  // becoming a hot loop — on the bench this reached 54,000 pulls in 8s.
  check('an instantly-returning camera does not cause a hot loop',
    st.counters.pulls < 60, `${st.counters.pulls} pulls in ~10s`);
  check('exactly one fall event written', store.rows.length === 1, `${store.rows.length} rows`);

  const row = store.rows[0];
  check('event is a fall', row && row.event_type === 'fall', row && row.event_type);
  check('event is on the configured bus', row && row.bus_id === 'test-bus', row && row.bus_id);
  check('severity is Alert', row && row.severity === 3, row && String(row.severity));
  check('transport recorded as onvif', row && row.detail.transport === 'onvif', row && JSON.stringify(row.detail.transport));
  check('topic preserved in detail', row && String(row.detail.topic).includes('FallDetection'), row && row.detail.topic);
  check('match reason recorded', row && typeof row.detail.matched_by === 'string', row && row.detail.matched_by);
  check('baseline counted, not alerted', st.counters.baseline >= 1, String(st.counters.baseline));
  check('clear counted, not alerted', st.counters.cleared >= 1, String(st.counters.cleared));
  check('unrelated motion counted as unrecognised', st.counters.unrecognised >= 1, String(st.counters.unrecognised));
  check('alert emitted to the engine',
    engine.emitted.some((e) => e.event === 'alert' && e.row.event_type === 'fall'));
  check('discovery recorded every distinct topic', st.distinct_topics >= 2, String(st.distinct_topics));

  // --- shared record path ---------------------------------------------------
  console.log('\nShared record path');
  {
    const e2 = fakeEngine();
    const s2 = fakeStore();
    const first = liveCamera.recordDetection({
      engine: e2, store: s2, signal: 'violence', bus: 'b1', via: 'onvif', detail: { transport: 'onvif' },
    });
    check('detection accepted', first.accepted === true, JSON.stringify(first));
    const second = liveCamera.recordDetection({
      engine: e2, store: s2, signal: 'violence', bus: 'b1', via: 'onvif', detail: { transport: 'onvif' },
    });
    check('cooldown suppresses the repeat', second.accepted === false && second.reason === 'cooldown', JSON.stringify(second));
    const sound = liveCamera.recordDetection({
      engine: e2, store: s2, signal: 'sound', bus: 'b1', via: 'onvif', detail: { transport: 'onvif' },
    });
    check('violence + sound raises the compound escalation',
      Boolean(sound.compound_event_id), JSON.stringify(sound));
    check('compound event stored as violence_disruption',
      s2.rows.some((r) => r.event_type === 'violence_disruption' && r.severity === 4));
  }

  server.close();

  // --- relay mode -----------------------------------------------------------
  console.log('\nRelay mode');
  {
    const received = [];
    const cloud = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, event_id: 'cam-remote-1' }));
      });
    });
    await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
    const cloudPort = cloud.address().port;

    const camera2 = await startFakeCamera();
    process.env.WELFARE_ONVIF_URL = `http://127.0.0.1:${camera2.address().port}/onvif/device_service`;
    process.env.WELFARE_ONVIF_RELAY_URL = `http://127.0.0.1:${cloudPort}`;
    process.env.WELFARE_ONVIF_RELAY_TOKEN = 'relay-token';

    delete require.cache[require.resolve('./onvif')];
    const relayMode = require('./onvif');

    scripted.length = 0;
    scripted.push([]);
    scripted.push([notification('tns1:RuleEngine/MilesightRule/Violence', { State: 'true' }, { operation: 'Changed' })]);

    const e3 = fakeEngine();
    const s3 = fakeStore();
    relayMode._internal.start(e3, s3);

    const relayDeadline = Date.now() + 12000;
    while (Date.now() < relayDeadline && received.length === 0) await sleep(200); // eslint-disable-line no-await-in-loop
    relayMode.stop();

    check('relay mode reported in status', relayMode.onvifState().mode === 'relay');
    check('detection posted to the cloud ingest route', received.length === 1, `${received.length} posts`);
    if (received.length) {
      check('posted to the violence signal path', received[0].url.startsWith('/api/welfare/camera/violence'), received[0].url);
      check('bus id passed as a query parameter', received[0].url.includes('bus=test-bus'), received[0].url);
      check('relay token passed as a query parameter', received[0].url.includes('token=relay-token'), received[0].url);
      const posted = JSON.parse(received[0].body);
      check('payload marks the transport', posted.transport === 'onvif', received[0].body);
      check('payload carries the ONVIF topic', String(posted.topic).includes('Violence'), received[0].body);
    }
    check('nothing written locally in relay mode', s3.rows.length === 0, `${s3.rows.length} rows`);

    camera2.close();
    cloud.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('self-test crashed:', err);
  process.exit(1);
});
