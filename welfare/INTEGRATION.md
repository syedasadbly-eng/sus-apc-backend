# Welfare Development Interface — Integration Notes

Smart Urban Sensing · branch `welfare-dev`

This module adds a welfare alerting layer to the existing APC dashboard without
altering passenger counting, reporting, or any Mayo Clinic-facing view. It is
off unless `FEATURE_WELFARE=true`, and when off the code path is provably inert:
no API route is mounted, no database table is created, and the sidebar menu
stays hidden.

---

## 1. What was added

| Path | Purpose | New file |
|---|---|---|
| `welfare/engine.js` | Rule engine. Pure logic, no I/O, injectable clock. | yes |
| `welfare/index.js` | SQLite store, REST API, wiring into `server.js`. | yes |
| `welfare/selftest.js` | 18 deterministic rule assertions. | yes |
| `public/welfare.js` | Front-end for the five welfare views. | yes |
| `server.js` | 5 insertions, listed below. | no |
| `public/index.html` | Nav section, 5 view containers, 1 script tag. | no |
| `public/app.js` | 5 entries added to the `updateHeader` titles map. | no |
| `public/style.css` | Namespaced block appended at the end of the file. | no |

Nothing existing was deleted or rewritten.

---

## 2. Touch points in `server.js`

There are five, all additive.

1. **Require** — `const welfare = require('./welfare');` next to the `mqtt`
   require.
2. **Mount** — `welfare.initWelfare(app, db, { topicMode: MQTT_CONFIG.topic });`
   immediately after `app.use(express.json())`. Returns `null` and logs a single
   line when the flag is off.
3. **GPS-only branch of `handleMessage`** — a `welfare.observe(...)` call in the
   early-return path, so position and liveness still reach Rules 6 and 12 on
   messages that carry no counting delta.
4. **End of `flushBusDelta`** — a `welfare.observe(...)` call after the existing
   database `try/catch`, so a welfare failure can never roll back or interrupt a
   record write.
5. **`connectMqtt`** — an `MQTT_ENABLED=false` guard. Defaults to enabled, so
   production behaviour is unchanged. Set it to `false` when running a local or
   branch instance so it does not subscribe to the live Mayo feed and write a
   second copy of the data.

`welfare.observe()` is wrapped in its own `try/catch` and returns immediately
when the flag is off, so points 3 and 4 cost one boolean comparison in
production.

---

## 3. Data isolation

- All welfare rows go to a single new table, `welfare_events`, created only when
  the flag is on.
- No existing table, column, index, or query was modified.
- The engine reads from the live feed and never writes back to it.

`welfare_events` columns: `event_id` (PK), `detected_at`, `date`, `bus_id`,
`source`, `event_type`, `severity`, `rule`, `reason`, `use_case`, `route`,
`lat`, `lng`, `onboard`, `sensor_health`, `acknowledged`, `acknowledged_at`,
`acknowledged_by`, `detail` (JSON).

---

## 4. The rules

Severity: 1 Log · 2 Notify · 3 Alert · 4 Escalate.

### R12 — Sensor health and data integrity

Runs first and **gates every other rule**. If a feed is untrusted, the welfare
rules go silent for that vehicle rather than guess. This matters more than any
individual alert: a counter stuck at an occupancy of 1 would otherwise fire
"passenger left on the bus" every single night, and the interface would be
ignored within a week.

| Check | Condition | Result |
|---|---|---|
| Stale feed | no data for `WELFARE_STALE_SEC` (600) | Notify, rules suppressed |
| Lost feed | no data for `WELFARE_OFFLINE_SEC` (1800) | Alert, rules suppressed |
| Negative occupancy | `onboard < 0` | Alert, rules suppressed |
| Stuck counter | no change in `WELFARE_STUCK_MIN` (45) min across `WELFARE_STUCK_KM` (2) km | Notify, rules suppressed |
| Day imbalance | boardings vs alightings differ by >10% at the service-day rollover | Notify |
| Recovery | first message after a gap | Log |
| No GPS fix | occupants aboard, no live fix | health degraded, geofence rules downgraded |

