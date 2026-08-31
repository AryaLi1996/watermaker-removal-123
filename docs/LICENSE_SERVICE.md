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

---

## How the client is put together

| File | Holds |
|---|---|
| `electron/license-config.js` | Endpoint, signing secret, grace period, poll cadence, offline plan prices |
| `electron/license-token.js` | Token verification and what an expiry means today |
| `electron/license-request.js` | The HTTP call, and the timeout that actually hangs up |
| `electron/subscription-monitor.js` | The state machine, storage, trial resolution, order polling |
| `electron/device-id.js` | The hardware-derived device id the trial is keyed by |
| `electron/secure-store.js` | Machine-bound AES-256-GCM for the files below |

Stored in the app's `userData` directory:

| File | Contents | Protection |
|---|---|---|
| `license.enc` | The signed token | AES-256-GCM, machine-bound, `0600` |
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

1. **One license covers both apps.** `LicensesTable` is keyed by `userId`
   alone, with no application dimension. A plan bought in SootheVoice
   satisfies this app for the same anonymous id, and the reverse. If the two
   should be sold separately, the service needs an app dimension in the table
   and in `/create-order` — a change in that repository, not this one.

2. **One free trial per machine, across both apps.** `TrialsTable` is keyed by
   `deviceId`. Someone who used their three days in SootheVoice arrives here
   with the trial already spent. The device id is derived the same way in both
   clients (MAC addresses + platform + arch, SHA-256) so it genuinely is the
   same key.

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

## Configuration

| Variable | Effect |
|---|---|
| `LICENSE_URL` | The base URL — Function URL or API Gateway stage |
| `LICENSE_SIGNING_SECRET` | HMAC secret; **must match the deployment's** |

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
