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
| `POST` | `/demo/activate` | Idempotent — issuing or returning this device's demo licence. |
| `POST` | `/demo/status` | Whether this device has had a demo. State only, never a token. |
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
| `demo.enc` | `{appId, deviceId, issuedAt, expiresAt, durationDays}` — a **cache** of what the service said about this device's demo; the record itself lives in the service | Same, and for the same reason as `trial.enc` |
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
appId = shuyin
```

Sent as a query parameter on the `GET` routes and a body field on the `POST`
routes — `/plans`, `/payment-methods`, `/trial/status`, `/trial/activate`,
`/create-order`, `/order-status`, `/payment-history` and the refresh path.
`electron/license-config.js` holds the value and
`electron/subscription-monitor.js` puts it on the wire; `URLSearchParams` in
one helper builds the query strings, so no route can quietly go without it.

**`shuyin`, not `smoothvoice`.** It was `smoothvoice` until recently, on the
reasoning that this app's rows already existed in the service's tables with no
appId, that the migration would stamp them with that value, and that renaming
would strand every licence bought before the change.

That reasoning does not survive the dates. The licence stack arrived here in
`Move subscriptions onto the shared license service` on **2026-08-31**, after
the **1.1.0** release on 2026-08-30; every released build predates it, and the
changelog's released sections mention no licence or subscription at all. **No
shipped build of this app has ever called the service**, so it has no rows
there to strand. The rows that do exist are SootheVoice's — which is why
`smoothvoice` remains the *service's* `DefaultAppId` and the app a legacy,
appId-less row is adopted for.

Sharing the id was not free while it lasted. The service keys `DemosTable` by
`"<appId>#<deviceId>"` and `TrialsV2Table` by `(deviceId, appId)`, so with both
clients sending `smoothvoice` the two collided on any machine running both: a
demo or trial spent in SootheVoice arrived here already used — the exact leak
the appId dimension exists to close.

`LICENSE_APP_ID` (or `VITE_APP_ID`) overrides it at build time, which is for
pointing a build at a test deployment — not for renaming the app.

One thing this change deliberately does **not** touch: `APP_SALT` in
`electron/secure-store.js` still contains the string `smoothvoice`. It is the
key-derivation salt for `license.enc`, `trial.enc` and `demo.enc`, not an app
id — changing it would make every one of those files on every existing install
undecryptable.

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
| `LicensesV2Table` | key `(userId, appId)`, GSI `licenseKey-index` |
| `TrialsV2Table` | key `(deviceId, appId)` |
| `DemosTable` | key `"<appId>#<deviceId>"` |
| Backfill | `migrate_app_id.py` stamps the pre-appId rows `appId = 'smoothvoice'` — SootheVoice's, since no released build of this app ever wrote one |
| Orders | `appId` stored on the order, so the payment webhook issues the license for the right app |
| Missing `appId` | defaults to `smoothvoice`, the app the appId-less rows belong to |

All of that is deployed from
[`ruanjian123`](https://github.com/AryaLi1996/ruanjian123); nothing in this
repository can change it — see the note at the top: this app deploys no
infrastructure. Until that stack is deployed, the routes it adds answer
**501**, and this client treats that as the entry not working rather than
falling back to anything local.

---

## The demo licence

Alongside the paid plans there is a **demo licence**: 30 days of every paid
feature, once per app per device, with no payment. It is for an internal test,
a demonstration, an evaluation, or a support conversation that needs the
licensed experience on someone else's machine — cases the three-day device
trial either cannot serve or has already spent.

It is issued by the service, like every other licence in this app.

| | |
|---|---|
| Issued by | `POST demo/activate` on the shared service |
| Signed with | the service's HMAC secret, verified here like any other token |
| Plan id | `demo` — no plan in `PLAN_TIERS` uses it |
| Length | `DEMO_DAYS` (30), then the ordinary grace period, then locked |
| Limited by | the service's `DemosTable`, keyed `"<appId>#<deviceId>"` |
| Asked about | `POST demo/status` — state only, never a token |
| Refreshed | never — see `refresh()`; `demo/activate` returns the same window, not a fresher one |

One door, one click, **no code**. The credential is "this device has not taken
one for this app", which is a fact the service holds. Asking again inside the
window returns the *same* window re-signed — so a reinstall or a lost token
recovers without buying more time — and asking after it has run out is
`demo_already_used`, which is final. A service that cannot be reached is
`demo_unavailable`: nothing is granted, nothing is spent, and trying again
later is the right advice. There is deliberately **no offline path**.

### What changed, and why

This used to be the one licence the service did not issue. The token was
minted in `electron/demo-license.js` and signed with the HMAC secret this
build already verifies with; it was unlocked by one of a couple of codes
hardcoded in `license-config.js` (`DEMO-2026`, `SHUYIN-TRIAL`); and "once per
device" was `demo.enc`, a file in the app's own `userData`.

Neither half was enforceable:

* **the codes shipped in every installer.** Anyone with the app had them, so
  "knowing the code" was never a credential. There is now no code at all —
  nothing to leak, nothing to rotate.
* **the limit was a file the device owns.** It stopped an honest user clicking
  twice and stopped nobody who deleted it. The limit is now a conditional put
  in the service's `DemosTable`, and deleting `demo.enc` gets the *same* demo
  window back, not a new one.

`demo.enc` survives, demoted to a cache: it holds the dates the service
reported, so the page can say "this device has already had its demo, until the
3rd" without a round trip and can still say it with no network. It is still
encrypted and machine-bound — not as a limit any more, but so a hand-edited
file cannot lie to the page about how long is left.

The service side is `POST /demo/activate` and `GET|POST /demo/status` in
[`ruanjian123`](https://github.com/AryaLi1996/ruanjian123)
(`serverless/verify-license/handler.py`), backed by a new `DemosTable`. This
app deploys no infrastructure — see the note at the top — so a build pointed
at a deployment that predates those routes gets a 501 and the entry simply
does not work; nothing falls back to a locally minted licence. Whether the
deployment this app points at has them yet is the next section.

### What this is not

A demo token is indistinguishable from a purchased one to anything that only
checks the signature. `planId: 'demo'` is the field that separates them, and
`isDemoLicense` in `renderer/src/subscription.ts` is what reads it — the page
names it a demo, counts it down, and keeps the paid entry live throughout so
it can be upgraded at any point.

The device id is still a hardware fingerprint computed client-side
(`electron/device-id.js`), so it is the same honest-user-scale limit the trial
has: it survives a reinstall, and it does not survive someone determined to
present as a different machine. What the move buys is that it is now *a* limit
at all, held somewhere the device cannot reach.

### Which builds have it

**Every build can take one, but no build offers it.** The subscription page
has no demo entry any more — the licence box that replaced it takes a key the
shop issued, and nothing in the interface asks for a demo. What remains is the
machinery: `license:activateDemo` still calls the service and adopts what it
returns, and a demo already in force is still honoured, named as a demo, and
counted down.

That leaves one flag with anything to gate:

| | |
|---|---|
| The entry | `demoLicenseEnabled` in `electron/license-config.js`, which gates `license:activateDemo` in `main.js`. Set `DISABLE_DEMO_LICENSE=true` to refuse the channel outright. |

`VITE_DISABLE_DEMO_LICENSE` no longer removes anything from the bundle, since
the bundle no longer has a demo entry to remove. `electron/license-config.js`
still reads it, which covers an unpackaged run — there the main process sees
the same environment the bundle was built in.

Turning it off is now a narrower decision than it was. It no longer stands
between a build and unlimited demos — the service does that — so it is only
about whether this build should be able to take its one demo at all.

---

## Which deployment this app points at

`DEFAULT_LICENSE_URL` in `license-config.js` is the Function URL of one
CloudFormation stack, and it is worth naming precisely, because the
deployment ticket for this work describes a different shape than the one
that exists:

| | |
|---|---|
| Stack | `ruanjian-license`, `us-east-1`, AWS account `641628981129` |
| Template | `serverless/verify-license/template.yaml` in `ruanjian123` |
| Endpoint | a **Lambda Function URL**, published as the `LicenseVerifierUrl` stack output |
| Function | `LicenseVerifier` (python3.11, arm64) |
| Deployed by | `.github/workflows/deploy-license.yml` in `ruanjian123` |

**There is no API Gateway and no `/prod` stage**, so there is no
`LicenseApiUrl` output to read and no stage prefix to append. `LICENSE_URL`
is the Function URL as printed by `sam list stack-outputs`, with its trailing
slash; routes are matched by path suffix, which is why the client can append
`demo/activate` to it and why an API Gateway stage *would* also work if one
were ever put in front.

Nor is `LICENSE_URL` spelled `VITE_LICENSE_API_URL` anywhere in this
repository — the main process reads `LICENSE_URL`, and `VITE_APP_ID` is
accepted only as the renderer's alias for `LICENSE_APP_ID`. The app id is
`shuyin`; `smoothvoice` is SootheVoice's, and a build sending it would share
that app's trial and demo records rather than keeping its own.

### How a deployment happens

Three jobs, and only the last one can change anything: `test` runs the
handler's unit suite with no AWS credentials at all, `plan` assumes a role
with no `ExecuteChangeSet` and prints the CloudFormation change-set, and
`apply` is gated on the `production` GitHub Environment's reviewers. Nothing
reaches the stack until a human reads that change-set and releases the run.
The signing secret is a GitHub **environment** secret on both environments;
`LicenseSigningSecret` has no default in the template and a `MinLength: 32`,
so a stack cannot come up carrying the public development value at all.

The demo knobs are template parameters with defaults that already match this
client — `DemoDays: 30`, `DemoPlanId: demo` — so an ordinary deploy needs no
overrides for them. `DefaultAppId` stays `smoothvoice`: it is the app a
request carrying no appId, and a row written before the dimension existed,
belongs to. This client always sends its own. `DemosTable` is a *resource*
in that template, not a parameter: CloudFormation names it, and passing
`DemosTable=…` as a parameter override fails before any AWS call is made.

### Where the demo routes are

**Live.** The deploy carrying them was approved and applied on 2 September
2026 (`ruanjian123` run #6, commit `d4f8879`), which added `DemosTable` and
pointed the function at it:

```
+ Add     DemosTable            AWS::DynamoDB::Table
* Modify  LicenseVerifierRole   AWS::IAM::Role
* Modify  LicenseVerifier       AWS::Lambda::Function
```

So `demo/activate` and `demo/status` answer for real now rather than 501, and
the 501 path in this client is the thing that should no longer be reachable
against the production endpoint. Nothing in this repository had to change for
it: the Function URL did not move, and the client was already pointed at it.

The `appId` scoping work behind it (`TrialsV2Table`, `LicensesV2Table`) is
merged on `main` but **its deploy is still waiting on the same approval
gate**, so the isolation "What the service still has to do" describes above
is not live yet — a trial spent in the sibling app still arrives here used.

---

## Configuration

| Variable | Effect |
|---|---|
| `LICENSE_URL` | The base URL — Function URL or API Gateway stage |
| `LICENSE_SIGNING_SECRET` | HMAC secret; **must match the deployment's** |
| `PREVIOUS_LICENSE_SIGNING_SECRET` | Also accepted when verifying, never signed with. Set only while a rotation is in flight — see *Rotating it* below. `VITE_PREVIOUS_LICENSE_SIGNING_SECRET` does the same for an unpackaged run |
| `LICENSE_APP_ID` / `VITE_APP_ID` | Which app the service scopes this build to. Defaults to `shuyin`; only change it for a test deployment |
| `DISABLE_DEMO_LICENSE` | `true` makes the main process refuse `license:activateDemo`. `VITE_DISABLE_DEMO_LICENSE` does the same for an unpackaged run, which shares the build environment |
| `ENABLE_MANUAL_ACTIVATION` | No longer read by the interface — the licence box is on in every build. `license:config` still reports what it said |

The signing secret ships with a public default, in this repository and in the
service's own source. A build still using it can have its tokens forged
offline, so the app warns at startup and the service warns in its logs. Both
ends holding the same symmetric secret is inherent to HMAC; the service's docs
name the fix (RSA — server signs, client verifies with an embedded public
key), and verification is centralised in `license-token.js` so that change
lands in one place.

### Rotating it

Rotating an HMAC secret is not like rotating a password. Both ends hold the
same string, so the moment the service starts signing with a new one, every
token already in a customer's hands stops verifying — and to this app that
reads as a licence that was **revoked**: grace period, then locked, for people
whose subscription is perfectly current. The only way out would be an update
they have not installed yet.

So it goes in two steps, and the first one has to reach people before the
second happens:

| | |
|---|---|
| 1. Ship a build that accepts both | `PREVIOUS_LICENSE_SIGNING_SECRET=<the current secret>` in the build environment, alongside the unchanged `LICENSE_SIGNING_SECRET`. Nothing changes for anyone yet. |
| 2. Wait | Until enough of the install base is on that build. There is no way to hurry it, and going early is what the whole exercise exists to avoid. |
| 3. Switch the service | `sam deploy --parameter-overrides LicenseSigningSecret=<new>`. New tokens are signed with the new secret; old ones still verify here. |
| 4. Let it settle | Each client swaps its own token on the next launch — see below. |
| 5. Ship a build that drops it | Unset `PREVIOUS_LICENSE_SIGNING_SECRET`. The old secret stops being accepted. |

`verifyToken` tries the current secret first and the previous one only on a
miss, so the cost is one extra HMAC on exactly the tokens issued before the
switch. Signing — `createToken`, used by tests and nothing else in a shipped
build — always uses the current secret alone.

**Step 4 completes itself.** On launch, a stored token that verifies only
under the previous secret triggers an immediate refresh
(`verifiedWithPreviousSecret` in `license-token.js`, read in `initialize()`),
which exchanges the licence key for a token signed with the current secret.
Best-effort and silent: the token in hand already works, so a failed exchange
costs nothing and the next launch tries again. Without it, a client would sit
on its old token until expiry and be locked out by the step-5 build.

**What accepting two secrets costs.** A token signed with the old secret still
verifies, so if the reason for rotating is that the old secret *leaked*, the
leak is still exploitable for the length of the window. That is the trade:
a window in which a leaked secret still works, against logging out every
paying customer. It is a window to get through, not a state to sit in —
`rotatingSigningSecret` is warned about at startup for exactly that reason.

**Tests never reach the real service.** The E2E fixtures set
`LICENSE_URL=http://127.0.0.1:9/` and stub the licence and payment IPC, so a
suite run cannot write a runner's device id into the shared production trial
table.