### R3 / R4 — Lone traveller

Occupancy of exactly 1 sustained for `WELFARE_LONE_SUSTAIN_SEC` (300). Notify by
day; Alert inside the night window `WELFARE_LATE_FROM`–`WELFARE_LATE_TO`
(20:00–06:00) evaluated in `DISPLAY_TZ`, which is `America/Chicago` for this
deployment.

### R6 / R9 — End-of-service occupancy

Occupants aboard while the vehicle is under `WELFARE_STATIONARY_KPH` (3) for
`WELFARE_EOS_SEC` (300).

- Inside a depot geofence → **Escalate**.
- Inside a terminus geofence → **Alert**.
- No geofence match, live fix → **Notify**, `stationary_with_occupants`.
- No live fix → **Notify**, explicitly flagged "location unconfirmed".

The last case is the important one. `server.js` substitutes each bus's static
depot coordinates when the UR35 reports status 52 (no fix), so a naive geofence
check would see every bus permanently parked at its depot. The rule therefore
requires `gpsValid === true` before it will name a location.

All rules share a per-rule, per-vehicle cooldown of `WELFARE_COOLDOWN_SEC` (600)
so a persistent condition produces a handful of events, not one per message.

---

## 5. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `FEATURE_WELFARE` | unset | `true` enables the whole module |
| `MQTT_ENABLED` | `true` | set `false` on dev instances |
| `WELFARE_STALE_SEC` | 600 | feed considered stale |
| `WELFARE_OFFLINE_SEC` | 1800 | feed considered lost |
| `WELFARE_STUCK_MIN` | 45 | stuck-counter window |
| `WELFARE_STUCK_KM` | 2 | distance that must be covered in that window |
| `WELFARE_LONE_SUSTAIN_SEC` | 300 | lone-traveller sustain |
| `WELFARE_LATE_FROM` / `_TO` | 20 / 6 | night window, local hours |
| `WELFARE_EOS_SEC` | 300 | stationary time before R6 fires |
| `WELFARE_STATIONARY_KPH` | 3 | speed treated as stopped |
| `WELFARE_COOLDOWN_SEC` | 600 | repeat suppression |
| `WELFARE_DEPOTS` | two Mayo Rochester anchors | JSON array |
| `WELFARE_TERMINI` | `[]` | JSON array |

Geofence JSON format:

```json
[{"name":"Gonda Building","lat":44.02302,"lng":-92.46657,"radiusM":180,"buses":["515"]}]
```

`buses` is optional; omit it to apply the geofence to the whole fleet.

The default depots are derived from `BUS_STATIC_LOCATIONS` in `server.js`. They
are the fallback coordinates, not surveyed depot positions, so **treat them as
placeholders**. Derive the real ones from stored history: cluster points where
speed is 0 for more than 20 minutes.

---

## 6. API

All routes are mounted at `/api/welfare` and exist only when the flag is on.

| Method | Route | Notes |
|---|---|---|
| GET | `/status` | flag state and resolved config; the front end uses this to decide whether to show the menu |
| GET | `/signals` | 8-row delivery matrix, live / blocked / camera |
| GET | `/fleet-health` | per-vehicle Rule 12 state |
| GET | `/events` | `limit`, `bus`, `type`, `min_severity`, `from`, `to`, `unack` |
| GET | `/events/live` | in-memory ring, last 200 |
| GET | `/stats?days=` | totals, by type, by day, by bus |
| POST | `/events/:id/ack` | acknowledge |
| POST | `/simulate` | writes a canned row, `source=simulated` |
| POST | `/simulate/observe` | pushes observations through the **real** rule path |
| POST | `/simulate/purge` | deletes all welfare rows; touches nothing else |

---

## 7. Front end

`public/welfare.js` calls `/api/welfare/status` on load. If that returns
anything other than 200 it stops, and the sidebar section stays hidden. On a
production build with the flag unset the dashboard is byte-for-byte the
experience it is today, apart from one suppressed 404 in the browser console.

