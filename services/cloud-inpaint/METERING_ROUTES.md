# The two routes this service still needs, and where they go

This stack is the *filler*. It repaints pixels and it has no idea who anybody
is. The two routes that decide whether an export may use it —
**`fill/quota`** and **`fill/consume`** — belong on the licence service, in
[`AryaLi1996/ruanjian123`](https://github.com/AryaLi1996/ruanjian123), because
"who is entitled to what" is a question about an account and that is where
accounts already are.

That is a different repository, so this file is the specification rather than
the implementation. Nothing here has been written yet; until it is, the app's
`fill/quota` call 404s, `cloud-quota.js` reads that as `UNKNOWN`, and **every
export is filled locally** — which is exactly today's behaviour and is why
shipping this stack first is safe.

The client side already exists and is tested: `electron/cloud-quota.js`,
`renderer/src/cloud.ts`, `backend/cloud_fill.py`.

## What the app sends and expects

Both routes are `POST` on the licence service's existing base URL, dispatched
by path suffix exactly like `trial/activate` and `demo/status` (`handler.py`'s
`_route`, which matches on `path.endswith(...)`).

### `POST fill/quota` — may this export use the service?

```jsonc
// →
{ "appId": "shuyin", "deviceId": "…", "userId": "…" }

// ←
{ "allowed":      true,
  "limit":        100,
  "used":         12,
  "remaining":    88,
  "periodEnds":   "2026-10-01T00:00:00Z",
  "overagePrice": "¥0.30",
  "endpoint":     { "url": "https://….lambda-url.us-east-1.on.aws/inpaint",
                    "token": "<see 'The token' below>" },
  "reason":       null }
```

### `POST fill/consume` — one export used it

```jsonc
// →
{ "appId": "shuyin", "deviceId": "…", "userId": "…", "units": 1 }

// ←  the same shape, with the new count
```

`readQuota` in `electron/cloud-quota.js` reads this field by field and treats
anything missing as not allowed, so a route that grows a field cannot break an
installed app, and a route that returns rubbish cannot talk one into uploading.

When `allowed` is `false`, `reason` is a key the renderer has a sentence for.
It already knows `unreachable` and `notAllowed`; add a case to
`renderer/src/i18n` alongside any new key rather than sending prose.

## The token

`endpoint.token` is what this service checks in `auth.py`, and that file's
`sign()` is the executable specification — it exists for this, and nothing in
the running service calls it. In the licence service's terms:

```python
import base64, hashlib, hmac, json, time

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

def mint_fill_token(app_id: str, user_key: str, ttl_seconds: int = 900) -> str:
    payload = {"app": app_id, "sub": user_key,
               "exp": int(time.time()) + ttl_seconds}
    body = _b64url(json.dumps(payload, separators=(",", ":"),
                              sort_keys=True).encode("utf-8"))
    mac = hmac.new(os.environ["FILL_SIGNING_SECRET"].encode("utf-8"),
                   body.encode("ascii"), hashlib.sha256)
    return f"{body}.{_b64url(mac.digest())}"
```

Three things to get right:

- **`FILL_SIGNING_SECRET` is the same string on both sides**, and is *not* the
  licence signing secret. See `CI_DEPLOY_SETUP.md` §3 for why they are separate
  and how this one is generated.
- **The signature covers the encoded body, not the decoded dict.** Otherwise
  the two ends have to agree on how a dict serialises, and one day they will
  not.
- **`ttl_seconds` is short.** Fifteen minutes is generous for an export that
  batches 240 frames at a time. It is the only thing that limits what a leaked
  token is worth: this service has no revocation list and should not grow one.
  It does not need to cover the whole export — a token is fetched per export,
  and an expiry mid-export falls back to the local filler for the remaining
  batches, which is a slower export and not a failed one.

`sub` is carried so a log line can say whose export spent the time. This
service does not use it for anything: what the account was entitled to was
decided before the token existed.

## Counting

One row per (account, period). The obvious shape, matching how `TrialsV2Table`
is keyed:

    FillUsageTable   partition: userKey   sort: period ("2026-09")
                     attributes: used (N), updatedAt, appId
                     TTL on a `expiresAt` a year out, so old periods age out

`userKey` should be the `userId` when there is one and fall back to
`"<appId>#<deviceId>"` when there is not — the same reasoning as
`DemosTable`'s key: an allowance should belong to whoever paid, and to a
machine only when nobody has.

Increment with a conditional `UpdateItem` (`ADD used :units`), which is atomic;
two exports finishing at once must not both read 99 and both write 100.

**Count after the fact, not before.** `fill/consume` is called by the app once
the export is written, with the number of units it actually used. An export
that fell back to the local filler for every frame calls it with nothing and is
not one of the hundred. Reserving up front would charge for work that a
timeout, a crash or a cancelled export meant the user never received.

## The numbers, and why none of them are in the app

The allowance, the price beyond it, what counts as one unit, and when the
period rolls over are all environment variables on the licence service:

    FILL_FREE_UNITS_PER_PERIOD   100
    FILL_OVERAGE_PRICE           "¥0.30"     already formatted; the app does
                                             not know the user's currency
    FILL_ENDPOINT_URL            the InpaintUrl this stack outputs

Going from a hundred a month to two hundred, changing the price, or charging
per minute of video instead of per export is then a change there and not a
release everybody has to install. The app renders what it is told.

`FILL_ENDPOINT_URL` being a variable on the licence service — rather than a
constant in the app — is what makes the next section cheap.

## Moving this to a GPU later

The app never holds a URL for this service; it is handed one per export by the
thing that just decided the export was allowed. So replacing the Lambda with a
GPU endpoint is one environment variable on the licence service and needs
nothing from any installed client. See the README's "How long a batch takes"
for when that becomes worth doing.

## Turning it off

Set `FILL_ENDPOINT_URL` to empty, or return `allowed: false`. Every client
falls back to the local filler on the next export, and the only thing the user
sees is the switch reporting that cloud filling is unavailable.
