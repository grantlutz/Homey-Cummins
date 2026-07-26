# Home Assistant Cummins Integrations — Feature & Functionality Review

This document reviews every known Home Assistant integration for Cummins home
standby generators (QuietConnect / Connect Cloud), as research input for the
Homey Pro port in this repository. Reviewed 2026-07-26.

---

## 1. tebrown/cummins_hacs — "Cummins Connect Cloud" (HACS custom integration)

**Repo:** https://github.com/tebrown/cummins_hacs
**Approach:** Native cloud-polling integration against the reverse-engineered
**Cummins Connect Cloud mobile API** (the backend of the ConnectCloud phone
app). No browser, no scraping at runtime. This is the most complete and most
current integration, and the primary reference for the Homey port.

### 1.1 Authentication (fully reverse-engineered, documented in its docs/DESIGN.md)

- Identity stack: **AWS Cognito** (user pool `us-east-1_rUcTfwn3b`) federating
  via **SAML** to **Salesforce** (`mylogin.cummins.com`, Cummins' custom
  `IAM_VisualforceToLightning` Apex login bridge, spoken over the Aura protocol).
- OAuth2 **PKCE** public client, id `28oqvfr332v3mp11u1tikqm565`, redirect URI
  locked to `connectcloud://authentication/callback`, scope `openid profile`.
- Token endpoint: `https://da-pcc-auth-production.auth.us-east-1.amazoncognito.com/oauth2/token`.
- Username/password login is done as **pure HTTP** (no JS execution): Cognito
  authorize → static JS bounce page → guest login page (regex out the Aura
  `fwuid`/`app`/`loaded` context) → POST credentials to the Apex bridge
  (`getDoLogin`) → returned `frontdoor.jsp` URL → static bounce →
  auto-submitting SAML form → POST `SAMLResponse` to Cognito
  `/saml2/idpresponse` → 302 to `connectcloud://…?code=…` → PKCE token
  exchange.
- **Critical gotcha #1 — TLS fingerprinting:** Salesforce's edge (`sfdcedge`)
  fingerprints the TLS ClientHello (JA3/JA4). Python `requests` gets served a
  broken generic login page even with byte-identical headers; the integration
  uses `curl_cffi` impersonating Chrome. Only the *login* endpoints are behind
  this edge; Cognito token refresh and the telemetry API are not.
- **Critical gotcha #2 — dual token header:** every API call must send BOTH
  `Authorization: Bearer <access_token>` AND `mobile-data: <id_token>`,
  otherwise the API 401s ("Cannot read property 'sub' of null").
- Only the **refresh token** is persisted (never the password). Access tokens
  last 3600 s and are refreshed 60 s early; a refreshed response may rotate the
  refresh token, which is persisted back. `400 invalid_grant` on refresh ⇒
  reauth required (HA surfaces a reauthentication flow).
- Fallback path: an off-box Playwright script (`tools/bootstrap_login.py`)
  produces a refresh token the user can paste in, in case Cummins changes the
  login page. MFA is not supported by either path.
- User-Agent for the telemetry API mirrors the app:
  `ConnectCloud_Maui/80 CFNetwork/3860.600.12 Darwin/25.5.0`.

### 1.2 The mobile API

Base: `https://cc.aws.powercommandcloud.com/api/dashboard/v1/mobile`

| Endpoint | Purpose |
|---|---|
| `GET /Profile` | Email + Accounts[] (`AccountId`, `CommandsEnabled`, AccountType) |
| `GET /Sites/Personal` | Sites, each with `Assets[]` (generators) — source of the asset id |
| `GET /Sites/GetAssets?id=<siteId>` | Assets for a site incl. `LastTelemetry` |
| `GET /Assets/Detail?id=<assetId>` | **Live telemetry snapshot** (primary poll target) |
| `GET /Assets/Events?id=<assetId>&from=<epoch_ms>` | Event/fault history (Severity, Code, Message, Timestamp, Acknowledged) |
| `GET /Assets/Commands?id=<assetId>` | Available commands + `IsEnabled` |
| `POST /Assets/SendCommand?id=<assetId>` | **Execute a command** — see below |

Telemetry arrives as `LastTelemetry.Properties[]` (name/value string pairs,
coerced to numbers client-side) plus a top-level `LastCheckIn` ISO timestamp.

#### Cloud command endpoint — SOLVED 2026-07-26 (not known to any prior project)

Upstream never captured this; tebrown's design doc lists it as unresolved
phase-2 work and cites the *web* app's path, which does not exist on the
mobile API. Established empirically against a live account by probing
candidates with a deliberately invalid command name, so **nothing had to be
executed to learn the protocol**:

```
POST {API_BASE}/Assets/SendCommand?id=<assetId>
Content-Type: application/json

{ "DestinationId": "<assetId>", "CommandString": "StartGenset", "Properties": [] }
```

Body fields mirror the objects `/Assets/Commands` returns. Evidence trail:

| Attempt | Result |
|---|---|
| `POST /Assets/{id}/command/{name}` (the web-app path) | **404** — absent from the mobile API |
| `/Assets/Command`, `/Assets/Commands`, `/Assets/ExecuteCommand`, lowercase and `PUT` variants | **404** |
| `POST /Assets/SendCommand` with no query param | **400** `Required parameter id is missing!` → endpoint exists |
| `POST /Assets/SendCommand?id=…` with the command-object body | **422** enum validation on `.CommandString` → body shape correct |

The 422 returned the server's own complete allowed-value list:

```
ResetDevice, ResetPassword, UpdateConfig, SoftwareUpdate, FaultReset,
StartAtsTest, StopAtsTest, StartGenset, StopGenset, StartExercise,
StopExercise, SetStandby, SetExerciseSchedule
```

`/Assets/Commands` reports which of these a given generator has enabled. On
the test unit all six of StartGenset, StopGenset, StartExercise,
StopExercise, SetStandby and SetExerciseSchedule came back `IsEnabled: true`.

**Still unknown:** the `Properties` shape for the parameterised commands
(`SetStandby`, `SetExerciseSchedule`). Simple commands take `Properties: []`.
Probing for that shape is *not* safe the way the above was — a
schema-valid empty payload would execute rather than error, and disabling
standby means the generator won't auto-start during an outage. That needs a
traffic capture from the ConnectCloud app.

### 1.3 Telemetry fields

| Field | Type | Meaning |
|---|---|---|
| `isRunning` | 0/1 | Generator running |
| `utilityAvailable` | 0/1 | Grid power present (invert + combine with isRunning = "on generator power") |
| `isExercising` | 0/1 | In a scheduled self-test |
| `isStandbyEnabled` | 0/1 | Standby (auto-start) enabled |
| `isRemoteEnabled` | 0/1 | Remote start/stop allowed |
| `batteryVoltage` | float V | Starter battery health — the "will it start" signal |
| `engineRuntime` | float h | Cumulative runtime (maintenance scheduling) |
| `faultType` | int | 0 = no fault |
| `gensetStatus` | int enum | Not decoded upstream |
| `loadStatus` | int enum | Not decoded upstream |
| `gensetPercentLoad` | int % | Load |
| `averageEngineSpeed` | int RPM | Engine speed |
| `frequencyOP` | float Hz | Output frequency |
| `gensetVoltage` | float V | Output voltage |
| `powerSource` | int enum | Not decoded upstream |
| `SoftwareVersion` | string | Firmware |
| `LastCheckIn` | ISO ts | Freshness / offline detection |

### 1.4 Entities exposed

**Sensors:** battery voltage (V, measurement), engine runtime (h,
total_increasing), load (%), output voltage (V), output frequency (Hz), engine
speed (RPM), firmware version (diagnostic), last check-in (timestamp,
diagnostic).

**Binary sensors:** running (device_class: running), utility power available
(power), exercising, standby enabled (diag), remote control enabled (diag),
fault (`faultType != 0`, device_class: problem, with `fault_type` attribute),
data stale (no check-in in **25 h** → problem, diagnostic).

### 1.5 Architecture choices worth copying

- `DataUpdateCoordinator` polling `/Assets/Detail` every **2 minutes**
  (telemetry is roughly event-driven upstream; 1–5 min is gentle and adequate).
- On 401: drop the access token, force one refresh, retry once.
- Auth failure ⇒ explicit reauthentication flow, not silent failure.
- Multi-asset support: each generator becomes its own device; setup asks which
  asset to add when an account has several.
- Read-only by design (phase 1). Commands (`StartGenset` / `StopGenset` /
  `SetExerciseSchedule`) are enumerated by the API with `IsEnabled` flags, and
  the web app POSTs to `/assets/{id}/command/<name>`, but the exact mobile
  command POST body was never captured — upstream deliberately deferred
  control to a phase 2.

### 1.6 Known gaps upstream

- `gensetStatus` / `loadStatus` / `powerSource` integer enums are not decoded.
- No MFA support in the login chain.
- No use of `/Assets/Events` for entities (fault/exercise history is fetched
  nowhere despite the endpoint being wrapped in the client).
- No commands/controls.

---

