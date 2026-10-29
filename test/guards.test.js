// -----------------------------------------------------------------------------
// One test per guard a mutation of the code could remove unseen: each case
// fails when the guard it names is broken (checked by mutation, TODO.md).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, CONFIG, READ, last, message, setup, settle, zoneDevice } from './helpers/app.js';
import { MINUTE, SECOND } from '../src/constants.js';

const stopsOf = (rm, path = '/api/4/zone/1/stop') => rm.writes.filter((w) => w.path === path);

test('the watering length written is the configured one (3 min: 180 s)', async (t) => {
  const { rm, press } = await setup(t, { config: { ...ALLOWED, watering_minutes: 3 } });
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(rm.writes[0].body, { time: 180, zid: 1 });
});

test('a start of a zone already watering is written while a stop of it is kept, and lets it go', async (t) => {
  const { rm, press, app } = await setup(t, { config: ALLOWED });
  rm.water(1);
  rm.ignoreStops = true;
  await press(zoneDevice(1), 'stop');
  assert.equal(app.stopGuards.size, 1);
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, true, ack.error);
  assert.equal(rm.writes.filter((w) => w.path === '/api/4/zone/1/start').length, 1);
  assert.equal(app.stopGuards.size, 0);
});

test('a stop clicked while a start is on the wire is not let go by that start', async (t) => {
  const { rm, send, advance, store, app } = await setup(t, { config: ALLOWED });
  rm.writeDelayMs = 150;
  // The stop's save to /data hangs (200 ms at most): the start's answer lands meanwhile.
  let release;
  rm.onWrite = (w) => {
    if (w.path === '/api/4/zone/1/start') {
      store.hang = new Promise((resolve) => {
        release = resolve;
      });
      send(zoneDevice(1), 'stop');
    }
  };
  const start = send(zoneDevice(1), 'start');
  await settle();
  rm.ignoreStops = true;
  await advance(5 * SECOND, 25);
  await start;
  store.hang = undefined;
  release?.();
  assert.ok(app.stopGuards.has('zone:1'), 'the stop clicked after the start left stays kept');
  await advance(MINUTE, 5 * SECOND);
  assert.ok(stopsOf(rm).length >= 2, 'and is sent again');
});

test('a stop that meets an unreachable controller is tried again within its 3 s', async (t) => {
  const { rm, press } = await setup(t);
  rm.water(1);
  rm.failNext = ['unreachable', 'unreachable'];
  const ack = await press(zoneDevice(1), 'stop');
  assert.equal(ack.success, true, ack.error);
  assert.equal(stopsOf(rm).length, 1);
});

test('a stop first sent by a check, then not applied: 1 write + 3 resends, the first is not a resend', async (t) => {
  const { rm, press, advance, store } = await setup(t);
  rm.water(1);
  rm.down = 'unreachable';
  await press(zoneDevice(1), 'stop');
  rm.down = undefined;
  rm.ignoreStops = true;
  await advance(5 * MINUTE, 5 * SECOND);
  assert.equal(stopsOf(rm).length, 4);
  assert.equal(store.data.stops[0].resends, 3);
});

test('a stop is in /data before its first byte', async (t) => {
  const { rm, press, store } = await setup(t);
  rm.water(1);
  let kept;
  rm.onWrite = (w) => {
    if (w.path === '/api/4/zone/1/stop') kept = store.data.stops.map((s) => s.key);
  };
  rm.ignoreStops = true;
  await press(zoneDevice(1), 'stop');
  assert.deepEqual(kept, ['zone:1']);
});

test('"Test the connection" logging in sends a kept stop before the rest of the read', async (t) => {
  const { rm, press, advance, gladys } = await setup(t);
  rm.water(1);
  rm.password = 'other';
  rm.tokens.clear();
  await advance(61 * SECOND);
  await press(zoneDevice(1), 'stop');
  rm.password = 'S3cret pass!';
  await advance(2 * MINUTE, 5 * SECOND);
  const from = rm.requests.length;
  await gladys.fake.action('test_connection', {});
  await settle(20);
  await advance(2 * SECOND, 100);
  const after = rm.requests.slice(from);
  const stop = after.indexOf('POST /api/4/zone/1/stop');
  assert.ok(stop >= 0);
  assert.ok(stop < after.indexOf('GET /api/4/program'), after.join(', '));
});

