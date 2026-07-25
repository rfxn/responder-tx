'use strict';

/* Duplicate-ID guard. The board's renderers write markup with innerHTML into containers
   declared in index.html, and `$` is document.querySelector, which returns the FIRST match
   in tree order. So when a renderer template literal re-emits an id that index.html already
   declares, every later `$('#that-id')` silently resolves to whichever node comes first in
   the document, not the one the caller meant. That shipped once: renderResources() emitted a
   second #recovery-body inside the Resources tab (which preceded #recovery-view), so the whole
   Recovery dashboard rendered into a hidden disclosure and the lens opened empty (v0.97.75
   through v0.97.81, fixed in v0.97.82 by renaming the resources-side node). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// renderer files: every script that builds markup strings for injection into the page
const RENDERERS = ['panels', 'board', 'map', 'sources', 'team', 'playback', 'notes', 'cameras'];

const ID_ATTR = /id="([a-z0-9-]+)"/g;

const idsIn = (src) => [...src.matchAll(ID_ATTR)].map((m) => m[1]);

test('no id declared in index.html is re-emitted by a renderer template literal', () => {
  const declared = new Set(idsIn(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
  assert.ok(declared.size > 100, `expected index.html to declare many ids, saw ${declared.size}`);

  const collisions = [];
  for (const name of RENDERERS) {
    const file = `js/${name}.js`;
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const id of new Set(idsIn(src))) {
      if (declared.has(id)) collisions.push(`${file} re-emits #${id}`);
    }
  }

  assert.deepEqual(collisions, [],
    `renderer markup re-emits ids index.html already declares; querySelector would resolve to the\n` +
    `first node in tree order, not the intended one. Rename the renderer-side id:\n  ${collisions.join('\n  ')}`);
});

test('the Recovery lens container is declared once and owned by index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal(idsIn(html).filter((id) => id === 'recovery-body').length, 1);

  const panels = fs.readFileSync(path.join(ROOT, 'js/panels.js'), 'utf8');
  assert.ok(!/id="recovery-body"/.test(panels),
    'js/panels.js must not emit #recovery-body: the resources disclosure uses #res-recovery-body');
  assert.ok(/id="res-recovery-body"/.test(panels),
    'the resources-side recovery disclosure should keep its own id');
});
