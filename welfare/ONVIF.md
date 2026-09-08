# ONVIF PullPoint ingest — AI Pro Dome → welfare console

## Why this exists

The AI Pro Dome (MS-C2972-RFPG1, firmware 63.8.0.6-r1) does not offer **HTTP
Notification** as an alarm action for the three signals the welfare console
needs: Fall Detection, Violence Detection and Sound Classification. Those
events were introduced in firmware 63.8.0.5-r4 and the alarm actions available
to them are not the full set the older event types get. No camera-side
configuration changes that.

ONVIF reverses the direction of travel. Instead of the camera pushing to us, we
subscribe to its **PullPoint event service** and pull. Nothing has to be
configured on the camera except ONVIF being on and a user account existing, so
there is no missing alarm-action menu to work around.

`welfare/camera.js` (HTTP Notification) and `welfare/onvif.js` (PullPoint) share
one record path — `camera.recordDetection()`. Cooldown, the violence+sound
compound rule, vehicle context, counters and the live feed behave identically
whichever transport delivered the detection. The transport is recorded in
`detail.transport`; it is not a second class of event.

## Topology

The camera is on the vehicle LAN behind the UR35 at a private address. Railway
cannot reach `192.168.1.200` and never will. So the listener runs **on-site**,
in one of two modes.

### Relay mode (the deployable one)

```
AI Pro Dome ──ONVIF/LAN──▶ on-site box ──HTTPS──▶ Railway console
192.168.1.200              (Pi / mini PC /        /api/welfare/camera/:signal
                            laptop, running
                            this repo)
```

The on-site box holds the ONVIF subscription and POSTs each detection to the
cloud console over the route the HTTP adapter already owns. The cloud side
needs no new ingest surface and no new authentication — it already trusts that
route with `WELFARE_CAMERA_TOKEN`. Set `WELFARE_ONVIF_RELAY_URL` to switch this
on. Only outbound HTTPS is required from the UR35, which is what it already
does for MQTT.

### Local mode

No relay URL set. Detections are written straight into the local SQLite
database and appear in the local console. Use this on the bench, or on a
vehicle that runs its own console.

## The topic strings, confirmed by the vendor

Milesight technical support supplied these on 2026-09-08 for MS-C2972-RFPG1 on
firmware 63.8.0.6-r1, confirming that the MSense events **do** publish as ONVIF
PullPoint topics:

| Signal | Topic |
|---|---|
| Fall Detection | `tns1:RuleEngine/FallDetector/Fall` |
| Violence Detection | `tns1:RuleEngine/ViolenceDetector/Violence` |
| Sound Classification | `tns1:RuleEngine/AudioDetector/Class` |

These are built into `welfare/onvif.js` as `VENDOR_TOPICS` and matched as
prefixes, so a per-rule instance suffix does not break recognition. They are
matched against the topic only, never the payload. `WELFARE_ONVIF_TOPICS` still
outranks them, because an operator who has probed their own camera knows better
than a support email.

Note also that the **Push Event Type** list under Network → More is *not*
relevant here. Milesight confirmed it governs pushing to their own app and NVR;
its omission of the MSense events says nothing about third-party subscribers.

## Confirm what your camera actually emits

Topic names have already been shown to shift between firmware builds and VMS
profiles, so verify rather than assume. From a machine that can reach the
camera:

```bash
node scripts/onvif-probe.js --host 192.168.1.200 --user admin --pass 'yourpass'
```

Then stage each event in front of the lens — lie down on the floor, shout,
scuffle with a colleague — and read the topic off the screen. Every notification
is printed decoded, and on exit the probe prints a ready-made
`WELFARE_ONVIF_TOPICS` value binding what it recognised.

```
[02:47:28] FALL  tns1:RuleEngine/MilesightRule/FallDetection
           operation: Changed
           data:   {"IsFall":"true"}
           matched by: keyword:fall, firing: true
```

Options: `--seconds N` to stop automatically, `--raw` to dump the XML of every
notification.

If the probe reports `not authorized`, the ONVIF account is the problem, not the
network — on some Milesight builds ONVIF users are managed separately from
web-interface users. Check both.

If the probe subscribes but nothing arrives, the event is not enabled on the
camera. Fall and Violence Detection cannot run at the same time as VCA Event,
Object Counting, Face Detection, Heat Map or Attribute Extraction, so one of
those has to come off first.

## Configuration

| Variable | Purpose |
|---|---|
| `FEATURE_WELFARE` | Must be `true` — the whole welfare layer is behind it |
| `FEATURE_WELFARE_ONVIF` | `true` to start the listener. Default off |
| `WELFARE_ONVIF_URL` | Camera address. `192.168.1.200`, `http://192.168.1.200` or a full device-service URL |
| `WELFARE_ONVIF_USER` | ONVIF username |
| `WELFARE_ONVIF_PASS` | ONVIF password |
| `WELFARE_ONVIF_BUS` | Which vehicle this camera is on. Falls back to `WELFARE_CAMERA_BUS`, then `lab-rig` |
| `WELFARE_ONVIF_TOPICS` | JSON `{"topic-substring":"fall\|violence\|sound"}`. Explicit bindings, from the probe |
| `WELFARE_ONVIF_RELAY_URL` | Cloud console base URL. Set = relay mode, unset = local mode |
| `WELFARE_ONVIF_RELAY_TOKEN` | Token for the cloud ingest route. Falls back to `WELFARE_CAMERA_TOKEN` |
| `WELFARE_ONVIF_PULL_SEC` | PullMessages long-poll seconds. Default `30` |
| `WELFARE_ONVIF_MESSAGE_LIMIT` | Messages per pull. Default `50` |
| `WELFARE_ONVIF_TERMINATION` | Subscription lifetime. Default `PT5M` |
| `WELFARE_ONVIF_IDLE_FLOOR_MS` | Minimum wall time for an empty pull, guarding against a camera that ignores the long-poll timeout. Default `1000` |
| `WELFARE_CAMERA_COOLDOWN_SEC` | Repeat suppression per bus per signal. Shared with the HTTP adapter. Default `30` |
| `WELFARE_CAMERA_COMPOUND_SEC` | Violence+sound corroboration window. Default `90` |

