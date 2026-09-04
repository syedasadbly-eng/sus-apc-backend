/* ============================================
   CAMERA INGEST — Milesight AI Pro Dome → welfare console
   Smart Urban Sensing

   The camera has no MQTT client on firmware 63.8.0.6-r1, so its only outbound
   path is HTTP Notification: up to three URLs per event type, GET or POST,
   with optional Basic credentials. This module terminates those callbacks and
   writes them into welfare_events as real events (source='camera').

   Design decisions, and why:

   1. THE PATH IDENTIFIES THE SIGNAL. Milesight does not document the JSON body
      for Fall or Violence Detection, and the body differs between firmware
      builds. Depending on it would make ingest a guess. A distinct URL per
      signal — /camera/fall, /camera/violence, /camera/sound — is set once on
      the camera and cannot drift.

   2. EVERY REQUEST IS CAPTURED VERBATIM. Until a real fall has been staged in
      front of the lens, nobody knows what this camera actually sends. The last
      CAPTURE_LIMIT requests are held in memory with method, content type,
      headers, query and raw body, readable at GET /camera/last. That capture is
      the point of this endpoint before it is the alerting path.

   3. IT ACCEPTS ANYTHING. A camera callback that 400s is a lost event and a
      silent one — the camera does not retry and does not surface the failure.
      The body is parsed as JSON when it parses and kept as text when it does
      not; a malformed body never blocks the event.

   4. IT IS NOT THE SIMULATOR. These are real detections and are deliberately
      NOT behind WELFARE_ALLOW_SIM. They are behind a shared token instead,
      because this route writes to the database from the public internet.
   ============================================ */

'use strict';

const express = require('express');
const { SEVERITY } = require('./engine');

const CAPTURE_LIMIT = 25;
const RAW_LIMIT_CHARS = 8000;

/** Shared secret. Sent by the camera as ?token=, X-Auth-Token, or the password
 *  half of Basic auth (the camera's HTTP Notification User Name / Password
 *  fields). Unset means open, which is logged loudly at mount time. */
const TOKEN = process.env.WELFARE_CAMERA_TOKEN || '';

/** Repeat suppression, per bus per signal. A fall holds its posture for as
 *  long as the person is down, and the camera re-fires for the whole time. */
const COOLDOWN_SEC = Number(process.env.WELFARE_CAMERA_COOLDOWN_SEC || 30);

/** Which vehicle a camera belongs to. Keyed by source IP so several rigs can
 *  share one console: {"192.168.5.190":"lab-rig","10.0.0.14":"515"} */
function cameraMap() {
  try {
    return process.env.WELFARE_CAMERA_MAP ? JSON.parse(process.env.WELFARE_CAMERA_MAP) : {};
  } catch {
    console.error('[camera] WELFARE_CAMERA_MAP is not valid JSON, ignoring it');
    return {};
  }
}

const DEFAULT_BUS = process.env.WELFARE_CAMERA_BUS || 'lab-rig';

/* Signal definitions. severity and use_case match the six-KPI model:
   use case 2 = Distress, use case 7 = Aggression / Violence & Disruption. */
const SIGNALS = {
  fall: {
    event_type: 'fall',
    severity: SEVERITY.ALERT,
    rule: 'camera_fall',
    use_case: 2,
    label: 'Fall detected',
  },
  violence: {
    event_type: 'violence',
    severity: SEVERITY.ESCALATE,
    rule: 'camera_violence',
    use_case: 7,
    label: 'Violent behaviour detected',
  },
  sound: {
    event_type: 'sound_classification',
    severity: SEVERITY.NOTIFY,
    rule: 'camera_sound',
    use_case: 7,
    label: 'Sound classification triggered',
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  captures: [],          // raw request ring, newest first
  lastEventAt: null,     // ISO of the last accepted detection
  lastSeenAt: null,      // ISO of the last request of any kind, incl. rejected
  accepted: 0,
  suppressed: 0,
  rejected: 0,
  bySignal: Object.create(null),
  lastAlertTs: Object.create(null), // `${busId}:${signal}` → ms
};

function cameraState() {
  return {
    connected: state.lastSeenAt != null,
    token_required: Boolean(TOKEN),
    cooldown_sec: COOLDOWN_SEC,
    default_bus: DEFAULT_BUS,
    map: cameraMap(),
    last_seen_at: state.lastSeenAt,
    last_event_at: state.lastEventAt,
    accepted: state.accepted,
    suppressed: state.suppressed,
    rejected: state.rejected,
    by_signal: { ...state.bySignal },
    signals: Object.keys(SIGNALS),
    captures_held: state.captures.length,
  };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function presentedToken(req) {
  if (req.query?.token) return String(req.query.token);
  if (req.headers['x-auth-token']) return String(req.headers['x-auth-token']);
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      return decoded.slice(decoded.indexOf(':') + 1);
    } catch { /* fall through */ }
  }
  return '';
}