## 2. wareed1/Cummins-Generator-to-Home-Assistant (Selenium + MQTT bridge)

**Repo:** https://github.com/wareed1/Cummins-Generator-to-Home-Assistant
**Approach:** Off-box pipeline on a Raspberry Pi: a Selenium (headless
Chromium) scraper logs into the Cummins Connect Cloud web portal, scrapes the
dashboard (piercing Shadow DOM with recursive JS), formats JSON, and publishes
it to Home Assistant over **MQTT** (Paho, QoS 1) from a nightly cron job. HA
side is plain `configuration.yaml` MQTT sensors + template binary sensors.

### 2.1 Data collected

- `runtime_hours` (scraped from dashboard)
- `battery_voltage` (scraped from dashboard)
- `last_exercise_date` — scraped from the portal's **Events/notifications**
  ("Genset exercise completed"), parsed to ISO
- `last_updated` — pipeline run timestamp

### 2.2 HA entities

- MQTT sensors: Generator Runtime (h, duration, total_increasing), Battery
  Voltage (V, measurement), Last Exercise (timestamp), Last Updated (timestamp).
- Template binary sensor **Generator Data Freshness** (problem): on when
  `last_updated` is older than **25 h** (pipeline failed / data stale).
- Template binary sensor **Generator Exercise Status** (problem): on when
  `last_exercise_date` is older than **8 days** (weekly self-test missed).
- Dashboard: entities card + two conditional alert cards (stale data, exercise
  overdue).

### 2.3 Ideas worth porting that tebrown's integration doesn't have

- **Last-exercise tracking and an "exercise overdue" alarm** (8-day
  threshold on a weekly exercise schedule). On Homey this can be derived
  properly from the API's `/Assets/Events` ("Genset exercise completed"
  events) and/or observed `isExercising` transitions — no scraping needed.
- The stale-data threshold concept (25 h) — already adopted by tebrown.

### 2.4 Why not to port its mechanism

Selenium scraping is fragile (breaks on portal redesigns), needs an external
always-on machine, and delivers data only as often as cron runs (daily). The
mobile API gives the same data (and much more) directly.

---

## 3. mdedonato/cummins_generator + Hass.io add-on (LOCAL web interface → MQTT)

**Repo:** https://github.com/mdedonato/cummins_generator (add-on packaging:
mdedonato/hassio-addons "Cummins Generator Bridge"). Actively maintained.
**Approach:** **Fully local, no cloud.** Older Cummins RS-series generators
(with the Ethernet web-interface card) run an embedded web server with HTTP
basic auth (default `admin`/`cummins`). The bridge polls it and republishes to
MQTT with HA discovery; control commands are relayed to the generator's
`wr_logical.cgi`.

### 3.1 The local protocol (fully decoded — the crown jewels)

`GET http://<host>/index_data.html` → strip HTML tags, split on whitespace:

| Index | Field |
|---|---|
| 0, 1 | hour, minute (generator clock) |
| 2 | battery voltage ×10 (138 → 13.8 V) |
| 3 | **status code** (decoded below) |
| 4, 5 | load line 1 %, load line 2 % |
| 6 | output voltage (VAC) |
| 7 | output frequency (Hz) |
| 8 | engine runtime in **minutes** (÷60 → h) |
| 9–11 | month name, day, year |
| 12 | **LCD status bit field** (decoded below) |
| 13 | current fault code |
| 14 | current event code |
| 15, 16 | event description, fault description |
| 17 | auto mode |

