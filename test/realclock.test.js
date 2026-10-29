// -----------------------------------------------------------------------------
// The app on the REAL clock, sped up 20 times (60 s of the interval are 3 s,
// but it is the real clock: it moves between any two reads of it), against
// the fake controller: the reads really start at the interval, never sooner,
// one exchange at a time, and a stop goes at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RainMachineApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { HOST, MAC, PASSWORD, fakeRainMachine } from './helpers/fakeRainMachine.js';
import { measurePeriod, realClock, spyOn } from './kit/index.mjs';

const SPEED = 20;
const INTERVAL = 60_000;

test('real clock x20: a read every interval, one exchange at a time, a stop at once', async () => {
  const clock = realClock({ speed: SPEED });
  const rm = fakeRainMachine({ timers: clock.timers, latencyMs: 40 });
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new RainMachineApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    exchange: rm.exchange,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  try {
    await app.connected({ host: HOST, password: PASSWORD, poll_interval: INTERVAL / 1000 });
    const gaps = await measurePeriod(spy, { count: 3, period: INTERVAL });
    assert.equal(gaps.length, 2);
    assert.equal(rm.peak, 1, `${rm.peak} exchanges at once`);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    rm.water(1);
    const started = clock.monotonic();
    await app.setValue(undefined, {
      external_id: `ext:test-integration:rainmachine-zone:${MAC}-1:stop`,
    });
    assert.equal(rm.zones.get(1).state, 0);
    assert.ok(clock.monotonic() - started < 4_300, 'within the ack budget');
  } finally {
    spy.restore();
    await app.shutdown();
    clock.close();
  }
  assert.ok(clock.timersSet < 400, `${clock.timersSet} timers`);
});
