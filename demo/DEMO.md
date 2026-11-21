# Demo mode

A self-running copy of the APC dashboard with generated sample data, for
promotion, sales demos and screenshots. It is kept fully separate from the
live client feed.

## What you get

- **Balanced counts.** Alightings land at about 99% of boardings for every
  full service day (about 0.9% of alightings are "missed", as a well-installed
  VS125 would). During the day the gap is wider, because people are still on
  board; it closes at each terminus and at the end of service.
- **History.** 400 days by default (Today / Week / Month / Year views, month-on-month
  change, Ridership vs Weather, Comparison, Reports and exports all populate),
  with gentle month-on-month growth and realistic hospital-shuttle peaks
  (morning appointments, lunchtime, afternoon discharges).
- **Live movement.** Buses 515 and 419 drive their real Mayo stop sequences
  (from `data/stops.json`) with live GPS, door counts every stop and an
  end-of-service depot reset. Payloads go through the same `handleMessage()`
  path as the real VS125 / UR35 feed, so every page updates by itself.
- **Welfare incidents** roughly every 30 minutes in service, each acknowledged and
  resolved with realistic notes and driver responses:
  - Possible fall (AI Pro Dome)
  - Loud noise on board (shouting / scream / glass break)
  - Possible altercation
  - Altercation, and it was heard too (violence + sound)
  - Unresponsive passenger (fall + dwell)
  - Standing capacity exceeded (raised live by the real R5 rule at the peaks)
  - Nobody has got off for a while
  - Parked with people on board
  - Someone travelling alone
  - Someone still on board at the depot
- **On-demand incidents for live presentations:**

  ```
  POST /api/demo/incident?type=fall&bus=515
  ```

  Types: `fall`, `loud_noise`, `violence`, `violence_sound`, `unresponsive`,
  `overcrowding`, `nobody_off`, `parked`, `lone`, `left_on_board`. On-demand
  incidents stay open so you can acknowledge and resolve them in the console
  while the audience watches. Set `DEMO_ADMIN_TOKEN` to require `&token=…`.

## Safety

- `DEMO_MODE=true` switches the live MQTT connection off on the server **and**
  in the browser (the broker settings are blanked so even Settings > Connect
  cannot reach it).
- The demo refuses to start against a database that already holds non-demo
  records. Always give the demo service its **own volume**.
- The header shows a **DEMO DATA** chip and "Demo feed". Set `DEMO_BADGE=false`
  only for clean promotional captures, and caption those images as illustrative.
- Never set `DEMO_MODE` on the client-facing service.

## Railway setup (new service, same repo)

1. In the Railway project, **New → GitHub Repo → sus-apc-backend**, branch
   `welfare-dev` (or whichever branch the live service builds from, once this is merged).
2. **Add a volume** to the new service, mounted at `/data`.
3. Variables:

   | Variable | Value |
   |---|---|
   | `DEMO_MODE` | `true` |
   | `DB_PATH` | `/data/demo.db` |
   | `DEMO_OPEN_ACCESS` | `true` to skip the password (optional) |
   | `DEMO_WHITE_LABEL` | On by default: hides the pilot client's name and logo. `false` keeps them |
   | `DEMO_BADGE` | `true` (default) |
   | `DEMO_ADMIN_TOKEN` | any secret, to protect `/api/demo/incident` (recommended) |

4. Deploy. First boot writes the history in a few seconds; then open the
   service URL. Restarts and redeploys only fill in what is missing.

## Tuning (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_HISTORY_DAYS` | `400` | Days of counting history on first boot |
| `DEMO_WELFARE_HISTORY_DAYS` | `45` | Days of welfare history on first boot |
| `DEMO_SERVICE_START` / `DEMO_SERVICE_END` | `05:00` / `23:30` | Local (Central) service window; wider than the real timetable so the demo is live in UK and US hours |
| `DEMO_WEEKENDS` | `true` | Reduced weekend service |
| `DEMO_MISS_ALIGHT` | `0.009` | Share of alightings missed (0.009 ≈ 99% match) |
| `DEMO_WELFARE_EVERY_MIN` | `30` | Mean minutes between welfare incidents |

To start the history again, delete the volume's `demo.db` (and `-wal`, `-shm`) and redeploy.

## Test

```
node demo/demo.selftest.js
```
