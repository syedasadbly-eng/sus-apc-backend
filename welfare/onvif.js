/* ============================================
   ONVIF PULLPOINT LISTENER — Milesight AI Pro Dome → welfare console
   Smart Urban Sensing

   WHY THIS EXISTS

   The AI Pro Dome (MS-C2972-RFPG1, firmware 63.8.0.6-r1) will not offer HTTP
   Notification as an alarm action for the three signals the welfare console
   needs — Fall Detection, Violence Detection and Sound Classification. That is
   a firmware-side limitation and no amount of camera configuration moves it.

   ONVIF inverts the direction of travel. Instead of the camera pushing to us,
   we subscribe to its PullPoint event service and pull. Nothing is configured
   on the camera beyond ONVIF being enabled and a user account existing, so
   there is no alarm-action menu to be missing.

   DESIGN DECISIONS, AND WHY

   1. NO NEW DEPENDENCIES. ONVIF is SOAP over HTTP. The three calls this needs
      — GetSystemDateAndTime, CreatePullPointSubscription, PullMessages — are
      hand-built envelopes and regex-parsed responses. Pulling in an ONVIF
      stack for three calls would add a large transitive tree to a service
      that currently runs on four dependencies.

   2. IT RUNS WHERE THE CAMERA IS. Railway cannot reach 192.168.1.200. This
      listener is designed to run on-site — a laptop, mini PC or Pi on the
      camera LAN — and either write to a local database or RELAY each detection
      to the cloud console over the existing /api/welfare/camera/:signal route.
      Relay mode means the cloud console needs no new ingest surface and no new
      authentication: it already trusts that route with a token.

   3. TOPIC NAMES ARE UNKNOWN UNTIL THE CAMERA SPEAKS. Milesight does not
      publish the ONVIF topic strings for its MSense events, and they differ
      between builds. So every topic seen is recorded with its payload at
      GET /onvif/topics, whether or not it was recognised. Discovery is the
      first job of this module; alerting is the second. Once the real strings
      are known, WELFARE_ONVIF_TOPICS binds them explicitly and the built-in
      keyword matching stops being load-bearing.

   4. INITIALIZED IS NOT AN ALARM. ONVIF property events replay their current
      state on subscribe (PropertyOperation="Initialized"). Treating that as a
      detection would raise a fall alert every time this process restarted.
      Baseline messages are recorded and never alerted on.

   5. IT SHARES THE HTTP ADAPTER'S RECORD PATH. Detections go through
      camera.recordDetection(), so cooldown, the violence+sound compound rule,
      vehicle context, counters and the live feed behave identically whether a
      detection arrived by HTTP Notification or by ONVIF. The transport is
      recorded in detail.transport; it is not a second kind of event.
   ============================================ */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const express = require('express');
const camera = require('./camera');

const ENABLED = process.env.FEATURE_WELFARE_ONVIF === 'true';

/** Device service endpoint. Either a full URL or a bare host/IP, which is
 *  expanded to the ONVIF default path. */
const RAW_TARGET = process.env.WELFARE_ONVIF_URL || process.env.WELFARE_ONVIF_HOST || '';

const USER = process.env.WELFARE_ONVIF_USER || '';
const PASS = process.env.WELFARE_ONVIF_PASS || '';

/** Which vehicle this camera is on. Same default as the HTTP adapter. */
const BUS = process.env.WELFARE_ONVIF_BUS || process.env.WELFARE_CAMERA_BUS || 'lab-rig';

/** PullMessages long-poll. The camera holds the request open until it has
 *  something to say or the timeout expires, so a long timeout is cheap and
 *  means near-real-time delivery without polling pressure. */
const PULL_TIMEOUT_SEC = Number(process.env.WELFARE_ONVIF_PULL_SEC || 30);
const MESSAGE_LIMIT = Number(process.env.WELFARE_ONVIF_MESSAGE_LIMIT || 50);

/** Subscription lifetime. PullMessages renews it on every call, so this only
 *  matters if the loop dies — the camera then reclaims the subscription
 *  instead of holding it forever. */
const TERMINATION = process.env.WELFARE_ONVIF_TERMINATION || 'PT5M';

