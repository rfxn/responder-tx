'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const { CONFIG, resolveAoPresets, aoFullBounds, AO_PRESET_FALLBACK } = loadApp();

// harness t() echoes keys, so the Full AO pill label resolves to its i18n key here
const FULL_LABEL = 'ao.full';

// sandbox-built arrays live in another realm (different Array prototype), so
// deepEqual's prototype check would fail; compare serialized structure instead
function deq(actual, expected, msg) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
}

function withConfig(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = CONFIG[k]; CONFIG[k] = patch[k]; }
  try { fn(); } finally { Object.assign(CONFIG, saved); }
}

test('aoFullBounds — derives [[s,w],[n,e]] from CONFIG.gaugeBbox, not literals', () => {
  withConfig({ gaugeBbox: { xmin: -98.0, ymin: 27.5, xmax: -93.4, ymax: 31.0 } }, () => {
    deq(aoFullBounds(), [[27.5, -98.0], [31.0, -93.4]]);
  });
  withConfig({ gaugeBbox: { xmin: -102.0, ymin: 28.0, xmax: -97.0, ymax: 31.1 } }, () => {
    deq(aoFullBounds(), [[28.0, -102.0], [31.1, -97.0]]);
  });
});

test('resolveAoPresets — absent event presets fall back to the built-in sub-AO list', () => {
  withConfig({ aoPresets: null }, () => {
    const p = resolveAoPresets('en');
    assert.equal(p[0][0], FULL_LABEL);
    deq(p[0][1], aoFullBounds());
    deq(p.slice(1), AO_PRESET_FALLBACK);
  });
});

test('resolveAoPresets — event.json presets replace the fallback when present', () => {
  const evp = [
    { id: 'houston', label: 'Houston metro', bounds: [[29.4, -95.9], [30.2, -94.9]] },
    { id: 'beaumont', label: 'Beaumont · Port Arthur', bounds: [[29.6, -94.5], [30.6, -93.4]] },
  ];
  withConfig({ aoPresets: evp }, () => {
    const p = resolveAoPresets('en');
    assert.equal(p.length, 3);
    assert.equal(p[0][0], FULL_LABEL);
    deq(p[1], ['Houston metro', [[29.4, -95.9], [30.2, -94.9]]]);
    deq(p[2], ['Beaumont · Port Arthur', [[29.6, -94.5], [30.6, -93.4]]]);
  });
});

test('resolveAoPresets — labelEs wins under es, label under en or when labelEs absent', () => {
  const evp = [
    { id: 'galvestonbay', label: 'Galveston Bay', labelEs: 'Bahía de Galveston', bounds: [[28.9, -95.5], [29.75, -94.35]] },
    { id: 'houston', label: 'Houston metro', bounds: [[29.4, -95.9], [30.2, -94.9]] },
  ];
  withConfig({ aoPresets: evp }, () => {
    assert.equal(resolveAoPresets('es')[1][0], 'Bahía de Galveston');
    assert.equal(resolveAoPresets('en')[1][0], 'Galveston Bay');
    assert.equal(resolveAoPresets('es')[2][0], 'Houston metro');
  });
});

test('resolveAoPresets — malformed entries are dropped; all-malformed falls back', () => {
  const good = { id: 'ok', label: 'OK area', bounds: [[29.0, -95.0], [30.0, -94.0]] };
  const bad = [
    null,
    { id: 'nolabel', bounds: [[29.0, -95.0], [30.0, -94.0]] },
    { id: 'nobounds', label: 'No bounds' },
    { id: 'badshape', label: 'Bad shape', bounds: [[29.0], [30.0, -94.0]] },
    { id: 'nan', label: 'NaN corner', bounds: [[29.0, 'x'], [30.0, -94.0]] },
  ];
  withConfig({ aoPresets: bad.concat([good]) }, () => {
    const p = resolveAoPresets('en');
    assert.equal(p.length, 2);
    deq(p[1], ['OK area', good.bounds]);
  });
  withConfig({ aoPresets: bad }, () => {
    deq(resolveAoPresets('en').slice(1), AO_PRESET_FALLBACK);
  });
});
