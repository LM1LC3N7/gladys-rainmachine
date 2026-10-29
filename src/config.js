// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password of
// the controller is kept here in memory only: never logged, never written to
// /data, never put in a status or an error.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, POLL_INTERVAL, WATERING_MINUTES } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  password: '',
  allow_watering: false,
  watering_minutes: WATERING_MINUTES.default,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Addresses that are never one controller: broadcast, multicast, "any". */
function unusableIpv4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  return (
    (a === 0 && b === 0 && c === 0 && d === 0) ||
    (a === 255 && b === 255 && c === 255 && d === 255) ||
    (a >= 224 && a <= 239)
  );
}

/**
 * The address of the controller typed by the user: an IPv4 address or a host
 * name, with an optional port (8080 by default; a pasted `https://` URL is
 * reduced to its host and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^https:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  // Spaces and control characters (CR, LF...) are never part of an address.
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > 260 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unusableIpv4(host) ? undefined : { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

/** The address as text: `host` alone on the default port. */
export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/**
 * The password as typed (spaces included: it is the controller's), or ''
 * when empty, too long or holding a control character (never sent then).
 */
function secret(value) {
  if (typeof value !== 'string' || value.length < LIMITS.secretMin) return '';
  if (Buffer.byteLength(value, 'utf8') > LIMITS.secretMax) return '';
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value) ? '' : value;
}

/** A whole number typed in the form, bounded; the default when missing or not a number. */
function bounded(value, { min, max, fallback, round = Math.round }) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, round(n)));
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const host = String(c.host ?? '').trim();
  // A pasted URL with `user:password@`: never parsed, never shown (it may hold a password).
  const credentialsInHost = host.includes('@');
  const plainHttp = /^http:\/\//i.test(host);
  const address = credentialsInHost || plainHttp ? undefined : parseAddress(host);
  const typedPassword = typeof c.password === 'string' && c.password !== '';
  const password = secret(c.password);
  return {
    address,
    /** The text typed when it is not an address (shown in the status, cut); never with an `@`. */
    invalidHost:
      host !== '' && !address && !credentialsInHost && !plainHttp ? host.slice(0, 100) : undefined,
    /** Credentials typed in the address field: a fixed message, the text never shown. */
    credentialsInHost,
    /** An http:// address: the local API is HTTPS only here (a fixed message). */
    plainHttp,
    password: password || undefined,
    /** A password typed but refused before anything is sent (control character, too long). */
    badPassword: typedPassword && !password,
    allowWatering: strictTrue(c.allow_watering),
    wateringMinutes: bounded(c.watering_minutes, {
      min: WATERING_MINUTES.min,
      max: WATERING_MINUTES.max,
      fallback: WATERING_MINUTES.default,
      round: Math.floor,
    }),
    pollInterval: bounded(c.poll_interval, {
      min: POLL_INTERVAL.min,
      max: POLL_INTERVAL.max,
      fallback: POLL_INTERVAL.default,
    }),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What identifies the session: the address and the password (never stored, never logged). */
export const sessionKey = (config) =>
  config.address && config.password
    ? JSON.stringify([config.address.host, config.address.port, config.password])
    : '';