/** Reconnect backoff. A camera that has lost power comes back in minutes, not
 *  milliseconds, so the ceiling is generous and the floor is short enough that
 *  a transient blip is invisible. */
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60000;

/** Minimum wall time for an empty pull.
 *
 *  PullMessages is specified to block for the requested timeout, but a device
 *  is free to return immediately with nothing — and some do. Without a floor,
 *  that turns the listener into a hot loop: a bench test against a camera that
 *  returned instantly logged 54,000 pulls in eight seconds, which on a vehicle
 *  4G link would be a data bill and a hot CPU for no events. Only empty pulls
 *  are slowed; a pull that carried messages goes straight round again. */
const IDLE_FLOOR_MS = Number(process.env.WELFARE_ONVIF_IDLE_FLOOR_MS || 1000);

/** Relay target, e.g. https://web-production-45ef4.up.railway.app
 *  Unset means write to the local database through the engine. */
const RELAY_URL = (process.env.WELFARE_ONVIF_RELAY_URL || '').replace(/\/+$/, '');
const RELAY_TOKEN = process.env.WELFARE_ONVIF_RELAY_TOKEN || process.env.WELFARE_CAMERA_TOKEN || '';

const TOPIC_RING = 40;
const RAW_LIMIT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Signal classification
// ---------------------------------------------------------------------------

/* Vendor-confirmed topic strings.

   Supplied by Milesight technical support on 2026-09-08 for MS-C2972-RFPG1 on
   firmware 63.8.0.6-r1, in answer to a direct question about whether the
   MSense events surface as ONVIF PullPoint topics despite being absent from
   the Push Event Type list. They do — that list governs pushing to Milesight's
   own app and NVR, not third-party subscribers.

   Matched as a prefix rather than an exact string: ONVIF topic expressions are
   commonly suffixed per source or rule instance, and a trailing token must not
   stop a fall being recognised. */
const VENDOR_TOPICS = [
  ['fall', 'tns1:RuleEngine/FallDetector/Fall'],
  ['violence', 'tns1:RuleEngine/ViolenceDetector/Violence'],
  ['sound', 'tns1:RuleEngine/AudioDetector/Class'],
  // Sits outside RuleEngine on this firmware. Observed alongside the
  // classifier above, so it is listed explicitly rather than left to the
  // keyword fallback.
  ['sound', 'tns1:AudioAnalytics/Audio/DetectedSound'],
];

/* Keyword matching, the fallback beneath the vendor strings above. Kept
   because the vendor list is one firmware build's answer and topic names have
   already been shown to shift between builds and VMS profiles. Ordered:
   violence is checked before sound so a topic naming both lands on the
   stronger signal. */
const KEYWORDS = [
  ['fall', /fall|tumble|lying|collapse/i],
  ['violence', /violen|fight|brawl|assault|aggress/i],
  ['sound', /sound|audio|scream|shout|gunshot|glass|siren|classif/i],
];

/** Explicit bindings, once discovery has told us the truth. JSON of
 *  { "pattern": "signal" }, pattern matched case-insensitively against the
 *  topic and then the whole payload:
 *  {"tns1:RuleEngine/MyRuleDetector/Fall":"fall"} */
function topicBindings() {
  const raw = process.env.WELFARE_ONVIF_TOPICS;
  if (!raw) return [];
  try {
    return Object.entries(JSON.parse(raw)).map(([pattern, signal]) => ({
      pattern,
      signal: String(signal).toLowerCase(),
      re: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }));
  } catch (err) {
    console.error('[onvif] WELFARE_ONVIF_TOPICS is not valid JSON, ignoring it:', err.message);
    return [];
  }
}

/** Values a camera uses to mean "this is happening". */
const TRUTHY = new Set(['true', '1', 'on', 'yes', 'active', 'start', 'started']);

/** Data item names that carry the on/off state of a property event.
 *  Confirmed against MS-C2972-RFPG1 fw 63.8.0.6-r1 on 2026-09-08: the audio
 *  classifier reports IsAudioAed=true then IsAudioAed=false a few seconds
 *  later, and AudioAnalytics/Audio/DetectedSound uses isSoundDetected. Without
 *  those names here the clear message reads as a second alarm and every shout
 *  raises two alerts. */
