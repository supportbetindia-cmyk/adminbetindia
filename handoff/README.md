# BetIndia click tracking — integration brief for the betindia.bet team

## Why

BetIndia pays publishers (cricket apps, sports sites) to show banner ads. Today
there is no way to tell which of them actually produces customers — only which
of them *claims* to.

This integration closes that. When someone taps a banner they arrive here
carrying a click ID:

```
https://www.betindia.bet/promo/welcome?bi_click=mCdWBNci07aim3gR9i-L_Q
```

If that ID survives to the point of registration, we can say "this signup came
from this exact banner on this publisher". Without it we can count clicks and
nothing else.

## Two pieces of work

| | Who | Effort |
|---|---|---|
| **Part 1** — carry the click ID to the signup form | Front-end | ~30 min |
| **Part 2** — tell us when an account is created | Back-end | ~1 hour |

Part 1 without Part 2 gets you nothing. Part 2 without Part 1 gets registration
counts with no idea where they came from. Both are needed.

## What this is not

- **No third-party script.** `bi-click.js` is served from betindia.bet.
- **No advertising pixel**, no fingerprinting, no analytics SDK.
- **No personal data collected by us.** The click ID is an opaque random string
  and the session id is random per visit; neither is derived from the user or
  their device.
- Two outbound calls, both to BetIndia's own domain. Nothing else is contacted.

---

# Part 1 — Front-end

### 1. Serve the script

Copy `bi-click.js` to the web root so it is reachable at
`https://www.betindia.bet/bi-click.js`, and include it on **every** page:

```html
<script src="/bi-click.js" defer></script>
```

Every page, not just the signup page — visitors land on a promo page and
register a few screens later.

### 2. Add two hidden fields to the registration form

```html
<form data-bi-registration>
  <input type="hidden" name="bi_click">
  <input type="hidden" name="bi_click_last">
  …
</form>
```

The script fills them automatically.

`data-bi-registration` is **opt-in on purpose** — without it a search box or
newsletter form would be counted as a signup.

If the form is submitted by JavaScript rather than a normal POST:

```js
const clickId = window.BI_CLICK.get();
window.BI_CLICK.track('registration_submitted');
```

### 3. Consent

The script reports consent as `unknown` by default — better than claiming
consent nobody gave. If the site has a cookie banner, set this before the
script loads:

```js
window.BI_CONSENT = 'granted';  // or 'denied'
```

---

# Part 2 — Back-end

**When an account is successfully created**, POST to us server-to-server.

```
POST https://go.betindia.games/api/v1/webhooks/registrations
Authorization: Bearer <SECRET — provided separately>
Content-Type: application/json

{
  "externalUserId": "48219",
  "registeredAt": "2026-09-12T10:00:00Z",
  "clickId":     "<the bi_click value from the form>",
  "lastClickId": "<the bi_click_last value from the form>",
  "phone":       "9876543210",
  "sourceEventId": "your-own-request-id"
}
```

| Field | Required | Notes |
|---|---|---|
| `externalUserId` | **Yes** | Your platform's user ID. Without it this is not a verified registration and we reject it with 422. |
| `registeredAt` | No | ISO 8601. Defaults to now. |
| `clickId` | No | From the `bi_click` hidden field. Without it the signup cannot be traced to an ad. |
| `lastClickId` | No | From `bi_click_last`. Used if the first does not match. |
| `phone` | No | Normalised and stored as a join key. Masked in our UI. |
| `sourceEventId` | No | Your own request id, so a delivery can be traced back. |

### Response

```json
{
  "accepted": true,
  "duplicate": false,
  "registrationId": "3f6df771-…",
  "attribution": {
    "confidence": "exact",
    "clickId": "mCdWBNci07aim3gR9i-L_Q",
    "reason": "Click ID passed through the registration and matched a recorded click."
  }
}
```

`confidence` tells you immediately whether the integration is working:

- **`exact`** — the click ID arrived and matched a real click. Working.
- **`unknown`** — no click ID, or one we never issued. Check Part 1.

### Things to know

- **Retry safely.** Sending the same `externalUserId` twice returns
  `"duplicate": true` with the same `registrationId`. It never creates a second
  registration. Retry on 5xx; do not retry on 4xx.
- **Call it once, after the account exists.** Not on form submit — on
  successful creation. A submission is not a registration.
- **It fails closed.** If you get 503, the secret is not configured on our side;
  tell us.
- Timeout us at 5 seconds and queue a retry rather than blocking your signup
  flow. A tracking call must never fail a user's registration.

---

## Testing

**Part 1:**

1. Open `https://www.betindia.bet/?bi_click=TESTCLICKID0000000000`
2. Confirm a `bi_click` cookie exists with that value
3. Navigate to the signup page **without** the parameter
4. Confirm the hidden field is still populated

**Part 2:**

```bash
curl -X POST https://go.betindia.games/api/v1/webhooks/registrations \
  -H "Authorization: Bearer <SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"externalUserId":"test-001","clickId":"TESTCLICKID0000000000"}'
```

Expect `"accepted": true` with `"confidence": "unknown"` — that test ID is not a
real click, so it correctly does not attribute.

**End to end:** we will send you a real smart link. Click it, register, and we
will confirm `"confidence": "exact"` on our side.

---

## Notes for the reviewer

- Cookies are `SameSite=Lax`, not `Strict`. The visitor arrives by a cross-site
  redirect from the publisher, and a `Strict` cookie would not be readable on
  that first page view — the only one carrying the ID.
- Cookie lifetime is 30 days, matching the proposed attribution window.
- The click ID is validated against `^[A-Za-z0-9_-]{16,64}$` before being
  stored or written into a field. Nothing from the URL is trusted.
- Our event endpoint only accepts requests from `betindia.bet` origins, and we
  verify every click ID against a real recorded click before treating it as
  attribution — a fabricated one is accepted and recorded as *unattributed*,
  never as a conversion.
- Browser requests use `keepalive` so an event survives the page navigating
  away. A failed request is swallowed; tracking must never break the page.
- Expect incomplete coverage on iOS and inside publisher in-app browsers.
  Safari deletes script-set cookies after 7 days, and in-app browsers often do
  not share storage with the user's real browser. That is a platform limit, not
  a defect — a share of registrations will arrive unattributed regardless.
- Consent and retention are under legal review. Confirm the cookie is covered
  by the site's privacy notice before this goes live.
