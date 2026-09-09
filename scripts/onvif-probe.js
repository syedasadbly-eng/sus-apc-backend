#!/usr/bin/env node
/* ============================================
   ONVIF PROBE — what does this camera actually emit?
   Smart Urban Sensing

   Run this on a machine that can reach the camera. It talks to the ONVIF
   device service, subscribes to the PullPoint event service, and prints every
   notification the camera sends, decoded, until you stop it.

   The point is discovery. Milesight does not publish the ONVIF topic strings
   for Fall Detection, Violence Detection or Sound Classification, and they
   differ between firmware builds. Rather than guess, stage each event in front
   of the lens with this running and read the topic off the screen. Then bind
   it exactly with WELFARE_ONVIF_TOPICS and stop relying on keyword matching.

   Usage:
     node scripts/onvif-probe.js --host 192.168.1.200 --user admin --pass 'secret'
     node scripts/onvif-probe.js --host 192.168.1.200 --user admin --pass 'secret' --seconds 300
     node scripts/onvif-probe.js --host 192.168.1.200 --user admin --pass 'secret' --raw

   No dependencies beyond Node 18. Nothing on the camera is modified: this
   creates a subscription and reads from it, which is what any NVR does.
   ============================================ */

'use strict';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const host = arg('host') || arg('url');
const user = arg('user') || '';
const pass = arg('pass') || '';
const seconds = Number(arg('seconds', 0)) || 0;
const showRaw = Boolean(arg('raw', false));

if (!host) {
  console.error(`
ONVIF probe — reads the events a camera publishes

  node scripts/onvif-probe.js --host <ip-or-url> --user <user> --pass <pass> [--seconds N] [--raw]

  --host      camera IP, host, or full device service URL
  --user      ONVIF user (usually the camera's admin account)
  --pass      that user's password
  --seconds   stop after N seconds (default: run until Ctrl-C)
  --raw       also print the raw XML of every notification
`);
  process.exit(2);
}

// The listener module carries the whole SOAP conversation. Reusing it here
// means the probe exercises the same code that will run in production — a
// probe with its own client would prove nothing about the listener.
process.env.WELFARE_ONVIF_URL = String(host);
process.env.WELFARE_ONVIF_USER = user;
process.env.WELFARE_ONVIF_PASS = pass;
process.env.FEATURE_WELFARE_ONVIF = 'true';

const onvif = require('../welfare/onvif');
const {
  classify, deviceServiceUrl, measureClock, findEventsService,
  createSubscription, pullMessages, tagText, envelope, soapPost,
} = onvif._internal;

const SIGNAL_LABEL = {
  fall: 'FALL',
  violence: 'VIOLENCE',
  sound: 'SOUND',
};

const seen = new Map();

function line(char = '─', n = 78) { return char.repeat(n); }

function describe(msg) {
  const verdict = classify(msg);
  const key = msg.topic || '(no topic)';
  const prior = seen.get(key) || { count: 0 };
  prior.count += 1;
  prior.signal = verdict.signal;
  seen.set(key, prior);

  const stamp = new Date().toISOString().slice(11, 19);
  const tag = verdict.signal
    ? `${SIGNAL_LABEL[verdict.signal]}${verdict.firing ? '' : ' (clear)'}`
    : 'unmapped';

  console.log(`\n[${stamp}] ${tag}  ${msg.topic || '(no topic)'}`);
  if (msg.operation) console.log(`           operation: ${msg.operation}`);
  if (msg.utc_time) console.log(`           camera time: ${msg.utc_time}`);
  if (Object.keys(msg.source).length) console.log(`           source: ${JSON.stringify(msg.source)}`);
  if (Object.keys(msg.data).length) console.log(`           data:   ${JSON.stringify(msg.data)}`);
  if (verdict.signal) console.log(`           matched by: ${verdict.matchedBy}, firing: ${verdict.firing}`);
  if (showRaw) console.log(`           raw: ${msg.raw}`);
}

