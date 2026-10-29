// -----------------------------------------------------------------------------
// The stops protect: never held back, never given up before they left, kept
// in /data, resent while the zone still waters (3 times once accepted), let
// go when applied or by a newer start from Gladys. Each case below is one of
// the lessons of the lots (a stop that never left is never given up).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import {
  ALLOWED,
  CONFIG,
  CONTROLLER,
  message,
  programDevice,
  setup,
  settle,
  zoneDevice,
} from './helpers/app.js';
import { MAC, NOW, OTHER_FP, fakeRainMachine } from './helpers/fakeRainMachine.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';

const stopsOf = (rm, path = '/api/4/zone/1/stop') => rm.writes.filter((w) => w.path === path);

test('a stop clicked during a long outage is kept, never given up, and sent when the controller is back', async (t) => {
  const { rm, press, advance, store, gladys } = await setup(t, {
    config: { ...CONFIG, poll_interval: 600 },
  });
  rm.water(1);
  rm.down = 'unreachable';
  const ack = await press(zoneDevice(1), 'stop');
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore parti/);
  assert.equal(store.data.stops[0].kind, 'zone');
  assert.equal(store.data.stops[0].written, false);
  // 30 minutes down: still kept, never counted, never dropped.
  await advance(30 * MINUTE, 5 * SECOND);
  assert.equal(stopsOf(rm).length, 0);
  assert.equal(store.data.stops.length, 1);
  assert.equal(store.data.stops[0].resends, 0);
  assert.match(message(gladys).en, /Stop of zone Landscaping: kept, not sent yet/);
  rm.down = undefined;
  await advance(16 * SECOND);
  assert.equal(stopsOf(rm).length, 1);
  assert.equal(rm.zones.get(1).state, 0);
  await advance(16 * SECOND);
  assert.equal(store.data.stops.length, 0);
});

test('a stop clicked while the password is refused is kept; it leaves first once another password is saved', async (t) => {
  const { rm, press, advance, gladys, store } = await setup(t);
  rm.water(1);
  rm.password = 'changed on the controller';
  rm.tokens.clear();
  await advance(61 * SECOND);
  assert.match(message(gladys).en, /refuses the password/);
  const logins = rm.logins;
  // A stop tries one login (a click, one a minute at most), refused: kept.
  const ack = await press(zoneDevice(1), 'stop');
  assert.match(ack.error, /refuse le mot de passe/);
  assert.equal(rm.logins, logins + 1);
  assert.equal(store.data.stops.length, 1);
  // No automatic try meanwhile.
  await advance(10 * MINUTE, 5 * SECOND);
  assert.equal(rm.logins, logins + 1);
  assert.match(
    message(gladys).en,
    /Stop of zone Landscaping: kept, not sent yet: it leaves once the password is accepted/,
  );
  // The right password saved: the stop leaves first.
  await gladys.fake.configUpdated({ ...CONFIG, password: 'changed on the controller' });
  await settle(20);
  await advance(2 * SECOND, 100);
  assert.equal(stopsOf(rm).length, 1);
  assert.equal(rm.zones.get(1).state, 0);
  const firstWrite = rm.requests.findIndex((r) => r.startsWith('POST /api/4/zone/1/stop'));
  const firstRead = rm.requests.findIndex(
    (r, i) => i > rm.requests.lastIndexOf('POST /api/4/auth/login') && r === 'GET /api/4/zone',
  );
  assert.ok(
    firstWrite >= 0 && (firstWrite < firstRead || firstRead === -1),
    'the stop before the reads',
  );
});

test('a stop clicked while the password is refused leaves when "Test the connection" logs in', async (t) => {
  const { rm, press, advance, gladys } = await setup(t);
  rm.water(1);
  rm.password = 'other';
  rm.tokens.clear();
  await advance(61 * SECOND);
  await press(zoneDevice(1), 'stop');
  assert.equal(stopsOf(rm).length, 0);
  rm.password = 'S3cret pass!';
  await advance(2 * MINUTE, 5 * SECOND);
  assert.equal(stopsOf(rm).length, 0, 'no automatic login');
  await gladys.fake.action('test_connection', {});
  await settle(20);
  await advance(2 * SECOND, 100);
  assert.equal(stopsOf(rm).length, 1);
  assert.equal(rm.zones.get(1).state, 0);
});

