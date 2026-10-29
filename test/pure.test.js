// -----------------------------------------------------------------------------
// The pure parts: the configuration, the answers of the controller, /data
// repaired, the water counter guard.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { CounterGuard } from '../src/guard.js';
import {
  macOf,
  parseFlow,
  parsePrograms,
  parseRestrictions,
  parseWifi,
  parseZones,
} from '../src/rainmachine/parse.js';
import { fileStore, normalizeMemory } from '../src/store.js';

const FP = Array.from({ length: 32 }, () => 'AB').join(':');

test('the address: IPv4 or a host name, port 8080 by default, nothing else', () => {
  assert.deepEqual(parseAddress('192.168.1.60'), { host: '192.168.1.60', port: 8080 });
  assert.deepEqual(parseAddress(' https://RainMachine.local:18080/ui '), {
    host: 'rainmachine.local',
    port: 18080,
  });
  for (const bad of [
    '',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '1.2.3',
    'a b',
    'x\r\ny',
    'h:0',
    'h:70000',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const http = normalizeConfig({ host: 'http://192.168.1.60', password: 'x' });
  assert.equal(http.address, undefined);
  assert.equal(http.plainHttp, true);
  const creds = normalizeConfig({ host: 'admin:pw@192.168.1.60' });
  assert.equal(creds.credentialsInHost, true);
  assert.equal(creds.invalidHost, undefined, 'never shown');
});

test('the configuration: watering off unless strictly true, its length bounded 1..60', () => {
  assert.equal(normalizeConfig({}).allowWatering, false);
  assert.equal(normalizeConfig({ allow_watering: 1 }).allowWatering, false);
  assert.equal(normalizeConfig({ allow_watering: 'true' }).allowWatering, true);
  assert.equal(normalizeConfig({ watering_minutes: 500 }).wateringMinutes, 60);
  assert.equal(normalizeConfig({ watering_minutes: 0 }).wateringMinutes, 1);
  assert.equal(normalizeConfig({ watering_minutes: '' }).wateringMinutes, 10);
  assert.equal(normalizeConfig({ watering_minutes: 'x' }).wateringMinutes, 10);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 15);
  assert.equal(normalizeConfig({ password: ' sp ace ' }).password, ' sp ace ');
  const bad = normalizeConfig({ password: 'a\nb' });
  assert.equal(bad.password, undefined);
  assert.equal(bad.badPassword, true);
  assert.equal(normalizeConfig({ password: 'é'.repeat(70) }).badPassword, true, '140 bytes');
});

test('the answers: strict numbers and states, bounded lists, the MAC as identity', () => {
  assert.equal(macOf('AB:CD:EF:12:34:56'), 'abcdef123456');
  assert.equal(macOf('ab-cd-ef-12-34-56'), 'abcdef123456');
  assert.equal(macOf('abcdef123456'), 'abcdef123456');
  assert.equal(macOf('ab:cd-ef:12:34:56'), undefined);
  assert.equal(macOf('00:00:00:00:00:00'), undefined);
  assert.equal(macOf('ff:ff:ff:ff:ff:ff'), undefined);
  assert.throws(() => parseWifi({ macAddress: '' }), /No MAC/);
  const zones = parseZones({
    zones: [
      { uid: 1, state: 1, remaining: 30.5, name: 'A\u0000B' },
      { uid: 1, state: 0 },
      { uid: '2', state: 1 },
      { uid: 3, state: 7, active: 'yes' },
      null,
    ],
  });
  assert.deepEqual([...zones.keys()], [1, 3]);
  assert.equal(zones.get(1).remaining, undefined, 'a decimal is unknown');
  assert.equal(zones.get(1).name, 'A B');
  assert.equal(zones.get(3).state, undefined);
  assert.equal(zones.get(3).active, undefined);
  assert.throws(() => parseZones({ zones: Array(65).fill({}) }), /Too many/);
  assert.throws(() => parseZones({}), /No zones/);
  assert.equal(parsePrograms({ programs: [{ uid: 2, status: 2 }] }).get(2).status, 2);
  assert.deepEqual(parseRestrictions({ freeze: true, weekDay: 0 }), {
    rainDelay: undefined,
    freeze: true,
    rainSensor: undefined,
    hourly: undefined,
    month: undefined,
    weekday: undefined,
  });
  // Prototype keys are only ever read, never copied.
  assert.equal(parseRestrictions(JSON.parse('{"__proto__": {"freeze": true}}')).freeze, undefined);
});

test('the flow sensor: litres from clicks per cubic metre; unknown unless used and both known', () => {
  const flow = (system) => parseFlow({ system }).liters;
  assert.equal(
    flow({
      useFlowSensor: true,
      flowSensorWateringClicks: 4000,
      flowSensorClicksPerCubicMeter: 1000,
    }),
    4000,
  );
  assert.equal(
    flow({ useFlowSensor: true, flowSensorWateringClicks: 1, flowSensorClicksPerCubicMeter: 3 }),
    333.3,
  );
  assert.equal(
    flow({
      useFlowSensor: false,
      flowSensorWateringClicks: 4000,
      flowSensorClicksPerCubicMeter: 1000,
    }),
    undefined,
  );
  assert.equal(
    flow({ useFlowSensor: true, flowSensorWateringClicks: 4000, flowSensorClicksPerCubicMeter: 0 }),
    undefined,
  );
  assert.equal(
    flow({
      useFlowSensor: true,
      flowSensorWateringClicks: null,
      flowSensorClicksPerCubicMeter: 1000,
    }),
    undefined,
  );
  assert.equal(
    flow({
      useFlowSensor: true,
      flowSensorWateringClicks: '4000',
      flowSensorClicksPerCubicMeter: 1000,
    }),
    undefined,
  );
});

test('/data repaired: stops bounded, never a resend count for a stop never written, pins checked', () => {
  const now = 1_000_000;
  const memory = normalizeMemory(
    {
      target: { host: '192.168.1.60', port: 8080, mac: 'ABCDEF123456' },
      pins: [
        { host: '192.168.1.60', port: 8080, fingerprint: FP },
        { host: 'x', port: 1, fingerprint: 'nope' },
      ],
      stops: [
        {
          kind: 'zone',
          uid: 1,
          host: '192.168.1.60',
          port: 8080,
          written: false,
          resends: 3,
          since: now + 5,
        },
        { kind: 'zone', uid: 1, host: '192.168.1.60', port: 8080 },
        { kind: 'all', host: '192.168.1.60', port: 8080, written: true, resends: 'x' },
        { kind: 'zone', host: '192.168.1.60', port: 8080 },
        { kind: 'valve', uid: 1, host: '192.168.1.60', port: 8080 },
      ],
      lastAttemptAt: now + 999,
      block: { failures: 2 },
      pause: { until: now + 1e12, reason: '5xx' },
    },
    now,
  );
  assert.equal(memory.target.mac, null, 'a MAC in another form is not kept');
  assert.equal(memory.pins.length, 1);
  assert.deepEqual(
    memory.stops.map((s) => [s.key, s.written, s.resends, s.since]),
    [
      ['zone:1', false, 0, now],
      ['all', true, 0, now],
    ],
  );
  assert.equal(memory.lastAttemptAt, now);
  assert.deepEqual(memory.block, { failures: 2 });
  assert.equal(memory.pause.until, now + 6 * 3_600_000);
  assert.deepEqual(normalizeMemory('garbage', now).stops, []);
});

test('/data unreadable is not empty; the file is written 0600', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rainmachine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { data: null });
  await store.save({ a: 1 });
  assert.deepEqual(await store.load(), { data: { a: 1 } });
  await writeFile(path, '{broken');
  assert.deepEqual(await store.load(), { unreadable: true });
  await chmod(path, 0o000);
  if (process.getuid?.() !== 0) {
    assert.deepEqual(await store.load(), { unreadable: true });
  }
});

test('the counter guard: never 0, a drop and a jump held, a plausible rise taken', () => {
  const H = 3_600_000;
  const guard = new CounterGuard({ value: 1000, at: 0 }, undefined, 0);
  assert.equal(guard.accept(0, H), false);
  assert.equal(guard.accept(1500, H), true);
  assert.equal(guard.accept(100, 2 * H), false);
  assert.equal(guard.held.direction, 'down');
  assert.equal(guard.accept(100, 3 * H), false, 'never by repetition');
  assert.equal(guard.accept(1500 + 6000 * 10, 3 * H), false, 'a jump past 6000 L/h held');
  const taken = guard.acceptHeld();
  assert.equal(taken.direction, 'up');
  assert.equal(guard.accept(1500 + 6000 * 10, 3 * H), true);
});
