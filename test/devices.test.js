// -----------------------------------------------------------------------------
// The Gladys devices (pure): ids parsed back strictly, categories, types and
// units of the core (its own constants when the clone is there), no switch,
// the core rules on every `supported_options` published (its own
// normalizeSupportedOptions when the clone is there, else the same rules),
// the states of a read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { FEATURES } from '../src/constants.js';
import { buildDevices, deviceStates, parseFeatureId } from '../src/devices.js';
import { parsePrograms, parseZones } from '../src/rainmachine/parse.js';

const CORE = '/home/claude/code/Gladys/server/utils';
const require = createRequire(import.meta.url);
const core = existsSync(`${CORE}/constants.js`) ? require(`${CORE}/constants.js`) : undefined;
let normalizeSupportedOptions;
try {
  normalizeSupportedOptions = require(
    `${CORE}/normalizeSupportedOptions.js`,
  ).normalizeSupportedOptions;
} catch {
  normalizeSupportedOptions = undefined;
}

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:test:${type}:${id}`,
    feature: (key) => `ext:test:${type}:${id}:${key}`,
  }),
};
const MAC = 'abcdef123456';
const controller = {
  mac: MAC,
  name: 'My House',
  hardware: 3,
  software: '4.0.925',
  zones: parseZones({
    zones: [
      { uid: 1, name: 'Lawn', state: 1, remaining: 61, active: true },
      { uid: 2, name: 'Box', state: 0, remaining: 0, active: true },
      { uid: 3, name: 'Off', state: 0, active: false },
      { uid: 4, name: 'Q', state: 2, remaining: 300 },
    ],
  }),
  programs: parsePrograms({ programs: [{ uid: 7, name: 'Morning', status: 1, active: true }] }),
  restrictions: { freeze: true, rainDelay: false },
};
const devices = buildDevices(gladys, controller, { language: 'en', host: '192.168.1.60' });

test('ids: the MAC, the uid, the key; parsed back strictly', () => {
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [
      `ext:test:rainmachine:${MAC}`,
      `ext:test:rainmachine-zone:${MAC}-1`,
      `ext:test:rainmachine-zone:${MAC}-2`,
      `ext:test:rainmachine-zone:${MAC}-4`,
      `ext:test:rainmachine-program:${MAC}-7`,
    ],
  );
  assert.deepEqual(parseFeatureId(gladys, `ext:test:rainmachine-zone:${MAC}-1:stop`), {
    kind: 'zone',
    mac: MAC,
    uid: 1,
    key: 'stop',
  });
  assert.deepEqual(parseFeatureId(gladys, `ext:test:rainmachine:${MAC}:stop_all`), {
    kind: 'controller',
    mac: MAC,
    uid: null,
    key: 'stop_all',
  });
  for (const bad of [
    `ext:test:rainmachine-zone:${MAC}-1:stop_all`,
    `ext:test:rainmachine:${MAC}-1:stop_all`,
    `ext:test:rainmachine-zone:${MAC}:stop`,
    `ext:test:rainmachine-zone:${MAC}-01:stop`,
    `ext:test:rainmachine-program:${MAC}-7:start`,
    `ext:other:rainmachine:${MAC}:stop_all`,
    `ext:test:rainmachine:ABCDEF123456:stop_all`,
    42,
    undefined,
  ]) {
    assert.equal(parseFeatureId(gladys, bad), undefined, String(bad));
  }
});

test('categories, types and units are the core ones; never a switch nor a writable binary', () => {
  for (const device of devices) {
    for (const f of device.features) {
      assert.notEqual(f.category, 'switch', f.external_id);
      if (f.type === 'binary') assert.equal(f.read_only, true, f.external_id);
      if (!f.read_only) {
        assert.deepEqual([f.category, f.type], ['button', 'push'], f.external_id);
      }
      if (core) {
        const types = Object.values(core.DEVICE_FEATURE_TYPES).flatMap((t) => Object.values(t));
        assert.ok(Object.values(core.DEVICE_FEATURE_CATEGORIES).includes(f.category), f.category);
        assert.ok(types.includes(f.type), f.type);
        if (f.unit) {
          assert.ok(
            (core.DEVICE_FEATURE_UNITS_BY_CATEGORY[f.category] ?? []).includes(f.unit),
            `${f.category}/${f.unit}`,
          );
        }
      }
    }
  }
});

test('the core rules on every supported_options published', () => {
  for (const device of devices) {
    for (const f of device.features) {
      if (f.supported_options === undefined) continue;
      assert.ok(Array.isArray(f.supported_options), f.external_id);
      const values = f.supported_options.map((o) => String(o.value));
      assert.equal(new Set(values).size, values.length, 'unique values');
      for (const option of f.supported_options) {
        assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
        assert.equal(typeof option.label, 'string');
        assert.equal(option.label, option.label.trim());
        assert.ok(option.label.length > 0);
      }
      if (normalizeSupportedOptions) {
        assert.doesNotThrow(() => normalizeSupportedOptions(f.supported_options, f));
      }
    }
  }
});

test('the states of a read: only what is known, never 0 for unknown', () => {
  const states = Object.fromEntries(
    deviceStates(gladys, controller, { counter: 123.4 }).map((s) => [
      s.device_feature_external_id,
      s.state,
    ]),
  );
  const c = (key) => `ext:test:rainmachine:${MAC}:${key}`;
  const z = (uid, key) => `ext:test:rainmachine-zone:${MAC}-${uid}:${key}`;
  assert.equal(states[c(FEATURES.WATERING)], 1);
  assert.equal(states[c(FEATURES.FREEZE)], 1);
  assert.equal(states[c(FEATURES.RAIN_DELAY)], 0);
  assert.equal(c(FEATURES.RAIN_SENSOR) in states, false, 'unknown: not published');
  assert.equal(states[c(FEATURES.WATER_USED)], 123.4);
  assert.equal(states[z(1, FEATURES.REMAINING)], 2);
  assert.equal(states[z(2, FEATURES.WATERING)], 0);
  assert.equal(states[z(2, FEATURES.REMAINING)], 0);
  // Queued: not watering yet.
  assert.equal(states[z(4, FEATURES.WATERING)], 0);
  assert.equal(states[`ext:test:rainmachine-program:${MAC}-7:running`], 1);
  const unknown = deviceStates(gladys, {
    mac: MAC,
    zones: parseZones({ zones: [{ uid: 1, name: 'x' }] }),
  });
  assert.deepEqual(unknown, []);
});