test('a stop answered 429 or 503 is kept and sent again by the checks, a 429 pause never holds it', async (t) => {
  const { rm, press, advance, store } = await setup(t);
  rm.water(1);
  // Login is not needed (token held): the stop POST gets a 429, then each retry within 3 s.
  rm.failNext = Array(30).fill(429);
  const ack = await press(zoneDevice(1), 'stop');
  assert.equal(ack.success, false);
  assert.equal(store.data.stops.length, 1);
  rm.failNext = [];
  await advance(16 * SECOND);
  assert.equal(stopsOf(rm).length, 1);
  assert.equal(rm.zones.get(1).state, 0);
  // Reads are paused by the 429 meanwhile; a new stop still goes at once.
  rm.water(2);
  const before = rm.writes.length;
  const ack2 = await press(zoneDevice(2), 'stop');
  assert.equal(ack2.success, true, ack2.error);
  assert.equal(rm.writes.length, before + 1);
});

test('a stop not applied is resent 3 times once accepted, then held and said, never by time', async (t) => {
  const { rm, press, advance, gladys, store } = await setup(t);
  rm.water(1);
  rm.ignoreStops = true;
  const ack = await press(zoneDevice(1), 'stop');
  assert.match(ack.error, /l'arrosage continue/);
  await advance(5 * MINUTE, 5 * SECOND);
  assert.equal(stopsOf(rm).length, 4);
  assert.equal(store.data.stops[0].resends, 3);
  assert.match(message(gladys).en, /sent 4 times, still not applied/);
  await advance(60 * MINUTE, 30 * SECOND);
  assert.equal(stopsOf(rm).length, 4);
  assert.equal(store.data.stops.length, 1, 'never let go by time');
  // The zone ends watering (by the controller's own timer): let go.
  rm.zones.get(1).state = 0;
  await advance(61 * SECOND);
  assert.equal(store.data.stops.length, 0);
});

test('a stop confirmed is not resent when the app starts the zone right after', async (t) => {
  const { rm, press, advance } = await setup(t);
  rm.water(1);
  await press(zoneDevice(1), 'stop');
  assert.equal(stopsOf(rm).length, 1);
  rm.water(1);
  await advance(5 * MINUTE, 5 * SECOND);
  assert.equal(stopsOf(rm).length, 1);
});

test('a newer start from Gladys lets the stop kept go; a stop clicked during a start cuts it', async (t) => {
  const { rm, press, advance, store, send, app } = await setup(t, { config: ALLOWED });
  rm.water(1);
  rm.ignoreStops = true;
  await press(zoneDevice(1), 'stop');
  assert.equal(store.data.stops.length, 1);
  rm.ignoreStops = false;
  rm.zones.get(1).state = 0;
  // Before the check reads it: a start of the zone clicked in Gladys.
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, true, ack.error);
  assert.equal(app.stopGuards.size, 0);
  await advance(2 * MINUTE, 5 * SECOND);
  assert.equal(rm.zones.get(1).state, 1, 'never countered');
  // A start on a slow line, a stop clicked before it leaves: the start gives way.
  rm.latencyMs = 400;
  const start = send(zoneDevice(2), 'start');
  await settle();
  await advance(300, 50);
  const stop = send(zoneDevice(2), 'stop');
  await advance(5 * SECOND, 50);
  const [a, b] = await Promise.all([start, stop]);
  assert.equal(a.success, false);
  assert.match(a.error, /arrêt a été cliqué/);
  assert.equal(b.success, true, b.error);
  assert.ok(!rm.writes.some((w) => w.path === '/api/4/zone/2/start'));
});

test('a stop ends a read stuck on a silent controller and leaves within the ack', async (t) => {
  const { rm, advance, send } = await setup(t);
  rm.water(1);
  rm.failNext = ['silent'];
  await advance(61 * SECOND);
  const ack = send(zoneDevice(1), 'stop');
  await advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, true, result.error);
  assert.equal(stopsOf(rm).length, 1);
});

test('a hung /data never holds the stops: several in a row leave, the checks go on', async (t) => {
  const { rm, store, send, advance } = await setup(t);
  rm.water(1);
  rm.water(2);
  rm.ignoreStops = true;
  let release;
  store.hang = new Promise((resolve) => {
    release = resolve;
  });
  const acks = [
    send(zoneDevice(1), 'stop'),
    send(zoneDevice(2), 'stop'),
    send(CONTROLLER, 'stop_all'),
  ];
  await advance(5 * SECOND, 50);
  await Promise.all(acks);
  assert.equal(stopsOf(rm).length, 1);
  assert.equal(stopsOf(rm, '/api/4/zone/2/stop').length, 1);
  assert.equal(stopsOf(rm, '/api/4/watering/stopall').length, 1);
  await advance(MINUTE, 5 * SECOND);
  assert.ok(stopsOf(rm, '/api/4/watering/stopall').length >= 2, 'the checks resend');
  store.hang = undefined;
  release();
});

