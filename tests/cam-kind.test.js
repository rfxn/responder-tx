'use strict';

/* Live video vs still photo. The board pools nine camera networks under one 📷, and the
   difference between them decides what an operator is actually looking at: a moving picture of
   the crossing now, or a single frame that the aging gate allows to be up to CAM_STALE_MINS old.
   Two invariants are guarded here. The kind is read off the camera's own row, never off a list of
   source names, so a new network inherits its marker, its label and its player from the data it
   publishes. And the live cue and the aging cue sit on disjoint sets, so a stale snapshot can
   never wear the live treatment. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const { camIsLive, CAM_NETS } = loadApp();
const ROOT = path.join(__dirname, '..');
const readFile = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CAMS = JSON.parse(readFile('data/cameras.json'));
const SRC = readFile('js/cameras.js');

function everyCam() {
  const out = [];
  for (const [arr, net] of CAM_NETS) for (const c of CAMS[arr] || []) out.push({ c, net });
  return out;
}

test('camIsLive: a stream URL makes a camera live, its absence makes it a still', () => {
  assert.equal(camIsLive({ httpsurl: 'https://s76.us-east-1.skyvdn.com/rtplive/TX_ABL_001/playlist.m3u8' }), true);
  assert.equal(camIsLive({ httpsurl: 'https://zoocams.elpasozoo.org/bridgepdn1.m3u8' }), true);
  assert.equal(camIsLive({ id: '1', name: 'a proxied city still' }), false);
  assert.equal(camIsLive({ camId: 'TX_Guadalupe', newest: '2026-07-25T00:00:00Z' }), false);
  assert.equal(camIsLive({ src: 'its', dist: 'AUS', icd: 'IH-35' }), false);
});

test('camIsLive: a URL the player could not load is not a live camera', () => {
  // the predicate is safeUrl, the same gate the player passes its source through, so the marker
  // cannot claim live anywhere the viewer would be handed a URL it refuses
  for (const bad of ['javascript:alert(1)', 'rtmp://host/stream', 'file:///etc/passwd', '', null, undefined, 'playlist.m3u8']) {
    assert.equal(camIsLive({ httpsurl: bad }), false, `${bad} must not read as live`);
  }
  assert.equal(camIsLive(null), false);
  assert.equal(camIsLive(undefined), false);
});

test('the kind is derived from the data, never from a list of source names', () => {
  // a per-source switch is exactly what this replaced: adding a network must not mean editing a
  // branch here. Guard the derivation itself, so a source name cannot creep back into it.
  const fn = SRC.match(/const camIsLive = [^\n]+/);
  assert.ok(fn, 'camIsLive not found in js/cameras.js');
  for (const [, net] of CAM_NETS) {
    assert.ok(!fn[0].includes(net), `camIsLive branches on the '${net}' source instead of the data`);
  }
  assert.ok(!/\bc\.src\b/.test(fn[0]), 'camIsLive branches on the source field');
  assert.ok(!/camIconClass/.test(SRC), 'the retired per-source icon switch is back');
});

test('every shipped camera resolves to exactly one kind, and the board ships both', () => {
  const all = everyCam();
  assert.ok(all.length > 1000, `inventory is only ${all.length} cameras`);
  const live = all.filter((x) => camIsLive(x.c));
  assert.ok(live.length > 0, 'no live camera in the inventory');
  assert.ok(live.length < all.length, 'no still camera in the inventory');
  for (const x of live) {
    assert.match(x.c.httpsurl, /^https:\/\/\S+\.m3u8$/, `${x.net}: live camera without an HLS playlist`);
  }
});

test('a network can carry both kinds, and each of its cameras still resolves alone', () => {
  // TxDOT is the case that makes a per-source rule wrong: the MapLarge heads stream and the ITS
  // heads only ever return a JPEG, from one array under one operator
  const tx = (CAMS.txdot || []);
  assert.ok(tx.some((c) => camIsLive(c)), 'no streaming TxDOT camera');
  assert.ok(tx.some((c) => !camIsLive(c)), 'no snapshot-only TxDOT camera');
  for (const c of tx.filter((x) => !camIsLive(x))) {
    assert.equal(c.src, 'its', 'a TxDOT camera with no stream that the snapshot proxy cannot fetch');
  }
});

test('the aging cue and the live cue can never land on the same camera', () => {
  // staleness is computed only where a capture stamp exists, and every one of those paths is a
  // still: the proxy header for the city/ITS/flood cams, the S3 key for the river cams. A live
  // camera therefore carries no capture stamp and no proxy id, so "stale" and "live" are
  // structurally unable to describe one camera, whatever the frame age turns out to be.
  for (const { c, net } of everyCam()) {
    if (!camIsLive(c)) continue;
    assert.equal(c.newest, undefined, `${net}: a live camera carries a still's capture stamp`);
    assert.equal(c.id, undefined, `${net}: a live camera carries a still proxy id`);
    assert.equal(c.camId, undefined, `${net}: a live camera carries a river still id`);
    assert.notEqual(c.src, 'its', `${net}: a live camera is flagged snapshot-only`);
  }
});

test('the viewer plays exactly what the marker calls live, and nothing else', () => {
  const fn = SRC.match(/function openCamViewer\(c, kind\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'openCamViewer not found in js/cameras.js');
  const body = fn[0];
  const liveAt = body.indexOf('camIsLive(c)');
  assert.notEqual(liveAt, -1, 'the viewer no longer dispatches on the live predicate');
  assert.equal(body.split('camIsLive(c)').length - 1, 1, 'one predicate, one branch');
  // every still branch must sit BELOW it, or a stream camera could be routed to a proxy. The
  // proxied networks dispatch off one table lookup; ITS and USGS keep their own branches.
  const stillAt = [body.indexOf('camStillNote(kind)')]
    .concat(['txdot', 'austin', 'atxfloods', 'houston', 'arlington', 'hays', 'porthou', 'swrecon', 'corpus']
      .map((net) => body.indexOf(`kind === '${net}'`)))
    .filter((i) => i !== -1);
  assert.ok(stillAt.length, 'no still branch found in the viewer');
  for (const at of stillAt) assert.ok(liveAt < at, 'a still branch is tested before the live branch');
  // and the live branch must never reach a still loader
  assert.ok(!/loadCityStill|loadItsSnapshot|loadRiverStill/.test(body.slice(liveAt, Math.min(...stillAt))),
    'the live branch loads a still');
});

/* A feed that publishes no capture time cannot be aged, so the aging gate can never fire on it.
   Before this the viewer printed the ordinary snapshot chip and an empty "captured ·", which let a
   frame of unknown age read as current. The absent stamp now has to be stated as its own condition,
   and it has to be derived from the missing header rather than from a list of source names, so any
   feed that drops its Last-Modified is covered the moment it does. */
