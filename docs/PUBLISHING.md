# Publishing to the Homey App Store

Checked against Athom's App Store Guidelines
(https://apps.developer.homey.app/app-store/guidelines) on 2026-07-27.

## Compliance status

| Guideline | Requirement | Status |
|---|---|---|
| Brand naming | "In case your app supports a specific brand, use the brand name for your app." | ✅ "Cummins Generator (Unofficial)" |
| Name length | Names over four words not permitted | ✅ 3 words |
| Reserved words | May not use "Homey" or "Athom" in the name | ✅ |
| Protocol names | May not include Zigbee/Z-Wave/433 MHz/Infrared in the name | ✅ |
| One app per brand | "Ideally there is only one app per brand or concept" | ✅ no other Cummins app exists |
| App images | 250×175, 500×350, 1000×700, JPG/PNG | ✅ exact |
| Driver images | 75×75, 500×500, 1000×1000 | ✅ exact |
| Image content | "Images that consist of a single flat shape or icon on a plain, monochrome or transparent background are not approved." | ✅ scene, not a flat mark |
| Homey branding | "Do not use the Homey logo, name or device in any of your images." | ✅ |
| Icons | Vector, transparent background, no gradients or background colours | ✅ 960×960, solid paths only |
| Permissions | Request only what's needed | ✅ `[]` |
| Changelog | Required per version | ✅ |
| Community topic | `homeyCommunityTopicId` | ✅ 157618 |

**Reverse-engineered APIs:** the published guidelines contain **no policy**
either permitting or prohibiting integrations built on undocumented or
reverse-engineered vendor APIs. Many existing store apps are built this way.
So this is not a documented blocker — but it is also not an explicit
blessing, and Athom's review is human. The description and README state
plainly that the app is unofficial and depends on interfaces Cummins may
change, which is the honest framing to submit under.

## Residual risks

1. **Illustrated images, not photographs.** The rule only forbids "a single
   flat shape or icon on a plain background", which the current scene is not,
   but the same section advises avoiding "clipart". A photograph of a real
   installation would be a stronger submission. Swap
   `assets/images/{small,large,xlarge}.png` if one becomes available.
2. **Trademark.** "Cummins" and "QuietConnect" are used descriptively, no
   logo or wordmark is reproduced anywhere in the artwork, and the app is
   labelled unofficial in its name, description, tags and README. This
   follows the guideline's own instruction to use the brand name, but Cummins
   Inc. could still object independently of Athom.
3. **Equipment control.** The guidelines say nothing about safety-relevant
   control. Start/stop is opt-in per device, and local control additionally
   requires the generator's own switch to be in REMOTE.

## Before submitting

- [ ] Bump the version if anything changed: `homey app version patch|minor|major`
- [ ] `npm run check` — typecheck, tests, `validate --level verified`
- [ ] Re-pair on a Homey under the new app id and confirm pairing works
      end to end from a clean state
- [ ] Confirm the forum topic title matches the store name

## Submitting

```bash
homey app publish
```

That uploads the build and opens it for Athom review. Publishing requires
being logged in (`homey login`); CI can use a `HOMEY_PAT` env var instead.

After submission the app appears under
https://tools.developer.homey.app as a draft/pending version. Athom review
is manual, so expect days rather than minutes. Approved versions have to be
promoted from Test to Live in the developer tools.

Note that the **app id is permanent**. `io.github.grantlutz.cummins` cannot
be changed after the first publish without shipping an entirely separate app
and asking every user to re-pair.
