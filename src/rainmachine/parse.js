// -----------------------------------------------------------------------------
// Answers of the controller -> plain values (pure). Strict: a field missing,
// null, an empty text or of another type is unknown (undefined), never 0 nor
// false; a decimal where an integer is expected is unknown too. Every list is
// bounded. The field names are those of regenmaschine 2024.3.0 and its test
// fixtures (tests/fixtures/*.json), read with Home Assistant's integration.
// -----------------------------------------------------------------------------

import { ControllerError, ERROR_KINDS } from './http.js';
import { LIMITS, RUN_STATES } from '../constants.js';

const fail = (message) => {
  throw new ControllerError(ERROR_KINDS.PROTOCOL, message, { sent: true });
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A whole number within bounds, or undefined (never a decimal, a text or a boolean). */
export const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** A finite number within bounds, or undefined. */
const numberIn = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;

const bool = (value) => (typeof value === 'boolean' ? value : undefined);

/** A name to show: control characters removed, trimmed, bounded; undefined when empty. */
export function cleanText(value) {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return text === '' ? undefined : text.slice(0, LIMITS.textLength);
}

/**
 * The identity: the MAC address of `provision/wifi` (`macAddress`), as 12
 * lower-case hex digits. Undefined when it cannot be read; never a broadcast
 * or all-zero address.
 */
export function macOf(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (!/^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}$/.test(text)) return undefined;
  const mac = text.replace(/[:-]/g, '');
  return mac === '000000000000' || mac === 'ffffffffffff' ? undefined : mac;
}

/** `provision/wifi` -> `{ mac }` (throws when there is no MAC: no identity, no device). */
export function parseWifi(json) {
  if (!isObject(json)) fail('Not an object');
  const mac = macOf(json.macAddress);
  if (!mac) fail('No MAC address');
  return { mac };
}

/** `provision/name` -> the name of the controller, or undefined. */
export const parseName = (json) => (isObject(json) ? cleanText(json.name) : undefined);

/** `apiVer` -> `{ api, hardware, software }`, each when readable. */
export function parseVersions(json) {
  if (!isObject(json)) fail('Not an object');
  return {
    api: cleanText(json.apiVer),
    hardware: intIn(json.hwVer, 1, 99) ?? intIn(Number(json.hwVer), 1, 99),
    software: cleanText(json.swVer),
  };
}

const runState = (value) =>
  value === RUN_STATES.NOT_RUNNING || value === RUN_STATES.RUNNING || value === RUN_STATES.QUEUED
    ? value
    : undefined;

/**
 * `zone` -> Map uid -> `{ uid, name, state, remaining, active }`. `state`
 * 0 not running, 1 running, 2 queued (undefined when unreadable);
 * `remaining` in seconds; `active` true when the field is missing (a first
 * generation controller does not send it, regenmaschine zone.py).
 */
export function parseZones(json) {
  if (!isObject(json) || !Array.isArray(json.zones)) fail('No zones');
  if (json.zones.length > LIMITS.zones) fail('Too many zones');
  const zones = new Map();
  for (const raw of json.zones) {
    if (!isObject(raw)) continue;
    const uid = intIn(raw.uid, 1, 999);
    if (uid === undefined || zones.has(uid)) continue;
    zones.set(uid, {
      uid,
      name: cleanText(raw.name),
      state: runState(raw.state),
      remaining: intIn(raw.remaining, 0, 7 * 24 * 3600),
      active: raw.active === undefined ? true : bool(raw.active),
    });
  }
  return zones;
}

/** `program` -> Map uid -> `{ uid, name, status, active }` (status as a zone state). */
export function parsePrograms(json) {
  if (!isObject(json) || !Array.isArray(json.programs)) fail('No programs');
  if (json.programs.length > LIMITS.programs) fail('Too many programs');
  const programs = new Map();
  for (const raw of json.programs) {
    if (!isObject(raw)) continue;
    const uid = intIn(raw.uid, 1, 999);
    if (uid === undefined || programs.has(uid)) continue;
    programs.set(uid, {
      uid,
      name: cleanText(raw.name),
      status: runState(raw.status),
      active: bool(raw.active),
    });
  }
  return programs;
}

/** `restrictions/currently` -> the restrictions in force, each when readable. */
export function parseRestrictions(json) {
  if (!isObject(json)) fail('Not an object');
  return {
    rainDelay: bool(json.rainDelay),
    freeze: bool(json.freeze),
    rainSensor: bool(json.rainSensor),
    hourly: bool(json.hourly),
    month: bool(json.month),
    weekday: bool(json.weekDay),
  };
}

/**
 * `provision` -> the flow sensor: `{ used, liters }`. The controller counts
 * the clicks of the flow sensor (`flowSensorWateringClicks`) and knows how
 * many make a cubic metre (`flowSensorClicksPerCubicMeter`): litres =
 * clicks × 1000 / clicks per m³ (Home Assistant sensor.py), rounded to 0.1 L.
 * Unknown when the sensor is not used, or either number is missing or not
 * positive.
 */
export function parseFlow(json) {
  if (!isObject(json)) fail('Not an object');
  const system = isObject(json.system) ? json.system : {};
  const used = bool(system.useFlowSensor);
  const clicks = numberIn(system.flowSensorWateringClicks, 0, 1e12);
  const perM3 = numberIn(system.flowSensorClicksPerCubicMeter, 0, 1e9);
  const liters =
    used === true && clicks !== undefined && perM3 !== undefined && perM3 > 0
      ? Math.round((clicks * 10_000) / perM3) / 10
      : undefined;
  return { used, liters };
}