Navigation is owned by `app.js`. Its `initNavigation()` already toggles
`.nav-item` and `.view` classes for any `data-view` button, `updateHeader()` now
knows the five welfare titles, and `initView()` has no default branch so it is a
safe no-op for these views. `welfare.js` therefore only adds a render listener
and never touches a class, which removes any possibility of the two handlers
fighting.

The five views:

1. **Welfare Console** — KPIs, live alert feed, per-vehicle state, event volume.
2. **Signal Delivery** — the six signals and seven use cases against what the
   installed hardware actually delivers, plus the blocking dependencies.
3. **Sensor Integrity** — Rule 12 per vehicle and the thresholds behind it.
4. **Event Log** — full audit trail, filterable, CSV export, acknowledge.
5. **Rules & Testing** — active thresholds, geofences, and event injection.

---

## 8. Running it

```bash
npm install

# development, no live feed, welfare on
FEATURE_WELFARE=true MQTT_ENABLED=false PORT=3001 DB_PATH=./dev.db npm start

# rule assertions
node welfare/selftest.js
```

Dashboard password is the existing client-side gate in `public/app.js`.

---

## 9. Verification performed

| Check | Result |
|---|---|
| `node welfare/selftest.js` | 18 passed, 0 failed |
| Flag off: `/api/welfare/status` | 404 |
| Flag off: tables created | `records`, `hourly_summary`, `daily_summary`, `bus_state` only |
| Flag off: welfare menu | hidden, all 8 original nav items work |
| Flag on: five views rendered | no console errors, no layout overflow |
| Flag on: live rule path via `/simulate/observe` | vehicle state populated, no false alerts |
| Return to core views after visiting welfare | header and view restored correctly |

The self-test covers: lone traveller by day and by night with the correct
severity split, depot escalation, an empty parked bus raising nothing, negative
occupancy suppressing the welfare rules, the stale → offline → recovery
sequence, stuck-counter detection, cooldown behaviour, and the no-GPS-fix case
where fallback coordinates must not fake a depot arrival.

---

## 10. Honest limitations

- **The thresholds are reasoned, not evidenced.** 5 minutes for a lone traveller
  and 5 minutes stationary at a depot are plausible starting points, nothing
  more. Replay stored history before treating any alert volume as meaningful.
- **The default depot geofences are the GPS fallback coordinates**, not surveyed
  depot positions. Rule 6 will be approximate until they are replaced.
- **Dwell-based use cases (1, 3, 4) remain blocked** on the VS125 dwell field
  name, its reporting interval, and whether it is reported per zone or per
  vehicle. That is one email to Milesight, and it unlocks three use cases in
  software alone.
- **Fall and violence remain camera-dependent** and unproven at bus saloon
  height. Milesight specifies a 3 m minimum install height; a bus saloon is
  2.0–2.2 m. This is the project's genuine go/no-go, and no amount of dashboard
  work substitutes for the bench test.
- **The rule engine holds state in memory.** A restart clears sustain timers, so
  a lone traveller is re-timed from zero. Acceptable for development; it needs
  persistence before any operational claim is made.
- **Alert delivery is not built.** Events are recorded and displayed. Nothing
  notifies a driver, controller, or clinician yet.

---

## 11. Suggested deployment sequence

1. Merge `welfare-dev` to `main` with `FEATURE_WELFARE` **unset**. The welfare
   code is then live in production and provably inert. Confirm the Mayo
   dashboard is unchanged.
2. Deploy a second Railway service from the same repo with
   `FEATURE_WELFARE=true` and its own volume and database. Because the MQTT
   client ID is randomised per process, it can safely subscribe alongside
   production — but keep an eye on it, since a duplicate client ID on HiveMQ
   causes an infinite disconnect loop that would look like a broker outage on
   the Mayo dashboard.
3. Calibrate thresholds against that instance for a fortnight.
4. Only then enable the flag on the production service.
