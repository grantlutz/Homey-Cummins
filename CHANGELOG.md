# Changelog

All notable changes to this app are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/).

This file is the developer-facing history. `.homeychangelog.json` is the
short, user-facing text shown in the Homey App Store, and must be updated
alongside it for every released version.

## [Unreleased]

Nothing yet.

## [1.0.1] — 2026-07-27

First release, submitted to the Homey App Store and pending certification.

Published as 1.0.1 rather than 1.0.0: `homey app publish` requires a version
bump at submission, so 1.0.0 was consumed by the publish flow and never
shipped as a distinct release.

### Added

**Two drivers, covering both generator generations**

- `generator` — Cummins Connect Cloud (QuietConnect and anything visible in
  the ConnectCloud app). Browserless username/password sign-in against
  Cummins' Salesforce/Cognito SSO, storing only the resulting refresh token;
  a pasted refresh token is accepted as a fallback. Repair flow re-authorises
  without losing the device.
- `generator-local` — older RS-series units with the Ethernet web-interface
  card. Fully local, no cloud account. Pairing discovers generators by
  sweeping Homey's own subnet; manual address entry remains as a fallback.

**Monitoring** — running state, utility power, "on generator power",
exercising, battery voltage, output voltage, output frequency, engine
runtime, load percentage, engine RPM (cloud), two load lines (local), and a
plain-English status. All with Insights history.

**Alarms** — fault, stale data (generator stopped checking in, default 25 h),
exercise overdue (default 8 days), and action-required (local). Thresholds
configurable per device.

**Control**

- Local: start/stop and standby toggles plus an Exercise button on the device
  tile; exercise schedule editable in device settings; generator clock sync
  with an optional automatic drift correction.
- Cloud: Exercise button on the tile, plus Flow actions to run or stop an
  exercise and clear a fault. Start/stop available behind an opt-in device
  setting, since it turns a real engine.

**Flow cards** — 30+ triggers, 20+ conditions, and 10 actions, including
edge-triggered utility-power loss/restore, generator start/stop, fault
raised/cleared, exercise started/completed, new cloud or local log events,
and threshold crossings for battery voltage and load. Full reference in
`docs/FLOW-CARDS.md`.

**Energy estimation** — enter the generator's nameplate kW and the app
derives power output and cumulative energy produced from the reported load.
Deliberately custom capabilities rather than `measure_power`/`meter_power`,
so Homey's Energy dashboard never counts generated power as household
consumption.

**Other** — a dashboard widget showing live status; an app settings page with
per-generator diagnostics and command troubleshooting; optional Homey
timeline notifications for utility loss, switching to generator power, and
faults.

### Protocol work

- **Solved the Cummins cloud command endpoint**, which no prior project had:
  `POST /Assets/SendCommand?id=<assetId>` with a body of
  `{DestinationId, CommandString, Properties}`. Found by probing with a
  deliberately invalid command name, so no command had to be executed to
  learn it; the server's 422 reply returned its complete allowed-command
  enum. Confirmed driving real hardware. Full write-up in
  `docs/HA-INTEGRATIONS.md`.
- Confirmed Salesforce's TLS fingerprinting does not block Homey's Node
  runtime, so username/password sign-in works without the `curl_cffi`
  workaround the upstream Python integration needs.

### Fixed

Defects found by review before first release:

- Truncated compressed HTTP responses hung forever, because Node does not
  propagate source-stream errors through `.pipe()`. This left the poll lock
  held permanently and silently froze all further polling.
- `log_poll_cycles = 1` disabled local log checking entirely (`n % 1` is
  always 0), so the most frequent setting produced no checks at all.
- The local load threshold trigger fired spuriously on the first poll after
  pairing, treating an unknown previous value as zero.
- Correcting a wrong IP or password did not clear the failure backoff, so a
  fixed device stayed unreachable for minutes with no retry attempts.
- A repair racing an in-flight poll could be immediately undone: the stale
  401 re-marked the device unavailable for 30 minutes and could overwrite the
  new refresh token with the old account's.
- A fixed 15-minute energy integration cap meant any poll interval above it
  never accumulated energy at all.
- `device.getUnavailableMessage()` does not exist in SDK v3 and would have
  thrown; devices now mirror the reason themselves.

Details and reproduction notes in `docs/REVIEW-LOG.md`.

### Store preparation

- App id set to `io.github.grantlutz.cummins`. The original
  `com.cummins.generator` asserted Cummins Inc.'s own namespace; the id is
  permanent once published.
- Named "Cummins Generator (Unofficial)", with the unofficial status stated
  in the name, description, tags and README.
- Store artwork replaced: the previous images were a flat mark on a gradient,
  which the guidelines reject.
- Third-party notices added (`THIRD-PARTY-NOTICES.md`) — two of the four
  upstream projects are MIT-licensed and their code was ported directly, so
  reproducing their notices is an obligation, not a courtesy.

[Unreleased]: https://github.com/grantlutz/Homey-Cummins/compare/main...HEAD
[1.0.1]: https://github.com/grantlutz/Homey-Cummins/releases/tag/v1.0.1
