'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const { esc, fmtNum, safeUrl, telHref, distMi, freshClass, cardAged, CONFIG } = loadApp();

test('esc — HTML injection payloads never produce raw markup', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "'; DROP TABLE--",
    '<svg/onload=alert(1)>',
  ];
  for (const p of payloads) {
    const out = esc(p);
    assert.ok(!out.includes('<'), `raw < leaked: ${out}`);
    assert.ok(!out.includes('>'), `raw > leaked: ${out}`);
  }
});

test('esc — every special char maps to its entity', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('esc — nullish coerces to empty string, not "null"/"undefined"', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(''), '');
});

test('esc — plain and numeric values pass through unchanged', () => {
  assert.equal(esc('Devils River at Bakers Crossing'), 'Devils River at Bakers Crossing');
  assert.equal(esc(19), '19');
});

test('fmtNum — finite numbers pass through as numbers', () => {
  assert.equal(fmtNum('12.5'), 12.5);
  assert.equal(fmtNum(3), 3);
  assert.equal(fmtNum('-4'), -4);
});

test('fmtNum — non-numeric strings are escaped, not injected', () => {
  assert.equal(fmtNum('N/A'), 'N/A');
  assert.equal(fmtNum('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(fmtNum('NaN'), 'NaN'); // +'NaN' is not finite -> escaped string
});

test('safeUrl — only http(s) survives; script/data schemes are neutralized', () => {
  assert.equal(safeUrl('https://api.weather.gov/x'), 'https://api.weather.gov/x');
  assert.equal(safeUrl('http://example.test'), 'http://example.test');
  assert.equal(safeUrl('HTTPS://EXAMPLE.TEST'), 'HTTPS://EXAMPLE.TEST');
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('data:text/html,<script>'), '#');
  assert.equal(safeUrl('//evil.test'), '#');
  assert.equal(safeUrl(''), '#');
  assert.equal(safeUrl(null), '#');
});

/* Hotline values come from the curator-editable data/resources.json, and safeUrl covers no tel:
   scheme, so the dial href must be rebuilt from digits rather than interpolated. Anything that is
   not a dialable number has to return '' so the caller renders text instead of a broken link. */
test('telHref — every shipped hotline value dials, punctuation stripped', () => {
  assert.equal(telHref('911'), 'tel:911');
  assert.equal(telHref('211'), 'tel:211');
  assert.equal(telHref('1-800-733-2767'), 'tel:18007332767');
  assert.equal(telHref('800-985-5990'), 'tel:8009855990');
  assert.equal(telHref('800-252-3439'), 'tel:8002523439');
  assert.equal(telHref('(830) 257-8181'), 'tel:8302578181');
  assert.equal(telHref('  911  '), 'tel:911');
});

test('telHref — a leading + is the only non-digit that reaches the href', () => {
  assert.equal(telHref('+1 800 733 2767'), 'tel:+18007332767');
  assert.equal(telHref('+52 (55) 5128-0000'), 'tel:+525551280000');
  assert.equal(telHref('1+800+7332767'), ''); // a + anywhere but the front is not a phone number
});

test('telHref — a non-dialable curated value degrades to text, never a link', () => {
  for (const bad of [
    'javascript:alert(1)',
    'tel:911"><script>alert(1)</script>',
    'call 911',
    '911 or the sheriff',
    'dial911',
    '#911',
    '911;+18005551212',
    '',
    '  ',
    null,
    undefined,
  ]) assert.equal(telHref(bad), '', `expected no href for ${JSON.stringify(bad)}`);
});

test('telHref — length bounds reject a too-short stub and a past-E.164 run of digits', () => {
  assert.equal(telHref('11'), '');
  assert.equal(telHref('9'), '');
  assert.equal(telHref('1234567890123456'), ''); // 16 digits, one past the E.164 ceiling
  assert.equal(telHref('123456789012345'), 'tel:123456789012345');
});

test('telHref — the raw value never reaches the href it builds', () => {
  const href = telHref('911');
  assert.ok(/^tel:\+?[0-9]+$/.test(href), `href carries something other than digits: ${href}`);
  for (const c of ['"', "'", '<', '>', ' ', '&', ';']) {
    assert.ok(!href.includes(c), `href carries ${c}`);
  }
});

test('distMi — identical points are zero distance', () => {
  assert.equal(distMi(29.75, -99.35, 29.75, -99.35), 0);
});

test('distMi — one degree of latitude is ~69.09 statute miles', () => {
  const d = distMi(29, -99, 30, -99);
  assert.ok(Math.abs(d - 69.0935) < 0.01, `got ${d}`);
});

test('distMi — one degree of longitude shrinks by cos(latitude)', () => {
  // at lat 29.75, one degree of lon ~= 69.0935 * cos(29.75deg) ~= 59.99 mi
  const d = distMi(29.75, -99.35, 29.75, -100.35);
  assert.ok(Math.abs(d - 59.99) < 0.05, `got ${d}`);
});

test('distMi — symmetric in argument order', () => {
  const a = distMi(29.75, -99.35, 30.5, -98.1);
  const b = distMi(30.5, -98.1, 29.75, -99.35);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test('freshClass — buckets age into fresh/recent/aging/stale', () => {
  const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
  assert.equal(freshClass(iso(10)), 'fresh'); // < 60m
  assert.equal(freshClass(iso(90)), 'recent'); // 60-180m
  assert.equal(freshClass(iso(300)), 'aging'); // 180m - staleMins(360)
  assert.equal(freshClass(iso(600)), 'stale'); // >= staleMins
});

test('freshClass — boundary at the configured stale cutoff is "stale"', () => {
  const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
  assert.equal(freshClass(iso(CONFIG.staleMins + 5)), 'stale');
});

/* ---------- cardAged: resolved suppresses now; per-type cutoffs beat the default ---------- */

// freeze the clock so ts ages are exact at the cutoff boundaries (same pattern as smartScore)
function withFrozenNow(fn) {
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  try { fn((min) => new Date(Date.now() - min * 60000).toISOString()); } finally { Date.now = realNow; }
}

test('cardAged — resolved status suppresses immediately regardless of age', () => {
  withFrozenNow((tsMinAgo) => {
    assert.equal(cardAged({ status: 'resolved', type: 'rescue', ts: tsMinAgo(0) }), true);
    assert.equal(cardAged({ status: 'resolved', type: 'info', ts: tsMinAgo(1) }), true);
  });
});

test('cardAged — a fresh unresolved card is not aged', () => {
  withFrozenNow((tsMinAgo) => {
    assert.equal(cardAged({ status: 'unverified', type: 'rescue', ts: tsMinAgo(5) }), false);
  });
});

test('cardAged — default cutoff is strictly greater-than: exactly agedCardMins is NOT aged', () => {
  withFrozenNow((tsMinAgo) => {
    // 'rescue' has no agedCardMinsByType entry, so the agedCardMins default governs
    assert.equal(cardAged({ status: 'unverified', type: 'rescue', ts: tsMinAgo(CONFIG.agedCardMins) }), false);
    assert.equal(cardAged({ status: 'unverified', type: 'rescue', ts: tsMinAgo(CONFIG.agedCardMins + 1) }), true);
  });
});

test('cardAged — per-type agedCardMinsByType override beats the default', () => {
  withFrozenNow((tsMinAgo) => {
    const infoCutoff = CONFIG.agedCardMinsByType.info;
    assert.ok(infoCutoff < CONFIG.agedCardMins, 'fixture premise: info override is shorter than default');
    const betweenMin = infoCutoff + 60; // over the info override, under the default
    assert.equal(cardAged({ status: 'unverified', type: 'info', ts: tsMinAgo(betweenMin) }), true);
    assert.equal(cardAged({ status: 'unverified', type: 'rescue', ts: tsMinAgo(betweenMin) }), false);
  });
});

test('cardAged — override boundary is also strictly greater-than', () => {
  withFrozenNow((tsMinAgo) => {
    const infoCutoff = CONFIG.agedCardMinsByType.info;
    assert.equal(cardAged({ status: 'unverified', type: 'info', ts: tsMinAgo(infoCutoff) }), false);
    assert.equal(cardAged({ status: 'unverified', type: 'info', ts: tsMinAgo(infoCutoff + 1) }), true);
  });
});
