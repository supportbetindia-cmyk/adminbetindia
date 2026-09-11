# Click capture — integration request for the betindia.bet website team

## What we're asking for

When someone taps a BetIndia banner on a partner site, they arrive here with a
click ID in the URL:

```
https://www.betindia.bet/promo/welcome?bi_click=mCdWBNci07aim3gR9i-L_Q
```

We need that value to survive as far as the registration record, so a signup
can be attributed to the banner that produced it. Without it we can count
clicks but cannot tell which publisher actually produces customers.

## What this is not

Worth stating plainly, because "add tracking to the site" usually means
something much larger:

- **No third-party script.** The file is served from betindia.bet.
- **No external network requests.** It calls nothing, reports nothing.
- **No third-party cookies**, no pixel, no fingerprinting, no analytics SDK.
- **No personal data.** The click ID is an opaque random string. It is not
  derived from the user, their device, or their IP, and cannot be reversed
  into anything about them.

It moves one random identifier from the URL into a form field, on our own
domain. That is the whole scope.

## Three steps

### 1. Serve the script

Copy `bi-click.js` to the web root so it is reachable at
`https://www.betindia.bet/bi-click.js`, and include it on every page:

```html
<script src="/bi-click.js" defer></script>
```

It must load on **every** page, not just the registration page — the visitor
usually lands on a promo page and registers a few screens later.

### 2. Add two hidden fields to the registration form

```html
<input type="hidden" name="bi_click">
<input type="hidden" name="bi_click_last">
```

The script fills them automatically. Nothing else to wire up.

If the form is submitted by JavaScript rather than a normal POST, read the
values instead:

```js
const clickId = window.BI_CLICK.get();        // first click, falls back to last
const lastClick = window.BI_CLICK.getLast();  // most recent click
```

### 3. Store them with the account

Save both values against the user record, and include them in whatever we read
registrations from (API response, webhook payload, or export).

That is the part that matters. A value captured in the browser but dropped at
the backend achieves nothing.

## Why two values

The attribution model is not finalised. The proposal is first click within a
30-day window, but that is still subject to business approval.

Recording only one of them now would lock that decision in at the browser,
where it cannot be revisited. Storing both keeps the choice on our side, and
lets us change the model later without losing history.

## Notes for the reviewer

- Cookies are `SameSite=Lax`, not `Strict`. The visitor arrives by a cross-site
  redirect from the publisher, and a `Strict` cookie would not be readable on
  that first page view — which is the only page view that carries the ID.
- Cookie lifetime is 30 days, matching the proposed attribution window.
- The value is validated against `^[A-Za-z0-9_-]{16,64}$` before being stored
  or written into a field. Nothing is taken from the URL on trust.
- Expect incomplete coverage on iOS and inside publisher in-app browsers.
  Safari deletes script-set cookies after 7 days, and in-app browsers often do
  not share storage with the user's real browser. This is a platform limit, not
  a defect in the script — a meaningful share of traffic will fall out of the
  window regardless of implementation.
- Consent and retention are still under legal review. Confirm the cookie is
  covered by the site's notice before this goes live.

## Testing it

1. Open `https://www.betindia.bet/?bi_click=TESTCLICKID0000000000`
2. Confirm a `bi_click` cookie exists with that value
3. Navigate to the registration page **without** the parameter
4. Confirm the hidden field is still populated
5. Submit a test registration and confirm the value reaches the database

Send us one test registration with a known click ID and we will confirm it
matches on our side.
