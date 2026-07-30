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
  var lostScript = false;

  function reveal() {
    if (HTML.className.indexOf('boot-failed') < 0) HTML.className += ' boot-failed';
  }

  // a script that never arrives breaks the board just as completely as one that will not parse
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target.tagName === 'SCRIPT') lostScript = true;
  }, true);

  /* load means every script has run or given up, so an unset flag past it is a real failure and not
     a slow connection. Without that wait a 3G responder would be told their browser is unsupported. */
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!window.__boardBooted || lostScript) reveal();
    }, 1200);
  });
}());