const STATE_KEY = /state|isfall|isviolen|isaudio|issound|active|logical|alarm|trigger/i;

/**
 * Decide whether a notification is one of our three signals, and whether it is
 * asserting the condition or clearing it.
 *
 * Returns { signal, firing, matchedBy } — signal null when unrecognised.
 */
function classify(msg, bindings = topicBindings()) {
  const haystack = `${msg.topic || ''} ${JSON.stringify(msg.data || {})} ${JSON.stringify(msg.source || {})}`;

  let signal = null;
  let matchedBy = null;

  // Operator configuration wins over everything: it is the only source that
  // knows what this particular camera on this particular build actually emits.
  for (const b of bindings) {
    if (b.re.test(haystack)) { signal = b.signal; matchedBy = `binding:${b.pattern}`; break; }
  }
  // Then the strings Milesight confirmed, matched against the topic only. The
  // topic is authoritative; the payload is not, and matching these against a
  // whole payload would let a data item mentioning a topic name misclassify.
  if (!signal) {
    const topic = String(msg.topic || '');
    for (const [name, vendorTopic] of VENDOR_TOPICS) {
      if (topic.startsWith(vendorTopic)) { signal = name; matchedBy = `vendor:${vendorTopic}`; break; }
    }
  }
  if (!signal) {
    for (const [name, re] of KEYWORDS) {
      if (re.test(haystack)) { signal = name; matchedBy = `keyword:${name}`; break; }
    }
  }
  if (!signal) return { signal: null, firing: false, matchedBy: null };

  // A property event carries its state in a data item. When such an item is
  // present and false, this message is the CLEAR, not the alarm — the person
  // has got up, the fight has stopped. Alerting on it would double every
  // incident and put a fall alert on the console after the fall ended.
  let firing = true;
  for (const [key, value] of Object.entries(msg.data || {})) {
    if (!STATE_KEY.test(key)) continue;
    firing = TRUTHY.has(String(value).trim().toLowerCase());
    break;
  }

  // Subscription baseline, not a detection. See design decision 4.
  if (msg.operation === 'Initialized') firing = false;

  return { signal, firing, matchedBy };
}

// ---------------------------------------------------------------------------
// SOAP
// ---------------------------------------------------------------------------

const NS = {
  env: 'http://www.w3.org/2003/05/soap-envelope',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  pwd: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest',
  b64: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary',
  wsa: 'http://www.w3.org/2005/08/addressing',
};

/** WS-UsernameToken with a PasswordDigest.
 *
 *  The Created timestamp must be within the camera's own clock tolerance, and
 *  a camera with no NTP can be minutes or years out. clockOffsetMs is measured
 *  once from GetSystemDateAndTime and applied here, which is the difference
 *  between authenticating and a stream of "sender not authorized".
 */
function securityHeader(user, pass, clockOffsetMs = 0) {
  if (!user) return '';
  const nonce = crypto.randomBytes(16);
  const created = new Date(Date.now() + clockOffsetMs).toISOString();
  const digest = crypto.createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(pass, 'utf8')]))
    .digest('base64');

  return `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" s:mustUnderstand="1">`
    + '<wsse:UsernameToken>'
    + `<wsse:Username>${xmlEscape(user)}</wsse:Username>`
    + `<wsse:Password Type="${NS.pwd}">${digest}</wsse:Password>`
    + `<wsse:Nonce EncodingType="${NS.b64}">${nonce.toString('base64')}</wsse:Nonce>`
    + `<wsu:Created>${created}</wsu:Created>`
    + '</wsse:UsernameToken></wsse:Security>';
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function envelope(bodyXml, { user, pass, clockOffsetMs, to, action } = {}) {
  const addressing = to
    ? `<wsa:To s:mustUnderstand="1" xmlns:wsa="${NS.wsa}">${xmlEscape(to)}</wsa:To>`
      + (action ? `<wsa:Action s:mustUnderstand="1" xmlns:wsa="${NS.wsa}">${action}</wsa:Action>` : '')
    : '';
  const header = securityHeader(user, pass, clockOffsetMs) + addressing;
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<s:Envelope xmlns:s="${NS.env}">`
    + (header ? `<s:Header>${header}</s:Header>` : '')
    + `<s:Body>${bodyXml}</s:Body></s:Envelope>`;
}

/** One SOAP POST. Resolves on any HTTP status — a SOAP Fault arrives as a 500
 *  with a body worth reading, and throwing on status would discard it. */
function soapPost(url, xml, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (err) { reject(new Error(`bad ONVIF URL '${url}': ${err.message}`)); return; }

    const lib = target.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml),
    };
    // Basic alongside WS-Security. Some Milesight builds accept only one of
    // the two and there is no way to know which without trying; sending both
    // costs a header and removes a whole class of support ticket.
    if (USER) headers.Authorization = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers,
      rejectUnauthorized: false, // cameras ship self-signed certificates
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`ONVIF request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(xml);
  });
}

