# Code Review Log — 2026-07-26

Record of the defects found in the first implementation pass and how they
were fixed, so the same traps aren't re-introduced.

## Severe

### 1. Truncated compressed responses hung forever (`lib/http.js`)

Node does **not** propagate source-stream errors through `.pipe()`. With
`accept-encoding: gzip`, a connection dropped mid-body left the gunzip
stream emitting neither `end` nor `error`, so `httpRequest`'s promise never
settled. In `poll()` that meant the `finally` never ran, `_pollBusy` stayed
`true` forever, and **every subsequent poll silently no-opped** — the device
sat on stale data, still showing as available, until the app restarted.

Reproduced with a local server that writes half a gzip body then destroys
the socket: identity encoding rejected with "aborted", gzip never settled.

**Fix:** explicit `error` and `aborted` handlers on the response itself when
a decompressor is in play, destroying the decompressor and rejecting.
**Regression test:** `testTruncatedCompressedResponse` in `test/smoke.js`
asserts both encodings reject rather than hang.

## Correctness

### 2. `log_poll_cycles = 1` disabled log checking entirely (local driver)

`_pollCount % logEvery === 1` is never true when `logEvery === 1`, because
`n % 1` is always 0. The setting's minimum is 1, so a user asking for the
*most* frequent log checks got none at all. Fixed by comparing against 0 and
incrementing after the check.

### 3. `local_load_above` fired on the first poll after pairing

The previous max load was computed with `|| 0`, coercing the first-poll
`null` to 0, so pairing a device while the generator was under load fired a
bogus "load rose above X". Fixed by reading both previous values before
writing and requiring both to be non-null — matching the `_transition` /
`_numeric` invariant that the first poll never triggers.

### 4. Failure backoff survived the fix that resolved it

Correcting a wrong IP or password created a new client but left
`_failCount` / `_backoffUntil` set and used a non-forced poll, so the device
stayed "unreachable" for minutes with zero attempts made. Same class of bug
on the cloud driver's threshold-change poll. Fixed by clearing the backoff
and forcing the verification poll.

### 5. Repair race could immediately undo a successful repair (cloud driver)

A poll in flight against the old client could, after the repair completed,
(a) mark the device unavailable again with a 30-minute backoff when its
stale 401 landed, and (b) overwrite the new `refresh_token` via the
abandoned client's rotation callback — worst when repairing to switch
accounts. Fixed with an `_apiGeneration` counter: results, errors, and token
rotations from a superseded client are discarded.

## Minor

- `statusKey()` reported `stopped` between app start and the first poll
  (`_statusCode` is memory-only), so a `status is stopped` condition read
  true for a running generator. Now falls back to the persisted status text.
- The widget showed "Load 0%" when load was genuinely unknown. Load now
  resolves to `null` rather than 0 when no line has reported.
- `device.getUnavailableMessage()` does not exist in SDK v3 and would have
  thrown. Caught by adding `tsc --checkJs` against `@types/homey`; devices
  now mirror the reason into `lastErrorMessage`.
- A fixed 15-minute energy-integration cap meant any poll interval above it
  never accumulated energy at all. The cap now scales with the poll
  interval. Caught by its own test on the first run.

## Verified clean

Edge-trigger semantics in both drivers, threshold run-listener crossing
logic, `_checkLogs` newest-first slicing, HTTP redirect method/body
downgrade rules, `connectcloud://` callback parsing, the token-refresh
dedupe, every Homey SDK call against the official typings, and every flow
card ID cross-checked between JS and compose files.
