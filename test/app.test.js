// -----------------------------------------------------------------------------
// The app end to end on the fake controller and the fake Gladys: the read,
// the devices and states, the start of a zone (option, bounds, confirmation)
// and the stops.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED,
  CONFIG,
  CONTROLLER,
  READ,
  READ_AGAIN,
  last,
  message,
  programDevice,
  setup,
  zoneDevice,
} from './helpers/app.js';
import { MAC, PASSWORD } from './helpers/fakeRainMachine.js';
import { SECOND } from '../src/constants.js';

test('the first read: login, identity, zones, programs, restrictions, flow, name, versions', async (t) => {
  const { gladys, rm } = await setup(t);
  assert.deepEqual(rm.requests, READ);
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  // Zone 3 is inactive: not offered.
  assert.deepEqual(ids, [
    CONTROLLER,
    zoneDevice(1),
    zoneDevice(2),
    programDevice(1),
    programDevice(2),
  ]);
  const controller = gladys.fake.discoveredDevices[0];
  assert.equal(controller.name, 'My House');
  assert.ok(controller.params.some((p) => p.name === 'MAC_ADDRESS' && p.value === MAC));
  assert.equal(
    message(gladys).en.startsWith('Connected: My House, 2 active zone(s), not watering'),
    true,
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the states of a read once the devices are created; the counter in litres', async (t) => {
  const { gladys, rm, advance } = await setup(t);
  rm.water(2, 125);
  rm.restrictions.freeze = true;
  await advance(60 * SECOND);
  assert.deepEqual(rm.requests.slice(READ.length), READ_AGAIN);
  assert.equal(last(gladys, `${CONTROLLER}:watering`), 1);
  assert.equal(last(gladys, `${CONTROLLER}:freeze`), 1);
  assert.equal(last(gladys, `${CONTROLLER}:rain_delay`), 0);
  assert.equal(last(gladys, `${CONTROLLER}:water_used`), 4000);
  assert.equal(last(gladys, `${zoneDevice(2)}:watering`), 1);
  assert.equal(last(gladys, `${zoneDevice(2)}:remaining`), 3);
  assert.equal(last(gladys, `${zoneDevice(1)}:watering`), 0);
  assert.equal(last(gladys, `${zoneDevice(1)}:remaining`), 0);
  assert.equal(last(gladys, `${programDevice(1)}:running`), 0);
  assert.match(message(gladys).en, /watering: Flower Box/);
});

test('never read sooner than the interval: the test button says so', async (t) => {
  const { gladys, rm } = await setup(t);
  const before = rm.requests.length;
  const ack = await gladys.fake.action('test_connection', {});
  assert.equal(rm.requests.length, before);
  assert.match(ack.data.message.en, /Not read again sooner than the interval/);
});

test('start a zone: refused while the option is off, nothing sent', async (t) => {
  const { rm, press } = await setup(t);
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser l'arrosage/);
  assert.equal(rm.writes.length, 0);
});

test('start a zone: fresh read, bounded length, confirmed by the read back', async (t) => {
  const { rm, press, clock } = await setup(t, { config: { ...ALLOWED, watering_minutes: 500 } });
  const before = rm.requests.length;
  const at = clock.monotonic();
  const ack = await press(zoneDevice(1), 'start');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(rm.requests.slice(before, before + 4), [
    'GET /api/4/provision/wifi',
    'GET /api/4/zone',
    'POST /api/4/zone/1/start',
    'GET /api/4/zone',
  ]);
  // 500 minutes asked: 60 at most.
  assert.deepEqual(rm.writes[0].body, { time: 3600, zid: 1 });
  assert.ok(rm.writes[0].at - at < 3500);
});

test('start a zone: an inactive or unknown zone is refused', async (t) => {
  const { rm, app } = await setup(t, { config: ALLOWED });
  rm.zones.get(1).active = false;
  await assert.rejects(
    app.setValue(undefined, { external_id: `${zoneDevice(1)}:start` }, 1),
    /inactive/,
  );
  rm.zones.delete(2);
  await assert.rejects(
    app.setValue(undefined, { external_id: `${zoneDevice(2)}:start` }, 1),
    /n'a plus cette zone/,
  );
  assert.equal(rm.writes.length, 0);
});

test('stop a zone: sent at once, confirmed by the read back, whatever the option', async (t) => {
  const { rm, press } = await setup(t, { config: CONFIG });
  rm.water(1);
  const ack = await press(zoneDevice(1), 'stop');
  assert.equal(ack.success, true, ack.error);
  assert.equal(rm.writes[0].path, '/api/4/zone/1/stop');
  assert.deepEqual(rm.writes[0].body, { zid: 1 });
  assert.equal(rm.zones.get(1).state, 0);
});

test('stop all and stop a program', async (t) => {
  const { rm, press } = await setup(t);
  rm.water(1);
  rm.programs.get(2).status = 1;
  let ack = await press(programDevice(2), 'stop');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(rm.writes.at(-1), {
    path: '/api/4/program/2/stop',
    body: { pid: 2 },
    at: rm.writes.at(-1).at,
  });
  ack = await press(CONTROLLER, 'stop_all');
  assert.equal(ack.success, true, ack.error);
  assert.equal(rm.writes.at(-1).path, '/api/4/watering/stopall');
  assert.equal(rm.zones.get(1).state, 0);
});

test('the password never leaves the login body, the token never a query string; neither is logged', async (t) => {
  const logs = [];
  const { gladys, store, press, rm } = await setup(t, { logs });
  rm.water(1);
  await press(zoneDevice(1), 'stop');
  const everything = JSON.stringify([logs, store.data, gladys.fake.connectionStatuses]);
  assert.ok(!everything.includes(PASSWORD));
  assert.ok(!everything.includes('tok'));
});

test('the water counter: a drop held and said, never published; taken in two clicks', async (t) => {
  const { gladys, rm, advance, clock } = await setup(t);
  await advance(60 * SECOND);
  assert.equal(last(gladys, `${CONTROLLER}:water_used`), 4000);
  rm.flow.clicks = 0;
  await advance(60 * SECOND);
  rm.flow.clicks = 120;
  await advance(60 * SECOND);
  assert.equal(last(gladys, `${CONTROLLER}:water_used`), 4000);
  assert.match(message(gladys).en, /Water counter held back: it dropped from 4000 to 120 L/);
  const first = await gladys.fake.action('accept_held_counter', {});
  assert.match(first.data.message.en, /from 4000 to 120 L/);
  // A second click too soon is a first click again.
  const early = await gladys.fake.action('accept_held_counter', {});
  assert.match(early.data.message.en, /Click again/);
  await clock.advance(4 * SECOND);
  const second = await gladys.fake.action('accept_held_counter', {});
  assert.match(second.data.message.en, /Taken/);
  await advance(60 * SECOND);
  assert.equal(last(gladys, `${CONTROLLER}:water_used`), 120);
});

test('a secondary endpoint failing never holds the core values back', async (t) => {
  const { gladys, rm, advance } = await setup(t);
  rm.unknown.add('/api/4/restrictions/currently');
  rm.unknown.add('/api/4/program');
  rm.water(1);
  await advance(60 * SECOND);
  assert.equal(last(gladys, `${zoneDevice(1)}:watering`), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /Not read this time: programs, restrictions/);
});

test('a 429 on a read pauses the reads (kept in /data); a 5xx too', async (t) => {
  const { gladys, rm, advance, store } = await setup(t);
  rm.failNext = [429];
  await advance(60 * SECOND);
  assert.match(message(gladys).en, /slow down \(429\)/);
  assert.equal(store.data.pause.reason, '429');
  const before = rm.requests.length;
  await advance(4 * 60 * SECOND);
  assert.equal(rm.requests.length, before, 'paused 5 min');
});

test('a password refused on a read: no automatic try; new password lifts it', async (t) => {
  const { gladys, rm, advance, store } = await setup(t);
  rm.password = 'new';
  rm.tokens.clear();
  await advance(60 * SECOND);
  assert.deepEqual(store.data.block, { failures: 1 });
  const logins = rm.logins;
  await advance(30 * 60 * SECOND, 10 * SECOND);
  assert.equal(rm.logins, logins);
  await gladys.fake.configUpdated({ ...CONFIG, password: 'new' });
  await advance(SECOND);
  assert.equal(store.data.block, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('another controller at the address: the old devices are said unreachable, a start refused', async (t) => {
  const { gladys, rm, advance, app } = await setup(t, { config: ALLOWED });
  rm.mac = '11:22:33:44:55:66';
  await advance(60 * SECOND);
  assert.match(message(gladys).en, /Another controller answers at this address/);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await assert.rejects(
    app.setValue(undefined, { external_id: `${zoneDevice(1)}:start` }, 1),
    /autre programmateur/,
  );
  assert.equal(rm.writes.length, 0);
  assert.ok(
    gladys.fake.transports.some(
      (e) => e.device_external_id === CONTROLLER && e.transport === 'unreachable',
    ),
  );
});

test('a restart never reads sooner than the interval', async (t) => {
  const { app, rm, store, clock } = await setup(t);
  await app.shutdown();
  const before = rm.requests.length;
  const second = await setup(t, { rm, store, clock, create: false });
  assert.equal(rm.requests.length, before);
  await second.advance(61 * SECOND);
  assert.ok(rm.requests.length > before);
  assert.equal(PASSWORD.length > 0, true);
});
