# Draft: Homey Community forum topic

Nothing has been posted. Homey's convention for app topics is
`[APP][Pro] <App Name>` in the **Apps** category.

**Suggested title:**
`[APP][Pro] Cummins Generator (Unofficial)`

Once the topic exists, send me its numeric id and I'll add
`homeyCommunityTopicId` to the app manifest, which makes Homey link the
store listing straight to the thread.

---

## Body (paste from here down)

# Cummins Generator (Unofficial)

Monitor — and control — a **Cummins home standby generator** from Homey.

> ⚠️ **Unofficial community app.** Not affiliated with, endorsed by, or
> supported by Cummins Inc. Please don't contact Cummins about it. It works
> by talking to interfaces Cummins doesn't publish, so they could change or
> withdraw them at any time and break it until it's updated.

## Two drivers

**Generator (Connect Cloud)** — for QuietConnect and anything you currently
watch in the Cummins ConnectCloud phone app. Sign in with your ConnectCloud
e-mail and password; only the resulting session token is stored, never your
password.

**Generator (Local, RS-series)** — for older RS models with the Ethernet
web-interface card. Entirely local, no internet, no cloud account. Faster
polling and full control.

You can pair both, and multiple generators of each.

## What it gives you

Running state, utility power present, "on generator power", exercising,
battery voltage, output voltage and frequency, engine runtime, load %, engine
RPM, and a plain-English status — all graphed in Insights.

Alarms for faults, for a generator that has stopped checking in, for a missed
weekly self-test, and (local) for "action required" on the front panel.

Enter your generator's nameplate kW and it also estimates power output and
cumulative energy produced. These are custom capabilities on purpose, so
Homey's Energy dashboard never counts generated power as household usage.

Plus a dashboard widget, an app settings page with live diagnostics for every
paired generator, and optional timeline notifications for the three things
worth knowing at 3am: utility lost, house switched to generator, fault.

## Control

On the **local** driver the device tile has an on/off switch (start/stop), a
standby toggle, and an Exercise button; the exercise schedule is editable in
device settings, and there's a generator-clock sync.

On the **cloud** driver you get an Exercise button plus Flow cards for
running/stopping an exercise and clearing a fault. Start/stop is there too,
but off by default behind a device setting — not because it's unreliable, but
because it turns a real engine.

Control requires the switch on the generator itself to be in **REMOTE**.

## Flows

30+ triggers, 20+ conditions, 10 actions. The ones people tend to build first:

- *Utility power was lost* → push notification "House is on backup power"
- *Utility power was lost* → wait 2 min → **and** generator is not running →
  "⚠️ OUTAGE AND GENERATOR DIDN'T START" — the failure that actually matters
- *Battery voltage dropped below 12.0 V* → notify. The battery is what starts
  the generator; a weak one means no backup when you need it
- *Exercise became overdue* → notify, and on local, run one
- *Load rose above 80%* → shed the EV charger and water heater

## Install

Source and install instructions: https://github.com/grantlutz/Homey-Cummins

*(Update this once it's in the App Store.)*

## Credits

This stands on reverse-engineering done by the Home Assistant community:

- [tebrown/cummins_hacs](https://github.com/tebrown/cummins_hacs) — the
  Connect Cloud API and the browserless SSO login, which this app ports
- [wareed1/Cummins-Generator-to-Home-Assistant](https://github.com/wareed1/Cummins-Generator-to-Home-Assistant)
  — exercise tracking and staleness alarms
- [mdedonato/cummins_generator](https://github.com/mdedonato/cummins_generator)
  and [mswilson/cummins-hass-integration](https://github.com/mswilson/cummins-hass-integration)
  — the decoded RS-series local protocol

One thing that's new here: the **cloud command endpoint** was never publicly
known — upstream had it as unfinished work. It's
`POST /Assets/SendCommand?id=<assetId>` with `{DestinationId, CommandString,
Properties}`, found by probing with an invalid command name so nothing had to
be executed to learn it. Full write-up in the repo.

## Known limits

- No MFA support on ConnectCloud sign-in.
- `SetStandby` and `SetExerciseSchedule` exist in the cloud API but take
  arguments in a format I haven't identified, so setting the exercise
  *schedule* is local-only for now.
- `gensetStatus` / `loadStatus` / `powerSource` are integer enums nobody has
  decoded. They're shown raw in device settings — if you can match values to
  what the Cummins app displays, please post them here.

Bug reports and generator models that work (or don't) are very welcome.

---

## After you post it

1. Note the topic's numeric id from the URL, e.g.
   `community.homey.app/t/app-pro-cummins-generator-unofficial/**12345**`
2. Send it to me and I'll add `"homeyCommunityTopicId": 12345` to
   `.homeycompose/app.json` so the store listing links to the thread.
