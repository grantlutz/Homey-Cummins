# Launch post — Homey Community

**Edit the existing topic (157618) rather than starting a new one.** Discourse
keeps the topic id when you change the title, the old URL keeps redirecting,
and 157618 is already baked into the app manifest as
`homeyCommunityTopicId` — a new topic would break that link.

**Subject:**

```
[APP][Pro] Cummins Generator (Unofficial)
```

`[APP][Pro]` is the Homey convention for a Pro-only app topic, and the name
matches the App Store listing exactly so the two are recognisably the same
thing.

---

## Post body (paste from here down)

# Cummins Generator (Unofficial)

Your standby generator is the one appliance in the house you *hope* never
runs — which is exactly why you want to know it's healthy before the night it
matters. This app brings it into Homey: live status, Insights history, alarms
for the things that quietly go wrong, and control from a device tile or a
Flow.

> ⚠️ **Unofficial community app.** Not affiliated with, endorsed by, or
> supported by Cummins Inc. Please don't contact Cummins about it. It works by
> talking to interfaces Cummins doesn't publish, so they can change or
> withdraw them at any time and break it until it's updated.

---

## Which driver do I need?

The app ships two, and picking the right one is the only fiddly part of setup.

**Generator (Connect Cloud)** — if you currently check your generator in the
**Cummins ConnectCloud phone app**, this is you. Covers QuietConnect and
anything else that account can see. Sign in with the same e-mail and
password; only the resulting session token is stored, never your password.

**Generator (Local, RS-series)** — if your generator has an **Ethernet port
and a web page you can open on your LAN** (older RS models with the
web-interface card), use this one. It's the better experience: no internet, no
cloud account, faster updates, and it can set the exercise schedule. Pairing
searches your network for it, so there's usually nothing to type.

Not sure? Try the local driver's network search first. If it finds nothing,
you're on Connect Cloud. You can pair both, and several generators of each.

---

## What you get

**Live, and graphed in Insights** — running, utility power present, whether
the house is actually on generator power, exercising, battery voltage, output
voltage and frequency, engine runtime, load percentage, engine RPM, and a
plain-English status.

**Alarms for the quiet failures**

- **Fault** — the generator is reporting a problem
- **Data stale** — it has stopped checking in, which usually means it lost
  network or power
- **Exercise overdue** — it missed its weekly self-test
- **Action required** — the front panel wants attention (local driver)

**Estimated power and energy** — enter your generator's nameplate kW in device
settings and you also get output in watts and cumulative kWh produced. These
are deliberately separate from Homey's Energy dashboard, so a running
generator never gets counted as household consumption.

**Also** — a dashboard widget with status at a glance, an app settings page
showing every paired generator at once, and optional timeline notifications
for the three things worth knowing at 3am: utility lost, house switched to
generator, fault raised.

---

## Control

**Local (RS-series):** on/off switch, standby toggle and an Exercise button
right on the device tile. The exercise schedule is editable in device
settings, and there's a generator clock sync with optional automatic drift
correction.

**Connect Cloud:** an Exercise button on the tile, plus Flow actions to run or
stop an exercise and clear a fault. Start/stop is there too, but off by
default behind a device setting — not because it's unreliable, but because it
turns over a real engine and shouldn't be one stray tap away.

Either way, the switch on the generator itself has to be in **REMOTE**.
That physical interlock is the safety net, and it's the answer to "why did my
command do nothing?"

---

## Flows

30+ triggers, 20+ conditions, 10 actions. The ones worth building on day one:

**Know the power went out**
`When` Utility power was lost → `Then` push notification "House is on backup
power"

**Catch the failure that actually matters**
`When` Utility power was lost → `Then` wait 2 minutes → `And` the generator
isn't running → `Then` "⚠️ OUTAGE AND THE GENERATOR DIDN'T START"

That second one is the whole reason to automate this. An outage is
inconvenient; an outage where the generator *didn't start* is the thing you
want to hear about immediately.

**Watch the battery** — `When` battery voltage dropped below 12.0 V → notify.
The battery is what cranks the engine. A weak battery is the single most
common reason a standby generator fails to start, and it gives you weeks of
warning if you're watching.

**Don't miss the self-test** — `When` exercise became overdue → notify (and on
the local driver, run one).

**Shed load during an outage** — `When` load rose above 80% → turn off the EV
charger and the water heater.

---

## Install

Source, setup instructions and troubleshooting:
**https://github.com/grantlutz/Homey-Cummins**

Coming to the Homey App Store shortly — I'll update this post with the store
link once it's through review.

---

## Credit where it's due

This app exists because the Home Assistant community did the hard part first,
over several years:

- **[tebrown/cummins_hacs](https://github.com/tebrown/cummins_hacs)** — worked
  out the Connect Cloud API and the browserless SSO login. This app is a port
  of that work, and his write-up made it possible.
- **[wareed1/Cummins-Generator-to-Home-Assistant](https://github.com/wareed1/Cummins-Generator-to-Home-Assistant)**
  — exercise tracking and the data-freshness alarm.
- **[mdedonato/cummins_generator](https://github.com/mdedonato/cummins_generator)**
  and **[mswilson/cummins-hass-integration](https://github.com/mswilson/cummins-hass-integration)**
  — decoded the RS-series local protocol: status codes, LCD bit flags and the
  control writes.
- The [Home Assistant thread](https://community.home-assistant.io/t/cummins-cloud-connect-generators/398442)
  that tracked Cummins' auth stack through its migrations since 2022.

One piece is new here. The **cloud command endpoint** was never publicly
known — upstream had it filed as unfinished work, and the forum thread has
people stuck on it going back years. It turns out to be
`POST /Assets/SendCommand?id=<assetId>` with
`{DestinationId, CommandString, Properties}`. I found it by probing with a
deliberately invalid command name, so nothing had to be fired at a real
generator to learn it — and Cummins' own validator replied with the complete
list of commands it accepts. Full write-up is in the repo, and it's going back
upstream.

---

## Known limits

- **No MFA** on ConnectCloud sign-in.
- **Exercise scheduling is local-only.** The cloud API has the command, but it
  takes arguments in a format I haven't identified, and guessing at it isn't
  safe when one of the neighbouring commands disables auto-start.
- **Three status fields are still undecoded** — `gensetStatus`, `loadStatus`
  and `powerSource` are integers nobody has cracked. They're shown raw in
  device settings. **If you can match those numbers to what the Cummins app
  displays on your generator, please post them here** — that's the single most
  useful thing anyone can contribute.

---

Bug reports welcome, and I'd genuinely like to hear which generator models
work — especially RS-series owners, since I don't have that hardware to test
against. Tell me your model and which driver you used.
