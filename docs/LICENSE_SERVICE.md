# Licensing: the shared license service

Subscriptions in this app are not local state. They are held by the service
documented in
[`ruanjian123/docs/LICENSE_INFRASTRUCTURE.md`](https://github.com/AryaLi1996/ruanjian123/blob/main/docs/LICENSE_INFRASTRUCTURE.md)
— one AWS Lambda over three DynamoDB tables — which this app **shares** with
SootheVoice rather than deploying its own copy.

Nothing in this repository provisions infrastructure. The client points at an
already-deployed endpoint.

---

## What this app talks to

| | |
|---|---|
| Function | `LicenseVerifier` (python3.11, arm64) — one handler, routed by path |
| Tables | `OrdersTable` (orderId), `LicensesTable` (userId), `TrialsTable` (deviceId) |
| Endpoint | `LICENSE_URL`, defaulting to the deployed Lambda Function URL |

**Function URL or API Gateway.** The handler dispatches on the *suffix* of the
request path and reads `rawPath`, `requestContext.http.path` and `path`. A
stage prefix therefore makes no difference: `https://…/prod` + `trial/status`
still ends with `/trial/status`. Point `LICENSE_URL` at either.

### Routes used

| Method | Route | Used for |
|---|---|---|
| `GET` | `/plans` | The plan cards. The service computes every price. |
| `GET` | `/payment-methods?lang=` | Which methods are usable, already localised. |
| `POST` | `/create-order` | `{planId, method, userId}` → checkout URL + `presentAs`. |
| `GET` | `/order-status?orderId=&userId=` | Polled while a payment is pending; carries the token once paid. |
| `GET` | `/payment-history?userId=` | The user's own past orders. |
| `POST` | `/trial/activate` | Idempotent — creating or returning this device's trial. |
| `GET` | `/trial/status?deviceId=` | Whether this device has had a trial. |
| `POST` | `/` | Exchanges a license key for a fresh token (the refresh path). |

Every one of them also carries `appId` — see below.

---

## How the client is put together

| File | Holds |
|---|---|
| `electron/license-config.js` | Endpoint, signing secret, grace period, poll cadence, offline plan prices |
| `electron/license-token.js` | Token verification and what an expiry means today |
| `electron/license-request.js` | The HTTP call, and the timeout that actually hangs up |
| `electron/subscription-monitor.js` | The state machine, storage, trial resolution, order polling |
| `electron/demo-license.js` | The demo licence this build issues itself — see below |
| `electron/device-id.js` | The hardware-derived device id the trial is keyed by |
| `electron/secure-store.js` | Machine-bound AES-256-GCM for the files below |

Stored in the app's `userData` directory:

| File | Contents | Protection |
|---|---|---|
| `license.enc` | The signed token | AES-256-GCM, machine-bound, `0600` |
| `demo.enc` | `{appId, deviceId, issuedAt, expiresAt, via}` — this device's demo licence | Same, and for the same reason as `trial.enc` |
| `trial.enc` | `{trialStart, trialEnd, durationDays}` | Same — not because dates are secret, but so they cannot be edited to extend a trial |
| `.license_ts` | Highest timestamp ever seen | Plaintext; catches a clock wound backwards |
| `.anon_id` | Anonymous payment id | Plaintext, not secret |
| `.device_id` | Hardware-derived device fingerprint | Plaintext, not secret |

States: `loading → unlicensed | active | grace_period | expired`. The grace
period (3 days past expiry) is why an unreachable service or a flight does not
lock someone out of what they paid for.

---

## Consequences of sharing the service

These follow from reusing one Lambda and one set of tables, and are worth
knowing before this ships.

1. **One license covers both apps** — until the service carries an app
   dimension. `LicensesTable` is keyed by `userId` alone, so a plan bought in
   SootheVoice satisfies this app for the same anonymous id, and the reverse.
   This client now names itself on every request (below); the isolation is
   only real once the service reads it.

2. **One free trial per machine, across both apps**, for the same reason.
   `TrialsTable` is keyed by `deviceId`, so someone who used their three days
   in SootheVoice arrives here with the trial already spent. The device id is
   derived the same way in both clients (MAC addresses + platform + arch,
   SHA-256) so it genuinely is the same key — which is why the app, not the
   machine, has to be the other half of it.

3. **The token's `features` are SootheVoice's** (`training`, `synthesis`,
   `separation`, `cover`). This app deliberately gates on *having* a valid
   license rather than on that list, which otherwise would unlock nothing here.

4. **Prices come from the service** and are rounded half-up, so the plans are
   ¥99 / ¥282 / ¥535 / ¥1010. This app previously rounded down (¥534 / ¥1009).
   The offline fallback in `license-config.js` mirrors the service's formula so
   the two agree; change a price on the service and update that fallback.

5. **Plan ids are the service's**: `monthly`, `quarterly`, `semi_annual`,
   `annual`. The last two were `halfyear` and `yearly` here.

6. **There is no auto-renewal to cancel.** The service takes one-off payments
   and extends the expiry, rather than creating a provider-side subscription.
   Buying again while a plan is live adds to the current end date.

---

## Which app this is

The service holds one set of tables for every app on the account. Nothing but
an app dimension separates them, so this client names itself on every request:

```
appId = smoothvoice
```

Sent as a query parameter on the `GET` routes and a body field on the `POST`
routes — `/plans`, `/payment-methods`, `/trial/status`, `/trial/activate`,
`/create-order`, `/order-status`, `/payment-history` and the refresh path.
`electron/license-config.js` holds the value and
`electron/subscription-monitor.js` puts it on the wire; `URLSearchParams` in
one helper builds the query strings, so no route can quietly go without it.

**`smoothvoice`, not `shuyin`.** This app's rows already exist in the
service's tables with no appId at all, and the migration stamps exactly that
value onto them. It is also the value the service falls back to for a request
carrying none, so an upgraded client and an old build resolve to the same
subscription during the rollout. A different id here would strand every
license bought before the change. `LICENSE_APP_ID` (or `VITE_APP_ID`)
overrides it at build time, which is for pointing a build at a test
deployment — not for renaming the app.

### What the client does with the answer

A token carries the appId the service issued it for. One naming another app
verifies here — same account, same signing secret — so only that field stops
it unlocking this app off a sibling's purchase:

* a stored token for another app is ignored at startup, and the app reads as
  unlicensed rather than honouring it;
* a token that arrives with a settled order is refused, and the page says the
  subscription belongs to a different app and to activate here, rather than
  reporting a payment that failed;
* a token with **no** appId is honoured. Every license bought before this
  change carries none; reading that as a mismatch would sign out every
  existing subscriber on upgrade.

### What the service still has to do

The client half is in place and is inert against today's deployment, which
ignores the extra field. Isolation begins when
[`ruanjian123`](https://github.com/AryaLi1996/ruanjian123) ships:

| | |
|---|---|
| `LicensesV2` | partition key `(appId, licenseId)`, GSI `appId-deviceId-index` |
| `TrialsV2` | partition key `(appId, deviceId)` |
| Migration | existing rows stamped `appId = 'smoothvoice'` |
| `USE_APP_ID_DIMENSION` | Lambda env var switching the new lookups on |
| Orders | `appId` stored on the order, so the payment webhook issues the license for the right app |
| Missing `appId` | defaults to `smoothvoice` and logs a warning, for the transition |

Until then a trial spent in the sibling app still arrives here used, and a
plan bought there still satisfies this one. Nothing in this repository can
change that — see the note at the top: this app deploys no infrastructure.

---

## The demo licence

Alongside the paid plans, the subscription page offers a **demo licence**:
seven days of every paid feature, once per device, with no payment. It is for
an internal test, a demonstration, or someone deciding whether temporal fill
is worth paying for — cases the three-day device trial either cannot serve or
has already spent.

It is the one licence in this app the service does not issue.

| | |
|---|---|
| Issued by | `electron/demo-license.js`, in this process |
| Signed with | the same HMAC secret this build verifies with |
| Plan id | `demo` — no plan in `PLAN_TIERS` uses it |
| Length | 7 days, then the ordinary grace period, then locked |
| Limited by | `demo.enc` in the app's `userData`, machine-bound like `trial.enc` |
| Refreshed | never — see `refresh()`; the service has no fresher copy |

Two doors, one licence: the **Get a demo licence** button sends nothing, and
the box takes one of the codes in `license-config.js` (`DEMO-2026`,
`SHUYIN-TRIAL`). Neither grants more than the other — a code that did would be
two features wearing one name. The codes are not secrets; they ship in that
file, and what limits a demo is the device record, not knowing the string.

### What this is not

A demo token is indistinguishable from a purchased one to anything that only
checks the signature. `planId: 'demo'` is the field that separates them, and
`isDemoLicense` in `renderer/src/subscription.ts` is what reads it — the page
names it a demo, counts it down, and keeps the paid entry live throughout so
it can be upgraded at any point.

The "once per device" limit is a file in the app's own data directory. It
stops an honest user clicking twice; it stops nobody who deletes the file. A
real limit needs the *service* to hold the record — a `demo-activate` route
against `TrialsV2`, refusing a device that has had one, exactly as
`trial/activate` already does. That belongs in
[`ruanjian123`](https://github.com/AryaLi1996/ruanjian123) and does not exist
yet; when it does, `activateDemo` becomes a call to it and this local mint
becomes the offline fallback, the same shape `_resolveTrial` already has.

### Which builds have it

**All of them, unless a build says otherwise.** The flag is a *disable*, and
unset means on, so a development run, a packaged release and the test suites
all carry the entry without anyone configuring anything.

Both halves of the app read the same variable, and the entry appears only if
both agree:

| | |
|---|---|
| The button | `VITE_DISABLE_DEMO_LICENSE` → `ENABLE_DEMO_LICENSE` in `renderer/src/config.ts`. Inlined at build time. |
| The issuing | `demoLicenseEnabled` in `electron/license-config.js`, which gates `license:activateDemo` in `main.js`. A renderer told the entry does not exist can still send the message; this is what refuses it. |

To turn it off for a build, set `VITE_DISABLE_DEMO_LICENSE=true` — in the
build environment, or in a `renderer/.env.production` that `npm run build`
picks up. That removes the button. Note the asymmetry: `VITE_` variables are
build-time values for the *bundle* and do not reach a packaged main process at
runtime, so a packaged build that must also refuse the IPC needs
`DISABLE_DEMO_LICENSE=true` in its own environment. In practice the button is
the entry, and there is no other way to reach the channel from the app.

---

## Configuration

| Variable | Effect |
|---|---|
| `LICENSE_URL` | The base URL — Function URL or API Gateway stage |
| `LICENSE_SIGNING_SECRET` | HMAC secret; **must match the deployment's** |
| `LICENSE_APP_ID` / `VITE_APP_ID` | Which app the service scopes this build to. Defaults to `smoothvoice`; only change it for a test deployment |
| `VITE_DISABLE_DEMO_LICENSE` | `true` removes the demo licence entry from the bundle. Unset — the default — means the demo is offered |
| `DISABLE_DEMO_LICENSE` | `true` makes the main process refuse `license:activateDemo`. For a packaged build, which cannot read the `VITE_` one at runtime |
| `ENABLE_MANUAL_ACTIVATION` | `true` shows the box for typing a licence key or token in by hand |

The signing secret ships with a public default, in this repository and in the
service's own source. A build still using it can have its tokens forged
offline, so the app warns at startup and the service warns in its logs. Both
ends holding the same symmetric secret is inherent to HMAC; the service's docs
name the fix (RSA — server signs, client verifies with an embedded public
key), and verification is centralised in `license-token.js` so that change
lands in one place.

**Tests never reach the real service.** The E2E fixtures set
`LICENSE_URL=http://127.0.0.1:9/` and stub the licence and payment IPC, so a
suite run cannot write a runner's device id into the shared production trial
table.