/** Constant-time-ish comparison. The token is short and low value, but there
 *  is no reason to leak its length through early exit. */
function tokenOk(given) {
  if (!TOKEN) return true;
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Body as { json, text }. The camera may send JSON, form data, an empty GET,
 *  or multipart with a snapshot attached. None of those may 400. */
function readBody(req) {
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  const type = String(req.headers['content-type'] || '');
  let text = null;
  let json = null;

  if (raw && raw.length) {
    if (type.startsWith('multipart/')) {
      // Snapshot payload. Do not decode it — record that it arrived and how big.
      return { json: null, text: null, binary_bytes: raw.length };
    }
    text = raw.toString('utf8').slice(0, RAW_LIMIT_CHARS);
    try { json = JSON.parse(text); } catch { json = null; }
  } else if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    json = req.body;
    try { text = JSON.stringify(req.body).slice(0, RAW_LIMIT_CHARS); } catch { text = null; }
  }
  return { json, text, binary_bytes: null };
}

function capture(req, signal, outcome, extra = {}) {
  const body = extra.body ?? readBody(req);
  const entry = {
    at: new Date().toISOString(),
    signal,
    outcome,
    method: req.method,
    path: req.originalUrl,
    from: clientIp(req),
    content_type: req.headers['content-type'] || null,
    user_agent: req.headers['user-agent'] || null,
    query: { ...req.query, token: req.query?.token ? '[redacted]' : undefined },
    body_json: body.json,
    body_text: body.json ? null : body.text,
    binary_bytes: body.binary_bytes,
    ...extra.note ? { note: extra.note } : {},
  };
  state.captures.unshift(entry);
  if (state.captures.length > CAPTURE_LIMIT) state.captures.length = CAPTURE_LIMIT;
  state.lastSeenAt = entry.at;
  return entry;
}

/** Which vehicle this detection belongs to: explicit query wins, then the IP
 *  map, then the configured default. */
function resolveBus(req) {
  const explicit = req.query?.bus || req.query?.bus_id || req.query?.busId;
  if (explicit) return { bus: String(explicit), via: 'query' };
  const ip = clientIp(req);
  const mapped = cameraMap()[ip];
  if (mapped) return { bus: String(mapped), via: `map:${ip}` };
  return { bus: DEFAULT_BUS, via: 'default' };
}

/** Enrich the event with whatever the counting feed knows about that vehicle
 *  right now — position, route, occupancy, sensor health. A fall alert that
 *  says which bus, where, and how many people were aboard is a different
 *  artefact from one that says "fall". Never throws: a camera event must land
 *  even when the vehicle has never reported. */