function summary() {
  console.log(`\n${line()}`);
  console.log('TOPICS SEEN');
  console.log(line());
  if (!seen.size) {
    console.log('\nNothing. The subscription worked but the camera published no events.');
    console.log('Trigger something in front of the lens — wave at it, make a noise, stage a fall —');
    console.log('and check that the event is enabled under Settings → Event on the camera.\n');
    return;
  }
  const rows = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [topic, info] of rows) {
    const mapped = info.signal ? `→ ${info.signal}` : '→ (unmapped)';
    console.log(`  ${String(info.count).padStart(4)}  ${topic}  ${mapped}`);
  }

  const unmapped = rows.filter(([, i]) => !i.signal).map(([t]) => t);
  const mapped = rows.filter(([, i]) => i.signal);

  if (mapped.length) {
    console.log('\nBIND THESE — set on the service running the listener:');
    const binding = Object.fromEntries(mapped.map(([t, i]) => [t, i.signal]));
    console.log(`\n  WELFARE_ONVIF_TOPICS='${JSON.stringify(binding)}'\n`);
  }
  if (unmapped.length) {
    console.log('Unmapped topics. If any of these is the welfare event you staged,');
    console.log('add it to WELFARE_ONVIF_TOPICS with the signal it represents:\n');
    for (const t of unmapped) console.log(`  "${t}": "fall" | "violence" | "sound"`);
    console.log('');
  }
}

async function main() {
  const deviceUrl = deviceServiceUrl(host);
  console.log(`\n${line('═')}`);
  console.log('ONVIF PROBE');
  console.log(line('═'));
  console.log(`Device service: ${deviceUrl}`);
  console.log(`User:           ${user || '(none — most cameras will refuse)'}`);

  // 1. Reachability and clock. GetSystemDateAndTime needs no credentials, so
  //    it separates "cannot reach the camera" from "credentials are wrong".
  let offset = 0;
  try {
    offset = await measureClock(deviceUrl);
    console.log(`Clock offset:   ${Math.round(offset / 1000)}s ${offset > 0 ? 'ahead of' : 'behind'} this machine`);
    if (Math.abs(offset) > 5000) {
      console.log('                (compensated automatically — but set NTP on the camera)');
    }
  } catch (err) {
    console.error(`\nCannot reach the ONVIF service: ${err.message}`);
    console.error('\nCheck: the IP is right, you are on the same network, and ONVIF is enabled');
    console.error('on the camera (Settings → Network → ONVIF, or under System → Security).\n');
    process.exit(1);
  }
  onvif._internal.state.clock_offset_ms = offset;

  // 2. Device identity, so the log says which camera this was.
  try {
    const { body } = await soapPost(
      deviceUrl,
      envelope('<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>',
        { user, pass, clockOffsetMs: offset }),
      10000,
    );
    const model = tagText(body, 'Model');
    const fw = tagText(body, 'FirmwareVersion');
    const serial = tagText(body, 'SerialNumber');
    if (model) console.log(`Camera:         ${model}${fw ? ` · firmware ${fw}` : ''}${serial ? ` · S/N ${serial}` : ''}`);
  } catch {
    // Identity is a nicety. Never let it stop the probe.
  }

  // 3. Events service and subscription.
  let eventsUrl;
  let subscription;
  try {
    eventsUrl = await findEventsService(deviceUrl);
    console.log(`Events service: ${eventsUrl}`);
    subscription = await createSubscription(eventsUrl);
    console.log(`Subscription:   ${subscription}`);
  } catch (err) {
    console.error(`\nSubscription failed: ${err.message}`);
    console.error('\nIf this says "not authorized", the ONVIF user or password is wrong, or the');
    console.error('account lacks event permissions. Milesight ONVIF users are configured');
    console.error('separately from web-interface users on some builds — check both.\n');
    process.exit(1);
  }

  console.log(`\nListening. Stage a fall, a shout, or a scuffle in front of the camera.`);
  console.log(seconds ? `Stopping automatically after ${seconds}s.` : 'Ctrl-C to stop.');
  console.log(line());

  let stop = false;
  const finish = () => {
    if (stop) return;
    stop = true;
    summary();
    process.exit(0);
  };
  process.on('SIGINT', finish);
  if (seconds) setTimeout(finish, seconds * 1000);

  let pulls = 0;
  while (!stop) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const messages = await pullMessages(subscription);
      pulls += 1;
      if (!messages.length) {
        process.stdout.write(`\r  ${pulls} pulls, ${seen.size} distinct topics, nothing new…   `);
        continue;
      }
      for (const msg of messages) describe(msg);
    } catch (err) {
      console.error(`\n  pull failed: ${err.message} — resubscribing`);
      try {
        // eslint-disable-next-line no-await-in-loop
        subscription = await createSubscription(eventsUrl);
      } catch (err2) {
        console.error(`  resubscribe failed: ${err2.message}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}

main().catch((err) => {
  console.error('\nprobe crashed:', err.message);
  process.exit(1);
});
