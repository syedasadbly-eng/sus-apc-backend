# AI Pro Dome → Welfare Console

Smart Urban Sensing · branch `welfare-camera-ingest`

How the Milesight AI camera's detections reach the welfare console, how to
configure both ends, and what is proven versus assumed.

---

## 1. Why HTTP and not MQTT

The camera is an **MS-C2972-RFPG1 AI Motorized Pro Dome**, firmware
`63.8.0.6-r1`. Its settings tree was searched page by page: there is **no MQTT
client on this firmware**. The outbound options are HTTP Notification, Email,
FTP, SIP, RTMP and App Push.

HTTP Notification is the only one that carries an event to our own code in real
time. So the camera posts directly to the welfare service, and the UR35 relay
originally sketched in `bus-welfare-sensing` is not needed on the lab rig.

**The path identifies the signal.** Milesight does not publish the JSON body for
Fall or Violence Detection, and the body has changed between firmware builds.
Parsing it to decide what happened would make ingest a guess. One URL per
signal, set once on the camera, cannot drift.

---

## 2. Camera-side configuration

Current state of the rig, set 4 Sep 2026:

| Setting | Value |
|---|---|
| IP | 192.168.5.190 static, gateway 192.168.5.1 |
| Fall Detection | **on** — min. duration 5 s, sensitivity 5, 24/7 schedule |
| Violence Detection | **on** — min. duration 12 s, sensitivity 5, 24/7 schedule |
| Sound Classification | **on** |
| VCA Event, Object Counting, Heat Map, Attribute Extraction | **off** — required, see below |
| Clock | synced from PC, timezone United Kingdom (London) |

**The exclusivity rule.** Milesight's release note for this firmware states that
Violence Detection and Fall Detection cannot run at the same time as VCA Event,
Object Counting, Face Detection, Heat Map or Attribute Extraction. All four of
the first set were on, which is why both tiles were greyed out and unclickable.
Turning them off un-greys both. Nothing is lost: counting stays on the VS125,
which is the architecture decision this project already made.

Sound Classification was tested alongside both and does **not** conflict.

### Setting the callback

For each detection, open its page under `Settings > Event`, tick **HTTP
Notification** under Alarm Action, and fill in URL 1:

```
http://<console-host>/api/welfare/camera/fall?bus=lab-rig&token=<TOKEN>
http://<console-host>/api/welfare/camera/violence?bus=lab-rig&token=<TOKEN>
http://<console-host>/api/welfare/camera/sound?bus=lab-rig&token=<TOKEN>
```

- **HTTP Method** — either works. POST also carries the payload, which is worth
  having while the body is still unknown. GET is fine if POST misbehaves.
- **Trigger Interval** — set 30 s at the camera as well as relying on the
  server-side cooldown. Two independent throttles, because a fall holds its
  posture for as long as the person is down and the camera re-fires throughout.
- **User Name / Password** — optional. If used, put the token in the password
  field; the endpoint accepts it as Basic auth. Prefer the query token over
  plain HTTP.

---

## 3. Server-side

Mounted by `welfare/index.js` in its own try/catch, so a camera-side fault
cannot stop the VS125-derived rules.

| Method | Route | Purpose |
|---|---|---|
| GET/POST/any | `/api/welfare/camera/:signal` | ingest — `fall`, `violence`, `sound` |
| GET | `/api/welfare/camera/last` | last 25 raw requests, verbatim |
| GET | `/api/welfare/camera/status` | connected, counts, config |

`/status` now reports `camera_connected` from real traffic rather than the
hardcoded `false` it returned before.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `WELFARE_CAMERA_TOKEN` | unset | shared secret; **unset means the route accepts unauthenticated writes** |
| `WELFARE_CAMERA_COOLDOWN_SEC` | 30 | repeat suppression, per bus per signal |
| `WELFARE_CAMERA_BUS` | `lab-rig` | vehicle when the request names none |
| `WELFARE_CAMERA_MAP` | `{}` | source IP → bus id, e.g. `{"192.168.5.190":"515"}` |

This route writes to the database from the public internet, so it is **not**
behind `WELFARE_ALLOW_SIM` — those are dev endpoints and this is a real one —
but it is behind the token. Set it.

### How events are classified

| Signal | event_type | Severity | Use case |
|---|---|---|---|
| fall | `fall` | 3 Alert | 2 Distress |
| violence | `violence` | 4 Escalate | 7 Aggression |
| sound | `sound_classification` | 2 Notify | 7 Violence & Disruption |

Rows are written with `source='camera'`, so they are separable from VS125-derived
rows in every query and never contaminate rule-tuning counts.

Each event is enriched with whatever the counting feed knows about that vehicle
at that moment: route, position, occupancy, sensor health. Position is only
attached when `gpsValid` is true — `server.js` substitutes static depot
coordinates on a no-fix, and an unvalidated position would place a fall at a
depot the bus never visited. A camera naming a bus the counting feed has never
reported does **not** create that vehicle in the fleet map.

---

## 4. Deliberate behaviours

**Nothing the camera sends can 400.** A rejected callback is a lost event and a
silent one: the camera does not retry and does not surface the failure. The body
is parsed as JSON when it parses, kept as text when it does not, and multipart
snapshots are recorded by size rather than decoded.

**A suppressed repeat returns 200, not 429.** The camera treats any non-2xx as a
delivery failure. Nothing failed — the event was received and folded into the
previous one.

**Every request is captured verbatim.** Until a fall has been staged in front of
the lens, nobody knows what this camera actually sends. `/camera/last` holds the
last 25 requests with method, content type, headers, query and raw body. That
capture is the point of this endpoint before it is the alerting path.

**An unknown signal is a 404 that is still captured.** A mistyped URL on the
camera shows up in `/camera/last` rather than vanishing.

---

## 5. Verification performed

`node welfare/camera.selftest.js` — 30 assertions, all passing. It runs a real
express server and makes real requests over a socket rather than calling the
handler directly, because the failure modes here are transport-shaped: a parser
rejecting a content type the camera sends, a Basic header it forms, a status
code it reads as failure.

Covered: token refusal, Basic-auth token, bare GET, malformed JSON body, valid
JSON with payload preserved, severity and use-case mapping, `source='camera'`,
unknown signal, vehicle context, unknown bus not being invented, IP-map
fallback, cooldown, per-signal cooldown independence, capture ring, token
redaction, status counters, engine emission.

The three pre-existing suites still pass unchanged: welfare 106, occupancy 31,
doorlog 32.

---

## 6. What this does not prove

- **No real detection has ever been received.** Everything above proves the
  server accepts and classifies what a camera would send. The `trust` column in
  Signal Delivery therefore reads `unproven` for Distress and Aggression until a
  genuine detection lands, which is a deliberately different claim from
  `measured`.
- **The payload shape is still unknown.** The `detail.payload` field is built to
  hold whatever arrives. Stage a fall, read `/camera/last`, and only then decide
  whether anything in the body is worth promoting into a column.
- **Egress from the camera is unconfirmed.** NTP failed from 192.168.5.190,
  which suggests the subnet has no route out. If the console is hosted on
  Railway, that route has to work before any of this runs. Test it before
  assuming.
- **The geometry gate is untouched.** Milesight specifies 3 m mounting height,
  15–20° tilt, and the person occupying more than 1/5 of the vertical frame at
  3–10 m. A bus saloon is 2.0–2.2 m. This module changes nothing about that; it
  only ensures that when a detection does fire, it is captured rather than lost.
- **The compound rule is not built.** Violence and sound arrive independently.
  Correlating them into the Violence & Disruption KPI is still to do.