test('a still with no capture time says so, and never wears the plain snapshot chip', () => {
  const fn = SRC.match(/async function loadProxyStill\([\s\S]*?\n\}/);
  assert.ok(fn, 'loadProxyStill not found in js/cameras.js');
  const body = fn[0];
  assert.match(body, /cam\.nostamp/, 'the viewer has no no-capture-time state');
  assert.match(body, /cam\.nostamp\.note/, 'the no-capture-time state carries no explanation');
  // the honest render is chosen by the parsed stamp, not by which source the camera came from
  for (const [, net] of CAM_NETS) {
    assert.ok(!body.includes(`'${net}'`), `loadProxyStill branches on the '${net}' source`);
  }
  // the snapshot chip and the captured row must both sit inside the has-a-stamp branch
  const nostampAt = body.indexOf('cam.nostamp');
  for (const key of ['cam.snapshot', 'cam.captured', 'cam.stale']) {
    const at = body.indexOf(key);
    assert.notEqual(at, -1, `${key} vanished from the viewer`);
    assert.ok(at < nostampAt, `${key} is rendered outside the has-a-stamp branch`);
  }
});

test('every shipped camera on a stampless feed is a still, so none can claim live', () => {
  // the no-capture-time path lives in the still player; a live network reaching it would mean a
  // stream camera rendered through a chip that says its age is unknown
  const cams = JSON.parse(readFile('data/cameras.json'));
  for (const net of ['swrecon', 'corpus']) {
    assert.ok(Array.isArray(cams[net]), `${net} is not in data/cameras.json`);
    for (const c of cams[net]) assert.equal(camIsLive(c), false, `${net} camera ${c.id} claims live`);
  }
});

/* The two camera proxies are separate implementations of one contract: the LAN server and the
   edge Function must resolve the same upstream for the same id, or a camera works on one board and
   404s on the other. Every source key that reaches the client has to exist in both. */
