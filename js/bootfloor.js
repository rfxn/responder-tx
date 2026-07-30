/* Boot floor guard. ES5 ONLY, and deliberately so: the engines this exists to catch cannot parse
   the syntax the rest of the board is written in, so anything modern here dies with everything else.
   No eval/new Function either, because script-src is 'self' with no 'unsafe-eval'.

   The board is classic scripts, so one SyntaxError in js/core.js stops the whole bundle and leaves a
   shell that still looks like a board: header, tabs, an empty map, "loading..." forever. Counts ship
   "?" rather than 0, so nothing reads as a false zero, but nothing says the board failed either.
   This watches for the failure instead of predicting it, which also covers a blocked, truncated or
   half-cached bundle rather than only an old browser. */
'use strict';

(function () {
  var HTML = document.documentElement;

  function reveal() {
    if (HTML.className.indexOf('boot-failed') < 0) HTML.className += ' boot-failed';
  }

  /* The sentinel is the ONLY signal. A script error event is not one: the edge injects a
     Cloudflare analytics beacon that our own CSP blocks, which fired an error on a healthy board
     and blanked it for every live visitor (v0.99.77, fixed v0.99.78). Any third party can put a
     tag on the page; none of them can speak for whether OUR bundle ran.

     load means every script has run or given up, so an unset flag past it is a real failure and not
     a slow connection. Without that wait a 3G responder would be told their browser is unsupported. */
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!window.__boardBooted) reveal();
    }, 1200);
  });
}());
