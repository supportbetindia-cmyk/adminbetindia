/*!
 * BetIndia click capture + website events — v2
 *
 * Two jobs:
 *   1. Carry the click ID from a smart-link landing URL through to the
 *      registration form, so a signup can be attributed to the banner.
 *   2. Report first-party events (landing, page view, registration submitted)
 *      back to go.betindia.games.
 *
 * First-party only. It sends one small JSON request to BetIndia's own
 * tracking endpoint and nothing else. No third-party script, no advertising
 * pixel, no personal data — the click ID is an opaque random string, and the
 * session id is random per visit.
 *
 * Install: serve from betindia.bet and include on every page, before </body>:
 *     <script src="/bi-click.js" defer></script>
 */
(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────
  var ENDPOINT = 'https://go.betindia.games/api/v1/events/website';
  var PARAM = 'bi_click';
  var COOKIE_FIRST = 'bi_click';
  var COOKIE_LAST = 'bi_click_last';
  var SESSION_KEY = 'bi_session';
  var DAYS = 30;

  /**
   * The click ID is 22 URL-safe base64 characters. Anything else is rejected
   * rather than stored — the value reaches a form field and a database, so it
   * is never taken from the URL on trust.
   */
  var VALID = /^[A-Za-z0-9_-]{16,64}$/;

  // ── Cookies ────────────────────────────────────────────────

  function readCookie(name) {
    var match = document.cookie.match(
      new RegExp('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeCookie(name, value) {
    var expires = new Date(Date.now() + DAYS * 864e5).toUTCString();
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    // Lax, not Strict: the visitor arrives by a cross-site redirect from the
    // publisher, and a Strict cookie would not be readable on that first page
    // view — which is the only one carrying the click ID.
    document.cookie =
      name + '=' + encodeURIComponent(value) +
      '; Max-Age=' + DAYS * 86400 +
      '; Expires=' + expires +
      '; Path=/; SameSite=Lax' + secure;
  }

  function fromUrl() {
    try {
      var value = new URLSearchParams(window.location.search).get(PARAM);
      return value && VALID.test(value) ? value : null;
    } catch (e) {
      return null;
    }
  }

  var incoming = fromUrl();

  if (incoming) {
    /*
     * Both the first and the most recent click are kept.
     *
     * The attribution model is not yet approved — the proposal is first click
     * within a 30-day window, "subject to business approval". Recording only
     * one would bake that decision into the browser, where it cannot be
     * revisited. Storing both leaves the choice on the server.
     */
    if (!readCookie(COOKIE_FIRST)) writeCookie(COOKIE_FIRST, incoming);
    writeCookie(COOKIE_LAST, incoming);
  }

  function current() {
    return { first: readCookie(COOKIE_FIRST), last: readCookie(COOKIE_LAST) };
  }

  // ── Session and idempotency ────────────────────────────────

  function randomId() {
    try {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      var out = '';
      for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
      return out;
    } catch (e) {
      return String(Date.now()) + Math.random().toString(36).slice(2, 12);
    }
  }

  /** One id per visit, so multiple page views group into one session. */
  function sessionId() {
    try {
      var existing = window.sessionStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      var fresh = randomId();
      window.sessionStorage.setItem(SESSION_KEY, fresh);
      return fresh;
    } catch (e) {
      // Private mode or storage disabled: fall back to a per-page id. Events
      // still record; they just will not group into one session.
      return randomId();
    }
  }

  // ── Sending ────────────────────────────────────────────────

  /**
   * Consent.
   *
   * Defaults to 'unknown' rather than 'granted' — claiming consent nobody gave
   * is worse than recording that we do not know. Wire this to the site's
   * cookie banner by setting window.BI_CONSENT to 'granted' or 'denied'.
   */
  function consent() {
    var value = window.BI_CONSENT;
    return value === 'granted' || value === 'denied' ? value : 'unknown';
  }

  function send(eventType, extra) {
    var value = current();
    var body = {
      eventType: eventType,
      sessionToken: sessionId(),
      // Unique per event, so a retry or a double-fire is absorbed server-side.
      eventKey: sessionId() + '-' + eventType + '-' + randomId(),
      clickId: value.first || value.last || null,
      pagePath: location.pathname,
      landingUrl: eventType === 'landing' ? location.href : null,
      consent: consent(),
      metadata: extra || null
    };

    try {
      // keepalive so the request survives the page navigating away, which is
      // exactly when a registration_submitted event fires.
      window.fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: 'omit',
        mode: 'cors'
      })['catch'](function () { /* tracking must never break the page */ });
    } catch (e) {
      /* ignore */
    }
  }

  // ── Hidden form fields ─────────────────────────────────────

  function fill(root) {
    var value = current();
    if (!value.first && !value.last) return;

    var scope = root || document;
    var firstFields = scope.querySelectorAll('input[name="bi_click"]');
    var lastFields = scope.querySelectorAll('input[name="bi_click_last"]');
    var i;

    for (i = 0; i < firstFields.length; i++) {
      if (!firstFields[i].value) firstFields[i].value = value.first || value.last || '';
    }
    for (i = 0; i < lastFields.length; i++) {
      if (!lastFields[i].value) lastFields[i].value = value.last || '';
    }
  }

  // ── Wiring ─────────────────────────────────────────────────

  function start() {
    fill();
    // A visit that arrived with a click ID is a landing; everything else is an
    // ordinary page view.
    send(incoming ? 'landing' : 'page_view');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.tagName !== 'FORM') return;
    fill(form);
    // Opt-in: mark the registration form with data-bi-registration so ordinary
    // forms (search, newsletter) are not counted as signups.
    if (form.hasAttribute('data-bi-registration')) send('registration_submitted');
  }, true);

  window.BI_CLICK = {
    get: function () { var v = current(); return v.first || v.last || null; },
    getFirst: function () { return current().first; },
    getLast: function () { return current().last; },
    fill: fill,
    /** For sites that submit forms via JavaScript rather than a normal POST. */
    track: function (eventType, metadata) { send(eventType, metadata); }
  };
})();
