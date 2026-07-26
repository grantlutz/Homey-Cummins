# Flow Card Reference

Complete reference of every Flow card the app provides. All cards are
device-scoped (Homey adds the device picker automatically).

## Generator (Connect Cloud) driver

### Triggers (When…)

| Card | Fires when | Tokens | Args |
|---|---|---|---|
| The generator started | `isRunning` 0→1 | — | — |
| The generator stopped | `isRunning` 1→0 | Total runtime (h) | — |
| Utility power was lost | `utilityAvailable` 1→0 | — | — |
| Utility power was restored | `utilityAvailable` 0→1 | — | — |
| Switched to generator power | running && !utility became true | — | — |
| Switched back to utility power | …became false | — | — |
| An exercise (self-test) started / completed | `isExercising` edges | — | — |
| A fault occurred | `faultType` 0→n | Fault type (number) | — |
| The fault cleared | `faultType` n→0 | — | — |
| Generator data went stale / fresh again | LastCheckIn older/newer than threshold | — | — |
| The exercise became overdue | no completed exercise within threshold | — | — |
| The battery voltage dropped below… | value crosses below the arg | Battery voltage | Voltage (V) |
| The load rose above… | value crosses above the arg | Load % | Load (%) |
| A new event was logged | new entry in the cloud event feed | Severity, Code, Message | — |

Threshold triggers fire on *crossings* (previous value on the other side),
so they fire once per excursion, not on every poll.

### Conditions (And…)

is running · utility power is available · on generator power · is exercising ·
has an active fault · data is stale · exercise is overdue · standby is
enabled · battery voltage above [V] · load above [%] — all invertible.

### Actions (Then…)

| Card | Notes |
|---|---|
| Refresh generator data | Immediate poll; bypasses failure backoff |
| Start/Stop the generator (EXPERIMENTAL) | Best-effort `/Assets/{id}/command/StartGenset|StopGenset` POST — the payload was never publicly captured. Triple-gated: the `commands_enabled` device setting AND `isRemoteEnabled` telemetry AND the command's `IsEnabled` flag from `/Assets/Commands`. |

## Generator (Local, RS-series) driver

All card IDs are prefixed `local_` internally; titles match the cloud driver
where the semantics match.

### Triggers

Same set as cloud minus stale/overdue/engine-speed, plus:

| Card | Fires when | Tokens |
|---|---|---|
| The status changed | decoded status string changed | Status |
| Action required turned on | LCD `0x60` bit set | — |
| A fault occurred | status code 6 | Fault code, Description (from the live fields) |
| A new event was logged | new entry in `events.html` (checked every N polls; fires once per new entry, oldest first) | Event code, Description |
| The load rose above… | **either** load line crosses the arg | Load % (the higher line) |

### Conditions

Same style as cloud, plus **The status is [dropdown]** with the decoded
status list (Stopped, Starting, Running, Priming, Fault, Engine Only, Test
Mode, Voltage Adjust, Config Mode, Cycle Crank Pause, Exercising, Engine
Cooldown).

### Actions (all confirmed local protocol)

| Card | Protocol |
|---|---|
| Start the generator | `wr_logical.cgi?@242=2` |
| Stop the generator | `wr_logical.cgi?@242=1` |
| Run an exercise now | `wr_logical.cgi?@242=3` |
| Enable / Disable standby | `@385=1` / `@385=0` |
| Set the exercise schedule | `@425` (frequency) + `@391` (day) + `@392` (hour) + `@393` (minute) |
| Sync the generator clock | POST `@448/@449/@450/@402/@403` (Homey-timezone wall clock) |
| Refresh generator data | Immediate poll; bypasses failure backoff |

The generator's physical switch must be in **REMOTE** for control commands
to take effect.

### Controls that don't need a Flow at all

The local driver exposes the same actions directly on the device, so simple
one-off operations don't require building a Flow:

- **on/off switch** on the tile → start / stop the engine
- **standby toggle** on the tile → arm / disarm auto-start
- **Exercise button** on the tile → run a self-test now
- **Device → Settings → Exercise schedule** → frequency / day / hour /
  minute, written to the generator on save and read back from it otherwise
- **Device → Settings → Maintenance** → sync the generator clock

The cloud driver's on/off switch only appears once *Enable experimental
start/stop commands* is turned on in its device settings.

## Starter flow recipes

1. **Outage alert** — When *Utility power was lost* → send push notification
   "⚡ House is on backup power"; And *is running* is false after 2 min →
   escalate ("outage AND generator didn't start").
2. **Battery health** — When *battery voltage dropped below 12.0* → notify
   with the voltage token.
3. **Missed self-test** — When *the exercise became overdue* → notify;
   optionally (local driver) Then *Run an exercise now*.
4. **Fault logging** — When *a fault occurred* → append tokens to a Google
   Sheet / notify with the description.
5. **Nightly clock sync (local)** — every day at 03:00 → *Sync the generator
   clock* (or just enable auto-sync in device settings).
