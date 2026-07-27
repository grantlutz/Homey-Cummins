# Third-Party Notices

This app is a derivative work. The Cummins Connect Cloud protocol and the
RS-series local protocol were both reverse-engineered by others; this project
ports and reimplements that work for Homey. The notices below are reproduced
as required by the corresponding licences.

---

## tebrown/cummins_hacs — MIT

https://github.com/tebrown/cummins_hacs

**`lib/CumminsApi.js` is a JavaScript port of that project's
`custom_components/cummins_connectcloud/api.py`, and `lib/AuraAuth.js` is a
JavaScript port of its `aura_auth.py`.** The Cognito/Salesforce SSO chain, the
dual-token (`Authorization` + `mobile-data`) requirement, the endpoint map and
the telemetry field semantics all originate there.

```
MIT License

Copyright (c) 2026 Travis Brown

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## wareed1/Cummins-Generator-to-Home-Assistant — MIT

https://github.com/wareed1/Cummins-Generator-to-Home-Assistant

No code was ported. The **25-hour data-staleness alarm** and the **8-day
"exercise overdue" alarm** are that project's ideas, adopted here as
configurable defaults.

```
MIT License

Copyright (c) 2026 Wayne A. Reed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## mswilson/cummins-hass-integration — Apache License 2.0

https://github.com/mswilson/cummins-hass-integration

No code was copied. The **exercise-schedule write parameters**
(`@425` frequency, `@391` day, `@392` hour, `@393` minute) and the
**load-management parameters** (`@426`) were documented by that project and
are reimplemented here in `lib/CumminsLocalApi.js`.

Licensed under the Apache License, Version 2.0 — full text at
http://www.apache.org/licenses/LICENSE-2.0. The upstream project ships no
`NOTICE` file. Changes made here: reimplemented in JavaScript against the
Homey SDK; no upstream source is reproduced.

---

## mdedonato/cummins_generator — no licence declared

https://github.com/mdedonato/cummins_generator

**This repository publishes no licence**, so no rights to copy or modify its
source are granted, and none were exercised: no code from it appears here.

What this project uses from it are **facts about the generator's own
protocol**, not authorship — the `index_data.html` field order, the status
code table (0–23), the LCD status bit masks, and the `wr_logical.cgi` control
parameters (`@242`, `@385`, and the `@448`/`@449`/`@450`/`@402`/`@403` clock
fields). Those describe how Cummins hardware behaves; they were independently
reimplemented in `lib/CumminsLocalApi.js`. The project is credited here
because it is where that knowledge was first published.

---

## Home Assistant community thread

https://community.home-assistant.io/t/cummins-cloud-connect-generators/398442

Traced the migration of Cummins' auth backend from Microsoft Azure B2C to the
current Salesforce/Cognito stack, and is the origin of the
"401 Cannot read property 'sub' of null" finding that identified the
dual-token requirement.

---

## Not derived from prior work

The following were established by this project and were not known to any of
the above:

- The **cloud command endpoint** `POST /Assets/SendCommand?id=<assetId>` with
  the body `{DestinationId, CommandString, Properties}`, and the server's full
  command enum. See `docs/HA-INTEGRATIONS.md`.
- The Homey app itself: drivers, capabilities, Flow cards, widget, settings
  pages, energy estimation, and the HTTP layer in `lib/http.js`.
