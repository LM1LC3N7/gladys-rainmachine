// -----------------------------------------------------------------------------
// The controller -> Gladys devices and their states (pure).
//
// External ids (frozen), `<mac>` the MAC address of the controller
// (`provision/wifi`, 12 lower-case hex digits), never its IP address:
//   gladys.externalIds('rainmachine', <mac>)                    the controller
//   gladys.externalIds('rainmachine-zone', `<mac>-<uid>`)       zone <uid>
//   gladys.externalIds('rainmachine-program', `<mac>-<uid>`)    program <uid>
// Feature keys (frozen, src/constants.js FEATURES):
//   controller: watering, rain_delay, freeze, rain_sensor, hourly, month,
//               weekday (read only), water_used (litres, guarded), stop_all
//   zone:       watering, remaining (read only), start, stop
//   program:    running (read only), stop
// Every feature is always built, so a republished device never loses one.
//
// Watering is never a switch nor a commandable binary: a "turn everything
// on/off" (voice assistants, HomeKit, scenes on switches) must never open a
// valve. Starting and stopping are `button/push` features. Only the active
// zones are offered (an inactive zone is off in the controller); every
// program is offered (stop only: a program waters for as long as the
// controller decides, so Gladys never starts one).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): minutes on `duration`, litres on
// `volume-sensor`. The water counter is a lifetime counter: it only ever
// goes through the guard of src/guard.js (never 0, drops and jumps held).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPES, FEATURES, RUN_STATES } from './constants.js';
import { FEATURE_NAMES, word } from './i18n.js';

const binary = {
  category: C.UNKNOWN,
  type: T.SENSOR.BINARY,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
};
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features of each kind of device, in display order. */
export const DEFINITIONS = {
  controller: {
    [FEATURES.WATERING]: binary,
    [FEATURES.RAIN_DELAY]: binary,
    [FEATURES.FREEZE]: binary,
    [FEATURES.RAIN_SENSOR]: binary,
    [FEATURES.HOURLY]: binary,
    [FEATURES.MONTH]: binary,
    [FEATURES.WEEKDAY]: binary,
    [FEATURES.WATER_USED]: {
      category: C.VOLUME_SENSOR,
      type: T.VOLUME_SENSOR.DECIMAL,
      unit: U.LITER,
      min: 0,
      max: 1_000_000_000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    [FEATURES.STOP_ALL]: button,
  },
  zone: {
    [FEATURES.WATERING]: binary,
    [FEATURES.REMAINING]: {
      category: C.DURATION,
      type: T.DURATION.INTEGER,
      unit: U.MINUTES,
      min: 0,
      max: 10_080,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    [FEATURES.START]: button,
    [FEATURES.STOP]: button,
  },
  program: {
    [FEATURES.RUNNING]: binary,
    [FEATURES.STOP]: button,
  },
};

/** The commands, by kind of device: `[feature key, what it does]`. */
export const COMMANDS = {
  controller: { [FEATURES.STOP_ALL]: 'stop' },
  zone: { [FEATURES.START]: 'start', [FEATURES.STOP]: 'stop' },
  program: { [FEATURES.STOP]: 'stop' },
};

const TYPE_OF = {
  [EXTERNAL_ID_TYPES.CONTROLLER]: 'controller',
  [EXTERNAL_ID_TYPES.ZONE]: 'zone',
  [EXTERNAL_ID_TYPES.PROGRAM]: 'program',
};

export const controllerIds = (gladys, mac) => gladys.externalIds(EXTERNAL_ID_TYPES.CONTROLLER, mac);
export const zoneIds = (gladys, mac, uid) =>
  gladys.externalIds(EXTERNAL_ID_TYPES.ZONE, `${mac}-${uid}`);
export const programIds = (gladys, mac, uid) =>
  gladys.externalIds(EXTERNAL_ID_TYPES.PROGRAM, `${mac}-${uid}`);

const ID = /:(rainmachine(?:-zone|-program)?):([0-9a-f]{12})(?:-([1-9]\d{0,2}))?$/;

/**
 * A device external id -> `{ kind, mac, uid }` (uid null for the controller),
 * checked against the ids this integration builds; undefined otherwise.
 */
export function parseDeviceId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) return undefined;
  const match = ID.exec(externalId);
  if (!match) return undefined;
  const kind = TYPE_OF[match[1]];
  const mac = match[2];
  const uid = match[3] === undefined ? null : Number(match[3]);
  if ((kind === 'controller') !== (uid === null)) return undefined;
  const ids =
    kind === 'controller'
      ? controllerIds(gladys, mac)
      : kind === 'zone'
        ? zoneIds(gladys, mac, uid)
        : programIds(gladys, mac, uid);
  return ids.device === externalId ? { kind, mac, uid } : undefined;
}

