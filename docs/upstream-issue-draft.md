# Draft: upstream contribution to tebrown/cummins_hacs

Nothing has been posted. Review, edit to taste, then use the "How to share
it" instructions at the bottom.

**Suggested title:**
`Phase 2: the mobile command endpoint is POST /Assets/SendCommand?id= (solved, confirmed on hardware)`

---

## Body (paste from here down)

`docs/DESIGN.md` §3 lists the mobile command POST shape as uncaptured and
treats control as phase 2:

> The web app POSTs commands to `/assets/{id}/command/<name>`; the exact
> mobile command POST body/path should be re-captured before implementing
> control (we only have the command *list*, not a confirmed invocation).

I found it without needing a capture, and it's confirmed working end to end
against a live generator (start and stop both executed successfully).

### The endpoint

```
POST https://cc.aws.powercommandcloud.com/api/dashboard/v1/mobile/Assets/SendCommand?id=<assetId>
Authorization: Bearer <access_token>
mobile-data: <id_token>
Content-Type: application/json

{
  "DestinationId": "<assetId>",
  "CommandString": "StartGenset",
  "Properties": []
}
```

The body mirrors the objects `/Assets/Commands?id=<assetId>` returns, which
is what put me onto the shape:

```json
{
  "DestinationId": "<assetId>",
  "CommandString": "StartGenset",
  "Properties": [],
  "IsEnabled": true
}
```

The `/assets/{id}/command/<name>` path from the web app returns **404** on
the mobile API — it isn't there.

### How it was found (no commands executed)

Every probe used a deliberately invalid command name, so nothing could act
on a real generator. That also makes the responses easy to read: a 404 means
the path doesn't exist, while anything else means the endpoint exists and
merely rejected the fake name.

| Attempt | Result |
|---|---|
| `POST /Assets/{id}/command/{name}` (the web-app path) | 404 |
| `POST /assets/{id}/command/{name}` (lowercase) | 404 |
| `POST /Assets/Command` `{Id, Command}` | 404 |
| `POST /Assets/Commands` `{Id, Command}` | 404 |
| `POST /Assets/ExecuteCommand` `{AssetId, Command}` | 404 |
| `PUT /Assets/Command` `{Id, Command}` | 404 |
| `POST /Assets/SendCommand` (no query param) | **400** `Required parameter id is missing!` |
| `POST /Assets/SendCommand?id=…` with the command-object body | **422** enum violation on `.CommandString` |

That 422 is the useful one — the server replies with its complete
allowed-value list:

```
ResetDevice, ResetPassword, UpdateConfig, SoftwareUpdate, FaultReset,
StartAtsTest, StopAtsTest, StartGenset, StopGenset, StartExercise,
StopExercise, SetStandby, SetExerciseSchedule
```

So the API supports rather more than the three commands currently noted in
DESIGN.md. `/Assets/Commands` reports which ones a given generator has
enabled — on my unit, StartGenset, StopGenset, StartExercise, StopExercise,
SetStandby and SetExerciseSchedule all came back `IsEnabled: true`.

### Still open

The `Properties` shape for the parameterised commands (`SetStandby`,
`SetExerciseSchedule`) is unknown. The simple ones take `Properties: []`.

I deliberately stopped probing there: the invalid-name trick doesn't apply to
argument shapes, so a schema-valid guess would *execute* rather than error —
and silently disabling standby means the generator won't auto-start in an
outage. That part still needs a real capture from the ConnectCloud app.

### Reference implementation

I hit this while porting your integration to Homey Pro
(https://github.com/grantlutz/Homey-Cummins). The Node implementation is in
`lib/CumminsApi.js` (`sendCommand`), and the full write-up including the
probe method is in `docs/HA-INTEGRATIONS.md`. Happy to open a PR against
`cummins_hacs` implementing this in Python instead if you'd prefer — say the
word and I'll put one together.

Two other things confirmed along the way that might interest you:

- **The Salesforce TLS-fingerprint block doesn't catch Node.** Your
  `aura_auth.py` needs `curl_cffi` because plain `requests` gets the generic
  template; a straight Node `https` client with ordinary browser headers is
  served the real login page and completes the SSO chain unmodified. So the
  fingerprinting appears to target Python's TLS stack specifically rather
  than "non-browser" clients generally.
- Your reverse-engineering of the auth chain held up exactly as documented —
  every hop behaved as `docs/DESIGN.md` §5 describes. Thank you for writing
  it down in that much detail; it made the port straightforward.

---

## How to share it

1. Go to **https://github.com/tebrown/cummins_hacs/issues/new**
2. Title: `Phase 2: the mobile command endpoint is POST /Assets/SendCommand?id= (solved, confirmed on hardware)`
3. Paste the body above (everything between the two `---` rules).
4. Before submitting, check it contains none of your own identifiers — the
   draft deliberately writes `<assetId>` rather than your real asset id, and
   includes no tokens. Your GitHub username will be attached to the post.

Optional follow-ups worth considering:

- **The HA forum thread**
  (https://community.home-assistant.io/t/cummins-cloud-connect-generators/398442)
  has people who have wanted this since 2022 — a short post linking the
  issue would reach them.
- **mswilson/cummins-hass-integration** and
  **mdedonato/cummins_generator** are local-protocol projects and don't need
  this, but both are credited in `THIRD-PARTY-NOTICES.md`.
- If you'd rather I open a Python PR against `cummins_hacs` implementing
  the endpoint, I can draft that too — it's a small change to `api.py` plus
  a `button`/`switch` platform.
