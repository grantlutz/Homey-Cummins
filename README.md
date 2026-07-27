# Cummins Generator (Unofficial) — Homey Pro app

> **This is an unofficial community app.** It is not affiliated with,
> endorsed by, or supported by Cummins Inc. "Cummins" and "QuietConnect" are
> trademarks of their respective owners and are used here only to describe
> the equipment this app works with. Do not contact Cummins for support with
> it. Use at your own risk.

Monitor — and on older models, control — your **Cummins home standby
generator** from Homey Pro, with full Flow, Insights, dashboard-widget and
notification support.

It works by talking to interfaces Cummins does not publish: the ConnectCloud
mobile API and the RS-series local web interface, both reverse-engineered by
the Home Assistant community and by this project. Cummins can change or
withdraw either at any time, which would break the app until it is updated.

App id: `io.github.grantlutz.cummins`

> **Which driver do I need?** If you monitor your generator with the
> **Cummins ConnectCloud phone app**, use the *Connect Cloud* driver. If your
> generator has an **Ethernet port and a web page you can open on your LAN**
> (older RS-series), use the *Local* driver — it's faster, needs no internet,
> and supports real start/stop control.

| Driver | For | Data source | Control |
|---|---|---|---|
| **Generator (Connect Cloud)** | QuietConnect / anything in the ConnectCloud app | Cummins cloud API | Start/stop, exercise, fault reset |
| **Generator (Local, RS-series)** | Older RS models with the web-interface card | Your LAN, no internet | Full (confirmed protocol) |

You can pair both, and multiple generators of each.

---

## What you get

**Live values** (all graphed in Insights): running, utility power present,
"on generator power", exercising, battery voltage, output voltage, output
frequency, engine runtime, load %, engine RPM (cloud), and a plain-English
status.

**Alarms:** fault, data stale (generator stopped checking in), exercise
overdue (missed its weekly self-test), action required (local).

**Estimated power output and energy produced** — enter your generator's
nameplate kW in device settings and the app derives watts and cumulative
kWh from the reported load. These are custom capabilities on purpose, so
Homey's Energy dashboard never counts generated power as household usage.

**A dashboard widget** with live status at a glance, an **app settings page**
with diagnostics for every paired generator, and optional **timeline
notifications** for the three things worth knowing at 3am: utility power
lost, house switched to generator, fault occurred.

**Flow cards** — 30+ triggers, 20+ conditions, 10 actions. Full reference in
[`docs/FLOW-CARDS.md`](docs/FLOW-CARDS.md).

### Controlling it without building a Flow

On the **local RS-series driver**, the device tile itself gives you:

| Control | Where |
|---|---|
| **Start / stop the generator** | On/off switch on the device tile |
| **Standby (auto-start) on/off** | Toggle on the device tile |
| **Run an exercise now** | Exercise button on the device tile |
| **Set the exercise schedule** | Device → Settings → *Exercise schedule* (frequency, day, hour, minute — written to the generator when you save, and read back from it otherwise) |
| **Sync the generator clock** | Device → Settings → Maintenance |

All of these need the generator's switch in **REMOTE**; that physical
interlock is the safety net.

On the **Connect Cloud driver** the on/off switch is hidden by default,
because it starts a real engine. Turn on *Enable remote start/stop* in the
device settings and the toggle appears; turn it off and it disappears again.
The Exercise button and the fault-reset card are always available — an
exercise is the same self-test the generator runs weekly on its own.

Setting the exercise *schedule* is local-only: that command exists in the
cloud API but takes arguments whose format is still unknown.

---

## Installation

