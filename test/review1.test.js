// -----------------------------------------------------------------------------
// Review r1: /data hung under a read (B1), "Stop all" never let go by a start
// (B2), a burst of stops written at once (I1), the guards without a test (I2),
// the TLS fallback of a first generation (m2), the statuses (m3, m4) and a
// start of a zone already queued (m6).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { ALLOWED, CONFIG, CONTROLLER, message, setup, settle, zoneDevice } from './helpers/app.js';
import { certs } from './kit/index.mjs';
import { MINUTE, SECOND } from '../src/constants.js';
import { CounterGuard } from '../src/guard.js';
import { ERROR_KINDS, exchange } from '../src/rainmachine/http.js';

const stopsOf = (rm, path = '/api/4/zone/1/stop') => rm.writes.filter((w) => w.path === path);

test('B1: /data hung under a read; a stop kept for a refused password leaves once the new one is saved', async (t) => {
  const { rm, store, advance, press, gladys, app } = await setup(t);
  let release;
  store.hang = new Promise((resolve) => {
    release = resolve;
  });
  rm.flow.clicks += 20;
  await advance(70 * SECOND);
  rm.password = 'NewPass-1';
  rm.tokens.clear();
  rm.water(1);
  const ack = await press(zoneDevice(1), 'stop');
  assert.match(ack.error, /refuse le mot de passe/);
  await advance(20 * SECOND);
  let applied = false;
  app.configUpdated({ ...CONFIG, password: 'NewPass-1' }).then(() => (applied = true));
  await advance(5 * SECOND, 100);
  assert.equal(stopsOf(rm).length, 1, 'the kept stop left');
  assert.equal(rm.zones.get(1).state, 0);
  await advance(10 * SECOND, 100);
  assert.equal(applied, true, 'the configuration applied, not stuck behind the disk');
  assert.ok(gladys.fake.connectionStatus);
  store.hang = undefined;
  release();
});

test('B2: "Stop all" never sent is not let go by the start of another zone; it leaves first', async (t) => {
  const { rm, press, advance, app, store } = await setup(t, { config: ALLOWED });
  rm.programs.get(1).status = 1;
  rm.water(2);
  rm.down = 'unreachable';
  await press(CONTROLLER, 'stop_all');
  assert.equal(store.data.stops[0].kind, 'all');
  rm.down = undefined;
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, false);
  assert.match(ack.error, /est gardé/);
  assert.ok(!rm.writes.some((w) => w.path === '/api/4/zone/1/start'));
  await advance(20 * SECOND);
  assert.equal(stopsOf(rm, '/api/4/watering/stopall').length, 1);
  assert.equal(rm.programs.get(1).status, 0);
  assert.equal(app.stopGuards.size, 0);
  // Applied and let go: a start goes again.
  const again = await press(zoneDevice(1), 'start');
  assert.equal(again.success, true, again.error);
});

test('B2: a start of zone 1 never lets go the stop of zone 2, nor a stop of its own zone never sent', async (t) => {
  const { rm, press, advance, app } = await setup(t, { config: ALLOWED });
  rm.water(2);
  rm.ignoreStops = true;
  await press(zoneDevice(2), 'stop');
  assert.ok(app.stopGuards.has('zone:2'));
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, true, ack.error);
  assert.ok(app.stopGuards.has('zone:2'), 'the stop of zone 2 kept');
  rm.water(3);
  rm.zones.get(3).active = true;
  rm.down = 'unreachable';
  await press(zoneDevice(1), 'stop');
  rm.down = undefined;
  await assert.rejects(
    app.setValue(undefined, { external_id: `${zoneDevice(1)}:start` }, 1),
    /pas encore parti/,
  );
  await advance(MINUTE, 5 * SECOND);
  assert.ok(stopsOf(rm).length >= 1, 'the kept stop of zone 1 left');
});

test('I1: five stops clicked at once on a slow controller (500 ms) are all written first, one read back', async (t) => {
  const { rm, send, advance, clock } = await setup(t);
  for (const uid of [1, 2, 3]) rm.water(uid);
  rm.zones.get(3).active = true;
  rm.programs.get(1).status = 1;
  rm.latencyMs = 500;
  const at = clock.monotonic();
  const acks = [
    send(zoneDevice(1), 'stop'),
    send(zoneDevice(2), 'stop'),
    send(CONTROLLER, 'stop_all'),
    send('ext:test-integration:rainmachine-program:abcdef123456-1', 'stop'),
  ];
  await settle();
  await advance(5 * SECOND, 50);
  const results = await Promise.all(acks);
  for (const r of results) assert.equal(r.success, true, r.error);
  const times = rm.writes.map((w) => Math.round(w.at - at));
  assert.equal(times.length, 4);
  assert.ok(Math.max(...times) <= 2_100, times.join(', '));
  const firstRead = rm.requests.lastIndexOf('POST /api/4/program/1/stop');
  assert.ok(firstRead >= 0);
});