test('every camera network the client ships is served by BOTH proxies', () => {
  const edge = readFile('functions/api/cam/[district]/[icd].js');
  const lan = readFile('server.py');
  const gen = readFile('scripts/gen-cameras.py');
  const cams = JSON.parse(readFile('data/cameras.json'));
  for (const [arr, net] of CAM_NETS) {
    if (!(cams[arr] || []).length) continue;
    if (net === 'txdot' || net === 'river' || net === 'elpbridge') continue; // ITS path, and the two direct-play sets
    assert.ok(new RegExp(`\\b${net}\\b`).test(edge), `${net} is missing from the edge proxy`);
    assert.ok(new RegExp(`\\b${net}\\b`).test(lan), `${net} is missing from server.py`);
  }
  // WeatherBug resolves a frame by walking the filename back, so the window has to match in all
  // three places or gen ships a camera a proxy then refuses to find
  const win = (src, key) => (src.match(new RegExp(`${key}\\s*=\\s*(\\d+)`)) || [])[1];
  assert.equal(win(gen, 'WB_PROBE_MINUTES'), win(edge, 'WB_PROBE_MINUTES'), 'gen and edge disagree on the probe window');
  assert.equal(win(gen, 'WB_PROBE_MINUTES'), win(lan, 'CAM_WB_PROBE_MINUTES'), 'gen and server.py disagree on the probe window');
});

test('the marker states its kind in text, not in colour and glyph alone', () => {
  const m = SRC.match(/const mark = \(c, kind\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, 'the camera marker builder was not found');
  assert.match(m[0], /aria-label="\$\{lbl\}"/, 'the marker carries no accessible name');
  assert.match(m[0], /title="\$\{lbl\}"/, 'the marker carries no hover label');
  assert.match(m[0], /camKindLong\(c\)/, 'the label is not the translated kind');
  assert.match(m[0], /cam-live.*cam-still|cam-still.*cam-live/, 'the marker does not carry a kind class');
});

test('the two marker states separate without relying on colour', () => {
  const css = readFile('css/app.css');
  const rule = (sel) => {
    const m = css.match(new RegExp(`\\${sel} \\{([^}]*)\\}`));
    return m ? m[1] : '';
  };
  const live = rule('.cam-icon.cam-live');
  assert.ok(live, '.cam-icon.cam-live has no rule');
  assert.match(live, /background:/, 'the live marker is not filled, so the pair separates by colour alone');
  assert.match(css, /\.cam-icon\.cam-still \{[^}]*dashed/, 'the still marker has no dashed border');
  // the per-operator rings are retired: two systems must not compete for the same 20 pixels
  for (const dead of ['cam-river', 'cam-austin', 'cam-houston', 'cam-arlington', 'cam-elp', 'cam-flood', 'cam-snap']) {
    assert.ok(!css.includes(`.cam-icon.${dead}`), `the retired ${dead} ring is back alongside the kind cue`);
  }
});

test('the kind is legended, labelled in both languages and free of em-dashes', () => {
  assert.match(readFile('js/map.js'), /legend\.cams/, 'the map legend has no camera key');
  assert.match(readFile('js/map.js'), /cam-icon cam-live/, 'the legend does not show the live marker');
  assert.match(readFile('js/map.js'), /cam-icon cam-still/, 'the legend does not show the still marker');
  const i18n = readFile('js/i18n.js');
  for (const k of ['cam.kind.live', 'cam.kind.still', 'cam.kind.live.long', 'cam.kind.still.long', 'legend.cams']) {
    assert.equal((i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2,
      `${k} is missing from en or es`);
  }
});

test('the region row reports the split, so a region of stills says so before it is opened', () => {
  const sub = readFile('js/map.js').match(/function camRegionSub\(p\) \{[\s\S]*?\n\}/);
  assert.ok(sub, 'camRegionSub not found');
  assert.match(sub[0], /state\.camLive/, 'the row does not read the live count');
  const i18n = readFile('js/i18n.js');
  for (const m of i18n.matchAll(/'sheet\.s\.cams\.count': '([^']+)'/g)) {
    assert.ok(m[1].includes('{n}') && m[1].includes('{l}'), `sheet.s.cams.count lost a placeholder: ${m[1]}`);
  }
  assert.match(readFile('js/cameras.js'), /state\.camLive\[p\.id\] = liveN\[p\.id\]/, 'the live count is never published');
});