// ---------------------------------------------------------------------------
// XML reading
// ---------------------------------------------------------------------------

/** Namespace-agnostic element text. Prefixes vary by vendor and by call.
 *
 *  The tag name must be followed by whitespace, a slash or the closing angle
 *  bracket. Without that boundary, asking for `Username` matches the enclosing
 *  `<wsse:UsernameToken>` and returns the wrong element — which is exactly
 *  what it did before the self-test caught it. */
function tagText(xml, name) {
  const m = new RegExp(
    `<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}\\s*>`,
    'i',
  ).exec(xml || '');
  return m ? m[1].trim() : null;
}

function soapFault(xml) {
  const reason = tagText(xml, 'Text') || tagText(xml, 'faultstring');
  const code = tagText(xml, 'Value') || tagText(xml, 'faultcode');
  if (!/Fault/i.test(xml || '')) return null;
  return [code, reason].filter(Boolean).join(' — ') || 'SOAP Fault';
}

function simpleItems(block) {
  const out = {};
  if (!block) return out;
  const re = /<(?:\w+:)?SimpleItem\s+([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const attrs = m[1];
    const name = /Name\s*=\s*"([^"]*)"/i.exec(attrs);
    const value = /Value\s*=\s*"([^"]*)"/i.exec(attrs);
    if (name) out[name[1]] = value ? value[1] : '';
  }
  return out;
}

/**
 * Pull the notifications out of a PullMessagesResponse.
 *
 * Deliberately regex-based rather than a DOM parse: the shapes we care about
 * are shallow and fixed, and this keeps the module dependency-free. Anything
 * unrecognised still reaches the topic ring with its raw XML, so a parse this
 * simple cannot silently swallow an event.
 */