A minimal on-site relay setup:

```bash
FEATURE_WELFARE=true \
FEATURE_WELFARE_ONVIF=true \
WELFARE_ONVIF_URL=192.168.1.200 \
WELFARE_ONVIF_USER=admin \
WELFARE_ONVIF_PASS='yourpass' \
WELFARE_ONVIF_BUS=lab-rig \
WELFARE_ONVIF_RELAY_URL=https://web-production-45ef4.up.railway.app \
WELFARE_ONVIF_RELAY_TOKEN='same-as-cloud-WELFARE_CAMERA_TOKEN' \
node server.js
```

Once the probe has told you the real topics, add them so keyword matching stops
being load-bearing:

```bash
WELFARE_ONVIF_TOPICS='{"tns1:RuleEngine/MilesightRule/FallDetection":"fall"}'
```

## Endpoints

| Route | What it gives you |
|---|---|
| `GET /api/welfare/onvif/status` | Subscription state, clock offset, mode, all counters |
| `GET /api/welfare/onvif/topics` | Every distinct topic seen, the recent ring, and which topics are still unbound |
| `GET /api/welfare/status` | Includes the `onvif` block above alongside `camera` |

`/onvif/topics` is the discovery endpoint — the same information as the probe,
from a listener that is already running.

## How a notification becomes an event

1. **Pull.** `PullMessages` long-polls for up to `WELFARE_ONVIF_PULL_SEC`. The
   camera holds the request open until it has something to say, so delivery is
   near-real-time without polling pressure.
2. **Parse.** Topic, `UtcTime`, `PropertyOperation`, and the Source/Data
   `SimpleItem` pairs are read out, namespace-prefix agnostic.
3. **Classify.** Explicit `WELFARE_ONVIF_TOPICS` bindings first, then built-in
   keyword matching. Violence is checked before sound so a topic naming both
   lands on the stronger signal.
4. **Decide whether it is firing.** A property event carries its state in a data
   item (`IsFall`, `State`). When that item is false this message is the
   **clear** — the person got up, the fight stopped — and is counted, not
   alerted on. `PropertyOperation="Initialized"` is the subscription baseline
   replayed on connect and is likewise never an alert; without that rule every
   restart would raise a fall.
5. **Record or relay.** Local mode calls `camera.recordDetection()`. Relay mode
   POSTs to `/api/welfare/camera/:signal` on the cloud console.
6. **Remember it either way.** Recognised or not, firing or not, the topic and
   payload land in the discovery ring. A topic this module does not understand
   is still visible at `/onvif/topics`.

## Resilience

- Subscription re-established automatically on any failure, with 2s→60s
  exponential backoff. Reconnects are counted in `/onvif/status`.
- The camera's clock is measured once per connection with
  `GetSystemDateAndTime` and the offset applied to every WS-UsernameToken. A
  camera with no NTP is otherwise a stream of `sender not authorized`.
- WS-Security and HTTP Basic are both sent. Some builds accept only one and
  there is no way to know which without trying.
- Self-signed camera certificates are accepted (`rejectUnauthorized: false`) —
  unavoidable for LAN-local devices, and the traffic never leaves the vehicle.
- Empty pulls are floored at `WELFARE_ONVIF_IDLE_FLOOR_MS`. A device that
  returns immediately instead of honouring the long-poll timeout would
  otherwise hot-loop — a bench run against one logged 54,000 pulls in eight
  seconds.
- Mounted in its own try/catch in `welfare/index.js`. An unreachable camera
  cannot take down the VS125-derived rules, which are the signals that
  currently work.
- Relay failures are counted and logged loudly as `RELAY FAILED`. A welfare
  event that fails to reach the console silently is the worst outcome available.

## Tests

```bash
node welfare/onvif.selftest.js
```

58 assertions against a fake ONVIF camera on localhost: the full SOAP
conversation, ONVIF-spec digest computation, clock-skew compensation,
notification parsing with mixed namespace prefixes, classification of all three
signals plus the negative cases, clear-versus-alarm handling, baseline
suppression, the shared record path including the compound rule, and relay mode
posting to the HTTP ingest route.

## What is still unproven

Everything below needs the camera in front of it, and none of it is claimed
until then:

- **The vendor strings against this camera.** They came from support, not from
  a document, and have not yet been observed on our own device. Run the probe
  and confirm.
- **The payload shape.** Which data items carry the on/off state of a fall, and
  what Sound Classification puts in its items (`Type`? a class name?), is
  unknown until a real detection is captured. The clear-versus-alarm logic
  depends on it.
- **Detection quality from a bus ceiling.** Mounting geometry, lens angle and
  motion are all unvalidated. Camera-derived distress and aggression evidence
  stays marked `unproven` until live detections exist.
- **Sound classification indoors on a moving vehicle.** Engine and road noise
  against gunshot/glass/scream models is untested.