test('a read begun before a start left never shows the zone dry after the start is confirmed', async (t) => {
  const { rm, send, advance, gladys, app } = await setup(t, { config: ALLOWED });
  rm.latencyMs = 200;
  await advance(59 * SECOND);
  // The poll starts; the start is clicked once the poll read the zones.
  let clicked;
  for (let i = 0; i < 100 && !clicked; i += 1) {
    await advance(50, 50);
    if (rm.requests.filter((r) => r === 'GET /api/4/zone').length >= 2) {
      clicked = send(zoneDevice(1), 'start');
    }
  }
  assert.ok(clicked);
  await advance(4 * SECOND, 50);
  const ack = await clicked;
  assert.equal(ack.success, true, ack.error);
  assert.equal(app.controller.zones.get(1).state, 1);
  assert.equal(last(gladys, `${zoneDevice(1)}:watering`), 1);
});

test('stale values are never republished at a reconnection (a 429 pause longer than 2 min)', async (t) => {
  const { rm, advance, gladys, app } = await setup(t);
  rm.failNext = [429];
  await advance(60 * SECOND);
  await advance(3 * MINUTE, 10 * SECOND);
  const before = gladys.fake.states.length;
  await app.connected(CONFIG);
  await advance(2 * SECOND);
  assert.equal(gladys.fake.states.length, before);
});

test('a login refused with an old password does not block the new one saved meanwhile', async (t) => {
  const { rm, send, advance, gladys, store, app } = await setup(t);
  rm.water(1);
  rm.password = 'new one';
  rm.tokens.clear();
  rm.latencyMs = 300;
  const stop = send(zoneDevice(1), 'stop');
  await settle();
  await advance(100, 50);
  // The stop logs in with the old password; the new one is saved meanwhile.
  const saved = app.configUpdated({ ...CONFIG, password: 'new one' });
  await advance(5 * SECOND, 50);
  await stop;
  await saved;
  await advance(70 * SECOND);
  assert.equal(store.data.block, null);
  assert.equal(gladys.fake.connectionStatus.connected, true, message(gladys).en);
  assert.ok(READ.length > 0);
});

test('a start sent shortly before a stop that lands after it is countered', async (t) => {
  const { rm, press, advance } = await setup(t, { config: ALLOWED });
  rm.startDelayMs = 10 * SECOND;
  await press(zoneDevice(1), 'start');
  // The stop finds the zone dry (the start has not landed yet).
  const ack = await press(zoneDevice(1), 'stop');
  assert.equal(ack.success, true, ack.error);
  await advance(40 * SECOND, SECOND);
  assert.equal(rm.zones.get(1).state, 0, 'the late start countered');
  assert.ok(stopsOf(rm).length >= 2);
});

test('a start waiting for the line when a stop is clicked never leaves after that stop', async (t) => {
  const { rm, send, advance } = await setup(t, { config: ALLOWED });
  rm.latencyMs = 300;
  await advance(59 * SECOND);
  // A poll holds the line; a start then a stop are clicked.
  let start;
  let stop;
  for (let i = 0; i < 100 && !stop; i += 1) {
    await advance(50, 50);
    if (rm.requests.includes('GET /api/4/provision/wifi') && rm.requests.length > 8) {
      start = send(zoneDevice(1), 'start');
      await advance(10, 10);
      stop = send(zoneDevice(1), 'stop');
    }
  }
  await advance(5 * SECOND, 50);
  const [a, b] = await Promise.all([start, stop]);
  assert.equal(b.success, true, b.error);
  assert.equal(a.success, false);
  assert.match(a.error, /arrêt a été cliqué/);
  assert.ok(!rm.writes.some((w) => w.path === '/api/4/zone/1/start'));
});
