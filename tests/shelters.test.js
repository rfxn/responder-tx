'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const { mergeShelters, shelterDup, shelterKey } = loadApp();

const curated = [
  { name: 'Calvary Temple Church (shelter + reunification center)', lat: 30.0439, lon: -99.1403 },
  { name: 'Uvalde Civic Center', lat: 29.2097, lon: -99.7862 },
];

/* ---------- shelterKey / shelterDup ---------- */

test('shelterKey — lowercases and collapses punctuation to spaces', () => {
  assert.equal(shelterKey('Calvary Temple Church (shelter + reunification center)'),
    'calvary temple church shelter reunification center');
  assert.equal(shelterKey(null), '');
});

test('shelterDup — containment name match dedups curated suffix variants', () => {
  assert.ok(shelterDup({ name: 'Calvary Temple Church' }, curated[0]));
});

test('shelterDup — geo proximity under 0.3 mi is a duplicate even with a different name', () => {
  assert.ok(shelterDup({ name: 'City Shelter A', lat: 29.2098, lon: -99.7861 }, curated[1]));
});

test('shelterDup — distinct name and distant coords is not a duplicate', () => {
  assert.equal(shelterDup({ name: 'Alexander Convention Center', lat: 28.4462, lon: -99.2447 }, curated[1]), false);
});

test('shelterDup — short name fragments never containment-match', () => {
  assert.equal(shelterDup({ name: 'Cente' }, curated[1]), false);
});

/* ---------- mergeShelters ---------- */

// note: vm-realm outputs have foreign prototypes — compare by JSON, not deepEqual
test('mergeShelters — no live data keeps curated unchanged', () => {
  assert.equal(JSON.stringify(mergeShelters(curated, null)), JSON.stringify(curated));
  assert.equal(JSON.stringify(mergeShelters(curated, [])), JSON.stringify(curated));
});

test('mergeShelters — live entries come first, flagged live:true', () => {
  const live = [{ name: 'Alexander Convention Center', lat: 28.4462, lon: -99.2447, status: 'OPEN' }];
  const out = mergeShelters(curated, live);
  assert.equal(out.length, 3);
  assert.equal(out[0].live, true);
  assert.equal(out[0].name, 'Alexander Convention Center');
  assert.equal(JSON.stringify(out.slice(1)), JSON.stringify(curated));
});

test('mergeShelters — live duplicate replaces the curated entry', () => {
  const live = [{ name: 'Uvalde Civic Center', lat: 29.2097, lon: -99.7862, status: 'FULL' }];
  const out = mergeShelters(curated, live);
  assert.equal(out.length, 2);
  assert.equal(out[0].status, 'FULL');
  assert.equal(out[1].name, curated[0].name);
});

test('mergeShelters — tolerates missing coords and nameless live rows', () => {
  const live = [{ name: 'No Coords Hall', status: 'OPEN' }, { status: 'OPEN' }, null];
  const out = mergeShelters(curated, live);
  assert.equal(out.length, 3);
  assert.equal(out[0].name, 'No Coords Hall');
});

test('mergeShelters — empty curated with live-only data', () => {
  const live = [{ name: 'Alexander Convention Center', lat: 28.4462, lon: -99.2447, status: 'OPEN' }];
  const out = mergeShelters([], live);
  assert.equal(out.length, 1);
  assert.equal(out[0].live, true);
});

/* ---------- generated file schema (when present) ---------- */

test('shelters-live.json — schema holds when the poller output is present', () => {
  const p = path.join(__dirname, '..', 'data', 'shelters-live.json');
  if (!fs.existsSync(p)) return; // absence-tolerant by design
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(d.generated);
  assert.ok(d.source && d.source.name && d.source.url);
  assert.ok(Array.isArray(d.shelters));
  for (const s of d.shelters) {
    assert.ok(s.name && s.status);
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon));
  }
});