You need [Node.js](https://nodejs.org) and the Homey CLI. Docker is required
by the CLI for `homey app run` on Homey Pro (Early 2023) and newer.

```bash
npm install --global homey
git clone https://github.com/grantlutz/Homey-Cummins.git
cd Homey-Cummins
npm install          # dev-only (type definitions); the app itself has no runtime deps
homey login
homey app install    # installs onto your Homey Pro
```

Use `homey app run` instead of `install` if you want live logs while testing
— the app stops when you quit. `homey app install` puts it on permanently.

---

## Setup

### Connect Cloud generators

1. On Homey: **Devices → + → Cummins Generator → Generator (Connect Cloud)**.
2. Enter your Cummins ConnectCloud e-mail and password.
3. Pick your generator from the list. Accounts with several generators can
   add each one.

The app signs in directly against Cummins' Salesforce/Cognito SSO and stores
**only the resulting session token — never your password**. Accounts with
multi-factor authentication are not supported.

<details>
<summary><strong>If sign-in fails with a "blocked" message</strong></summary>

Cummins' login runs behind Salesforce, which inspects how a client connects
(its TLS fingerprint) and may refuse anything that isn't a real browser. It
is known to block Python; whether it blocks Homey depends on their current
rules. If you hit this, get a token on a computer instead:

```bash
git clone https://github.com/tebrown/cummins_hacs
cd cummins_hacs
python3 -m venv .venv && source .venv/bin/activate
pip install -r tools/requirements.txt
playwright install chromium

export CUMMINS_USERNAME='you@example.com'
export CUMMINS_PASSWORD='your-password'
python tools/bootstrap_login.py
```

Paste the printed **refresh token into the password field** when pairing
(the e-mail field can be anything). The app detects a token automatically.
Token refresh and telemetry are not behind the fingerprinting edge, so once
paired everything works normally.
</details>

**When the session expires** the device goes unavailable with "sign-in
expired". Use **Device → Repair** to sign in again — you don't lose the
device, its history, or your Flows.

### Local RS-series generators

1. Give the generator a fixed IP (DHCP reservation on your router).
2. **Devices → + → Cummins Generator → Generator (Local, RS-series)**.
3. Enter its IP address and web credentials — the factory default is
   `admin` / `cummins`.

**For remote control, the switch on the generator must be set to REMOTE.**
In any other position the generator accepts monitoring but ignores start,
stop, exercise and standby commands.

---

## Device settings

| Setting | Default | What it does |
|---|---|---|
| Poll interval | 2 min (cloud) / 30 s (local) | How often to fetch data. Cloud telemetry is event-driven upstream, so faster polling mostly adds load, not freshness. |
| Data stale after | 25 h | Raises the stale alarm when the generator stops checking in. 25 h catches a missed daily check-in. |
| Exercise overdue after | 8 d | Raises the overdue alarm when no self-test completed. 8 d catches a missed weekly exercise. |
| Generator rated output | 0 (off) | Your nameplate kW. Set it to get power-output and energy-produced values. |
| Timeline notifications | on | Post utility-lost / on-generator / fault to the Homey timeline. |
| Enable remote start/stop | off | Cloud driver only — adds the on/off switch. Starts a real engine. |
| Auto-sync generator clock | off | Local driver only. Corrects the generator's clock when it drifts. |

The settings panel also shows read-only diagnostics: firmware, site,
exercise schedule, generator clock, and the raw undecoded status codes.

---

## Using it in Flows

A few starters — the complete card list is in
[`docs/FLOW-CARDS.md`](docs/FLOW-CARDS.md).

**Know immediately when the power goes out**
`When` Utility power was lost → `Then` Send push notification "House is on
backup power".

**Catch the failure that actually matters — a generator that didn't start**
`When` Utility power was lost → `Then` Delay 2 minutes → `And` The generator
is not running → `Then` Send push notification "⚠️ OUTAGE AND GENERATOR DID
NOT START".

**Protect against a dead starter battery**
`When` The battery voltage dropped below `12.0` V → `Then` Notify with the
voltage token. The battery is what starts the generator; a weak one means no
backup power when you need it.

**Never miss a self-test**
`When` The exercise became overdue → `Then` Notify. On the local driver you
can add `Then` Run an exercise now.

**Log every fault**
`When` A fault occurred → `Then` Append the code and description tokens to a
Google Sheet, or send them by e-mail.

**Load shedding during an outage**
`When` The load rose above `80` % → `Then` Turn off the EV charger and the
water heater.

---

## Safety notes

- **Disabling standby means the generator will not start by itself during an
  outage.** Flows run without confirmation — be deliberate with that card.
- **Cloud start/stop is off by default and gated behind a device setting.**
  Not because it might not work — it is confirmed working — but because it
  starts a real engine. It additionally requires the generator to report
  remote control as enabled.
- Remote-starting a generator runs a real engine. Make sure nobody is
  servicing it.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Sign-in expired" | Session lapsed — **Repair** the device. |
| Sign-in "blocked" during pairing | TLS fingerprinting; use the refresh-token method above. |
| "Generator unreachable" (local) | Wrong IP or credentials, or the generator is off the network. Fix them in device settings — the app retries immediately. |
| Commands do nothing (local) | The generator's switch isn't in REMOTE. |
| Data stale alarm | The generator itself hasn't checked in to Cummins. Usually means it lost network or power, not an app problem. |
| No power/energy values | Set the rated kW in device settings; they're off at 0. |
| Status enums shown as raw numbers | `gensetStatus` / `loadStatus` / `powerSource` have never been decoded by anyone. They're exposed raw in settings — if you can correlate them with what the Cummins app shows, please open an issue. |

App-wide status for all generators is on the app's settings page:
**More → Apps → Cummins Generator → Configure**.

---

## Development

```
lib/            zero-dependency clients: http.js (session/cookies/redirects),
                CumminsApi.js (cloud), AuraAuth.js (SSO login),
                CumminsLocalApi.js (local), EnergyEstimator.js
drivers/        generator (cloud), generator-local (RS-series)
widgets/        generator-status dashboard widget
settings/       app settings page
docs/           protocol research, porting plan, flow reference, review log
test/smoke.js   offline tests
```

Changes are recorded in [`CHANGELOG.md`](CHANGELOG.md) as they are made;
[`.homeychangelog.json`](.homeychangelog.json) holds the shorter text the
Homey App Store shows per version.

```bash
npm run check       # typecheck + tests + verified-level validation
npm test            # offline tests, no Homey required
npm run typecheck   # tsc --checkJs against the real Homey SDK typings
npm run validate    # homey app validate --level verified
```

The app has **no runtime dependencies** — all HTTP goes through
`lib/http.js` on Node built-ins, so it runs unmodified on every Homey Pro.

- `app.json` is generated. Edit `.homeycompose/` and the
  `driver.*.compose.json` files instead.
- `npm run typecheck` checks the JavaScript against `@types/homey`; that's
  how a call to a non-existent SDK method got caught. Keep it at zero errors.
- Don't add `typescript` to devDependencies — the Homey CLI then treats this
  as a TypeScript app and tries to compile it. The script uses `npx`.

Notable documentation:
[`docs/HA-INTEGRATIONS.md`](docs/HA-INTEGRATIONS.md) is the full protocol
record (cloud API endpoints, telemetry fields, the SSO login chain, and the
decoded local protocol tables) — read it before re-deriving anything.
[`docs/REVIEW-LOG.md`](docs/REVIEW-LOG.md) records bugs already found and
fixed, including a response-handling hang that froze polling permanently.

### Before publishing to the Homey App Store

Replace `assets/images/*` with real lifestyle photography — the store
rejects flat icon artwork — and change the app `id` in
`.homeycompose/app.json` if you don't control a matching domain.

---

## Credits

This app stands on prior reverse-engineering work by the Home Assistant
community. Licence texts and a precise statement of what was ported versus
reimplemented are in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

- **[tebrown/cummins_hacs](https://github.com/tebrown/cummins_hacs)** (MIT,
  © 2026 Travis Brown) — the Connect Cloud API and browserless SSO login
  chain. `lib/CumminsApi.js` and `lib/AuraAuth.js` are direct ports of that
  project's `api.py` and `aura_auth.py`.
- **[wareed1/Cummins-Generator-to-Home-Assistant](https://github.com/wareed1/Cummins-Generator-to-Home-Assistant)**
  (MIT, © 2026 Wayne A. Reed) — the exercise-tracking and data-freshness
  alarm ideas (adopted as concepts; no code ported).
- **[mdedonato/cummins_generator](https://github.com/mdedonato/cummins_generator)**
  (no licence declared — no code used) and
  **[mswilson/cummins-hass-integration](https://github.com/mswilson/cummins-hass-integration)**
  (Apache 2.0) — first published the decoded RS-series local protocol:
  status codes, LCD bit flags, and the `wr_logical.cgi` control writes.
  Reimplemented here, not copied.
- The [Home Assistant community thread](https://community.home-assistant.io/t/cummins-cloud-connect-generators/398442)
  that worked out the auth stack over several years.

## License

MIT — see [`LICENSE`](LICENSE). Third-party notices for the work this app
derives from are in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
