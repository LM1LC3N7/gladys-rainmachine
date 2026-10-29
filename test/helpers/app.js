// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys (the real wiring of src/handlers.js),
// the fake controller of fakeRainMachine.js and the virtual clock of the
// testkit: every read of the clock moves it (1 µs), and nothing fires unless
// the test moves it on.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { settle, testClock } from '../kit/index.mjs';
import { RainMachineApp } from '../../src/app.js';
import { SECOND } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { HOST, MAC, NOW, PASSWORD, fakeRainMachine } from './fakeRainMachine.js';

export { settle };
export const CONFIG = { host: HOST, password: PASSWORD };
export const ALLOWED = { ...CONFIG, allow_watering: true };
export const SEL = 'test-integration';
export const CONTROLLER = `ext:${SEL}:rainmachine:${MAC}`;
export const zoneDevice = (uid) => `ext:${SEL}:rainmachine-zone:${MAC}-${uid}`;
export const programDevice = (uid) => `ext:${SEL}:rainmachine-program:${MAC}-${uid}`;
export const READ = [
  'POST /api/4/auth/login',
  'GET /api/4/provision/wifi',
  'GET /api/4/zone',
  'GET /api/4/program',
  'GET /api/4/restrictions/currently',
  'GET /api/4/provision',
  'GET /api/4/provision/name',
  'GET /api/4/apiVer',
];
export const READ_AGAIN = READ.slice(1, 6);

export const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

/**
 * `clock`, `rm` and `store` may be shared between two lives (a restart).
 * `create`: every device discovered is created in Gladys after the first read.
 */
export async function setup(
  t,
  {
    config = CONFIG,
    clock = testClock({ start: NOW }),
    rm,
    store = memoryStore(),
    create = true,
    logs = [],
    devices,
    getConfig,
    connect = true,
    boot = true,
  } = {},
) {
  const dev = rm ?? fakeRainMachine({ timers: clock.timers });
  dev.now = clock.monotonic;
  const gladys = createFakeGladys({ config, ...(devices ? { devices } : {}) });
  if (getConfig) {
    gladys.getConfig = getConfig;
  }
  const app = new RainMachineApp({
    gladys,
    logger: recorder(logs),
    exchange: dev.exchange,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app);
  t.after(() => app.shutdown());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await clock.advance(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (boot) {
    await app.boot();
  }
  if (connect) {
    await gladys.connect();
    await settle(20);
  }
  if (create && !devices) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
    await settle();
  }
  const target = (deviceId, key) => {
    const device = gladys.fake.devices.find((d) => d.external_id === deviceId);
    return [device, device.features.find((f) => f.external_id === `${deviceId}:${key}`)];
  };
  const send = (deviceId, key, value = 1) => gladys.fake.setValue(...target(deviceId, key), value);
  /** A command, the clock moved on until it answers (5 s at most, as Gladys waits). */
  const press = async (deviceId, key, value = 1, wait = 5 * SECOND) => {
    const ack = send(deviceId, key, value);
    ack.catch(() => {});
    await settle();
    await advance(wait, 50);
    return ack;
  };
  return { gladys, app, rm: dev, store, clock, advance, logs, press, send };
}

export const last = (gladys, featureId) => gladys.fake.lastState(featureId);
export const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
