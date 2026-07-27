# Homey Pro Port Plan — Cummins Generators

Goal: port everything the four Home Assistant integrations do (see
`HA-INTEGRATIONS.md`) to a native Homey Pro app, and go beyond them with
Homey's first-class Flow, Insights, and device-UI features. No Homey app for
Cummins exists — this is the first.

**Two drivers**, covering both generator generations:

1. **`generator`** (Connect Cloud) — QuietConnect units monitored via the
   reverse-engineered cloud mobile API (ports tebrown + wareed1 features).
2. **`generator-local`** (RS-series local web card) — fully local polling +
   *confirmed* control protocol (ports mdedonato + mswilson features).

## 1. Architecture

```
CLOUD driver:
Cummins Connect Cloud mobile API  ←(poll /Assets/Detail every N min)←  Homey app
         Cognito token refresh    ←(refresh token, stored per device)
         /Assets/Events           ←(poll for fault/exercise events → Flow triggers)

LOCAL driver:
http://<generator-ip>/index_data.html  ←(poll every N s, HTTP basic auth)←  Homey app
http://<generator-ip>/wr_logical.cgi   ←(confirmed control writes)
http://<generator-ip>/events.html, faults.html, exercise.html  ←(logs/schedule)
```

- **Node.js, SDK v3, zero runtime npm dependencies** — `lib/http.js` wraps
  Node's `https` with a cookie jar + redirect control so the app runs on every
  Homey Pro model.
- `lib/CumminsApi.js` — port of tebrown's `api.py`: refresh-token driven,
  dual-header auth (`Authorization` + `mobile-data`), 401→refresh→retry, token
  rotation persisted back to the device store.
- `lib/AuraAuth.js` — port of `aura_auth.py`: browserless username/password
  login. **Risk:** Salesforce TLS fingerprinting may block Node the way it
  blocks Python `requests` (can't know until tried against the live site — no
  `curl_cffi` equivalent bundled on Homey). Mitigation: the pairing flow also
  accepts a **pasted refresh token** (obtained from tebrown's
  `tools/bootstrap_login.py` on any computer), which is *not* behind the
  fingerprinting edge. Login failures of the "blocked" flavor tell the user
  exactly this.

## 2. Cloud device model (`generator` driver)

Class `other`; each Cummins asset = one Homey device. Multi-generator
accounts supported (pairing lists all assets).

### Capabilities

| Capability | Type | Source |
|---|---|---|
| `measure_voltage.battery` (std sub) | V | `batteryVoltage` |
| `measure_voltage.output` (std sub) | V | `gensetVoltage` |
| `generator_running` (custom bool) | — | `isRunning` |
| `utility_power` (custom bool) | — | `utilityAvailable` |
| `on_generator_power` (custom bool) | — | derived: `isRunning && !utilityAvailable` |
| `generator_exercising` (custom bool) | — | `isExercising` |
| `measure_generator_load` (custom, %) | % | `gensetPercentLoad` |
| `measure_frequency` (standard, Hz — needs compatibility >=12.2.0) | Hz | `frequencyOP` |
| `measure_engine_speed` (custom, RPM) | RPM | `averageEngineSpeed` |
| `measure_engine_runtime` (custom, h) | h | `engineRuntime` |
| `alarm_fault` (custom bool, alarm) | — | `faultType != 0` |
| `alarm_data_stale` (custom bool, alarm) | — | `now - LastCheckIn > stale threshold` |
| `alarm_exercise_overdue` (custom bool, alarm) | — | `now - lastExercise > overdue threshold` |
| `last_checkin` (custom string) | — | `LastCheckIn`, localized |
| `last_exercise` (custom string) | — | Events API / `isExercising` falling edge |

