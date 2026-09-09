#!/usr/bin/env node
/* ============================================
   WELFARE ONVIF RELAY — standalone on-site listener
   Smart Urban Sensing

   Subscribes to the camera's ONVIF PullPoint event service on the LAN and
   relays every recognised detection to the cloud welfare console over the
   existing token-gated /api/welfare/camera/:signal route.

   No database, no MQTT, no server. Run it on any machine that can reach the
   camera and the internet. Node 18+.

   Usage (arguments override environment variables):
     node scripts/welfare-onvif-relay.js --host 192.168.1.200 --user admin \
       --pass 'secret' --relay https://your-console.up.railway.app \
       --token 'WELFARE_CAMERA_TOKEN' --bus lab-rig

   For observe-only discovery without sending anything, use
   scripts/onvif-probe.js instead.
   ============================================ */

'use strict';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const host = arg('host') || process.env.WELFARE_ONVIF_URL;
const user = arg('user') || process.env.WELFARE_ONVIF_USER || 'admin';
const pass = arg('pass') || process.env.WELFARE_ONVIF_PASS || '';
const relay = arg('relay') || process.env.WELFARE_ONVIF_RELAY_URL || '';
const token = arg('token') || process.env.WELFARE_ONVIF_RELAY_TOKEN
  || process.env.WELFARE_CAMERA_TOKEN || '';
const bus = arg('bus') || process.env.WELFARE_ONVIF_BUS || 'lab-rig';

if (!host) {
  console.error('Missing --host. Example:');
  console.error("  node scripts/welfare-onvif-relay.js --host 192.168.1.200 --user admin --pass 'secret'");
  process.exit(1);
}
if (!relay) {
  console.error('Missing --relay (the welfare console base URL).');
  console.error(`For observe-only discovery run: node scripts/onvif-probe.js --host ${host} --user ${user} --pass '...'`);
  process.exit(1);
}
if (!token) {
  console.error('Missing --token. The console rejects untokenised posts.');
  process.exit(1);
}

// The listener module reads its configuration from the environment, so set it
// before requiring it.
process.env.FEATURE_WELFARE = 'true';
process.env.FEATURE_WELFARE_ONVIF = 'true';
process.env.WELFARE_ONVIF_URL = String(host);
process.env.WELFARE_ONVIF_USER = String(user);
process.env.WELFARE_ONVIF_PASS = String(pass);
process.env.WELFARE_ONVIF_BUS = String(bus);
process.env.WELFARE_ONVIF_RELAY_URL = String(relay);
process.env.WELFARE_ONVIF_RELAY_TOKEN = String(token);

// eslint-disable-next-line import/no-dynamic-require
const onvif = require('../welfare/onvif');

const state = onvif._internal.state;

console.log('============================================');
console.log(' Welfare ONVIF relay');
console.log(`   camera : ${host} (user ${user})`);
console.log(`   bus    : ${bus}`);
console.log(`   relay  : ${relay}`);
console.log('   stop   : Ctrl-C');
console.log('============================================');

if (!onvif.initOnvif(null, null)) {
  console.error('Listener refused to start. Check the arguments above.');
  process.exit(1);
}

// Heartbeat, so an idle terminal still shows the subscription is alive.
const beat = setInterval(() => {
  const s = onvif.onvifState();
  const c = s.counters || {};
  console.log(`[status] ${s.status} · pulls ${c.pulls || 0} · messages ${c.messages || 0}`
    + ` · recognised ${c.recognised || 0} · relayed ${c.relayed || 0}`
    + ` · distinct topics ${s.distinct_topics || 0}`
    + (c.relay_failed ? ` · RELAY FAILED ${c.relay_failed}` : '')
    + (s.error ? ` · last error: ${s.error}` : ''));
}, 30000);
if (beat.unref) beat.unref();

function summarise() {
  clearInterval(beat);
  const topics = Object.values(state.seen_topics || {});
  console.log('\n--------------------------------------------');
  console.log('Topics seen this run:');
  if (!topics.length) {
    console.log('  (none — the camera sent no notifications)');
  } else {
    const binding = {};
    topics
      .sort((a, b) => b.count - a.count)
      .forEach((t) => {
        console.log(`  ${String(t.count).padStart(4)} × ${t.topic}${t.signal ? `  → ${t.signal}` : '  → UNBOUND'}`);
        if (t.signal) binding[t.topic] = t.signal;
      });
    if (Object.keys(binding).length) {
      console.log('\nPin these bindings on the service with:');
      console.log(`  WELFARE_ONVIF_TOPICS='${JSON.stringify(binding)}'`);
    }
  }
  console.log('--------------------------------------------');
  process.exit(0);
}

process.on('SIGINT', summarise);
process.on('SIGTERM', summarise);
