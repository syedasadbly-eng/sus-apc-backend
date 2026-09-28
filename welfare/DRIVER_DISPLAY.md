# Driver display

`public/driver.html` is a cab-mounted alert screen, one per bus. It uses the existing
welfare API and adds no backend changes.

## Open it

```
https://<service>/driver.html?bus=515
```

Tap **Start** once. This unlocks the alert sound, goes full screen and keeps the screen awake.

| Parameter | Default | Meaning |
|---|---|---|
| `bus` | asked on first start, then remembered | Vehicle this screen belongs to |
| `window` | `10` | Minutes an alert stays on screen unless it is marked Seen |
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
**SEEN** acknowledges the alert (`POST /api/welfare/events/:id/ack`, `by: driver:<bus>`),
so the console can see that the driver has it. Alerts also clear on their own after
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
