#!/usr/bin/env node
/* ============================================
   HTTP NOTIFICATION LISTENER — is it the camera, or is it the network?
   Smart Urban Sensing

   Milesight tested HTTP Notification on this model and firmware on their bench
   and it worked, so they suspect our network. Fair. But a public webhook test
   crosses the camera's HTTP client, the UR35, DNS, the SIM's APN policy, TLS
   and the public internet in one hop, and when nothing arrives it says nothing
   about which of those failed.

   This removes all of them. Run it on a laptop on the SAME LAN as the camera
   and point HTTP Notification at that laptop's private address. If a request
   arrives here, the camera is configured correctly and the fault is egress. If
   nothing arrives here either, the fault is on the camera and Milesight has a
   reproducible case.

   Usage:
     node scripts/notify-listener.js
     node scripts/notify-listener.js --port 8080

   Then set on the camera, per event, under Alarm Action → HTTP Notification:
     URL:    http://<this-laptop-ip>:8080/fall
     Method: POST
     (leave user/password empty for this test)

   Everything received is printed in full and appended to
   notify-capture.log in the working directory. HTTP only, no TLS, no
   dependencies, no auth — it is a diagnostic, not a service. Do not expose it
   to the internet.
   ============================================ */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const port = Number(arg('port', 8080));
const logFile = path.resolve(process.cwd(), String(arg('log', 'notify-capture.log')));

let count = 0;

/** Every non-internal IPv4 address, so the operator can see which one to type
 *  into the camera without going hunting for it. */
function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function record(text) {
  process.stdout.write(text);
  try { fs.appendFileSync(logFile, text); } catch { /* console output is enough */ }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    count += 1;
    const raw = Buffer.concat(chunks);
    const type = String(req.headers['content-type'] || '');

    let bodyView;
    if (!raw.length) {
      bodyView = '(empty)';
    } else if (type.startsWith('multipart/') || type.startsWith('image/')) {
      // Almost certainly a snapshot attached to the notification. Do not dump
      // binary into a terminal; record that it arrived and how big it was.
      bodyView = `<${raw.length} bytes of ${type || 'binary'}>`;
    } else {
      const text = raw.toString('utf8');
      try {
        bodyView = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        bodyView = text;
      }
    }

    const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const lines = [
      '',
      '─'.repeat(78),
      `#${count}  ${new Date().toISOString()}  from ${from}`,
      '─'.repeat(78),
      `${req.method} ${req.url}`,
      '',
      'Headers:',
      ...Object.entries(req.headers).map(([k, v]) => `  ${k}: ${v}`),
      '',
      'Body:',
      bodyView.split('\n').map((l) => `  ${l}`).join('\n'),
      '',
    ];
    record(`${lines.join('\n')}\n`);

    // Always 200, and always fast. A Milesight camera treats a non-2xx or a
    // slow reply as a delivery failure, and this listener exists to prove
    // delivery, not to test the camera's error handling.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true, seq: count }));
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is already in use. Try: node scripts/notify-listener.js --port 8081\n`);
  } else {
    console.error(`\nCould not start listener: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  const addrs = localAddresses();
  console.log(`\n${'═'.repeat(78)}`);
  console.log('HTTP NOTIFICATION LISTENER');
  console.log('═'.repeat(78));
  console.log(`Listening on port ${port}, all interfaces. Logging to ${logFile}`);
  console.log('\nSet one of these as the HTTP Notification URL on the camera:\n');
  if (addrs.length) {
    for (const a of addrs) console.log(`  http://${a.address}:${port}/fall      (${a.name})`);
  } else {
    console.log('  No external network interface found — is this machine on the camera LAN?');
  }
  console.log('\nUse the LAN address that is on the same subnet as the camera.');
  console.log('Method: POST. Leave username and password empty for this test.');
  console.log('\nThen trigger the event and watch this window. Ctrl-C to stop.');
  console.log('─'.repeat(78));
});

process.on('SIGINT', () => {
  console.log(`\n\n${count} request${count === 1 ? '' : 's'} received.`);
  if (!count) {
    console.log('\nNothing arrived. If the camera can reach this machine at all, the fault is');
    console.log('on the camera side — which is a reproducible case for Milesight. Check first:');
    console.log('  · the URL has no typo and uses this machine\'s LAN address, not a hostname');
    console.log('  · the event itself is enabled and its arming schedule covers now');
    console.log('  · HTTP Notification is ticked in that event\'s Alarm Action, and saved');
    console.log('  · this machine\'s firewall allows inbound connections on the port');
    console.log('  · the event actually triggered (check the camera\'s own event log)');
  } else {
    console.log(`\nThe camera is configured correctly and can deliver notifications.`);
    console.log('If a public URL still receives nothing, the fault is egress: DNS on the');
    console.log('camera, the UR35 firewall, TLS support in the camera\'s HTTP client, or the');
    console.log(`SIM's APN policy. Full capture in ${logFile}`);
  }
  console.log('');
  process.exit(0);
});
