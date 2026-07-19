'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const { esc, fmtNum, safeUrl, distMi, freshClass, CONFIG } = loadApp();

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