test('a stop kept in /data across a restart leaves once the configuration is read, even after getConfig failed', async (t) => {
  const clock = testClock({ start: NOW });
  const rm = fakeRainMachine({ timers: clock.timers });
  const store = memoryStore();
  const first = await setup(t, { clock, rm, store });
  rm.water(1);
  rm.down = 'unreachable';
  await first.press(zoneDevice(1), 'stop');
  await first.app.shutdown();
  assert.equal(store.data.stops.length, 1);
  rm.down = undefined;
  let calls = 0;
  const second = await setup(t, {
    clock,
    rm,
    store,
    create: false,
    getConfig: async () => {
      calls += 1;
      // The first call is the resynchronization of the fake connect().
      if (calls === 2) throw new Error('Gladys busy');
      return CONFIG;
    },
  });
  assert.equal(stopsOf(rm).length, 0, 'no password yet');
  assert.match(
    message(second.gladys).en,
    /could not be read from Gladys.*Stop of zone 1: kept, not sent yet: it leaves once Gladys gives the password/,
  );
  await second.advance(31 * SECOND, 500);
  assert.equal(stopsOf(rm).length, 1);
  assert.equal(rm.zones.get(1).state, 0);
});

test('getConfig failing at a reconnection is tried again; the stops still go meanwhile', async (t) => {
  const { gladys, rm, advance, press, app } = await setup(t);
  let fail = true;
  gladys.getConfig = async () => {
    if (fail) throw new Error('down');
    return CONFIG;
  };
  app.onConnected(() => gladys.getConfig());
  await settle(20);
  assert.match(message(gladys).en, /could not be read from Gladys/);
  rm.water(1);
  const ack = await press(zoneDevice(1), 'stop');
  assert.equal(ack.success, true, ack.error);
  fail = false;
  await advance(31 * SECOND);
  assert.doesNotMatch(message(gladys).en, /could not be read/);
});

test('a changed certificate: nothing sent, the stop kept; two clicks trust it and the stop leaves', async (t) => {
  const { gladys, rm, advance, press, store } = await setup(t);
  rm.water(1);
  rm.fingerprint = OTHER_FP;
  rm.tokens.clear();
  await advance(61 * SECOND);
  assert.match(
    message(gladys).en,
    new RegExp(`certificate of the controller changed.*${OTHER_FP}`),
  );
  const before = rm.requests.length;
  const ack = await press(zoneDevice(1), 'stop');
  assert.match(ack.error, /certificat du programmateur a changé/);
  assert.equal(rm.requests.length, before, 'not a byte to the new certificate');
  let r = await gladys.fake.action('trust_certificate', {});
  assert.match(r.data.message.en, new RegExp(OTHER_FP));
  assert.equal(store.data.pins[0].fingerprint !== OTHER_FP, true, 'nothing at the first click');
  await advance(4 * SECOND);
  r = await gladys.fake.action('trust_certificate', {});
  assert.match(r.data.message.en, /Trusted/);
  await settle(20);
  await advance(3 * SECOND, 100);
  assert.equal(stopsOf(rm).length, 1);
  assert.equal(rm.zones.get(1).state, 0);
});

test('a stop for a controller the last read showed is not at this address is refused unsent', async (t) => {
  const { app, rm } = await setup(t);
  await assert.rejects(
    app.setValue(undefined, {
      external_id: `ext:test-integration:rainmachine-zone:${'0'.repeat(11)}1-1:stop`,
    }),
    /autre programmateur/,
  );
  assert.equal(rm.writes.length, 0);
  assert.notEqual(MAC, '0'.repeat(11) + '1');
});

test('a program stop and stop all are checked on the programs too', async (t) => {
  const { rm, press, advance, store } = await setup(t);
  rm.programs.get(1).status = 1;
  rm.ignoreStops = true;
  await press(programDevice(1), 'stop');
  assert.equal(store.data.stops[0].kind, 'program');
  rm.ignoreStops = false;
  rm.programs.get(1).status = 0;
  await advance(16 * SECOND);
  assert.equal(store.data.stops.length, 0);
});
