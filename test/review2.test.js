// -----------------------------------------------------------------------------
// Review r2: /data slow to load (B3), the start that arrived before a stop
// (I1), "Stop all" while the programs cannot be read, the TLS fallback only on
// a protocol alert, and the corrections of r1 without a test (m3).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { testClock } from './kit/index.mjs';
import { ALLOWED, CONFIG, CONTROLLER, message, setup, settle, zoneDevice } from './helpers/app.js';
import { NOW, OTHER_FP, fakeRainMachine } from './helpers/fakeRainMachine.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { ERROR_KINDS, exchange } from '../src/rainmachine/http.js';
import { memoryStore } from '../src/store.js';

test('B3: /data slow to load (3 s) at a restart: nothing pinned nor sent, /data and the kept stop intact', async (t) => {
  const clock = testClock({ start: NOW });
  const rm = fakeRainMachine({ timers: clock.timers });
  const store = memoryStore();
  const first = await setup(t, { clock, rm, store });
  rm.water(1);
  rm.down = 'unreachable';
  await first.press(zoneDevice(1), 'stop');
  await first.app.shutdown();
  const before = JSON.parse(JSON.stringify(store.data));
  rm.down = undefined;
  rm.fingerprint = OTHER_FP;
  const slow = {
    load: () =>
      new Promise((resolve) => clock.timers.setTimeout(() => resolve(store.load()), 3 * SECOND)),
    save: (data) => store.save(data),
  };
  const mark = rm.requests.length;
  const second = await setup(t, {
    clock,
    rm,
    store: slow,
    boot: false,
    connect: false,
    create: false,
  });
  // The SDK waits for the 'connected' handler, which waits (bounded) for /data.
  const connecting = second.gladys.connect();
  await second.advance(100, 50);
  // A stop clicked while /data loads: kept, nothing sent.
  const ack = second.app.setValue(undefined, { external_id: `${zoneDevice(1)}:stop` }, 1).then(
    () => 'ok',
    (err) => err.message,
  );
  await second.advance(5 * SECOND, 100);
  await ack;
  await second.advance(30 * SECOND, SECOND);
  await connecting;
  assert.deepEqual(rm.requests.slice(mark), [], 'not a byte to the other certificate');
  assert.deepEqual(store.data.pins, before.pins, 'the pin kept');
  assert.equal(store.data.stops.length, 1, 'the kept stop kept');
  assert.match(message(second.gladys).en, /certificate of the controller changed/);
});

test('B3: a stop clicked while /data loads is kept and leaves once it is loaded', async (t) => {
  const clock = testClock({ start: NOW });
  const rm = fakeRainMachine({ timers: clock.timers });
  const store = memoryStore();
  const first = await setup(t, { clock, rm, store });
  await first.app.shutdown();
  rm.water(1);
  const slow = {
    load: () =>
      new Promise((resolve) => clock.timers.setTimeout(() => resolve(store.load()), 3 * SECOND)),
    save: (data) => store.save(data),
  };
  const second = await setup(t, {
    clock,
    rm,
    store: slow,
    boot: false,
    connect: false,
    create: false,
  });
  // The SDK waits for the 'connected' handler, which waits (bounded) for /data.
  const connecting = second.gladys.connect();
  await second.advance(100, 50);
  const mark = rm.requests.length;
  const ack = second.app.setValue(undefined, { external_id: `${zoneDevice(1)}:stop` }, 1).then(
    () => 'ok',
    (err) => err.message,
  );
  await second.advance(500, 100);
  assert.deepEqual(rm.requests.slice(mark), [], 'nothing before /data is loaded');
  assert.match(message(second.gladys).en, /\/data is still being read/);
  await second.advance(10 * SECOND, 100);
  await ack;
  await connecting;
  assert.ok(rm.writes.some((w) => w.path === '/api/4/zone/1/stop'));
  assert.equal(rm.zones.get(1).state, 0);
});

test('I1: a start waiting for the line behind a stop, arrived before it: never written after it', async (t) => {
  const { rm, send, advance } = await setup(t, { config: ALLOWED });
  rm.water(2);
  // The poll's provision read is slow (abortable): the start waits for the line.
  rm.latencyFor = (method, path) => (path === '/api/4/provision' ? 2_500 : 0);
  const before = rm.requests.filter((r) => r === 'GET /api/4/restrictions/currently').length;
  for (let i = 0; i < 2000; i += 1) {
    await advance(50, 50);
    if (rm.requests.filter((r) => r === 'GET /api/4/restrictions/currently').length > before) break;
  }
  await advance(50, 50);
  // The stop is answered with a refusal at once (no read back): its turn ends
  // quickly, and the start that arrived before it then gets the line.
  rm.failFor.set('POST /api/4/zone/2/stop', [{ code: 5 }]);
  const start = send(zoneDevice(2), 'start');
  await advance(100, 50);
  const stop = send(zoneDevice(2), 'stop');
  await advance(6 * SECOND, 50);
  const [a] = await Promise.all([start, stop]);
  assert.equal(a.success, false);
  assert.match(a.error, /arrêt a été cliqué/);
  assert.ok(!rm.writes.some((w) => w.path === '/api/4/zone/2/start'), JSON.stringify(rm.writes));
});

