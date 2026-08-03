# MQTT Messaging Protocol & Schema

**Project:** Smart Urban Sensing — Mayo Clinic Bus APC (WP1 deliverable)
**Document owner:** Smart Urban Sensing Ltd (SUS)
**Version:** 1.0.0 (2026-08-03)
**Status:** Production, in use on Mayo Clinic buses 515 and 419
**Related codebase:** [sus-apc-backend @ feat/admin-auth-audit](https://github.com/syedasadbly-eng/sus-apc-backend/tree/feat/admin-auth-audit)

---

## 1. Purpose & scope

This document is the single source of truth for the MQTT messaging protocol used between the on-bus edge (Milesight UR35 cellular gateway + Milesight VS125 3D people-counting sensors) and the SUS V9 Analytics Platform. It covers:

- Broker configuration and security posture
- Topic hierarchy and gateway → bus mapping
- Payload schemas for every message type the backend accepts
- The full field-path resolution table used by the ingester
- Delivery semantics, de-duplication, and error handling
- Transport (cellular) profile derived from live UR35 diagnostics
- How to onboard a new bus without code changes

Everything in this document is grounded in payloads captured on the live production broker and in the running code at `server.js` (commit range around `main…feat/admin-auth-audit`).

---

## 2. System overview

```
 ┌─────────────────────────────┐        LTE (AT&T US, MCC 310/MNC 410)
 │ Bus (515 or 419)            │        ├── APN: "broadband"
 │                             │        ├── RSRP: -100…-104 dBm (typical)
 │  ┌──────────────┐  Ethernet │        ├── RSRQ: -12…-16 dB
 │  │  VS125 door1 ├───┐       │        └── SINR: 21…26 dB
 │  └──────────────┘   │       │
 │  ┌──────────────┐   ├───►  UR35 ──── mqtts:8883 ────┐
 │  │  VS125 door2 ├───┘  gateway                       │
 │  └──────────────┘                                    ▼
 │  (UR35 also publishes GPS + status on bus/00X)   HiveMQ Cloud
 └─────────────────────────────┘                    (TLS, user/pass)
                                                        │
                                                        ▼
                                             ┌───────────────────────┐
                                             │ sus-apc-backend       │
                                             │  Node.js MQTT client  │
                                             │  → SQLite (WAL)       │
                                             │  → REST /api/*        │
                                             │  → Live dashboard     │
                                             └───────────────────────┘
```

- **Edge sensor:** Milesight VS125, firmware `V_125-LW.1.0.3-r2`, HW `V1.1`. Two per bus (door 1 + door 2).
- **Edge gateway:** Milesight UR35, model `UR35`, PN `L04AF-G-P-W`, firmware `35.3.0.11`, HW `0300`.
- **Broker:** HiveMQ Cloud, host `492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud`, port `8883` (TLS).
- **Backend:** `sus-apc-backend` on Railway ([web-production-45ef4.up.railway.app](https://web-production-45ef4.up.railway.app/)).

---

## 3. Broker configuration

| Setting | Value | Notes |
|---|---|---|
| Broker | HiveMQ Cloud (managed) | `*.s1.eu.hivemq.cloud` cluster |
| Host | `492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud` | Configurable via `MQTT_HOST` env var |
| Port | `8883` | MQTT over TLS 1.2+ only. No plaintext `1883`. |
| Protocol | MQTT v3.1.1 | `mqtt.js` default. Move to v5 in a future revision. |
| Client ID | `sus-backend-<random>` | Auto-generated per connect |
| Auth | Username + password | Users provisioned in HiveMQ Cloud console |
| Backend user | `sus-dashboard` (subscribe-only) | Password stored in Railway env `MQTT_PASS`. Never checked in. |
| Sensor users | one per bus | Publish-only. Rotated quarterly. |
| Keepalive | 60 s (default) | UR35 default; backend inherits |
| Clean session | `true` | Backend does not require persistent session; it re-subscribes on connect |
| TLS | Required | HiveMQ Cloud's public CA chain; no client certs today |

**Security posture**

- All traffic is TLS.
- Broker enforces per-user ACLs: sensor users can only publish under their own `bus/00X/#` subtree; the backend user has read-only access to `bus/#`.
- No secrets in the repo; connection details live in `.env.example` with placeholders and in Railway's environment variables.
- Passwords rotate every 90 days. Rotation SOP is `docs/mqtt-credential-rotation.md` (WP2 deliverable).

---

## 4. Topic hierarchy

The canonical pattern is:

```
bus/{gateway_id}/{door}/telemetry     — VS125 counting sensor
bus/{gateway_id}/telemetry            — UR35 gateway status / GPS
```

The backend subscribes with a single wildcard: `bus/#`.

### 4.1 Gateway → bus label mapping

Physical gateway IDs `001..004` are mapped to human bus labels `515` and `419` in `server.js` (constant `GATEWAY_MAP`, lines ~42-46):

| Topic prefix | Bus label | Route |
|---|---|---|
| `bus/001` | `515` | Mayo Downtown Inter-Campus Loop (Gonda ↔ Charlton ↔ Saint Marys) |
| `bus/002` | `515` | Same bus, second door |
| `bus/003` | `419` | Mayo NW Patient Parking Shuttle (Building B ↔ Baldwin) |
| `bus/004` | `419` | Same bus, second door |

Multiple topics can therefore resolve to the same bus (multi-door buses). All count deltas and GPS fixes for a given bus are merged in-memory before being written to SQLite.

### 4.2 Observed topic instances (production)

Captured live from the broker on 2026-07-31:

| Topic | Device SN | Bus | First seen | Msg count |
|---|---|---|---|---|
| `bus/001/door2/telemetry` | `6537F28545220003` | 515 | 2026-06-12 | 40,982 |
| `bus/002/door1/telemetry` | `6537F28778010000` | 515 | 2026-06-12 | 28,645 |
| `bus/002/door2/telemetry` | `6537F28554930004` | 515 | 2026-06-15 | 16,357 |
| `bus/003/telemetry` | (UR35 419) | 419 | 2026-06-15 | see `/api/debug/topics` |
| `bus/004/telemetry` | (UR35 419) | 419 | 2026-06-15 | see `/api/debug/topics` |

Live topic registry is always available at [`/api/debug/topics`](https://web-production-45ef4.up.railway.app/api/debug/topics).

### 4.3 QoS & retention

| Property | Value | Rationale |
|---|---|---|
| Publish QoS | `1` (at least once) | Sensor firmware default. Duplicate delivery is handled by the ingester's de-dupe logic (§7). |
| Retained flag | `false` | Telemetry is time-valued; a retained heartbeat could mislead a fresh subscriber. |
| Message TTL | Broker default (no expiry) | Backend applies its own clock-skew tolerance. |

---

## 5. Payload schemas

All payloads are UTF-8 JSON. NMEA sentences (starting with `$GP` / `$GN`) are silently dropped by the ingester — they are noise from certain UR35 firmwares that mis-configure a raw GPS passthrough.

Every payload flowing through the ingester is captured verbatim at [`/api/debug`](https://web-production-45ef4.up.railway.app/api/debug) (last 20).

### 5.1 Common envelope — `device_info` + `time_info`

Every VS125 message includes:

```json
{
  "device_info": {
    "device_mac": "24:E1:24:FF:39:72",
    "device_name": "People Counter",
    "device_sn": "6537F28778010000",
    "firmware_version": "V_125-LW.1.0.3-r2",
    "hardware_version": "V1.1",
    "ip_address": "192.168.1.53",
    "running_time": 370,
    "wlan_mac": "24:E1:24:FF:39:73"
  },
  "time_info": {
    "dst_status": false,
    "enable_dst": false,
    "end_time":   "2026-07-31T20:31:00-00:00",
    "start_time": "2026-07-31T20:30:00-00:00",
    "time_zone":  "UTC-0:00 Western European Time (WET), Greenwich Mean Time (GMT)"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `device_info.device_sn` | string | **yes** | Sensor serial; primary identity for the counter |
| `device_info.firmware_version` | string | yes | Fleet inventory + upgrade planning |
| `device_info.running_time` | integer | no | Seconds since last device reboot (fault-hunting) |
| `time_info.start_time` | ISO 8601 | yes | Start of the reporting window (device clock) |
| `time_info.end_time` | ISO 8601 | yes | End of the reporting window (device clock) |
| `time_info.time_zone` | string | no | Human-readable TZ label (informational only) |

**Clock policy.** The device clock is treated as advisory. The **broker receive time** is the authoritative timestamp. `time_info.start_time` is used only to compute a skew figure that is written to the diagnostic log — never to reject a message. This decision was made after bus 515's VS125 device clock froze at 2026-05-30 and silently black-holed live data.

### 5.2 `line_periodic_data` — periodic heartbeat (VS125)

Emitted on a fixed cadence (60 s default) whether or not people crossed the line. Used as a heartbeat when no `line_trigger_data` has ever been seen from that bus.

```json
{
  "line_periodic_data": [
    {
      "line": 1,
      "line_name": "Line1",
      "line_uuid": "54e1d1de-1d76-4bcd-b559-2c1f30176133",
      "total": { "in": 0, "out": 0 }
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `line` | integer | yes | Line index (1-based) |
| `line_uuid` | string (UUID v4) | yes | Stable identity of the counting line; used in the periodic de-dupe key |
| `total.in` | integer | yes | Boardings within this window (see §5.5 inversion note) |
| `total.out` | integer | yes | Alightings within this window (see §5.5 inversion note) |

### 5.3 `line_total_data` — cumulative daily totals (VS125)

Cumulative since the device's midnight reset. Written to `records.boardings` / `records.alightings`.

```json
{
  "line_total_data": [
    {
      "line": 1,
      "line_name": "Line1",
      "line_uuid": "54e1d1de-1d76-4bcd-b559-2c1f30176133",
      "total": {
        "capacity_counted": -176,
        "in_counted": 4327,
        "out_counted": 4503
      }
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `total.in_counted` | integer | yes | Cumulative alightings since local midnight |
| `total.out_counted` | integer | yes | Cumulative boardings since local midnight |
| `total.capacity_counted` | integer | no | Device's estimate of onboard delta from a configured baseline; **ignored by the backend** — we compute our own running tally |

### 5.4 `line_trigger_data` — per-event triggers (VS125, preferred)

The authoritative per-event counting source. Emitted the moment somebody crosses the line. Same shape as `line_periodic_data`.

**Counting policy is sticky:** if a bus has *ever* sent `line_trigger_data`, the backend treats trigger as primary and ignores periodic messages for counting (they are still recorded as heartbeats). This prevents the double-count incident on 2 June 2026 when both message types were credited.

### 5.5 VS125 IN/OUT inversion

The VS125 is mounted with its lens facing **into** the bus, so the sensor's semantic "out" event actually corresponds to a passenger walking **into** the bus (boarding) and its "in" event corresponds to an **alighting**. The ingester inverts this at read time via `FIELD_PATHS` (§6). Downstream data (`records.boardings`, `records.alightings`, `/api/stops/boardings`) is already in the bus operator's frame of reference — do not re-invert.

### 5.6 UR35 gateway payload — GPS + status

The UR35 publishes on `bus/00X/telemetry` (no `/doorN/` segment) once every 15-60 s. It contains a GPS fix and modem status. The exact JSON key layout is firmware-dependent; the ingester tolerates all three shapes below via `FIELD_PATHS` (§6):

```jsonc
// Shape A: flat "data" object
{
  "data": {
    "latitude": 44.02384,
    "longitude": -92.46716,
    "speed": 12.4,
    "status": 53
  }
}

// Shape B: top-level fields
{ "latitude": 44.02384, "longitude": -92.46716, "speed": 12.4, "status": 53 }

// Shape C: nested under "gps"
{ "gps": { "latitude": 44.02384, "longitude": -92.46716, "speed": 12.4 }, "status": 53 }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `latitude` | number (WGS-84) | yes | −90…90. `0` is rejected as "no fix". |
| `longitude` | number (WGS-84) | yes | −180…180. `0` is rejected as "no fix". |
| `speed` | number (km/h) | no | Instantaneous speed; `0` if stationary or unknown |
| `status` | integer | yes | `53 = valid fix`, `52 = no fix acquired`. Any other value is accepted with a diagnostic warning. |

**Coordinate parsing.** Legacy UR35 firmwares emit NMEA-style strings (`"4402.38N"`); the ingester's `parseGpsCoord()` handles those. Modern firmwares emit decimal degrees. Both are supported.

### 5.7 Full worked example — bus 515 door 2 heartbeat

Captured from the live broker at 2026-07-31 23:11:55 UTC:

```json
{
  "device_info": {
    "device_mac": "24:E1:24:FF:39:20",
    "device_name": "People Counter",
    "device_sn": "6537F28545220003",
    "firmware_version": "V_125-LW.1.0.3-r2",
    "hardware_version": "V1.1",
    "ip_address": "192.168.1.51",
    "running_time": 330,
    "wlan_mac": "24:E1:24:FF:39:21"
  },
  "line_periodic_data": [
    { "line": 1, "line_name": "Line1", "line_uuid": "fb798b5f-2c15-4360-8713-ba0d213169c7",
      "total": { "in": 0, "out": 0 } }
  ],
  "line_total_data": [
    { "line": 1, "line_name": "Line1", "line_uuid": "fb798b5f-2c15-4360-8713-ba0d213169c7",
      "total": { "capacity_counted": -7141, "in_counted": 8442, "out_counted": 15583 } }
  ],
  "time_info": {
    "dst_status": false, "enable_dst": false,
    "end_time":   "2026-07-31T23:12:00-00:00",
    "start_time": "2026-07-31T23:11:00-00:00",
    "time_zone":  "UTC-0:00 Western European Time (WET), Greenwich Mean Time (GMT)"
  }
}
```

---

## 6. Field-path resolution table (source of truth)

The ingester never assumes a fixed key layout. Every semantic field is resolved by trying an ordered list of dot-notation paths and taking the first hit. This is defined in `server.js` (`FIELD_PATHS`, lines 213-226):

| Semantic field | Direction | Try paths (in order) |
|---|---|---|
| Boardings (cumulative) | in ← sensor's `out_counted` | `line_total_data.0.total.out_counted` |
| Alightings (cumulative) | out ← sensor's `in_counted` | `line_total_data.0.total.in_counted` |
| Boardings (periodic) | in ← sensor's `out` | `line_periodic_data.0.total.out` |
| Alightings (periodic) | out ← sensor's `in` | `line_periodic_data.0.total.in` |
| Boardings (trigger) | in ← sensor's `out` | `line_trigger_data.0.total.out` |
| Alightings (trigger) | out ← sensor's `in` | `line_trigger_data.0.total.in` |
| Legacy line total in | — | `line.0.total.in`, `linePeriod.0.total.in`, `line1_in`, `total.in` |
| Legacy line total out | — | `line.0.total.out`, `linePeriod.0.total.out`, `line1_out`, `total.out` |
| Latitude | — | `data.latitude`, `latitude`, `gps.latitude` |
| Longitude | — | `data.longitude`, `longitude`, `gps.longtitude`, `gps.longitude` |
| Speed | — | `data.speed`, `speed`, `gps.speed` |
| GPS status | — | `data.status`, `status` |

Adding support for a new firmware layout is a one-line change: append a path to the relevant list.

---

## 7. Delivery semantics & de-duplication

The ingester enforces two independent rules to keep counts honest:

### 7.1 Trigger vs. periodic (sticky-mode)

```
if bus has EVER sent line_trigger_data:
    count from trigger; ignore periodic for counting
else:
    count from periodic, with per-window de-dupe
```

State is held in `busHasEverSentTrigger[busId]` (memory) and does not persist across restarts by design — a fresh boot re-derives it from the first message that arrives.

### 7.2 Per-window periodic de-dupe

When a bus is still in periodic-only mode, the ingester constructs a de-dupe key:

```
key = busId + '|' + line_uuid + '|' + time_info.start_time
```

If the key has already been seen this run, the delta is credited as `0`. The key set is bounded (10 000 keys; oldest 2 000 are evicted when it grows past that).

### 7.3 Clock skew handling

Every message carries `time_info.start_time`. The ingester compares that to the broker's `Date.now()` and records the skew in seconds. Messages are **never dropped** for clock skew; the skew figure is exposed in `/api/mqtt-flow` for observability.

### 7.4 GPS validation

A GPS point is accepted only if all of the following hold:

1. `latitude` parses to a number and `|lat| ≤ 90` and `lat ≠ 0`.
2. `longitude` parses to a number and `|lng| ≤ 180` and `lng ≠ 0`.
3. `status` is missing or not equal to `52`.

Rejections are logged into `/api/gps-debug` with a human-readable `verdict` (`gps_fields_missing`, `no_satellite_fix`, `lat_unparseable`, `lng_unparseable`, `coords_out_of_range`, `rejected_other`) and a remediation `advice` string.

---

## 8. Transport (cellular) profile

Sampled from the UR35 diagnostic logs supplied with this document (`cellular.log.old`, `system.info`, 2026-05-01 window):

| Metric | Typical range observed | Interpretation |
|---|---|---|
| Network | LTE FDD | 4G, no fallback to 3G in the sampled window |
| Operator | MCC 310 / MNC 410 | AT&T Mobility, USA (Mayo Rochester campus) |
| Serving cell RSRP | −99 to −104 dBm | Fair-to-good |
| RSRQ | −12 to −16 dB | Fair |
| SINR | 21 to 26 dB | Good |
| CSQ (0-31) | 17 to 22 | Fair-to-good |
| APN | `broadband` | Provisioned per SIM |
| UR35 fw | `35.3.0.11` | Current stable |
| UR35 model / PN | `UR35` / `L04AF-G-P-W` | Global LTE, PoE, WiFi variant |

These figures are healthy for MQTT telemetry — no additional roaming or QoS work is required to meet WP1's "production-ready" bar. Sustained sub-−110 dBm RSRP or SINR under 5 dB should be treated as a WP2 field-issue and logged.

---

## 9. Backend observability endpoints

All of these are available on the running Railway deployment:

| Endpoint | Purpose |
|---|---|
| [`/api/live`](https://web-production-45ef4.up.railway.app/api/live) | Current per-bus state (onboard, occupancy, GPS, next stop) plus broker connection + message count |
| [`/api/mqtt-flow`](https://web-production-45ef4.up.railway.app/api/mqtt-flow) | Last 100 message decisions (which were counted, which were ignored, and why) |
| [`/api/debug`](https://web-production-45ef4.up.railway.app/api/debug) | Last 20 raw payloads (verbatim) |
| [`/api/debug/topics`](https://web-production-45ef4.up.railway.app/api/debug/topics) | Distinct MQTT topics seen since boot, with device SN and message count |
| [`/api/debug/state`](https://web-production-45ef4.up.railway.app/api/debug/state) | In-memory live device state (pre-DB) |
| [`/api/gps-debug`](https://web-production-45ef4.up.railway.app/api/gps-debug) | Last 100 GPS validation verdicts + advice |
| [`/api/history-locations`](https://web-production-45ef4.up.railway.app/api/history-locations) | GPS breadcrumbs, filterable by `bus_id`, `from`, `to` |
| [`/api/stops/boardings`](https://web-production-45ef4.up.railway.app/api/stops/boardings) | Boardings and alightings aggregated per stop |

---

## 10. Adding a new bus

No code change is required for a new bus if it uses the same VS125 firmware family.

1. Provision a new HiveMQ Cloud user with publish access limited to `bus/00N/#`.
2. Configure the UR35 to publish to `bus/00N/doorX/telemetry` (VS125) and `bus/00N/telemetry` (UR35 GPS).
3. Add a row to `GATEWAY_MAP` in `server.js` mapping `bus/00N` → the new bus label (e.g. `bus/005 → 601`).
4. Add the bus's route + stops to `data/stops.json`.
5. Deploy. The topic will appear in `/api/debug/topics` on the first message and the live map will show the bus immediately.

---

## 11. Change log

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-03 | Initial WP1 sign-off draft. Documents the schema currently in production on buses 515 and 419. |

---

## 12. Appendix — glossary

- **APC** — Automatic Passenger Counting.
- **CSQ** — 3GPP TS 27.007 signal-quality indicator (0-31 scale; 99 = unknown).
- **RSRP / RSRQ / SINR** — LTE reference-signal power, quality, and interference-plus-noise ratio.
- **UR35** — Milesight industrial cellular router used as the on-bus gateway.
- **VS125** — Milesight 3D stereo vision people-counter used as the on-door sensor.
- **Line trigger vs. periodic** — VS125 emits both an event-driven `line_trigger_data` and a heartbeat `line_periodic_data`. Only one is credited (see §7.1).