/** A feature external id -> `{ kind, mac, uid, key }`, or undefined. */
export function parseFeatureId(gladys, externalId) {
  if (typeof externalId !== 'string') return undefined;
  const at = externalId.lastIndexOf(':');
  if (at <= 0) return undefined;
  const key = externalId.slice(at + 1);
  const device = parseDeviceId(gladys, externalId.slice(0, at));
  if (!device || !Object.hasOwn(DEFINITIONS[device.kind], key)) return undefined;
  return { ...device, key };
}

export const controllerName = (c) => (c.name ?? `RainMachine ${c.mac.slice(-6)}`).slice(0, 100);

function featuresOf(kind, ids, language) {
  return Object.entries(DEFINITIONS[kind]).map(([key, spec]) => {
    const feature = {
      name: word(FEATURE_NAMES[kind][key], language).slice(0, 100),
      external_id: ids.feature(key),
      ...spec,
    };
    return feature;
  });
}

/** The zones offered in the Discovery tab: the active ones. */
export const offeredZones = (c) => [...(c.zones?.values() ?? [])].filter((z) => z.active === true);

/** The devices of the controller read: itself, its active zones, its programs. */
export function buildDevices(gladys, c, { language, host }) {
  const ids = controllerIds(gladys, c.mac);
  const params = [
    { name: 'IP_ADDRESS', value: host ?? '' },
    { name: 'MAC_ADDRESS', value: c.mac },
    { name: 'HARDWARE_VERSION', value: c.hardware === undefined ? '' : String(c.hardware) },
    { name: 'FIRMWARE_VERSION', value: c.software ?? '' },
  ].filter((p) => p.value !== '');
  const devices = [
    {
      name: controllerName(c),
      external_id: ids.device,
      features: featuresOf('controller', ids, language),
      params,
      should_poll: false,
    },
  ];
  for (const zone of offeredZones(c)) {
    const zIds = zoneIds(gladys, c.mac, zone.uid);
    devices.push({
      name: `${zone.name ?? `Zone ${zone.uid}`} (${controllerName(c)})`.slice(0, 100),
      external_id: zIds.device,
      features: featuresOf('zone', zIds, language),
      params: [
        { name: 'ZONE', value: String(zone.uid) },
        { name: 'CONTROLLER', value: c.mac },
      ],
      should_poll: false,
    });
  }
  for (const program of c.programs?.values() ?? []) {
    const pIds = programIds(gladys, c.mac, program.uid);
    devices.push({
      name: `${program.name ?? `Program ${program.uid}`} (${controllerName(c)})`.slice(0, 100),
      external_id: pIds.device,
      features: featuresOf('program', pIds, language),
      params: [
        { name: 'PROGRAM', value: String(program.uid) },
        { name: 'CONTROLLER', value: c.mac },
      ],
      should_poll: false,
    });
  }
  return devices;
}

const flag = (value) => (typeof value === 'boolean' ? (value ? 1 : 0) : undefined);

/**
 * The states of a read: `[{ device_feature_external_id, state }]`, only the
 * values known (a missing value is skipped, never 0, never NaN). `counter`:
 * the water counter the guard let through (undefined: nothing).
 */
export function deviceStates(gladys, c, { counter } = {}) {
  const states = [];
  const push = (id, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      states.push({ device_feature_external_id: id, state: value });
    }
  };
  const ids = controllerIds(gladys, c.mac);
  const zones = [...(c.zones?.values() ?? [])];
  const programs = [...(c.programs?.values() ?? [])];
  if (c.zones) {
    // Watering: a zone running (a program waters through its zones); unknown
    // while the state of a zone cannot be read and none is seen running.
    const any = zones.some((z) => z.state === RUN_STATES.RUNNING);
    const unknown = zones.some((z) => z.state === undefined);
    push(ids.feature(FEATURES.WATERING), any ? 1 : unknown ? undefined : 0);
  }
  const r = c.restrictions;
  if (r) {
    push(ids.feature(FEATURES.RAIN_DELAY), flag(r.rainDelay));
    push(ids.feature(FEATURES.FREEZE), flag(r.freeze));
    push(ids.feature(FEATURES.RAIN_SENSOR), flag(r.rainSensor));
    push(ids.feature(FEATURES.HOURLY), flag(r.hourly));
    push(ids.feature(FEATURES.MONTH), flag(r.month));
    push(ids.feature(FEATURES.WEEKDAY), flag(r.weekday));
  }
  push(ids.feature(FEATURES.WATER_USED), counter);
  for (const zone of zones) {
    const zIds = zoneIds(gladys, c.mac, zone.uid);
    const running = zone.state === undefined ? undefined : zone.state === RUN_STATES.RUNNING;
    push(zIds.feature(FEATURES.WATERING), flag(running));
    if (running === false) {
      push(zIds.feature(FEATURES.REMAINING), 0);
    } else if (running && zone.remaining !== undefined) {
      push(zIds.feature(FEATURES.REMAINING), Math.ceil(zone.remaining / 60));
    }
  }
  for (const program of programs) {
    const running =
      program.status === undefined ? undefined : program.status === RUN_STATES.RUNNING;
    push(programIds(gladys, c.mac, program.uid).feature(FEATURES.RUNNING), flag(running));
  }
  return states;
}
