// Kept external so production CSP does not permit inline script execution.
(function () {
  'use strict';
  var renderApi = 'https://ekasi-pay-api.onrender.com';
  function fixUrl(url) {
    if (typeof url !== 'string') return url;
    return url.replace(/^https:\/\/ekasi-pay-api(?=\/|$)/, renderApi);
  }
  var runtime = window.__KASIPAY_API_URL__;
  if (!runtime || !String(runtime).includes('.')) {
    window.__KASIPAY_API_URL__ = renderApi;
  }
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      return originalFetch.call(this, fixUrl(input), init);
    }
    if (input && typeof input.url === 'string') {
      var patched = fixUrl(input.url);
      if (patched !== input.url) input = new Request(patched, input);
    }
    return originalFetch.call(this, input, init);
  };
})();