**Status codes:** 0/1 Stopped, 2/3 Starting, 4 Running, 5 Priming,
6 Fault (append fault #), 7 Eng.Only, 8 TestMode, 9 Volt Adj, 20 Config Mode,
21 Cycle crank pause, 22 Exercising, 23 Engine Cooldown.

**LCD bits:** `0x01` utility present, `0x02` utility connected, `0x0C`
running, `0x10` standby (inverted: standby enabled when bit is 0), `0x60`
action required. Derived: *exercising* = running && utility connected.

**Commands** — `GET /wr_logical.cgi?<param>`:
`@242=1` stop, `@242=2` start, `@242=3` exercise now; `@385=0/1` standby
disable/enable; time sync via POST `@448`(month) `@449`(day) `@450`(year)
`@402`(hour) `@403`(minute).

**Logs:** `events.html` / `faults.html` embed `var page_data = "..."` (5 lines
per entry: code, description, timestamp, …); `exercise.html` exposes the
exercise schedule; `loads_data.html` load-shed state.

### 3.2 Entities

Sensors: battery voltage, load 1/2 %, output volts, output freq, engine hours,
status (decoded string), fault code + description, event code + description,
auto mode, generator time/date, event log, fault log, exercise schedule, load
control. Binary sensors: utility present (power), utility connected
(connectivity), running, standby, action required (problem), exercising.
Buttons: Engine Start / Stop / Exercise. Switch: Standby Enable. Plus periodic
generator clock sync.

---

## 4. mswilson/cummins-hass-integration (LOCAL, native HA custom component)

**Repo:** https://github.com/mswilson/cummins-hass-integration — same local
web interface as §3, but as a native HA integration for the discontinued
**RS20A (model GSBB)**. Same data indices, status map, and LCD bits.

Extra decodings beyond §3:
- **Exercise schedule writes:** `@425=<0-3>` frequency (Never/Weekly/
  Bimonthly/Monthly), `@391=<0-6>` day (Sun–Sat), `@392=<hour>`, `@393=<minute>`.
- **Load management:** `@426=1/2` manual/auto mode, `@426=3/4` load-1
  disconnect/connect, `@426=5/6` load-2 disconnect/connect;
  current mode/values parsed from `loads.html` / `loads_data.html`.
- Exercise schedule read: parsed from `exercise.html` JS
  (`writeSingleOption`/`writeDays`/`hrs24ToHrs12` patterns).
- Control requires the generator's physical switch in **REMOTE**.

Entities: same sensor/binary-sensor set plus buttons (start/stop/standby
en/disable/exercise now), selects (exercise frequency/day/hour/minute, load
mode, load 1/2), datetime (generator clock with sync).

---

## 5. Other prior art & ecosystem findings

- **HA community thread** "Cummins Cloud Connect generators"
  (community.home-assistant.io/t/398442, 2022–2026): documents the history —
  Cummins originally ran a Microsoft Azure B2C auth stack
  (`powercommand.b2clogin.com`, API then at
  `mobile-prod.aws.powercommandcloud.com`), later migrated to the current
  Salesforce/Cognito stack, breaking early attempts; the thread's working
  solutions became the wareed1 and tebrown repos. Also the origin of the
  "401 Cannot read property 'sub' of null" discovery (dual-token requirement).
- **Nobody anywhere has decoded the cloud integer enums**
  (`gensetStatus`/`loadStatus`/`powerSource`) **or captured the cloud
  StartGenset/StopGenset POST body.** (One live observation in the forum:
  gensetStatus = 8 seen on a healthy generator.) The local status-code table
  (§3.1) is the best cross-reference candidate but is a different controller
  namespace — do not present it as authoritative for cloud values.
- **genmon** (jgyates/genmon) does not support Cummins (open feature request).
- **HACS default store:** no Cummins integration (tebrown's is
  custom-repository only).
- **Homey:** no Cummins/Onan generator app exists in the Homey App Store or
  community — this port is first.
- Adjacent (not home-standby HA): ad-rpi/open-ec-ags (BLE protocol for RV
  EC-AGS+, full spec + working start/stop), Peter-Georgiev/ModbusTCP_GEN_C250
  (industrial PowerCommand controllers speak Modbus TCP),
  MartinVerges/genset-control, jcoliz/GenController,
  LenShustek/GeneratorController (hardware projects).

---

## 6. Consolidated feature matrix (input for the Homey port)

Cloud-side (Connect Cloud / QuietConnect generators):

| Feature | tebrown | wareed1 | Homey port |
|---|---|---|---|
| Cloud API polling (no scraping) | ✅ | ❌ (scrape) | ✅ port |
| Username/password sign-in in-product | ✅ | ✅ (env file) | ✅ port (+ token fallback) |
| Refresh-token fallback entry | ✅ | ❌ | ✅ port |
| Reauth flow on expiry | ✅ | ❌ | ✅ (repair via Homey) |
| Battery voltage | ✅ | ✅ | ✅ |
| Engine runtime (h) | ✅ | ✅ | ✅ |
| Load % | ✅ | ❌ | ✅ |
| Output voltage / frequency | ✅ | ❌ | ✅ |
| Engine speed (RPM) | ✅ | ❌ | ✅ |
| Firmware version | ✅ | ❌ | ✅ (setting/diagnostic) |
| Last check-in timestamp | ✅ | ✅ (last_updated) | ✅ |
| Running state | ✅ | ❌ | ✅ |
| Utility power present | ✅ | ❌ | ✅ |
| "On generator power" derived state | (invert) | ❌ | ✅ explicit |
| Exercising state | ✅ | ❌ | ✅ |
| Standby / remote-enabled flags | ✅ | ❌ | ✅ |
| Fault alarm (faultType != 0) | ✅ | ❌ | ✅ |
| Stale-data alarm (25 h) | ✅ | ✅ | ✅ (configurable) |
| Last exercise date | ❌ | ✅ | ✅ (from Events API / isExercising edge) |
| Exercise-overdue alarm (8 d) | ❌ | ✅ | ✅ (configurable) |
| Event/fault history | ❌ (endpoint wrapped, unused) | partially (scrape) | ✅ (event-based flow triggers) |
| Multi-generator support | ✅ | ❌ | ✅ |
| Start/Stop commands | ❌ (phase 2, POST shape unknown) | ❌ | ⚠️ experimental, gated (see PLAN.md) |
| Automations | via HA generic | via HA generic | ✅ first-class Flow cards |

Local-side (older RS-series generators with the Ethernet web card):

| Feature | mdedonato | mswilson | Homey port |
|---|---|---|---|
| Local polling (index_data.html) | ✅ (via MQTT) | ✅ native | ✅ native driver |
| Decoded status string (0–23 map) | ✅ | ✅ | ✅ |
| LCD bit flags (utility/running/standby/action) | ✅ | ✅ | ✅ |
| Battery / output V / freq / engine h | ✅ | ✅ | ✅ |
| Load line 1 & 2 % | ✅ | ✅ | ✅ |
| Fault + event code & description | ✅ | partial | ✅ |
| Event/fault logs | ✅ | ❌ | ✅ (flow trigger on new event/fault) |
| Start / Stop / Exercise-now commands | ✅ | ✅ | ✅ (confirmed protocol → real Flow actions) |
| Standby enable/disable | ✅ | ✅ | ✅ |
| Exercise schedule read | ✅ | ✅ | ✅ (settings info) |
| Exercise schedule write (@425/@391/@392/@393) | ❌ | ✅ | ✅ (flow action) |
| Load management (@426) | placeholder | ✅ | ⚠️ optional, later phase |
| Generator clock sync | ✅ | ✅ | ✅ (action + auto option) |

---

## Appendix A — auth/login chain summary for porting

1. `GET {cognito}/oauth2/authorize?response_type=code&client_id=…&redirect_uri=connectcloud://authentication/callback&scope=openid+profile&state=…&code_challenge=…&code_challenge_method=S256` — follow redirects; lands on a **401** page whose body contains a static JS redirect (`var url = '…'` or `window.location.replace('…')`).
2. Follow that bounce URL (capture its `startURL` query param). The landing page HTML embeds the Aura context: regex `"fwuid":"…"`, `"app":"…"`, `"loaded":{"…":"…"}`.
3. `POST {login-host}/clw/s/sfsites/aura?r=0&aura.ApexAction.execute=1` — form-urlencoded: `message={"actions":[{id:"0;a",descriptor:"aura://ApexActionController/ACTION$execute",callingDescriptor:"UNKNOWN",params:{namespace:"",classname:"IAM_VisualforceToLightning",method:"getDoLogin",params:{fedID,password,startURL,resourceURL:null,appID:null,lang:"en_US"},cacheable:false,isContinuation:false}}]}`, `aura.context={mode:"PROD",fwuid,app,loaded,dn:[],globals:{},uad:true}`, `aura.pageURI=<login page path+query>`, `aura.token=null`.
   - Success → `returnValue.returnValue` = full `frontdoor.jsp?…&sid=…` URL.
   - Wrong password → `{"state":"ERROR","error":[{"message":"Your login attempt has failed…"}]}`.
4. GET frontdoor URL → static bounce → GET → now-authenticated `/clw/idp/login` returns auto-submitting SAML form; POST `SAMLResponse`+`RelayState` (HTML-entity-decode them) to the form action (Cognito `/saml2/idpresponse`), `allow_redirects=false`.
5. 302 `Location: connectcloud://authentication/callback?code=…&state=…` — verify state, extract code.
6. `POST {cognito}/oauth2/token` `grant_type=authorization_code&client_id&code&redirect_uri&code_verifier` → `{access_token, id_token, refresh_token, expires_in:3600}`.

Runtime refresh: `POST /oauth2/token` `grant_type=refresh_token&client_id&refresh_token` → fresh access+id token (refresh token may rotate — persist it).

**Porting risk:** steps 1–4 sit behind Salesforce's TLS-fingerprinting edge.
Node.js (OpenSSL-based TLS) may be served the same broken page as Python
`requests`. The Homey app therefore must keep the paste-a-refresh-token
pairing path as a first-class fallback; token refresh + telemetry API (steps
5–6 and all polling) are not behind that edge and work from any HTTP client.