Standby/remote-enabled flags + firmware version + status enums surface as
**device settings (read-only info fields)** rather than capabilities — they're
diagnostics, not live telemetry (mirrors HA's "diagnostic" entity category).
All numeric + boolean capabilities get **Insights** (`"insights": true`).

### Polling

- `/Assets/Detail` every N minutes (setting, default 2, min 1).
- `/Assets/Events` on the same cycle with `from=<last seen event ts>` —
  produces the `generator_event` trigger, fault details, and last-exercise
  tracking ("Genset exercise completed" events; falls back to observed
  `isExercising` 1→0 transitions).
- API/auth errors → `setUnavailable()` with the reason; recovered → `setAvailable()`.
- Auth expiry (`invalid_grant`) → device unavailable with "sign in again"
  message; **repair flow** re-runs login without deleting the device (parallels
  HA's reauth flow).

## 3. Flow cards

**Triggers (device-scoped):**
`generator_started`, `generator_stopped` (token: runtime h),
`utility_power_lost`, `utility_power_restored`,
`switched_to_generator_power`, `switched_to_utility_power`,
`fault_occurred` (tokens: fault type/code/message), `fault_cleared`,
`exercise_started`, `exercise_completed`,
`data_went_stale`, `data_fresh_again`,
`exercise_overdue`,
`battery_voltage_below` (arg: volts), `load_above` (arg: %),
`generator_event` (any new cloud event; tokens: severity, code, message).

**Conditions:**
`is_running`, `utility_power_is_available`, `is_on_generator_power`,
`is_exercising`, `has_fault`, `data_is_stale`, `exercise_is_overdue`,
`battery_voltage_above` (arg), `load_is_above` (arg),
`standby_is_enabled`, `remote_control_is_enabled`.

**Actions:**
`refresh_now` (immediate poll),
`start_generator` / `stop_generator` — endpoint solved during development
(`POST /Assets/SendCommand?id=`, see HA-INTEGRATIONS.md) and confirmed on
real hardware. Gated behind an opt-in device setting AND `isRemoteEnabled`
AND the command's `IsEnabled` flag, because it turns a real engine.
`StartExercise` / `StopExercise` / `FaultReset` are ungated.

## 4. Pairing

1. Custom `login` view: username + password, plus collapsible "Advanced:
   refresh token" input (fallback for TLS-fingerprint block / MFA accounts).
2. On login: run `AuraAuth.login()` (or validate pasted token), then
   `listAssets()`.
3. Standard `list_devices` → `add_devices` templates; each device stores
   `{ assetId, refreshToken }` (token in device **store**, never the password).
4. `repair` flow: same login view, updates the stored token.

## 5. Settings (per device)

- Poll interval (minutes, default 2)
- Stale-data threshold (hours, default 25)
- Exercise-overdue threshold (days, default 8)
- Enable remote start/stop (boolean, default off, with warning)
- Read-only info: site, asset id, firmware, standby/remote flags, raw
  `gensetStatus`/`loadStatus`/`powerSource` codes (undecoded upstream).

## 5b. Local device model (`generator-local` driver)

Pairing: enter IP/host + basic-auth credentials (defaults `admin`/`cummins`),
connection tested by fetching `index_data.html`. Poll interval default 30 s
(local — can be much faster than cloud).

Capabilities: shares the cloud set (`generator_running`, `utility_power`,
`on_generator_power`, `generator_exercising`, `measure_voltage.battery`,
`measure_voltage.output`, `measure_frequency`,
`measure_engine_runtime`, `alarm_fault`) plus local extras:
`generator_status` (decoded 0–23 string), `measure_generator_load.line1` /
`.line2`, `alarm_action_required`, `standby_enabled` (as a togglable
capability — the protocol for enable/disable is confirmed).

Flow triggers add: `status_changed` (token: status string), `event_logged` /
`fault_logged` (tokens: code, description). Actions are REAL (not
experimental) because the protocol is confirmed: `start_generator`,
`stop_generator`, `exercise_now`, `standby_on`, `standby_off`,
`set_exercise_schedule` (frequency/day/hour/minute dropdowns → `@425/@391/
@392/@393`), `sync_clock` (@448/@449/@450/@402/@403). Control requires the
generator's switch in REMOTE — documented in the pairing view and README.

Settings: poll interval (s), auto clock-sync toggle + drift threshold,
read-only info (model, exercise schedule, generator clock).

## 6. Beyond the HA feature set

- First-class Flow triggers/conditions/actions (HA users had to build
  template sensors + generic automations by hand).
- Event-stream trigger from `/Assets/Events` (unused by both cloud HA projects).
- Exercise tracking from the API instead of scraping.
- Insights graphs for every numeric/boolean capability out of the box.
- Configurable thresholds (HA hardcoded 25 h / 8 d).
- One app covering BOTH generator generations (cloud QuietConnect + local
  RS-series) — no HA integration does both.
- A dashboard **widget** (Homey >=12.3.0) showing live generator status
  (state, battery, load, utility) for any paired generator.

## 7. Not ported / out of scope

- wareed1's Selenium/MQTT mechanism (obsolete — API replaces it).
- MFA login (upstream limitation; refresh-token path is the workaround).
- Decoding `gensetStatus`/`loadStatus`/`powerSource` enums (not decoded by any
  known project; exposed raw in settings so users can report mappings).
- `SetExerciseSchedule` command (no captured payload at all).

## 8. Validation

- `homey app validate --level publish` clean.
- Unit-style smoke tests for `lib/` (telemetry flattening, cookie jar,
  redirect handling) runnable with plain `node`.
- Live test requires real Cummins credentials → user runs `homey app run`.