function vehicleContext(engine, busId) {
  try {
    // Read the live vehicle map directly, and only if the vehicle already
    // exists. engine.vehicle(id) would CREATE one, inventing a bus in the
    // fleet-health view every time a camera posted with a stray bus id.
    if (!engine || !engine.vehicles || !engine.vehicles.has(String(busId))) return {};
    const v = engine.vehicles.get(String(busId));
    return {
      route: v.route ?? null,
      // Same GPS caution as the rules: server.js substitutes static depot
      // coordinates when the UR35 reports no fix, so an unvalidated position
      // would place every event at a depot it never visited.
      lat: v.gpsValid ? v.lat ?? null : null,
      lng: v.gpsValid ? v.lng ?? null : null,
      onboard: v.onboard ?? null,
      sensor_health: v.health ?? null,
      onboard_is_modelled: Boolean(v.occupancyModel),
      gps_valid: Boolean(v.gpsValid),
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function createCameraRouter(engine, store) {
  const router = express.Router();

  // Accept every content type as a Buffer, so nothing the camera sends can be
  // rejected by a parser before this module has seen it.
  const rawBody = express.raw({ type: () => true, limit: '4mb' });

  router.get('/camera/status', (req, res) => res.json(cameraState()));

  router.get('/camera/last', (req, res) => {
    const n = Math.min(CAPTURE_LIMIT, Number(req.query.limit) || CAPTURE_LIMIT);
    res.json({ captures: state.captures.slice(0, n), state: cameraState() });
  });

  /**
   * The ingest route.
   *
   *   POST|GET /api/welfare/camera/:signal?bus=515&token=…
   *
   * :signal is fall | violence | sound. Anything else is captured and refused,
   * so a mistyped URL on the camera shows up in /camera/last rather than
   * vanishing.
   */
  router.all('/camera/:signal', rawBody, (req, res) => {
    const signal = String(req.params.signal || '').toLowerCase();
    const spec = SIGNALS[signal];
    const body = readBody(req);

    if (!spec) {
      state.rejected += 1;
      capture(req, signal, 'unknown_signal', { body });
      return res.status(404).json({
        error: `Unknown signal '${signal}'`,
        signals: Object.keys(SIGNALS),
      });
    }

    if (!tokenOk(presentedToken(req))) {
      state.rejected += 1;
      capture(req, signal, 'unauthorised', { body });
      return res.status(401).json({ error: 'Bad or missing token' });
    }

    const { bus, via } = resolveBus(req);
    const nowTs = Date.now();
    const key = `${bus}:${signal}`;
    const sinceLast = (nowTs - (state.lastAlertTs[key] ?? 0)) / 1000;

    if (sinceLast < COOLDOWN_SEC) {
      state.suppressed += 1;
      capture(req, signal, 'suppressed', {
        body,
        note: `within ${COOLDOWN_SEC}s cooldown (${Math.round(sinceLast)}s since last)`,
      });
      // 200, not 429. The camera treats a non-2xx as a delivery failure and
      // there is nothing wrong here — the event was received and deliberately
      // folded into the previous one.
      return res.json({ accepted: false, reason: 'cooldown', cooldown_sec: COOLDOWN_SEC });
    }

    state.lastAlertTs[key] = nowTs;

    const ctx = vehicleContext(engine, bus);
    const detectedAt = new Date(nowTs).toISOString();
    const row = {
      event_id: `cam-${bus}-${signal}-${nowTs}`,
      detected_at: detectedAt,
      bus_id: bus,
      source: 'camera',
      event_type: spec.event_type,
      severity: spec.severity,
      severity_name: { 1: 'log', 2: 'notify', 3: 'alert', 4: 'escalate' }[spec.severity],
      rule: spec.rule,
      reason: `${spec.label} by AI Pro Dome`,
      use_case: spec.use_case,
      route: ctx.route ?? null,
      lat: ctx.lat ?? null,
      lng: ctx.lng ?? null,
      onboard: ctx.onboard ?? null,
      sensor_health: ctx.sensor_health ?? 'camera',
      acknowledged: 0,
      detail: {
        signal,
        device: 'MS-C2972-RFPG1',
        from_ip: clientIp(req),
        bus_resolved_via: via,
        http_method: req.method,
        content_type: req.headers['content-type'] || null,
        query: { ...req.query, token: undefined },
        payload: body.json ?? (body.text ? { raw: body.text } : null),
        snapshot_bytes: body.binary_bytes,
        vehicle_context: Object.keys(ctx).length ? ctx : 'no counting data for this vehicle',
      },
    };

    // The write is the event. If the database is unavailable the detection is
    // still worth surfacing in the live feed and the capture ring, so the
    // insert failure is contained rather than 500ing back at the camera.
    let stored = true;
    try {
      if (store) store.insert(row);
    } catch (err) {
      stored = false;
      console.error('[camera] store insert failed:', err.message);
    }

    try {
      if (engine) {
        engine.counters[spec.event_type] = (engine.counters[spec.event_type] ?? 0) + 1;
        engine.recent.unshift(row);
        if (engine.recent.length > engine.recentLimit) engine.recent.length = engine.recentLimit;
        engine.emit(spec.severity >= SEVERITY.ALERT ? 'alert' : 'log', row);
      }
    } catch (err) {
      console.error('[camera] engine notify failed:', err.message);
    }

    state.accepted += 1;
    state.bySignal[signal] = (state.bySignal[signal] ?? 0) + 1;
    state.lastEventAt = detectedAt;
    capture(req, signal, 'accepted', { body, note: `event ${row.event_id}` });

    console.log(`[camera] ${row.severity_name.toUpperCase()} ${bus} ${spec.event_type} from ${clientIp(req)}`);

    return res.json({ accepted: true, stored, event_id: row.event_id, bus_id: bus });
  });

  return router;
}

function initCamera() {
  if (!TOKEN) {
    console.warn('[camera] WELFARE_CAMERA_TOKEN is not set — /api/welfare/camera/* accepts unauthenticated writes');
  }
  console.log(`[camera] ingest ready: /api/welfare/camera/{${Object.keys(SIGNALS).join(',')}} · default bus ${DEFAULT_BUS} · cooldown ${COOLDOWN_SEC}s`);
  return true;
}

module.exports = {
  createCameraRouter,
  initCamera,
  cameraState,
  SIGNALS,
  // exported for the self-test
  _internal: { tokenOk, resolveBus, readBody, state },
};