test('"Stop all" while the programs cannot be read: let go by two reads in a row of every zone dry', async (t) => {
  const { rm, press, advance, gladys, app } = await setup(t, {
    config: { ...ALLOWED, poll_interval: 60 },
  });
  rm.water(1);
  rm.unknown.add('/api/4/program');
  rm.failFor.set('GET /api/4/program', Array(1000).fill(500));
  await press(CONTROLLER, 'stop_all');
  assert.equal(rm.zones.get(1).state, 0);
  // One read of the zones dry is not enough while the programs cannot be read.
  assert.ok(app.stopGuards.has('all'));
  assert.match(message(gladys).en, /programs cannot be read/);
  await advance(2 * MINUTE, 5 * SECOND);
  assert.equal(app.stopGuards.has('all'), false);
  const ack = await press(zoneDevice(2), 'start');
  assert.equal(ack.success, true, ack.error);
});

test('"Stop all" while the programs cannot be read and a zone still waters: kept', async (t) => {
  const { rm, press, advance, app } = await setup(t);
  rm.water(1);
  rm.ignoreStops = true;
  rm.failFor.set('GET /api/4/program', Array(1000).fill(500));
  await press(CONTROLLER, 'stop_all');
  await advance(5 * MINUTE, 5 * SECOND);
  assert.ok(app.stopGuards.has('all'));
});

test('m2: no legacy fallback on a reset after the TCP connection (only on a TLS protocol alert)', async (t) => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let trusted = false;
  await assert.rejects(
    exchange({
      host: '127.0.0.1',
      port: server.address().port,
      timeoutMs: 2000,
      tls: 'auto',
      method: 'GET',
      path: '/',
      trust: async () => {
        trusted = true;
      },
    }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && !err.handshake,
  );
  assert.equal(trusted, false);
  assert.equal(server.connections ?? 0, 0);
});

test('m3: a hung /data never stops the reads (each save bounded to 2 s)', async (t) => {
  const { rm, store, advance } = await setup(t, { config: { ...CONFIG, poll_interval: 15 } });
  let release;
  store.hang = new Promise((resolve) => {
    release = resolve;
  });
  const mark = rm.requests.length;
  rm.flow.clicks += 20;
  await advance(80 * SECOND, SECOND);
  const reads = rm.requests.slice(mark).filter((r) => r === 'GET /api/4/provision/wifi').length;
  assert.ok(reads >= 3, `${reads} reads in 80 s`);
  store.hang = undefined;
  release();
});

test('m3: a scene of 5 starts at 450 ms an exchange: all 5 written and confirmed', async (t) => {
  const { rm, app, advance } = await setup(t, { config: ALLOWED });
  for (const uid of [4, 5]) rm.zones.set(uid, { ...rm.zones.get(1), uid, name: `Z${uid}` });
  rm.zones.get(3).active = true;
  rm.latencyMs = 450;
  const acks = [1, 2, 3, 4, 5].map((uid) =>
    app.setValue(undefined, { external_id: `${zoneDevice(uid)}:start` }, 1).then(
      () => 'ok',
      (err) => err.message,
    ),
  );
  await settle();
  await advance(5 * SECOND, 50);
  assert.deepEqual(await Promise.all(acks), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('m3: the status before the configuration (getConfig not failed): waiting for it', async (t) => {
  const { gladys, app } = await setup(t, { connect: false });
  await app.updateStatus();
  await settle(5);
  assert.match(gladys.fake.connectionStatus?.message?.en ?? '', /Waiting for the configuration/);
});

test('m3: the read back waits less near the answer: 5 starts with slow writes all confirmed', async (t) => {
  const { rm, app, advance } = await setup(t, { config: ALLOWED });
  for (const uid of [4, 5]) rm.zones.set(uid, { ...rm.zones.get(1), uid, name: `Z${uid}` });
  rm.zones.get(3).active = true;
  rm.latencyMs = 100;
  rm.writeDelayMs = 600;
  const acks = [1, 2, 3, 4, 5].map((uid) =>
    app.setValue(undefined, { external_id: `${zoneDevice(uid)}:start` }, 1).then(
      () => 'ok',
      (err) => err.message,
    ),
  );
  await settle();
  await advance(5 * SECOND, 20);
  assert.deepEqual(await Promise.all(acks), ['ok', 'ok', 'ok', 'ok', 'ok']);
});