function parseNotifications(xml) {
  const out = [];
  const re = /<(?:\w+:)?NotificationMessage[^>]*>([\s\S]*?)<\/(?:\w+:)?NotificationMessage>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const topicRaw = tagText(block, 'Topic') || '';

    // A notification nests two Message elements: the WS-Notification wrapper
    // <wsnt:Message>, which carries nothing, and the ONVIF <tt:Message>, which
    // carries UtcTime and PropertyOperation. Requiring at least one attribute
    // skips the wrapper and finds the one that matters.
    const messageStart = /<(?:\w+:)?Message\s+[^>]*>/i.exec(block);
    const attrs = messageStart ? messageStart[0] : '';

    const sourceBlock = tagText(block, 'Source');
    const dataBlock = tagText(block, 'Data');
    const keyBlock = tagText(block, 'Key');

    out.push({
      topic: topicRaw.replace(/<[^>]*>/g, '').trim(),
      utc_time: (/UtcTime\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || null,
      operation: (/PropertyOperation\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || null,
      source: simpleItems(sourceBlock),
      key: simpleItems(keyBlock),
      data: simpleItems(dataBlock),
      raw: block.length > RAW_LIMIT_CHARS ? `${block.slice(0, RAW_LIMIT_CHARS)}…` : block,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  target: null,
  status: 'stopped',        // stopped | connecting | subscribed | error
  error: null,
  subscription: null,
  clock_offset_ms: 0,
  connected_at: null,
  last_pull_at: null,
  last_message_at: null,
  pulls: 0,
  messages: 0,
  recognised: 0,
  cleared: 0,
  baseline: 0,
  unrecognised: 0,
  relayed: 0,
  relay_failed: 0,
  reconnects: 0,
  topics: [],               // discovery ring, newest first
  seen_topics: Object.create(null),
};

function onvifState() {
  return {
    enabled: ENABLED,
    target: state.target,
    status: state.status,
    error: state.error,
    subscribed: state.status === 'subscribed',
    subscription: state.subscription,
    bus_id: BUS,
    mode: RELAY_URL ? 'relay' : 'local',
    relay_url: RELAY_URL || null,
    clock_offset_ms: state.clock_offset_ms,
    connected_at: state.connected_at,
    last_pull_at: state.last_pull_at,
    last_message_at: state.last_message_at,
    pull_timeout_sec: PULL_TIMEOUT_SEC,
    counters: {
      pulls: state.pulls,
      messages: state.messages,
      recognised: state.recognised,
      cleared: state.cleared,
      baseline: state.baseline,
      unrecognised: state.unrecognised,
      relayed: state.relayed,
      relay_failed: state.relay_failed,
      reconnects: state.reconnects,
    },
    distinct_topics: Object.keys(state.seen_topics).length,
    bindings: topicBindings().map((b) => ({ pattern: b.pattern, signal: b.signal })),
    vendor_topics: Object.fromEntries(VENDOR_TOPICS.map(([s, t]) => [t, s])),
  };
}

function remember(msg, verdict) {
  const topic = msg.topic || '(no topic)';
  const seen = state.seen_topics[topic] || { topic, count: 0, first_at: null, last_at: null, signal: null, firing: null };
  seen.count += 1;
  seen.last_at = new Date().toISOString();
  if (!seen.first_at) seen.first_at = seen.last_at;
  seen.signal = verdict.signal;
  seen.firing = verdict.firing;
  state.seen_topics[topic] = seen;

  state.topics.unshift({
    at: seen.last_at,
    topic,
    utc_time: msg.utc_time,
    operation: msg.operation,
    signal: verdict.signal,
    firing: verdict.firing,
    matched_by: verdict.matchedBy,
    source: msg.source,
    data: msg.data,
  });
  if (state.topics.length > TOPIC_RING) state.topics.length = TOPIC_RING;
}

// ---------------------------------------------------------------------------
// ONVIF conversation
// ---------------------------------------------------------------------------

function deviceServiceUrl(raw) {
  const t = String(raw).trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) {
    return /\/onvif\//i.test(t) ? t : `${t.replace(/\/+$/, '')}/onvif/device_service`;
  }
  return `http://${t.replace(/\/+$/, '')}/onvif/device_service`;
}

/** Measure the camera's clock. Unauthenticated by specification, which is why
 *  it is also the cheapest reachability test available. */
async function measureClock(deviceUrl) {
  const xml = envelope('<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>');
  const res = await soapPost(deviceUrl, xml, 10000);
  const utc = tagText(res.body, 'UTCDateTime');
  if (!utc) return 0;
  const y = tagText(utc, 'Year'); const mo = tagText(utc, 'Month'); const d = tagText(utc, 'Day');
  const h = tagText(utc, 'Hour'); const mi = tagText(utc, 'Minute'); const s = tagText(utc, 'Second');
  if (!y || !mo || !d) return 0;
  const cameraMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0), Number(s || 0));
  return cameraMs - Date.now();
}

/** Where the events service lives. Usually the same endpoint as the device
 *  service, but not on every build, and guessing wrong is a silent failure. */
async function findEventsService(deviceUrl) {
  const xml = envelope(
    '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>Events</Category></GetCapabilities>',
    { user: USER, pass: PASS, clockOffsetMs: state.clock_offset_ms },
  );
  const res = await soapPost(deviceUrl, xml, 10000);
  const events = tagText(res.body, 'Events');
  const xaddr = events ? tagText(events, 'XAddr') : null;
  return xaddr || deviceUrl;
}

async function createSubscription(eventsUrl) {
  const xml = envelope(
    '<CreatePullPointSubscription xmlns="http://www.onvif.org/ver10/events/wsdl">'
    + `<InitialTerminationTime>${TERMINATION}</InitialTerminationTime>`
    + '</CreatePullPointSubscription>',
    { user: USER, pass: PASS, clockOffsetMs: state.clock_offset_ms },
  );
  const res = await soapPost(eventsUrl, xml, 15000);
  const ref = tagText(res.body, 'SubscriptionReference');
  const addr = ref ? tagText(ref, 'Address') : null;
  if (!addr) {
    const fault = soapFault(res.body);
    throw new Error(`CreatePullPointSubscription failed (HTTP ${res.status})${fault ? `: ${fault}` : ''}`);
  }
  return addr;
}

async function pullMessages(subscriptionUrl) {
  const xml = envelope(
    '<PullMessages xmlns="http://www.onvif.org/ver10/events/wsdl">'
    + `<Timeout>PT${PULL_TIMEOUT_SEC}S</Timeout><MessageLimit>${MESSAGE_LIMIT}</MessageLimit>`
    + '</PullMessages>',
    {
      user: USER,
      pass: PASS,
      clockOffsetMs: state.clock_offset_ms,
      to: subscriptionUrl,
      action: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest',
    },
  );
  // The camera holds the request for the whole timeout, so the socket deadline
  // must exceed it or every long poll would look like a network failure.
  const res = await soapPost(subscriptionUrl, xml, (PULL_TIMEOUT_SEC + 15) * 1000);
  if (res.status >= 400) {
    const fault = soapFault(res.body);
    throw new Error(`PullMessages failed (HTTP ${res.status})${fault ? `: ${fault}` : ''}`);
  }
  return parseNotifications(res.body);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Relay to the cloud console over the route the HTTP adapter already owns.
 *  Uses the same token and the same URL shape the camera would have used, so
 *  the cloud side cannot tell — and does not need to — that the detection came
 *  in over ONVIF from a box on the bus LAN. */
async function relay(signal, detail) {
  const url = new URL(`${RELAY_URL}/api/welfare/camera/${signal}`);
  url.searchParams.set('bus', BUS);
  if (RELAY_TOKEN) url.searchParams.set('token', RELAY_TOKEN);
  const payload = JSON.stringify({ transport: 'onvif', ...detail });

  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`relay HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('relay timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** One recognised, firing detection. */
async function deliver(engine, store, signal, msg, verdict) {
  const detail = {
    transport: 'onvif',
    device: 'MS-C2972-RFPG1',
    topic: msg.topic,
    onvif_utc_time: msg.utc_time,
    property_operation: msg.operation,
    matched_by: verdict.matchedBy,
    source: msg.source,
    data: msg.data,
  };

  if (RELAY_URL) {
    try {
      await relay(signal, detail);
      state.relayed += 1;
      console.log(`[onvif] relayed ${signal} for ${BUS} → ${RELAY_URL}`);
    } catch (err) {
      state.relay_failed += 1;
      // Loud, and counted. A relay that fails silently is a welfare event that
      // never happened as far as the console is concerned.
      console.error(`[onvif] RELAY FAILED for ${signal} on ${BUS}: ${err.message}`);
    }
    return;
  }

  const result = camera.recordDetection({
    engine, store, signal, bus: BUS, via: 'onvif', detail,
  });
  if (result.accepted) {
    console.log(`[onvif] ${signal} recorded for ${BUS} as ${result.event_id}`);
  } else {
    console.log(`[onvif] ${signal} for ${BUS} folded into the previous event (${result.reason})`);
  }
}

// ---------------------------------------------------------------------------
// Listener loop
// ---------------------------------------------------------------------------

let running = false;
let stopRequested = false;

async function handleMessages(engine, store, messages) {
  const bindings = topicBindings();
  for (const msg of messages) {
    state.messages += 1;
    state.last_message_at = new Date().toISOString();
    const verdict = classify(msg, bindings);
    remember(msg, verdict);

    if (!verdict.signal) { state.unrecognised += 1; continue; }
    if (msg.operation === 'Initialized') { state.baseline += 1; continue; }
    if (!verdict.firing) { state.cleared += 1; continue; }

    state.recognised += 1;
    // Sequential, not parallel: a bus produces a handful of events a day and
    // the compound rule reads state the previous delivery just wrote.
    // eslint-disable-next-line no-await-in-loop
    await deliver(engine, store, verdict.signal, msg, verdict);
  }
}

async function loop(engine, store) {
  let backoff = BACKOFF_MIN_MS;

  while (!stopRequested) {
    try {
      state.status = 'connecting';
      state.error = null;

      const deviceUrl = deviceServiceUrl(RAW_TARGET);
      state.target = deviceUrl;

      state.clock_offset_ms = await measureClock(deviceUrl);
      if (Math.abs(state.clock_offset_ms) > 5000) {
        console.warn(`[onvif] camera clock is ${Math.round(state.clock_offset_ms / 1000)}s from ours — compensating in the auth token`);
      }

      const eventsUrl = await findEventsService(deviceUrl);
      const subscription = await createSubscription(eventsUrl);

      state.subscription = subscription;
      state.status = 'subscribed';
      state.connected_at = new Date().toISOString();
      state.error = null;
      backoff = BACKOFF_MIN_MS;
      console.log(`[onvif] subscribed to ${subscription}`);

      while (!stopRequested) {
        const startedAt = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const messages = await pullMessages(subscription);
        state.pulls += 1;
        state.last_pull_at = new Date().toISOString();

        if (messages.length) {
          // eslint-disable-next-line no-await-in-loop
          await handleMessages(engine, store, messages);
          continue;
        }

        const elapsed = Date.now() - startedAt;
        if (elapsed < IDLE_FLOOR_MS) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => {
            const t = setTimeout(r, IDLE_FLOOR_MS - elapsed);
            if (t.unref) t.unref();
          });
        }
      }
    } catch (err) {
      if (stopRequested) break;
      state.status = 'error';
      state.error = err.message;
      state.subscription = null;
      state.reconnects += 1;
      console.error(`[onvif] ${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { const t = setTimeout(r, backoff); if (t.unref) t.unref(); });
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  running = false;
  state.status = 'stopped';
}

function start(engine, store) {
  if (running) return false;
  running = true;
  stopRequested = false;
  loop(engine, store).catch((err) => {
    running = false;
    state.status = 'error';
    state.error = err.message;
    console.error('[onvif] listener stopped:', err.message);
  });
  return true;
}

function stop() {
  stopRequested = true;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function createOnvifRouter() {
  const router = express.Router();

  router.get('/onvif/status', (req, res) => res.json(onvifState()));

  /** Discovery. This is the endpoint that tells us what the camera actually
   *  calls its welfare events, which is the one thing no datasheet does. */
  router.get('/onvif/topics', (req, res) => {
    const distinct = Object.values(state.seen_topics)
      .sort((a, b) => b.count - a.count);
    res.json({
      distinct,
      recent: state.topics.slice(0, Math.min(TOPIC_RING, Number(req.query.limit) || TOPIC_RING)),
      unbound: distinct.filter((t) => !t.signal).map((t) => t.topic),
      state: onvifState(),
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initOnvif(engine, store) {
  if (!ENABLED) {
    console.log('[onvif] disabled (set FEATURE_WELFARE_ONVIF=true to enable)');
    return false;
  }
  if (!RAW_TARGET) {
    console.error('[onvif] FEATURE_WELFARE_ONVIF is on but WELFARE_ONVIF_URL is not set — not starting');
    return false;
  }
  if (!USER) {
    console.warn('[onvif] WELFARE_ONVIF_USER is not set — most cameras reject unauthenticated event subscriptions');
  }

  state.target = deviceServiceUrl(RAW_TARGET);
  console.log(`[onvif] listener starting: ${state.target} · bus ${BUS} · ${RELAY_URL ? `relay → ${RELAY_URL}` : 'writing locally'}`);
  start(engine, store);
  return true;
}

module.exports = {
  initOnvif,
  createOnvifRouter,
  onvifState,
  stop,
  ENABLED,
  // exported for the self-test and the probe script
  _internal: {
    classify,
    parseNotifications,
    simpleItems,
    tagText,
    soapFault,
    envelope,
    soapPost,
    securityHeader,
    deviceServiceUrl,
    measureClock,
    findEventsService,
    createSubscription,
    pullMessages,
    handleMessages,
    state,
    start,
    topicBindings,
    VENDOR_TOPICS,
  },
};
