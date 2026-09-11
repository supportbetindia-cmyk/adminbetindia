
(function () {
  'use strict';

  var PARAM = 'bi_click';
  var COOKIE_FIRST = 'bi_click';
  var COOKIE_LAST = 'bi_click_last';
  var DAYS = 30;

 
  var VALID = /^[A-Za-z0-9_-]{16,64}$/;

  function readCookie(name) {
    var match = document.cookie.match(
      new RegExp('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeCookie(name, value) {
    var expires = new Date(Date.now() + DAYS * 864e5).toUTCString();
    var secure = location.protocol === 'https:' ? '; Secure' : '';
   
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
    if (!readCookie(COOKIE_FIRST)) writeCookie(COOKIE_FIRST, incoming);
    writeCookie(COOKIE_LAST, incoming);
  }

  function current() {
    return {
      first: readCookie(COOKIE_FIRST),
      last: readCookie(COOKIE_LAST)
    };
  }

 
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
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { fill(); });
  } else {
    fill();
  }

  document.addEventListener('submit', function (event) {
    if (event.target && event.target.tagName === 'FORM') fill(event.target);
  }, true);

  window.BI_CLICK = {
    get: function () { return current().first || current().last || null; },
    getFirst: function () { return current().first; },
    getLast: function () { return current().last; },
    fill: fill
  };
})();