test('I2: a resend answered 503 or cut is not a try: 3 accepted resends still follow', async (t) => {
  const { rm, press, advance, store } = await setup(t);
  rm.water(1);
  rm.ignoreStops = true;
  await press(zoneDevice(1), 'stop');
  rm.failFor.set('POST /api/4/zone/1/stop', [503, 'cut']);
  await advance(10 * MINUTE, 5 * SECOND);
  const posted = rm.requests.filter((r) => r === 'POST /api/4/zone/1/stop').length;
  assert.equal(stopsOf(rm).length, 4, '1 + 3 accepted');
  assert.equal(posted, 6, '+ the 503 and the cut, not counted');
  assert.equal(store.data.stops[0].resends, 3);
});

test('I2: a drop accepted is the floor: a value under it is held again', () => {
  const H = 3_600_000;
  const guard = new CounterGuard({ value: 1000, at: 0 }, undefined, 0);
  assert.equal(guard.accept(100, H), false);
  guard.acceptHeld();
  // Right after the acceptance of 100 L: 90 L is under it, never taken.
  assert.equal(guard.accept(90, H), false, 'under the value accepted');
  assert.equal(guard.held.to, 90);
});

test('I2: the option turned off during the handshake of the write: nothing written', async (t) => {
  const { rm, press, app } = await setup(t, { config: ALLOWED });
  rm.duringHandshake = async (method, path) => {
    if (method === 'POST' && path === '/api/4/zone/1/start') {
      await app.configUpdated(CONFIG);
    }
  };
  const ack = await press(zoneDevice(1), 'start');
  assert.match(ack.error, /Autoriser l'arrosage/);
  assert.equal(rm.writes.length, 0);
});

test('m2: a TLS 1.0 only controller: refused in modern TLS, taken by the legacy fallback before a pin', async (t) => {
  const legacy = https.createServer(
    {
      key: certs.device.key,
      cert: certs.device.cert,
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1',
      ciphers: 'AES128-SHA:@SECLEVEL=0',
    },
    (req, res) => res.end('{"statusCode":0}'),
  );
  await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => legacy.close(resolve)));
  const port = legacy.address().port;
  const base = { host: '127.0.0.1', port, timeoutMs: 3000, method: 'GET', path: '/api/4/zone' };
  await assert.rejects(
    exchange({ ...base, tls: 'modern', trust: async () => {} }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && err.handshake === true,
  );
  let seen;
  const res = await exchange({
    ...base,
    tls: 'auto',
    trust: async (_fp, info) => {
      seen = info;
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { legacy: true });
});

test('m2: the pin keeps the handshake: a controller pinned modern is never spoken to in legacy TLS', async (t) => {
  const { app, store } = await setup(t);
  assert.equal(store.data.pins[0].legacy, false);
  assert.equal(app.tlsFor({ host: '192.168.1.60', port: 8080 }), 'modern');
  assert.equal(app.tlsFor({ host: '10.0.0.9', port: 8080 }), 'auto');
});

test('m3: before the configuration, the status never says "enter the address"', async (t) => {
  const { gladys } = await setup(t, {
    connect: false,
    store: (await import('../src/store.js')).memoryStore({
      stops: [{ kind: 'zone', uid: 1, host: '192.168.1.60', port: 8080, written: false }],
    }),
  });
  await settle(10);
  const shown = gladys.fake.connectionStatus?.message?.en ?? '';
  assert.doesNotMatch(shown, /Enter the address/);
});

test('m4: a stop kept for another address says what it waits for', async (t) => {
  const { gladys, rm, press, app } = await setup(t);
  rm.water(1);
  rm.down = 'unreachable';
  await press(zoneDevice(1), 'stop');
  await app.configUpdated({ ...CONFIG, host: '192.168.1.61' });
  await settle(10);
  assert.match(message(gladys).en, /clicked for another address/);
});

test('m6: a zone already queued is confirmed only by a remaining time equal to the length written', async (t) => {
  const { rm, press } = await setup(t, { config: { ...ALLOWED, watering_minutes: 5 } });
  rm.zones.get(1).state = 2;
  rm.zones.get(1).remaining = 120;
  rm.startDelayMs = 60 * SECOND;
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore appliqué/);
});
