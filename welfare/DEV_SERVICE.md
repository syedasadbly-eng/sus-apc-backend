# Welfare Dev Service — setup

How to run welfare development so it cannot affect the Mayo dashboard.

Background: on 1 September the welfare interface was merged to `main` behind a
feature flag that was off. The dashboard was verified healthy immediately after
the deploy and failed roughly twelve hours later. The merge was reverted and
service was restored. The root cause was never established, because the Railway
deploy logs were not captured before the revert.

The lesson is not about that particular flag. It is that development code should
not enter the deployment path of a clinical dashboard at all. A feature flag
protects against the code *running*; it does not protect against the code being
*present*, being built, or changing the process it lives in.

---

## Rule

`main` deploys to production. Nothing else ever does.

`welfare-dev` deploys to a second, separate Railway service. Welfare code is
merged to `main` only after it has run for weeks on that service and there is a
reason to move it.

---

## What separation actually buys you

| Layer | Shared with production? | Protects against |
|---|---|---|
| Separate service | no | a crash, a memory limit, a bad build |
| Separate volume + database | no | corruption, disk exhaustion, schema surprises |
| Broker disabled at first | no | HiveMQ connection and traffic limits |
| Separate branch | no | an accidental production deploy |
| Railway account | **yes** | nothing — see the warning below |

### Warning: the account is shared

A second always-on service draws from the same Railway plan: the same credit
balance, the same resource ceiling. If that balance runs out, **both** services
stop, including the Mayo dashboard.

Mitigations, in order of preference:

1. Do the calibration work locally. `welfare/replay.js` needs no hosting at all
   — see below. This is free and carries no shared-fate risk whatsoever.
2. Run the dev service only when you need it, and stop it in between.
3. Give the dev service a low memory ceiling so it cannot starve production.
4. Check the plan's headroom before creating anything.

Until the dev service is genuinely needed for a shared URL, prefer option 1.

---

## Step 1 — calibrate locally, no hosting required

`welfare/replay.js` streams the historical `records` table through the rule
engine and reports the alert volume the thresholds would have produced. The
source database is opened **read-only**, so it cannot modify production data
even if pointed straight at it.

```bash
node welfare/replay.js --db ./apc_data.db
node welfare/replay.js --db ./apc_data.db --from 2026-06-01 --to 2026-08-31
node welfare/replay.js --db ./apc_data.db --csv /tmp/events.csv
node welfare/replay.js --db ./apc_data.db --set loneSustainSec=900,eosStationarySec=900
```

To get a copy of the production database, download it from the Railway volume
(`/data/apc_data.db`) or export the `records` table. Work on the copy.

### Why this matters more than the dashboard

Against a 30-day synthetic feed, the thresholds as written produce **41.5 events
per service day**. Widening the lone-traveller sustain and end-of-service dwell
to 15 minutes and the cooldown to 30 minutes brings that to **4.6 per day** — a
ninefold reduction.

Those specific numbers are from generated test data, not from Mayo's feed, so
treat them only as evidence that the tool works and that the shipped defaults are
almost certainly too tight. Run it against real history before believing any
figure.

An alerting system nobody trusts is worse than no alerting system. Calibration
is the project, and none of it requires Railway.

---

## Step 2 — create the dev service, when you need one

In the Railway dashboard:

1. **New Service → GitHub Repo →** `syedasadbly-eng/sus-apc-backend`.
   Put it in a **new project** rather than alongside production, so a mistake in
   project-level settings cannot reach the live service.
2. **Settings → Source:** set the branch to `welfare-dev`.
   Confirm the production service is still pinned to `main`.
3. **Settings → Volume:** add a volume, mount path `/data`. This must be a new
   volume, not the production one.
4. **Settings → Healthcheck Path:** `/api/health`.
5. **Variables:** set exactly these and nothing else.

```
FEATURE_WELFARE=true
WELFARE_ALLOW_SIM=true
MQTT_ENABLED=false
DB_PATH=/data/welfare_dev.db
DISPLAY_TZ=America/Chicago
BUS_CAPACITY=16
PORT=3001
```

`WELFARE_ALLOW_SIM=true` is safe here and only here. It enables event injection
and the purge button, which must never be reachable on a client-facing service.

`MQTT_ENABLED=false` is the important one. It keeps this service off the live
broker, so it cannot consume HiveMQ connection or traffic allowance that the
production feed depends on.

6. Deploy, then confirm the production dashboard is still healthy.

### Do not

- Do not attach the production volume.
- Do not point `DB_PATH` at `apc_data.db`.
- Do not set `WELFARE_ALLOW_SIM` on the production service.
- Do not change the production service's branch.

---

## Step 3 — add the live feed only when the rules are quiet

Once replay shows a sensible alert volume, you may want the dev service reading
real traffic. Before enabling it, check the HiveMQ plan's connection and traffic
limits, because this adds a second subscriber to the account the Mayo dashboard
depends on.

Safer, if the broker plan is tight: create a second HiveMQ credential with
read-only permission on `bus/#`, so the dev service cannot publish and appears
separately in the broker's connection accounting.

Set `MQTT_ENABLED=true` and watch both services for a day.

---

## Step 4 — a safeguard for production, worth doing now

Set **Healthcheck Path** to `/api/health` on the *production* service.

With a healthcheck configured, Railway will not route traffic to a replica that
fails it, and the previous working deployment keeps serving. The 1 September
outage would have been contained instead of leaving the dashboard down for
hours. This is independent of anything welfare-related.

Also add a branch protection rule on `main` requiring a pull request, so nothing
reaches production without review.

---

## Step 5 — before any future merge to `main`

1. Replay shows an alert volume you are willing to defend.
2. The dev service has run for at least two weeks without incident.
3. Production has a healthcheck on `/api/health`.
4. The merge happens at a time when the shuttles are not running and you can
   watch it, not last thing at night.
5. You capture the deploy logs immediately after, healthy or not. Not having
   them is why the September outage is still unexplained.
6. The welfare views sit behind server-side role checks, not a client-side
   password. The `feat/admin-auth-audit` branch already has `requireAuth` and
   `requireAdmin` for this; that branch is a large change to the login path and
   deserves the same isolated validation before it goes near production.
