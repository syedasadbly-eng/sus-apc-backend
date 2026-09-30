# Driver display

`public/driver.html` is a cab-mounted alert screen, one per bus. It talks only to the
PIN-protected, bus-scoped routes in `welfare/driver.js`.

## PIN

| Variable | Example | Meaning |
|---|---|---|
| `WELFARE_DRIVER_PIN` | `4821` | One PIN for every cab screen |
| `WELFARE_DRIVER_PINS` | `{"515":"4821","419":"7734"}` | Optional per-bus PINs. A bus listed here uses its own PIN, and others use the fleet PIN |

- **First start:** the screen asks for the PIN once and remembers it on that tablet. It asks again only if the server rejects it, for example after the PIN is changed.
- **Lockout:** five wrong PINs from one address lock that address out for five minutes.
- **Scope:** a PIN only reads and acknowledges alerts for its own bus. The response carries no camera IP, no raw payload and no other vehicle.
- **No PIN set:** if neither variable is set, the routes stay open. This is logged loudly at startup.

Routes:

```
GET  /api/welfare/driver/:bus               X-Driver-Pin: <pin>
POST /api/welfare/driver/:bus/ack/:eventId  X-Driver-Pin: <pin>
```

## Open it

```
https://<service>/driver.html?bus=515
```

Tap **Start** once. This unlocks the alert sound, goes full screen and keeps the screen awake.

| Parameter | Default | Meaning |
|---|---|---|
| `bus` | asked on first start, then remembered | Vehicle this screen belongs to |
| `window` | `10` | Minutes an alert stays on screen unless the driver answers it |
| `test` | off | `test=1` also shows simulated events, marked TEST |
| `sound` | on | `sound=0` starts muted |
| `api` | same origin | Backend base URL, if the page is hosted elsewhere |

## What the driver sees

One full-screen state at a time:

| State | Colour | When |
|---|---|---|
| All clear | dark / green | Connected, the bus is being watched, no open alert |
| Passenger may have fallen | red | `fall` |
| Incident on board | red | `violence`, `violence_disruption` |
| Someone still on board | red | `end_of_service_occupancy` |
| Someone still on board / Lone passenger, late / People on board, bus parked | amber | `terminus_occupancy`, `lone_traveller_late_night`, `stationary_with_occupants` |
| Monitoring paused / Off shift | grey | `fleet-health` reports the bus untrusted or off shift |
| No connection | grey | No successful poll for 30 s |

These go to the control-room console only and never reach the cab: sensor health, count
drift, `dwell_no_alighting`, and a `sound_classification` on its own.

If there is more than one alert, the worst and newest is shown, with a "+N more" count.
The driver answers with one of two buttons (`POST /api/welfare/driver/:bus/respond`
with `{ids, response}`, PIN in `X-Driver-Pin`, recorded as `driver:<bus>`):

- **CHECKED, PASSENGER OK** (`response: "ok"`) acknowledges the alert and every open
  alert of the same kind on this bus, and the console shows a green "Driver: passenger OK" tag.
- **NEED HELP** (`response: "help"`) leaves the alert open, the cab shows "Help requested",
  and the console flags the card red with "Driver needs help".

A PIN can only answer its own bus's alerts that are on screen now. The older
`POST /api/welfare/driver/:bus/ack/:id` (SEEN) route is kept for screens still running
a cached copy. Alerts also clear on their own after
`window` minutes, so the driver never has to touch the screen while driving.

## Hardware

Any 7–10" Android tablet or in-cab display running Chrome in kiosk mode, on the UR35's Wi-Fi.
Mount it outside the driver's primary field of view, and follow the operator's in-cab
device policy.

## Camera events

Camera events carry the bus resolved by `WELFARE_CAMERA_MAP`, else `?bus=` on the camera's
notification URL, else `default_bus`. The AI Pro Dome is assigned to bus 515: its URLs still say `?bus=lab-rig`,
and `WELFARE_CAMERA_ALIASES` (default `{"lab-rig":"515"}`) renames that on arrival, so its
alerts appear on `driver.html?bus=515`.
