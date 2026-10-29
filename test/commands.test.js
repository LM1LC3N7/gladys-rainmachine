// -----------------------------------------------------------------------------
// The start of a zone: a scene on several zones of a slow controller, the
// read back equal to the state before, the option checked right before the
// byte, and the certificate pin that must be in /data before the password
// leaves.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, CONFIG, message, setup, settle, zoneDevice } from './helpers/app.js';
import { SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';

test('a scene starting 5 zones of a slow controller (400 ms an exchange): all 5 written and confirmed', async (t) => {
  const { rm, app, advance } = await setup(t, { config: ALLOWED });
  for (const uid of [4, 5, 6]) {
    rm.zones.set(uid, { ...rm.zones.get(1), uid, name: `Z${uid}` });
  }
  rm.zones.get(3).active = true;
  rm.latencyMs = 400;
  const acks = [1, 2, 3, 4, 5].map((uid) =>
    app.setValue(undefined, { external_id: `${zoneDevice(uid)}:start` }, 1).then(
      () => 'ok',
      (err) => err.message,
    ),
  );
  await settle();
  await advance(5 * SECOND, 50);
  assert.deepEqual(await Promise.all(acks), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(
    rm.writes.map((w) => w.path),
    [1, 2, 3, 4, 5].map((uid) => `/api/4/zone/${uid}/start`),
  );
});

test('a read back equal to the state before: "not applied yet", then the follow-up reads', async (t) => {
  const { rm, press } = await setup(t, { config: ALLOWED });
  rm.applyDelayMs = 30 * SECOND;
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore appliqué/);
  assert.equal(rm.writes.length, 1);
});

test('the option turned off between the click and the byte: nothing written', async (t) => {
  const { rm, send, advance, app } = await setup(t, { config: ALLOWED });
  rm.latencyMs = 400;
  const ack = send(zoneDevice(1), 'start');
  await settle();
  await advance(500, 50);
  await app.configUpdated(CONFIG);
  await advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /Autoriser l'arrosage/);
  assert.equal(rm.writes.length, 0);
});

test('a start is refused while a stop is on its way, and during a 429 pause', async (t) => {
  const { rm, send, advance, press } = await setup(t, { config: ALLOWED });
  rm.water(2);
  rm.latencyMs = 300;
  const stop = send(zoneDevice(2), 'stop');
  await settle();
  const start = send(zoneDevice(1), 'start');
  await advance(5 * SECOND, 50);
  const [s1, s2] = await Promise.all([stop, start]);
  assert.equal(s1.success, true, s1.error);
  assert.equal(s2.success, false);
  assert.ok(!rm.writes.some((w) => w.path === '/api/4/zone/1/start'));
  rm.latencyMs = 0;
  rm.failNext = [429];
  await advance(61 * SECOND);
  const ack = await press(zoneDevice(1), 'start');
  assert.match(ack.error, /ralentir \(429\)/);
});

test('the first pin cannot be saved: nothing sent, not even the login', async (t) => {
  const store = memoryStore(null, { failSave: true });
  const { rm, gladys } = await setup(t, { store, create: false });
  assert.deepEqual(rm.requests, []);
  assert.match(message(gladys).en, /could not be kept in \/data: nothing sent/);
});

test('/data unreadable: the pin is unknown, nothing sent, the file never overwritten', async (t) => {
  const store = memoryStore({ pins: [] }, { unreadable: true });
  const { rm, gladys } = await setup(t, { store, create: false });
  assert.deepEqual(rm.requests, []);
  assert.equal(store.saves, 0);
  assert.match(message(gladys).en, /\/data cannot be read/);
});

test('a scene on a very slow controller (900 ms): no start leaves after 3.5 s, the late ones are "nothing sent"', async (t) => {
  const { rm, app, advance, clock } = await setup(t, { config: ALLOWED });
  rm.zones.get(3).active = true;
  rm.latencyMs = 900;
  const at = clock.monotonic();
  const acks = [1, 2, 3].map((uid) =>
    app.setValue(undefined, { external_id: `${zoneDevice(uid)}:start` }, 1).then(
      () => 'ok',
      (err) => err.message,
    ),
  );
  await settle();
  await advance(5 * SECOND, 50);
  const results = await Promise.all(acks);
  for (const w of rm.writes) assert.ok(w.at - at <= 3500, `written at ${w.at - at} ms`);
  const written = rm.writes.length;
  assert.equal(results.filter((r) => /rien envoyé/.test(r)).length, 3 - written);
});
