# Cummins Generator — Homey Pro app

Homey SDK v3 app, plain JavaScript, **zero runtime npm dependencies** (all
HTTP via `lib/http.js` on Node built-ins — keep it that way).

## Changelog — maintain this on every change

**`CHANGELOG.md` is kept up to date as part of the work, not afterwards.**
Every user-visible change, bug fix, or protocol finding gets an entry in the
same commit that makes the change. Do not wait to be asked, and do not batch
it up for later.

- Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) —
  `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security`
  under an `## [Unreleased]` heading, promoted to a version heading on
  release.
- Write entries for the person running the app, not the person who wrote the
  diff: say what now behaves differently and why it matters. Internal
  refactors with no observable effect don't need an entry.
- On release, also update **`.homeychangelog.json`** — that is the short
  user-facing text shown in the Homey App Store, keyed by version, and it
  must exist for the version being published. The two files serve different
  readers: `CHANGELOG.md` is the full developer history, the JSON is a
  paragraph a store visitor reads.
- Bump the version with `homey app version <patch|minor|major>`, then move
  `[Unreleased]` to that version with today's date.

## Editing rules

- **`npm run check` must pass** — it chains type check, tests, and
  `homey app validate --level verified`. All three work offline.
- `app.json` is GENERATED — edit `.homeycompose/app.json`, the
  `driver.*.compose.json` files, and `.homeycompose/capabilities/*.json`.
- Offline tests: `npm test` (spins up a throwaway HTTP server; no Homey
  needed). Run after touching `lib/`.
- `npm run typecheck` runs `tsc --checkJs` against the real Homey SDK type
  definitions (`@types/homey`), which is how the non-existent
  `getUnavailableMessage()` call was caught. Keep it at zero errors, and
  keep JSDoc types accurate rather than silencing it.
- Do NOT add `typescript` to devDependencies: the Homey CLI reads that as
  "this is a TypeScript app" and tries to compile the whole app, which
  breaks `homey app run/validate`. The typecheck script pulls it via `npx`.
- Flow card IDs are app-global: local-driver cards are prefixed `local_` to
  avoid colliding with cloud-driver cards. Never reuse an ID across drivers.
- Custom-capability flow cards are triggered MANUALLY from `device.js` via
  `this.driver.triggers.<id>` (fetched once in each driver's `onInit`).
  Card IDs deliberately do NOT match the `<capability>_true` auto-trigger
  pattern — renaming one to match would double-fire.

## Architecture in one breath

Two drivers: `generator` (Connect Cloud mobile API, refresh-token auth in
device store, poll `/Assets/Detail` + `/Assets/Events`) and
`generator-local` (RS-series embedded web server, poll `index_data.html`,
confirmed control writes via `wr_logical.cgi`). Both device.js files share
the same patterns: `_transition`/`_numeric` capability helpers that fire
edge-triggers only when the previous value was non-null (first poll after
pairing never triggers), progressive failure backoff (`poll(force)` bypasses
it for user-initiated refreshes), and read-only diagnostics pushed into
device settings labels.

## Domain gotchas (documented at length in docs/)

- Cloud API requires BOTH `Authorization: Bearer` AND `mobile-data:
  <id_token>` headers — missing the second 401s.
- The username/password login (`lib/AuraAuth.js`) may be blocked by
  Salesforce TLS fingerprinting (blocks Python; Node untested). Pairing
  accepts a pasted refresh token in the password field (>100 chars = token).
- Cloud commands go to `POST /Assets/SendCommand?id=<assetId>` with body
  `{DestinationId, CommandString, Properties: []}` — discovered here, not
  known upstream, and confirmed driving real hardware. `Properties` shapes
  for SetStandby/SetExerciseSchedule are still unknown; do NOT probe for
  them, a schema-valid payload executes rather than erroring.
- The `*_experimental` flow-card IDs are kept only because renaming a card
  ID breaks any Flow already using it. Their titles no longer say that.
- The generator's local clock is naive wall-time; all drift math must
  compare against `_homeyLocalNow()` (same frame), never `Date.now()`.
- Power/energy are ESTIMATES from load% × the user's `rated_kw` setting
  (`lib/EnergyEstimator.js`) — deliberately custom capabilities, not
  `measure_power`/`meter_power`, so Homey's Energy dashboard never counts
  generated power as household consumption.
- SDK v3 has no getter for the unavailable message, so devices keep their
  own `lastErrorMessage` copy for the settings page.
- `docs/HA-INTEGRATIONS.md` holds the full reverse-engineering record
  (API endpoints, telemetry fields, local protocol tables) — check it before
  re-deriving anything.
