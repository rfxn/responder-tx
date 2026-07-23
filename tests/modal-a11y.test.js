'use strict';

// Pure-function coverage for the modal focus-trap helper (js/core.js). The trap/inert/focus
// side effects need a real browser and are verified by manual QA; only the DOM-free sub-parts
// (Tab cycle-index math, focusable-visibility predicate) are unit-tested here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const { modalCycleIndex, modalIsFocusableVisible } = loadApp();

test('modalCycleIndex — empty focus set yields -1 (nothing to focus)', () => {
  assert.equal(modalCycleIndex(0, -1, false), -1);
  assert.equal(modalCycleIndex(0, 0, true), -1);
});

test('modalCycleIndex — single focusable pins to 0 for both directions', () => {
  assert.equal(modalCycleIndex(1, 0, false), 0);
  assert.equal(modalCycleIndex(1, 0, true), 0);
  assert.equal(modalCycleIndex(1, -1, false), 0);
});

test('modalCycleIndex — Tab advances and wraps at the last focusable', () => {
  assert.equal(modalCycleIndex(3, 0, false), 1);
  assert.equal(modalCycleIndex(3, 1, false), 2);
  assert.equal(modalCycleIndex(3, 2, false), 0); // wrap forward
});

test('modalCycleIndex — Shift-Tab retreats and wraps at the first focusable', () => {
  assert.equal(modalCycleIndex(3, 2, true), 1);
  assert.equal(modalCycleIndex(3, 1, true), 0);
  assert.equal(modalCycleIndex(3, 0, true), 2); // wrap backward
});

test('modalCycleIndex — focus outside the trap (current -1) enters at the first focusable', () => {
  assert.equal(modalCycleIndex(4, -1, false), 0);
  assert.equal(modalCycleIndex(4, -1, true), 0);
});

test('modalIsFocusableVisible — nullish is not focusable', () => {
  assert.equal(modalIsFocusableVisible(null), false);
  assert.equal(modalIsFocusableVisible(undefined), false);
});

test('modalIsFocusableVisible — a zero-box node with no client rects is hidden', () => {
  const hidden = { offsetWidth: 0, offsetHeight: 0, getClientRects: () => [] };
  assert.equal(modalIsFocusableVisible(hidden), false);
});

test('modalIsFocusableVisible — a laid-out node (nonzero box) is visible', () => {
  const shown = { offsetWidth: 120, offsetHeight: 32, getClientRects: () => [{}] };
  assert.equal(modalIsFocusableVisible(shown), true);
});

test('modalIsFocusableVisible — client rects alone (zero offsets) still count as visible', () => {
  const inline = { offsetWidth: 0, offsetHeight: 0, getClientRects: () => [{ width: 10, height: 4 }] };
  assert.equal(modalIsFocusableVisible(inline), true);
});
