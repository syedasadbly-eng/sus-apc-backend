/* ============================================
   DRIVER DISPLAY API — Smart Urban Sensing welfare layer

   The cab screen (public/driver.html) talks only to these routes:

     GET  /api/welfare/driver/:bus               what this bus's screen shows now
     POST /api/welfare/driver/:bus/ack/:eventId  driver pressed SEEN

   Why separate routes rather than reusing /events:
     - PIN-protected. A tablet left in a cab must not be able to read the whole
       fleet's welfare log or acknowledge another bus's alerts.
     - Minimal. The response carries only what the screen draws: no camera IP,
       no raw payload, no other vehicle.
     - The alert filter lives here, so the screen and the console's Driver
       Screens view cannot drift apart on what reaches a driver.

   PIN:
     WELFARE_DRIVER_PIN   one PIN for every cab, e.g. 4821
     WELFARE_DRIVER_PINS  optional per-bus PINs, JSON: {"515":"4821","419":"7734"}
                          A bus listed here uses its own PIN, others use the fleet one.
     Neither set: the routes stay open, which is logged loudly at startup and
     reported as pin_required:false so the screen can say so.

   The PIN travels in the X-Driver-Pin header. Five wrong attempts from one
   address lock that address out for five minutes.
   ============================================ */

'use strict';

const crypto = require('crypto');
const express = require('express');

/** Alert types that reach a cab. Everything else stays on the console:
 *  sensor health, count drift, dwell, and a sound on its own. */
const DRIVER_TYPES = new Set([
  'fall',
  'violence',
  'violence_disruption',
  'end_of_service_occupancy',
  'terminus_occupancy',
  'lone_traveller_late_night',
  'stationary_with_occupants',
]);

const WINDOW_MIN = Number(process.env.WELFARE_DRIVER_WINDOW_MIN || 10);
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

function fleetPin() { return String(process.env.WELFARE_DRIVER_PIN || ''); }
function busPins() {
  try {
    return process.env.WELFARE_DRIVER_PINS ? JSON.parse(process.env.WELFARE_DRIVER_PINS) : {};
  } catch {
    console.error('[driver] WELFARE_DRIVER_PINS is not valid JSON, ignoring it');
    return {};
  }
}
function pinFor(bus) {
  const own = busPins()[String(bus)];
  return own != null && own !== '' ? String(own) : fleetPin();
}
function pinRequired(bus) { return pinFor(bus) !== ''; }

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const fails = new Map(); // ip -> { n, until }
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket?.remoteAddress || '').trim();
}

function requirePin(req, res, next) {
  const bus = String(req.params.bus || '');
  if (!pinRequired(bus)) return next();

  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.until > Date.now()) {
    const retry = Math.ceil((f.until - Date.now()) / 1000);
    res.set('Retry-After', String(retry));
    return res.status(429).json({ error: 'locked', retry_after_sec: retry });
  }

  const given = req.get('X-Driver-Pin') || '';
  if (given && safeEqual(given, pinFor(bus))) {
    fails.delete(ip);
    return next();
  }
  if (given) {
    const expired = f && f.until && f.until <= Date.now();
    const n = (expired ? 0 : f?.n || 0) + 1;
    fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    if (n >= MAX_FAILS) console.warn(`[driver] ${ip} locked out after ${n} wrong PINs for bus ${bus}`);
  }
  return res.status(401).json({ error: given ? 'wrong_pin' : 'pin_required' });
}

/** The alerts this bus's screen should show right now, worst first. */
function activeFor(store, bus) {
  const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
  const rows = store.query({ busId: bus, from: since, unackOnly: true, limit: 50 });
  return rows.filter((e) => DRIVER_TYPES.has(e.event_type));
}

function createDriverRouter(engine, store) {
  const router = express.Router();
  router.use(express.json());

  router.get('/driver/:bus', requirePin, (req, res) => {
    const bus = String(req.params.bus);
    const includeTests = req.query.test === '1';
    let health = null;
    try {
      health = (engine.fleetHealth() || []).find((h) => String(h.bus_id) === bus) || null;
    } catch { health = null; }
    try {
      const alerts = activeFor(store, bus)
        .filter((e) => includeTests || e.source !== 'simulated')
        .map((e) => ({
          event_id: e.event_id,
          event_type: e.event_type,
          detected_at: e.detected_at,
          severity: e.severity,
          simulated: e.source === 'simulated',
        }));
      res.json({
        bus,
        pin_required: pinRequired(bus),
        window_min: WINDOW_MIN,
        monitoring: health ? {
          trustworthy: Boolean(health.trustworthy),
          off_shift: Boolean(health.off_shift),
          never_reported: Boolean(health.never_reported),
        } : null,
        alerts,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/driver/:bus/ack/:eventId', requirePin, (req, res) => {
    const bus = String(req.params.bus);
    const id = String(req.params.eventId);
    // Only this bus's own, currently showing alerts. A cab cannot clear
    // another vehicle's alert, or an old one, by guessing an id.
    let mine = false;
    try { mine = activeFor(store, bus).some((e) => e.event_id === id); } catch { mine = false; }
    if (!mine) return res.status(404).json({ acknowledged: false });
    const ok = store.acknowledge(id, `driver:${bus}`);
    return res.status(ok ? 200 : 404).json({ acknowledged: Boolean(ok) });
  });

  return router;
}

function initDriver() {
  if (!fleetPin() && !Object.keys(busPins()).length) {
    console.warn('[driver] WELFARE_DRIVER_PIN is not set — /api/welfare/driver/* is open to anyone with the link');
  } else {
    console.log(`[driver] PIN required (${Object.keys(busPins()).length} per-bus, fleet PIN ${fleetPin() ? 'set' : 'not set'})`);
  }
  return true;
}

module.exports = { createDriverRouter, initDriver, DRIVER_TYPES, _test: { fails } };
