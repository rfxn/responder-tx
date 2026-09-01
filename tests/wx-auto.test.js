/* The merged radar + forecast row auto-enables on an active tropical threat, on the same gate that
   raises the tracker. Everything here CALLS maybeAutoWx() or fires a real map event through the
   handlers initMap() registered; a source-text assertion would not have caught the case this file
   most needs to hold, which is that a toggle-off latches and the auto-enable never re-opens it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWiredMap } = require('./harness.js');

const HOUR = 3600000;
const alert = (event, endsInMs = 6 * HOUR) => ({
  properties: { event, ends: new Date(Date.now() + endsInMs).toISOString() },
});

// a wired map with initMap() run for real, parked in the pre-auto state
function wired(alerts) {
  const w = loadWiredMap();
  w.state.alerts = alerts || [];
  w.state.wxAutoDone = false;
  if (w.sandbox.layerRowOn('wx')) w.sandbox.wxRemove();
  w.state.wxAutoDone = false; // wxRemove above fires overlayremove, which latches
  return w;
}

test('an active tropical threat brings up radar and the forecast together', () => {
  const w = wired([alert('Tropical Storm Warning')]);
  w.sandbox.maybeAutoWx();
  assert.equal(w.sandbox.layerRowOn('wx'), true, 'the merged row must come on during a tropical threat');
  assert.equal(w.map.hasLayer(w.layers.radar), true, 'observed radar is half of what the owner asked for');
  assert.equal(w.map.hasLayer(w.layers.fcstRadar), true, 'the HRRR forecast is the other half');
  assert.equal(w.state.wxAutoDone, true, 'and the latch burns so it happens once per session');
});

test('a hurricane watch and a storm surge warning each count as the threat', () => {
  for (const ev of ['Hurricane Watch', 'Storm Surge Warning', 'Tropical Storm Watch', 'Hurricane Warning']) {
    const w = wired([alert(ev)]);
    w.sandbox.maybeAutoWx();
    assert.equal(w.sandbox.layerRowOn('wx'), true, `${ev} must raise the radar pair`);
  }
});

/* The owner's ask was scoped to the cyclone: this must not become a permanent radar default by
   way of a product that is merely tropical-adjacent. A Local Statement is issued for every storm
   and carries no watch or warning of its own. */
test('ordinary weather, and a tropical statement, leave the row alone', () => {
  for (const ev of ['Flood Watch', 'Wind Advisory', 'Tropical Cyclone Local Statement',
    'Severe Thunderstorm Warning', 'Beach Hazards Statement', 'Air Quality Alert']) {
    const w = wired([alert(ev)]);
    w.sandbox.maybeAutoWx();
    assert.equal(w.sandbox.layerRowOn('wx'), false, `${ev} is not a tropical threat to Texas`);
    assert.equal(w.state.wxAutoDone, false, 'and must not burn the latch on its way past');
  }
});

test('an expired warning is not a live threat', () => {
  const w = wired([alert('Hurricane Warning', -2 * HOUR)]);
  w.sandbox.maybeAutoWx();
  assert.equal(w.sandbox.layerRowOn('wx'), false, 'a warning that already ended must not raise the row');
});

test('no alerts at all leaves the row off', () => {
  const w = wired([]);
  w.sandbox.maybeAutoWx();
  assert.equal(w.sandbox.layerRowOn('wx'), false, 'a quiet Gulf keeps radar an opt-in layer');
});

/* The reader closing the row is the decision that outranks the storm. Without this the next
   alerts poll, three minutes later, reopens a layer the reader just shut. */
test('turning the row off stops the auto-enable for the session', () => {
  const w = wired([alert('Tropical Storm Warning')]);
  w.sandbox.maybeAutoWx();
  assert.equal(w.sandbox.layerRowOn('wx'), true);
  w.sandbox.wxRemove(); // what the pill and the sheet row both call
  assert.equal(w.sandbox.layerRowOn('wx'), false, 'the row is down');
  assert.equal(w.state.wxAutoDone, true, 'a toggle-off must latch');
  w.sandbox.maybeAutoWx();
  assert.equal(w.sandbox.layerRowOn('wx'), false, 'and the storm must not reopen it');
});

test('dropping either half alone is still the reader closing the row', () => {
  for (const half of ['radar', 'fcstRadar']) {
    const w = wired([alert('Tropical Storm Warning')]);
    w.sandbox.maybeAutoWx();
    w.state.wxAutoDone = false;
    w.fire('overlayremove', { layer: w.layers[half] });
    assert.equal(w.state.wxAutoDone, true, `removing ${half} must latch`);
  }
});

