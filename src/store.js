// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), with wall dates (a monotonic instant belongs to its process):
//   - `target`: the address and MAC of the last controller read, where a stop
//     goes while the controller cannot be read;
//   - `pins`: the SHA-256 fingerprint of the certificate of each address
//     (8 at most), pinned at the first connection (public, not a secret),
//     and `refusedPin`, another one seen since at an address (shown,
//     trusted only by two clicks of "Trust the new certificate");
//   - `lastAttemptAt`: the time of the last read (written at most once a
//     minute, BEFORE the read), so a restart never reads sooner than the
//     interval;
//   - `stops`: the stops not seen applied (zone, program or all; address,
//     MAC, since, written, resends): a restart sends them again as soon as
//     the password is known;
//   - `counter`: the water counter guard of the created device (src/guard.js);
//   - `block`: the password refused (failures): no automatic try until
//     another password is saved or "Test the connection" succeeds;
//   - `pause`: a 429 or a 5xx (until, reason).
// No secret (no password, no access token, no hash of them), no personal
// data. The file is readable by the container user only (0600), bounded and
// repaired when read. A file that cannot be read is not an empty one:
// `load()` says so, and the app then never overwrites it with a guess.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';
import { normalizeFingerprint } from './rainmachine/http.js';

export const STATE_FILE = '/data/rainmachine-state.json';
const MAX_BYTES = 64 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }`. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      if (text.length > MAX_BYTES) return { unreadable: true };
      try {
        return { data: JSON.parse(text) };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { unreadable = false, failSave = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    unreadable,
    failSave,
    /** A promise that, while set, every save waits for (a hung disk). */
    hang: undefined,
    async load() {
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.hang) await this.hang;
      if (this.failSave) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

const macIn = (value) =>
  typeof value === 'string' && /^[0-9a-f]{12}$/.test(value) ? value : undefined;

/** An address kept: a host name or IPv4 address in lower case, and a port. */
export function addressOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const host =
    typeof raw.host === 'string' && raw.host.length <= 253 && /^[a-z0-9.-]+$/.test(raw.host)
      ? raw.host
      : undefined;
  const port = intIn(raw.port, 1, 65535);
  return host && port ? { host, port } : undefined;
}

export const STOP_KINDS = ['zone', 'program', 'all'];

/** The key of a stop: `all`, `zone:<uid>` or `program:<uid>`. */
export const stopKey = (kind, uid) => (kind === 'all' ? 'all' : `${kind}:${uid}`);

function normalizeStop(raw, now) {
  if (!raw || typeof raw !== 'object') return undefined;
  const address = addressOf(raw);
  const kind = STOP_KINDS.includes(raw.kind) ? raw.kind : undefined;
  const uid = kind === 'all' ? null : intIn(raw.uid, 1, 999);
  if (!address || !kind || uid === undefined) return undefined;
  // `since` only dates the status: a date in the future (a clock set back,
  // NTP not there yet) or none keeps the stop, dated now.
  const since = Number.isFinite(raw.since) && raw.since <= now ? raw.since : now;
  const written = raw.written === true;
  return {
    key: stopKey(kind, uid),
    kind,
    uid,
    ...address,
    mac: macIn(raw.mac) ?? null,
    since,
    written,
    // Never written: no resend can have been counted (a stop that never left is
    // never held); a count that cannot be read is 0.
    resends: written ? (intIn(raw.resends, 0, 100) ?? 0) : 0,
  };
}

const point = (p) =>
  p && Number.isFinite(p.value) && p.value > 0 && Number.isFinite(p.at)
    ? { value: p.value, at: p.at }
    : null;

function normalizeCounter(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.featureId !== 'string') return null;
  if (raw.featureId.length > 300) return null;
  const last = point(raw.last);
  if (!last) return null;
  const h = raw.held;
  const held =
    h &&
    (h.direction === 'up' || h.direction === 'down') &&
    [h.from, h.to, h.threshold, h.at].every(Number.isFinite)
      ? { direction: h.direction, from: h.from, to: h.to, threshold: h.threshold, at: h.at }
      : null;
  return { featureId: raw.featureId, last, held };
}

function normalizePin(raw) {
  const address = addressOf(raw);
  const fingerprint = normalizeFingerprint(raw?.fingerprint);
  return address && fingerprint ? { ...address, fingerprint } : null;
}

/**
 * The persisted state, repaired and bounded (see the header). A time in the
 * future for `lastAttemptAt` counts as now: never a longer wait than the
 * interval.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const target = addressOf(data.target);
  const stops = [];
  for (const entry of Array.isArray(data.stops) ? data.stops.slice(0, LIMITS.stops) : []) {
    const stop = normalizeStop(entry, now);
    if (stop && !stops.some((s) => s.key === stop.key)) stops.push(stop);
  }
  const pause =
    data.pause && Number.isFinite(data.pause.until) && data.pause.until > now
      ? {
          until: Math.min(data.pause.until, now + TIMINGS.rateLimitMax),
          reason: data.pause.reason === '5xx' ? '5xx' : '429',
        }
      : null;
  return {
    target: target ? { ...target, mac: macIn(data.target?.mac) ?? null } : null,
    pins: (Array.isArray(data.pins) ? data.pins.slice(-8) : []).map(normalizePin).filter(Boolean),
    refusedPin: normalizePin(data.refusedPin),
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    stops,
    counter: normalizeCounter(data.counter),
    block:
      data.block && typeof data.block === 'object'
        ? { failures: intIn(data.block.failures, 1, 1000) ?? 1 }
        : null,
    pause,
  };
}