/* PB_LIVE_HIDE strips fcstRadar on every playback engage. That is the board taking the layer
   away, not the reader closing it, and latching on it would kill the auto-enable for the rest of
   a session for anyone who scrubbed the archive once. */
test('playback taking the forecast away is not the reader closing it', () => {
  const w = wired([alert('Tropical Storm Warning')]);
  assert.ok(w.app.pbLiveHideAll().some(([k]) => k === 'fcstRadar'),
    'playback no longer hides the forecast; this guard is vacuous');
  const prevPb = w.state.pb;
  w.state.pb = Object.assign({}, prevPb, { live: false }); // engaged: pbBlocksLive() is true
  try {
    w.fire('overlayremove', { layer: w.layers.fcstRadar });
    assert.equal(w.state.wxAutoDone, false, 'a playback strip must not read as a toggle-off');
    w.sandbox.maybeAutoWx();
    assert.equal(w.sandbox.layerRowOn('wx'), false, 'and nothing live may be added under a past frame');
    assert.equal(w.state.wxAutoDone, false, 'deferred, not spent: the latch is still unburnt');
  } finally { w.state.pb = prevPb; }
  w.sandbox.maybeAutoWx();
  assert.equal(w.sandbox.layerRowOn('wx'), true, 'a session that scrubbed the archive must still get the auto-enable');
});

test('a restored OFF from a saved layer set is the reader closing it too', () => {
  const w = wired([alert('Tropical Storm Warning')]);
  const known = w.app.layerRowKeys();
  assert.ok(known.includes('wx'), 'the merged row must be a saved key or the restore cannot latch');
  w.app.applyLayerState(known.filter((k) => k !== 'wx'), known);
  assert.equal(w.state.wxAutoDone, true, 'a saved set with the row off must latch');
  w.sandbox.maybeAutoWx();
  assert.equal(w.sandbox.layerRowOn('wx'), false, 'a returning reader who had it off keeps it off');
});

test('the event-config kill switch turns the whole behaviour off', () => {
  const w = wired([alert('Hurricane Warning')]);
  w.app.CONFIG.wxAutoEnable = false;
  try {
    w.sandbox.maybeAutoWx();
    assert.equal(w.sandbox.layerRowOn('wx'), false, 'the kill switch must hold against a live hurricane warning');
    assert.equal(w.state.wxAutoDone, false, 'and must not burn the latch on its way past');
  } finally { w.app.CONFIG.wxAutoEnable = true; }
});

/* The gate is shared with the tracker on purpose: two thresholds for one storm is the E5 shape
   that has bitten this repo before. If one moves, this fails rather than drifting silently. */
test('radar and the tracker answer to the same threat gate', () => {
  const w = wired([alert('Tropical Storm Warning')]);
  w.sandbox.maybeAutoTropical();
  w.sandbox.maybeAutoWx();
  assert.equal(w.map.hasLayer(w.layers.tropical), true, 'the tracker comes up');
  assert.equal(w.sandbox.layerRowOn('wx'), true, 'and radar comes up with it, on the same alerts');
  const quiet = wired([alert('Flood Watch')]);
  quiet.sandbox.maybeAutoTropical();
  quiet.sandbox.maybeAutoWx();
  assert.equal(quiet.map.hasLayer(quiet.layers.tropical), false, 'and neither moves without the storm');
  assert.equal(quiet.sandbox.layerRowOn('wx'), false);
});

/* The alerts poll is the only thing that re-checks the gate. A storm that arrives between page
   loads reaches the reader only through this call site, so it is asserted by running fetchAlerts
   for real against a stubbed body rather than by grepping sources.js for the call. */
test('the alerts fetch is what drives the auto-enable', async () => {
  const w = loadWiredMap();
  const SB = w.sandbox;
  const body = { type: 'FeatureCollection', features: [] };
  const saved = {};
  const stubs = ['showEmergencyBanner', 'dismissEmergencyBanner', 'recordAlertHist', 'renderAlertList',
    'renderAlertPolys', 'renderTiles', 'markHealthy', 'syncAcutePoll', 'fetch'];
  for (const k of stubs) { saved[k] = SB[k]; SB[k] = () => {}; }
  SB.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/geo+json' }, json: async () => body });
  const calls = w.spyOn('maybeAutoWx');
  try {
    await SB.fetchAlerts();
  } finally { Object.assign(SB, saved); }
  assert.ok(calls.names().includes('maybeAutoWx'), 'fetchAlerts must re-check the gate every cycle');
});
