// -----------------------------------------------------------------------------
// The integration: the RainMachine controller typed in the configuration (one
// address and its password), one read of it every poll interval, its Gladys
// devices (the controller, its active zones, its programs) and states, the
// water counter guard, the transport badge, the buttons of the configuration
// screen, the start of a zone (only when the configuration allows watering)
// and the stops (never held back). index.js only wires the SDK handlers to it.
//
// One exchange at a time on the line (src/lane.js), each its own TLS
// connection whose certificate is checked against the pin before any byte
// leaves (src/rainmachine/http.js): the reads of a poll, a command (its fresh
// read, its write, its read back), a stop, the check of the stops.
//
// The certificate: pinned at the first connection to an address (in /data
// before the password leaves; a pin that cannot be saved sends nothing),
// with the handshake it took (modern TLS, or legacy only for a controller
// that refused modern TLS at that first connection).
// Another certificate is never learnt by itself: nothing is sent to it, its
// fingerprint is shown, and two clicks of "Trust the new certificate" take it.
//
// The password and the access token: the token the login gives is kept in
// memory only, for one address and one password. A password refused (the
// login answered 401 or `statusCode` 2) is never tried again automatically:
// another password saved, or "Test the connection" (one login a minute at
// most), tries again; a stop clicked meanwhile tries a login too (one a
// minute at most), and is kept until it can leave.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read); only the reads
//     that follow a command (5 s, 20 s);
//   - `provision/wifi` first: the MAC address is the identity, the values go
//     to the devices of that MAC; `zone` is the core of a read; the programs,
//     the restrictions, the flow sensor, the name and the versions are
//     secondary: one that fails never holds the others back (tried again
//     later, said in the status);
//   - a read begun before a write left is not applied; values older than
//     2 minutes are never sent as new;
//   - the water counter goes through src/guard.js on the session clock: never
//     0, a jump or a drop held until the user accepts it in two clicks.
//
// Starting a zone opens a valve:
//   - refused unless "Allow watering" is on, checked on arrival and again
//     right before the write (in `beforeSend`, nothing in between);
//   - decided on a fresh read (identity, the zone, its state), never on the
//     state in memory; refused when a value it needs is missing, when the
//     zone is inactive, while a stop is on its way, while "Stop all" is kept,
//     or while a stop of that zone has not left;
//   - the length is the configured minutes, bounded 1 to 60 here again: the
//     controller ends the run by itself;
//   - the write leaves by 3.5 s after the click or not at all; answered by
//     4.3 s; confirmed only by a read back showing the zone watering ("sent,
//     not applied yet" when it still shows it dry, "queued" when the
//     controller queued it, "sent, without confirmation" when it cannot be
//     read).
//
// The stops (a zone, a program, or every zone: `watering/stopall`) protect:
// never held back by the option, a read or a command in progress (they end
// them), a failed read, a 429 or 5xx pause, a configuration saved, a
// controller never read. A start that arrived before a stop and has not left
// gives way. The stops clicked together are all written first, then read
// back once. Tried again every 250 ms for 3 s; not seen applied, a stop is
// kept in /data and checked every 15 s: sent again while the zone (the
// program, any zone) still waters (3 times at most once the controller
// accepted it, then held and said in the status), let go when the read shows
// it applied, or (the stop of a zone only) when a start of that zone clicked
// in Gladys after it left.
// Never by time; a try only counts when the controller accepted the write.
// The only cases a stop does not leave at once (kept, said in the status, and
// sent as soon as it can): no password known yet (a restart before Gladys
// gives the configuration: the password is never written to /data), the
// password refused (sent once another password is saved or a login
// succeeds), the certificate changed (sent once the user trusts it or the
// pinned one is back), the controller unreachable. Refused unsent: no
// address known at all, or the last read showed another controller (another
// MAC) at that address.
//
// Clocks: `monotonic` paces everything in memory (reads, retries, waits,
// deadlines), so that a wall clock moved by NTP never stops nor hurries
// them; the guard of the water counter runs on the session clock (the wall
// clock read once at the start plus the monotonic time since); the wall
// clock only dates what /data keeps for the next process.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, sessionKey } from './config.js';
import {
  FEATURES,
  PATHS,
  PRESSED,
  RUN_STATES,
  SECOND,
  TIMINGS,
  WATERING_MINUTES,
} from './constants.js';
import {
  COMMANDS,
  buildDevices,
  controllerIds,
  controllerName,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
} from './devices.js';
import { CounterGuard, margin } from './guard.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { Lane } from './lane.js';
import { StatePublisher } from './publisher.js';
import { RainMachineClient, errorReason } from './rainmachine/client.js';
import { ControllerError, ERROR_KINDS } from './rainmachine/http.js';
import {
  parseFlow,
  parseName,
  parsePrograms,
  parseRestrictions,
  parseVersions,
  parseWifi,
  parseZones,
} from './rainmachine/parse.js';
import { fileStore, normalizeMemory, stopKey } from './store.js';

const sameAddress = (a, b) => Boolean(a && b) && a.host === b.host && a.port === b.port;

/** A clear refusal of a write (password, token, statusCode, 3xx/4xx, 429): it was not applied. */
const clearRefusal = (err) =>
  [
    ERROR_KINDS.AUTH,
    ERROR_KINDS.FORBIDDEN,
    ERROR_KINDS.REJECTED,
    ERROR_KINDS.RATE_LIMITED,
  ].includes(err?.kind) ||
  (err?.kind === ERROR_KINDS.HTTP && err.status >= 300 && err.status < 500);

/** A failure a stop is tried again on, within its 3 s (it may not have reached the controller). */
const transient = (err) =>
  [
    ERROR_KINDS.UNREACHABLE,
    ERROR_KINDS.TIMEOUT,
    ERROR_KINDS.ABORTED,
    ERROR_KINDS.PROTOCOL,
    ERROR_KINDS.RATE_LIMITED,
    ERROR_KINDS.FORBIDDEN,
  ].includes(err?.kind) ||
  (err?.kind === ERROR_KINDS.HTTP && err.status >= 500);

/** The value Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(feature) {
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** The secondary parts of a read: their failure never holds the core values back. */
const SECONDARY = ['programs', 'restrictions', 'flow', 'name', 'versions'];
const MAX_PINS = 8;

const freshController = () => ({
  mac: undefined,
  name: undefined,
  hardware: undefined,
  software: undefined,
  zones: undefined,
  programs: undefined,
  restrictions: undefined,
  liters: undefined,
  /** Monotonic time the last applied read started (-Infinity: none). */
  readAt: -Infinity,
  /** Monotonic time the name and versions were last read. */
  slowAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
  /** name -> { failures, nextAt, reason }: the secondary parts that failed. */
  secondary: new Map(),
  failed: [],
  /** The water counter the guard let through, to publish (undefined: nothing). */
  counterValue: undefined,
});

export class RainMachineApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'rainmachine' }),
    exchange,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.wallStart = now();
    this.monoStart = monotonic();
    this.client = new RainMachineClient(exchange ? { exchange } : {});
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.lane = new Lane();
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: never overwritten (a guess would lose what it holds). */
    this.memoryUnreadable = false;
    /** /data loaded (or found unreadable): before, nothing is pinned, sent with a secret nor saved. */
    this.memoryReady = false;
    this.memoryLoaded = undefined;
    this.controller = freshController();
    this.generation = 0;
    this.started = false;
    this.configRead = false;
    this.configSeq = 0;
    this.savedRaw = undefined;
    this.configChain = Promise.resolve();
    this.configTimer = undefined;
    /** Monotonic deadline of a 429/5xx pause. */
    this.pausedUntil = -Infinity;
    /** Monotonic time of the last login asked by a click while the password is refused. */
    this.loginClickAt = -Infinity;
    /** Monotonic time of the last read sent (never sooner than the interval). */
    this.lastAttemptAt = -Infinity;
    /** `getConfig()` failed (said in the status until the configuration is read). */
    this.configFailed = false;
    /** Milliseconds the last exchange took (a read back is tried only when it fits). */
    this.exchangeMs = undefined;
    this.attemptSavedAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Monotonic time the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** The starts waiting for the line, and the worker that runs them. */
    this.startQueue = [];
    this.startWorker = undefined;
    /** uid -> monotonic end: a start sent and not confirmed (never "already so" meanwhile). */
    this.pending = new Map();
    /** uid -> monotonic time the last start of that zone left. */
    this.lastStartAt = new Map();
    /** Counts the stops: a start that arrived before the current count gives way. */
    this.protectSeq = 0;
    this.stops = [];
    this.stopWorker = undefined;
    /** key -> the stop not seen applied. */
    this.stopGuards = new Map();
    this.checkTimer = undefined;
    this.checkDueAt = Infinity;
    this.checking = false;
    /** The water counter guard of the created device, and its feature id. */
    this.counterGuard = undefined;
    this.counterFeature = undefined;
    this.savedCounter = undefined;
    this.keptWall = undefined;
    this.heldLogged = undefined;
    /** First clicks of the two-click buttons: { at, ... }. */
    this.pendingAccept = undefined;
    this.pendingTrust = undefined;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.monotonic();
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.monotonic() - this.monoStart);
  }

  /** Waits `ms`; ends at once when `signal` aborts (a stop takes the line). */
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = this.timers.setTimeout(done, Math.max(0, ms));
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * `promise` raced against `ms` and `signal`: `{ done: true, value }`, or
   * `{ done: false }` when the time ran out or the line was taken. Never an
   * unbounded wait while the line is held (a hung disk never holds a stop back).
   */
  async bounded(promise, ms, signal) {
    let timer;
    let onAbort;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ done: false }), Math.max(0, ms));
      onAbort = () => resolve({ done: false });
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        promise.then(
          (value) => ({ done: true, value }),
          () => ({ done: true, value: undefined }),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // --- /data -------------------------------------------------------------------

  /** Loads /data once (the stops kept there belong to the whole run). */
  loadMemory() {
    if (!this.memoryLoaded) {
      this.memoryLoaded = (async () => {
        let result;
        try {
          result = await this.store.load();
        } catch {
          result = { unreadable: true };
        }
        const now = this.now();
        if (result?.unreadable) {
          this.memoryUnreadable = true;
          this.logger.warn(
            'RainMachine: /data/rainmachine-state.json cannot be read: it is never overwritten',
          );
          this.memory = normalizeMemory(null, now);
          this.memoryReady = true;
          return;
        }
        this.memory = normalizeMemory(result?.data ?? null, now);
        this.memoryReady = true;
        if (this.memory.pause) {
          this.pausedUntil = Math.max(
            this.pausedUntil,
            this.mono() + (this.memory.pause.until - now),
          );
        }
        for (const kept of this.memory.stops) {
          if (this.stopGuards.has(kept.key)) continue;
          const guard = this.newStopGuard(kept, { host: kept.host, port: kept.port }, kept.mac);
          guard.since = kept.since;
          guard.written = kept.written;
          guard.resends = kept.resends;
          this.stopGuards.set(kept.key, guard);
        }
        if (this.stopGuards.size > 0) {
          // A stop clicked while /data loaded is kept with the others now.
          this.persistStops().catch(() => {});
          this.armStopCheck(0);
        }
      })();
    }
    return this.memoryLoaded;
  }

  async saveMemory() {
    // Unreadable: never overwritten. Not loaded yet: never overwritten with a guess.
    if (this.memoryUnreadable || !this.memoryReady) {
      return false;
    }
    // Bounded: a hung disk never holds a read, a configuration nor a stop.
    const saved = await this.bounded(
      this.store.save(this.memory).then(
        () => true,
        (err) => {
          this.logger.warn(`RainMachine: saving the state to /data failed: ${err.message}`);
          return false;
        },
      ),
      TIMINGS.saveWait,
    );
    if (!saved.done) {
      this.logger.warn('RainMachine: saving the state to /data takes too long: not awaited');
      return false;
    }
    return saved.value === true;
  }

  /** The stops not seen applied, in /data. */
  persistStops() {
    const stops = [...this.stopGuards.values()].map((g) => ({
      kind: g.kind,
      uid: g.uid,
      host: g.target.host,
      port: g.target.port,
      mac: g.mac ?? null,
      since: g.since,
      written: g.written,
      resends: g.resends,
    }));
    const kept = this.memory.stops.map(({ key: _key, ...rest }) => rest);
    if (JSON.stringify(stops) === JSON.stringify(kept)) {
      return Promise.resolve(true);
    }
    this.memory.stops = stops.map((s) => ({ ...s, key: stopKey(s.kind, s.uid) }));
    return this.saveMemory();
  }

  /**
   * At the start of the container, before the configuration is read: the
   * stops kept in /data are restored and checked as soon as the password is
   * known (it is never in /data).
   */
  async boot() {
    await this.loadMemory();
    if (this.stopGuards.size > 0) {
      this.logger.warn(
        'RainMachine: stops kept in /data: sent again once the configuration is read',
      );
      this.armStopCheck(0);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the interval
   * after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    // The read of the previous configuration is aborted (stop()) and ignored by
    // its generation: never waited for (it may be stuck on a hung disk).
    await this.bounded(this.loadMemory(), TIMINGS.saveWait);
    if (generation !== this.generation) {
      return;
    }
    this.controller = freshController();
    this.client.reset();
    // The controller last read at this address: shown (offline) until it is read again.
    const kept = this.memory.target;
    if (this.config.address && sameAddress(kept, this.config.address) && kept.mac) {
      this.controller.mac = kept.mac;
    }
    this.counterGuard = undefined;
    this.counterFeature = undefined;
    this.savedCounter = undefined;
    this.pendingAccept = undefined;
    this.pendingTrust = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (this.stopGuards.size > 0) {
      // The configuration (and its password) is known now: the stops kept go
      // first (the check takes the line before any read), never awaited.
      this.runCheck().catch((err) => this.logger.warn(`RainMachine: check: ${err.message}`));
    }
    if (!this.config.address || this.config.badPassword || !this.config.password) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1], generation);
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    // The first read is not awaited: a configuration saved next is never held
    // behind it (a read may wait for a slow controller or disk).
    this.tick().catch((err) => this.logger.error(`RainMachine refresh failed: ${err.message}`));
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: a whole interval.
      return this.interval;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const handle of this.controller.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.controller.followUps.clear();
    // A read of this configuration ends (a stop or its check has its own target).
    if (this.lane.holder?.kind === 'read') {
      this.lane.holder.controller.abort();
    }
    this.publisher.stop();
  }

  /** The container stops: every timer (the stops are in /data), and /data written. */
  async shutdown() {
    this.stop();
    if (this.checkTimer) {
      this.timers.clearTimeout(this.checkTimer);
      this.checkTimer = undefined;
    }
    this.memory.lastAttemptAt = Number.isFinite(this.lastAttemptAt)
      ? this.now() - (this.mono() - this.lastAttemptAt)
      : this.memory.lastAttemptAt;
    // A hung disk never holds the container's stop (2 s at most).
    await this.bounded(this.saveMemory(), 2 * SECOND);
  }

  clearTimer() {
    if (this.controller.timer) {
      this.timers.clearTimeout(this.controller.timer);
      this.controller.timer = undefined;
    }
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), forever, then `connected`.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    // A configuration saved after this request left wins over its answer.
    const seq = this.configSeq;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`RainMachine: reading the configuration failed: ${err.message}`);
      // The next try armed first: nothing below may hold it back.
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected(getConfig).catch(() => {});
      }, TIMINGS.configRetry);
      this.configFailed = true;
      await this.bounded(this.loadMemory(), TIMINGS.saveWait);
      this.lastStatus = undefined;
      await this.setStatus(false, this.status()[1]);
      return;
    }
    this.configFailed = false;
    await this.inOrder(() => this.connected(seq !== this.configSeq ? this.savedRaw : raw));
  }

  /** Configurations (read or saved) applied one at a time, in their order of arrival. */
  inOrder(fn) {
    const run = this.configChain.then(fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge), without reading the controller nor sending old values.
   */
  async connected(raw = {}) {
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.liftBlockOnNewPassword(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or a new password restart (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalidHost !== this.config.invalidHost ||
      next.credentialsInHost !== this.config.credentialsInHost ||
      next.plainHttp !== this.config.plainHttp ||
      next.badPassword !== this.config.badPassword ||
      sessionKey(next) !== sessionKey(this.config)
    );
  }

  /** Another password saved (or given at a reconnection) lifts a refusal at once. */
  async liftBlockOnNewPassword(raw) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== sessionKey(this.config) && this.memory.block) {
      this.memory.block = null;
      this.loginClickAt = -Infinity;
      // Never awaited without a bound: a hung disk never holds the stops kept.
      await this.bounded(this.saveMemory(), TIMINGS.stopSaveWait);
      // The stops kept for the refusal leave first (armed once the new configuration is in).
    }
  }

  rescheduleOnNewInterval(previous) {
    const c = this.controller;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      this.config.password &&
      !c.running &&
      c.online !== false &&
      c.timer
    ) {
      this.schedule(this.dueIn());
    }
  }

  /** The configuration saved: applied in order of arrival, the last one wins. */
  configUpdated(raw = {}) {
    this.configSeq += 1;
    this.savedRaw = raw;
    return this.inOrder(() => this.applyConfig(raw));
  }

  async applyConfig(raw) {
    this.configRead = true;
    this.configFailed = false;
    await this.liftBlockOnNewPassword(raw);
    if (!this.started || this.needsRestart(raw)) {
      this.started = true;
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowWatering !== previous.allowWatering) {
      this.logger.info(
        `RainMachine: watering from Gladys ${this.config.allowWatering ? 'allowed' : 'disabled'}`,
      );
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async setStatus(connected, message, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Pauses, password, certificate -------------------------------------------

  get paused() {
    return this.mono() < this.pausedUntil;
  }

  /** The password refused: no automatic login until another one or a login that succeeds. */
  blocked() {
    return Boolean(this.memory.block);
  }

  /** The password of the configuration was refused by a login (not one changed meanwhile). */
  authFailed(key) {
    if (key !== sessionKey(this.config)) {
      return Promise.resolve();
    }
    this.client.reset();
    const failures = (this.memory.block?.failures ?? 0) + 1;
    this.memory.block = { failures };
    this.logger.warn('RainMachine: password refused; no new try until it changes');
    this.updateStatus().catch(() => {});
    return this.saveMemory();
  }

  /** A login succeeded with the password of now: a refusal is lifted, kept stops leave. */
  loggedIn(key) {
    if (key !== sessionKey(this.config) || !this.memory.block) {
      return;
    }
    this.memory.block = null;
    this.loginClickAt = -Infinity;
    this.saveMemory().catch(() => {});
    this.logger.info('RainMachine: password accepted');
    if (this.stopGuards.size > 0) {
      // The stops kept for the refusal take the line next (before the rest of a read).
      this.runCheck().catch((err) => this.logger.warn(`RainMachine: check: ${err.message}`));
    }
    this.updateStatus().catch(() => {});
  }

  /** A 429 or a 5xx: every path waits but the stops, kept in /data. */
  async pause(err, reason = '429', wait = undefined) {
    const length =
      wait ??
      Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err?.retryAfter ?? TIMINGS.rateLimitDefault),
      );
    this.pausedUntil = Math.max(this.pausedUntil, this.mono() + length);
    this.memory.pause = { until: this.now() + (this.pausedUntil - this.mono()), reason };
    await this.saveMemory();
  }

  /**
   * The TLS handshake for an address: the one its pin was taken with
   * ('legacy' only for a controller that took nothing else at its first
   * connection), 'auto' before the first pin (modern, then legacy once).
   */
  tlsFor(target) {
    const pin = this.pinOf(target);
    if (!pin) return 'auto';
    return pin.legacy ? 'legacy' : 'modern';
  }

  /** The pin of an address, or undefined. */
  pinOf(target) {
    return this.memory.pins?.find((p) => sameAddress(p, target));
  }

  /**
   * The certificate of a new connection, checked BEFORE anything is written:
   * the pin of the address, or, at the first connection, pinned now (kept in
   * /data before the password leaves; 1 s at most, else nothing is sent).
   * Another one is refused, and kept for "Trust the new certificate".
   */
  async trust(fingerprint, target, { legacy = false } = {}) {
    if (this.memoryUnreadable || !this.memoryReady) {
      // The pin is unknown (unreadable, or not loaded yet): nothing is sent (a
      // guess could send the password to an impostor).
      throw new ControllerError(ERROR_KINDS.STORAGE, '/data not read', { notSent: true });
    }
    const pin = this.pinOf(target);
    if (pin && pin.fingerprint !== fingerprint) {
      const refused = this.memory.refusedPin;
      if (!refused || refused.fingerprint !== fingerprint || !sameAddress(refused, target)) {
        this.memory.refusedPin = { host: target.host, port: target.port, fingerprint, legacy };
        this.logger.warn('RainMachine: the certificate of the controller changed, nothing sent');
        this.saveMemory().catch(() => {});
      }
      throw new ControllerError(ERROR_KINDS.CERTIFICATE, 'The certificate changed', {
        notSent: true,
        fingerprint,
      });
    }
    if (pin) {
      if (this.memory.refusedPin && sameAddress(this.memory.refusedPin, target)) {
        // The pinned certificate is back: nothing to trust any more.
        this.memory.refusedPin = null;
        this.pendingTrust = undefined;
        this.saveMemory().catch(() => {});
      }
      return;
    }
    const pins = (this.memory.pins ?? []).filter((p) => !sameAddress(p, target));
    const previous = this.memory.pins;
    this.memory.pins = [
      ...pins.slice(-(MAX_PINS - 1)),
      { host: target.host, port: target.port, fingerprint, legacy },
    ];
    // The first pin must be in /data before the password leaves: otherwise a
    // restart would trust whatever answers next.
    const saved = await this.bounded(this.saveMemory(), TIMINGS.pinSaveWait);
    if (!saved.done || !saved.value) {
      if (this.pinOf(target)?.fingerprint === fingerprint) this.memory.pins = previous;
      throw new ControllerError(ERROR_KINDS.STORAGE, '/data not writable', { notSent: true });
    }
    this.logger.info('RainMachine: certificate of the controller pinned (first connection)');
  }

  /**
   * One call of the API to `target` (the configured address, or the one of a
   * stop kept), with its password and token. `login`: 'auto' (a login when
   * there is no token, unless the password was refused) or 'click' (also
   * while refused, one a minute at most: a user's gesture).
   */
  async call(
    target,
    { method = 'GET', path, body, timeoutMs, signal, beforeSend, login = 'auto' },
  ) {
    const password = sameAddress(target, this.config.address) ? this.config.password : undefined;
    const key = password ? JSON.stringify([target.host, target.port, password]) : '';
    if (!password) {
      throw new ControllerError(ERROR_KINDS.NO_PASSWORD, 'No password', { notSent: true });
    }
    if (!this.client.hasToken(key) && this.blocked()) {
      if (login !== 'click' || this.mono() - this.loginClickAt < TIMINGS.loginClickEvery) {
        throw new ControllerError(ERROR_KINDS.NO_PASSWORD, 'Password refused', {
          notSent: true,
          blocked: true,
        });
      }
      this.loginClickAt = this.mono();
    }
    const started = this.mono();
    let logins = 0;
    try {
      const result = await this.client.call({
        address: target,
        password,
        key,
        trust: (fingerprint, info) => this.trust(fingerprint, target, info),
        tls: this.tlsFor(target),
        method,
        path,
        body,
        timeoutMs,
        now: () => this.mono(),
        signal,
        beforeSend,
        onLogin: () => {
          logins += 1;
          this.loggedIn(key);
        },
      });
      // The time one read takes (a read back is only tried when it fits).
      if (method === 'GET') this.exchangeMs = (this.mono() - started) / (1 + logins);
      return result;
    } catch (err) {
      if (err?.kind === ERROR_KINDS.AUTH) {
        // Never awaited here: a hung disk never holds a stop on the line.
        this.authFailed(key).catch(() => {});
      }
      throw err;
    }
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The time until the next read may go (never sooner than the interval). */
  dueIn(mono = this.mono()) {
    return Math.max(0, this.lastAttemptAt + this.interval - mono);
  }

  /** The next read: after a pause (never sooner than the interval), its backoff, else the interval. */
  schedule(delay) {
    const c = this.controller;
    this.clearTimer();
    const mono = this.mono();
    let wait;
    if (this.paused) {
      wait = Math.max(this.pausedUntil - mono, this.interval);
    } else {
      wait = delay ?? (c.online === false ? c.wait : this.interval);
    }
    const generation = this.generation;
    c.timer = this.timers.setTimeout(
      () => {
        c.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) =>
            this.logger.error(`RainMachine refresh failed: ${err.message}`),
          );
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const c = this.controller;
    if (!c.running) {
      c.running = this.run().finally(() => {
        c.running = undefined;
      });
    }
    return c.running;
  }

  /** The time of this read, in memory and (at most once a minute) in /data, BEFORE it. */
  async noteAttempt() {
    const mono = this.mono();
    this.lastAttemptAt = mono;
    if (mono - this.attemptSavedAt >= TIMINGS.attemptWriteEvery) {
      this.attemptSavedAt = mono;
      this.memory.lastAttemptAt = this.now();
      await this.saveMemory();
    }
  }

  async run({ login = 'auto' } = {}) {
    const generation = this.generation;
    if (this.paused || (this.blocked() && login !== 'click')) {
      await this.updateStatus();
      this.schedule();
      return;
    }
    let delay;
    await this.noteAttempt();
    const startedAt = this.mono();
    try {
      const read = await this.readAll(generation, login);
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= this.lastSentAt) {
        // Begun before a write left: it may show the state before it.
        this.logger.debug('RainMachine: read begun before a write, not applied');
      } else {
        this.applyRead(read, startedAt);
        // The stops first: a slow disk never delays them (the saves are bounded too).
        this.observeStops(
          { mac: read.mac, zones: read.zones, programs: read.values.programs },
          startedAt,
        );
        await this.saveTarget();
        await this.evaluateCounter();
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        // The line was taken (a stop, a command): not a failure, nothing applied.
        this.logger.debug('RainMachine: read ended by a stop or a command');
      } else {
        delay = await this.failed(err);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** One GET on the line (a turn of its own: a command or a stop may pass between two). */
  async read(path, generation, parse, login) {
    const holder = await this.lane.acquire('read');
    try {
      if (generation !== this.generation) {
        throw new ControllerError(ERROR_KINDS.ABORTED, 'Configuration changed');
      }
      const data = await this.call(this.config.address, {
        path,
        timeoutMs: TIMINGS.readTimeout,
        signal: holder.signal,
        login,
      });
      return parse(data);
    } finally {
      holder.release();
    }
  }

  /** Whether a secondary part is due now. */
  secondaryDue(name, mono) {
    const s = this.controller.secondary.get(name);
    return !s || mono >= s.nextAt;
  }

  /**
   * A secondary part failed: tried again after twice the interval, doubling
   * up to 1 h (an unknown call, `statusCode` 13 or a 404: an hour, a first
   * generation controller has no such endpoint).
   */
  secondaryFailed(name, err, mono) {
    const s = this.controller.secondary.get(name) ?? { failures: 0 };
    s.failures += 1;
    const absent =
      (err?.kind === ERROR_KINDS.HTTP && err.status === 404) ||
      (err?.kind === ERROR_KINDS.REJECTED && err.code === 13);
    const wait = absent
      ? TIMINGS.secondaryMaxWait
      : Math.min(TIMINGS.secondaryMaxWait, this.interval * 2 ** s.failures);
    s.nextAt = mono + wait;
    s.reason = absent ? 'absent' : errorReason(err);
    this.controller.secondary.set(name, s);
    this.logger.debug(`RainMachine: ${name} not read (${s.reason})`);
  }

  /**
   * The core (`provision/wifi`, `zone`), then the secondary parts due. A 429
   * anywhere pauses everything; an abort ends the read.
   */
  async readAll(generation, login = 'auto') {
    const c = this.controller;
    const get = (path, parse) => this.read(path, generation, parse, login);
    const wifi = await get(PATHS.wifi, parseWifi);
    const zones = await get(PATHS.zones, parseZones);
    const read = { mac: wifi.mac, zones, values: {}, failed: [] };
    const mono = this.mono();
    const slowDue = mono - c.slowAt >= TIMINGS.slowRefresh || c.mac !== wifi.mac;
    const secondary = async (key, fn) => {
      if (!this.secondaryDue(key, mono)) {
        read.failed.push(key);
        return;
      }
      try {
        read.values[key] = await fn();
        this.controller.secondary.delete(key);
      } catch (err) {
        // An abort ends the read; a 429 pauses everything (the controller asks it);
        // a refused password stops the reads. Any other failure (a 5xx, an
        // unknown call, a bad shape) leaves this part unread, never the others.
        if (
          err?.kind === ERROR_KINDS.ABORTED ||
          err?.kind === ERROR_KINDS.RATE_LIMITED ||
          err?.kind === ERROR_KINDS.AUTH ||
          err?.kind === ERROR_KINDS.CERTIFICATE
        ) {
          throw err;
        }
        this.secondaryFailed(key, err, mono);
        read.failed.push(key);
      }
    };
    await secondary('programs', () => get(PATHS.programs, parsePrograms));
    await secondary('restrictions', () => get(PATHS.restrictions, parseRestrictions));
    await secondary('flow', () => get(PATHS.provision, parseFlow));
    if (slowDue || c.name === undefined) {
      await secondary('name', () => get(PATHS.name, parseName));
    }
    if (slowDue || c.hardware === undefined) {
      await secondary('versions', () => get(PATHS.versions, parseVersions));
    }
    if (slowDue) {
      c.slowAt = mono;
    }
    return read;
  }

  /** A read answered: the controller as read (only what was read this time). */
  applyRead(read, startedAt) {
    const c = this.controller;
    const { values } = read;
    if (c.mac && c.mac !== read.mac) {
      // Another controller answers at this address: the old devices are no longer read.
      this.logger.warn('RainMachine: another controller answers at this address');
      this.counterGuard = undefined;
      this.counterFeature = undefined;
      this.savedCounter = undefined;
      this.pendingAccept = undefined;
      c.name = undefined;
      c.hardware = undefined;
      c.software = undefined;
      c.programs = undefined;
      c.restrictions = undefined;
      c.liters = undefined;
    }
    c.online = true;
    c.failures = 0;
    c.wait = undefined;
    c.error = undefined;
    c.mac = read.mac;
    c.zones = read.zones;
    if (values.programs !== undefined) c.programs = values.programs;
    if (values.restrictions !== undefined) c.restrictions = values.restrictions;
    if (values.flow !== undefined) c.liters = values.flow.liters;
    else if (read.failed.includes('flow')) c.liters = undefined;
    if (values.name !== undefined) c.name = values.name;
    if (values.versions !== undefined) {
      c.hardware = values.versions.hardware;
      c.software = values.versions.software;
    }
    c.failed = read.failed.filter((key) => SECONDARY.includes(key) && key !== 'name');
    c.readAt = startedAt;
  }

  /** Keeps in /data the address and MAC of the controller read, when they changed. */
  async saveTarget() {
    const c = this.controller;
    const address = this.config.address;
    const kept = this.memory.target;
    if (!c.mac || (sameAddress(kept, address) && kept.mac === c.mac)) {
      return;
    }
    this.memory.target = { host: address.host, port: address.port, mac: c.mac };
    await this.saveMemory();
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const c = this.controller;
    const reason = errorReason(err);
    if (err.kind === ERROR_KINDS.AUTH || (err.kind === ERROR_KINDS.NO_PASSWORD && err.blocked)) {
      // Not read until another password or a login that succeeds: offline.
      c.online = false;
      c.error = 'auth';
      return undefined;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // The controller answers: the status shows the 429 pause.
      await this.pause(err, '429');
      this.logger.warn(`RainMachine: ${reason}, pause`);
      return undefined;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(c.failures, TIMINGS.backoff.length - 1)],
    );
    c.failures += 1;
    c.online = false;
    c.wait = wait;
    c.error = reason;
    if (err.kind === ERROR_KINDS.HTTP && err.status >= 500) {
      // A 5xx: a pause of the same length, kept in /data.
      await this.pause(err, '5xx', wait);
    }
    this.logger.warn(`RainMachine: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  pauseMessage() {
    if (!this.paused) {
      return undefined;
    }
    const wait = age(this.pausedUntil - this.mono());
    return this.memory.pause?.reason === '5xx' ? T.serverError(wait) : T.rateLimited(wait);
  }

  // --- Water counter -----------------------------------------------------------

  /** The created feature of the water counter of the controller read, else undefined. */
  counterFeatureOf() {
    const c = this.controller;
    if (!c.mac) {
      return undefined;
    }
    const id = controllerIds(this.gladys, c.mac).feature(FEATURES.WATER_USED);
    for (const device of this.gladys.devices ?? []) {
      const feature = (device?.features ?? []).find((f) => f?.external_id === id);
      if (feature) {
        return feature;
      }
    }
    return undefined;
  }

  /**
   * The guard of the created counter feature, from Gladys and /data, on the
   * session clock: their wall dates turned into session dates with the
   * offset of now, then bounded by the session clock (a date in the future
   * is now).
   */
  currentCounterGuard() {
    const feature = this.counterFeatureOf();
    if (!feature) {
      return undefined;
    }
    if (!this.counterGuard || this.counterFeature !== feature.external_id) {
      const saved =
        this.memory.counter?.featureId === feature.external_id ? this.memory.counter : undefined;
      const sessionNow = this.sessionNow();
      const offset = this.now() - sessionNow;
      const toSession = (ref) =>
        ref && Number.isFinite(ref.at)
          ? { ...ref, at: Math.min(ref.at - offset, sessionNow) }
          : ref;
      const kept = saved ? { last: toSession(saved.last), held: toSession(saved.held) } : undefined;
      this.counterGuard = new CounterGuard(toSession(lastValueOf(feature)), kept, sessionNow);
      this.counterFeature = feature.external_id;
      this.savedCounter = undefined;
      // The reference taken from /data keeps its wall date there while it is unchanged.
      const last = this.counterGuard.last;
      this.keptWall =
        last && kept?.last && last.value === kept.last.value && last.at === kept.last.at
          ? { value: last.value, at: last.at, wall: saved.last.at }
          : undefined;
    }
    return this.counterGuard;
  }

  /**
   * The water counter of the last read through the guard: what to publish
   * (the value, or the last one accepted while a value is held), kept in
   * /data when the guard changed. Nothing while the device is not created.
   */
  async evaluateCounter() {
    const c = this.controller;
    const guard = this.currentCounterGuard();
    if (!guard || c.liters === undefined) {
      c.counterValue = undefined;
      return;
    }
    const value = c.liters;
    const plausible = guard.accept(value, this.sessionNow());
    c.counterValue = plausible ? value : guard.held ? guard.last?.value : undefined;
    const heldKey = guard.held ? `${guard.held.direction}:${guard.held.from}` : undefined;
    if (heldKey && heldKey !== this.heldLogged) {
      this.logger.warn(
        `RainMachine water counter ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: "Accept the held water counter" takes it`,
      );
    }
    this.heldLogged = heldKey;
    await this.saveCounter();
  }

  /** Keeps the guard in /data when its reference or its value held changed, as wall dates. */
  async saveCounter() {
    const state = this.counterGuard.state();
    const offset = this.now() - this.sessionNow();
    const kept = this.keptWall;
    const toWall = (ref) => {
      if (!ref || !Number.isFinite(ref.at)) return ref;
      if (ref === state.last && kept && ref.value === kept.value && ref.at === kept.at) {
        return { ...ref, at: kept.wall };
      }
      return { ...ref, at: ref.at + offset };
    };
    const key = JSON.stringify([
      this.counterFeature,
      state.last,
      Math.round(offset / 60_000),
      state.held && {
        direction: state.held.direction,
        from: state.held.from,
        threshold: state.held.threshold,
      },
    ]);
    if (key === this.savedCounter) {
      return;
    }
    this.memory.counter = {
      featureId: this.counterFeature,
      last: toWall(state.last),
      held: toWall(state.held),
    };
    if (await this.saveMemory()) {
      this.savedCounter = key;
    }
  }

  /** Whether `pending` is a valid first click for a second one now (3 s to 5 min ago). */
  secondClick(pending, mono) {
    return (
      pending !== undefined &&
      mono - pending.at >= TIMINGS.confirmAfter &&
      mono - pending.at <= TIMINGS.confirmWithin
    );
  }

  /**
   * "Accept the held water counter", in two clicks: the first lists the
   * value held (nothing is accepted), the second, 3 s to 5 min later,
   * accepts it only when the guard still holds that value, or, for a rise
   * since, what may have flowed since the first click. The acceptance itself
   * stays bounded (src/guard.js). A save of the form never accepts.
   */
  async acceptHeldCounter() {
    const guard = this.currentCounterGuard();
    const held = guard?.held;
    const mono = this.mono();
    const now = this.sessionNow();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    if (!this.secondClick(pending, mono)) {
      if (!held) {
        return T.accept.nothing;
      }
      const listed = { direction: held.direction, from: held.from, to: held.to };
      this.pendingAccept = { at: mono, listedAt: now, guard, listed };
      return T.accept.confirm(listed);
    }
    const { listed } = pending;
    const top = listed.to + margin(pending.listedAt, now);
    const same =
      held &&
      pending.guard === guard &&
      held.direction === listed.direction &&
      held.from === listed.from &&
      (held.direction === 'up'
        ? held.to >= listed.to && held.to <= top
        : held.to >= listed.to && held.to <= top);
    if (!same) {
      if (!held) return T.accept.nothing;
      return T.accept.changed;
    }
    const taken = guard.acceptHeld();
    this.logger.info(
      `RainMachine water counter ${taken.direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
    );
    // Published at the next read (never sooner than the interval).
    return T.accept.done(taken);
  }

  /**
   * "Trust the new certificate", in two clicks: the first one shows the whole
   * fingerprint refused and pins nothing; a second one 3 s to 5 min later
   * pins exactly that fingerprint, if it is still the one refused for the
   * address of now. Never a certificate that was not shown.
   */
  async trustCertificate() {
    const refused = this.memory.refusedPin;
    const pending = this.pendingTrust;
    this.pendingTrust = undefined;
    if (!refused || this.memoryUnreadable) {
      return T.trust.nothing;
    }
    const mono = this.mono();
    if (!this.secondClick(pending, mono) || pending.fingerprint !== refused.fingerprint) {
      this.pendingTrust = { fingerprint: refused.fingerprint, at: mono };
      return T.trust.confirm(refused.fingerprint);
    }
    const target = { host: refused.host, port: refused.port };
    const previous = this.memory.pins;
    this.memory.pins = [
      ...(this.memory.pins ?? []).filter((p) => !sameAddress(p, target)),
      { ...target, fingerprint: refused.fingerprint, legacy: refused.legacy === true },
    ].slice(-MAX_PINS);
    this.memory.refusedPin = null;
    if (!(await this.saveMemory())) {
      this.memory.pins = previous;
      this.memory.refusedPin = refused;
      return T.trust.notSaved;
    }
    this.logger.info('RainMachine: the new certificate of the controller was trusted by the user');
    if (this.stopGuards.size > 0) {
      // The stops kept for the certificate leave first.
      this.armStopCheck(0);
    }
    return T.trust.done(refused.fingerprint);
  }

  // --- Status ----------------------------------------------------------------

  /** The name of the target of a stop, for the status. */
  stopLabel(guard) {
    if (guard.kind === 'all') return T.stopLabels.all;
    const c = this.controller;
    const entry = guard.kind === 'zone' ? c.zones?.get(guard.uid) : c.programs?.get(guard.uid);
    return guard.kind === 'zone'
      ? T.stopLabels.zone(entry?.name ?? String(guard.uid))
      : T.stopLabels.program(entry?.name ?? String(guard.uid));
  }

  /** Where a stop kept stands, for the status. */
  stopState(guard) {
    if (!guard.written) {
      if (this.config.address && !sameAddress(guard.target, this.config.address)) {
        return T.stopStates.otherAddress;
      }
      if (!this.config.password) {
        return T.stopStates.noPassword;
      }
      if (this.blocked()) return T.stopStates.passwordRefused;
      if (this.memory.refusedPin && sameAddress(this.memory.refusedPin, guard.target)) {
        return T.stopStates.certificate;
      }
      return T.stopStates.notSent;
    }
    if (guard.kind === 'all' && guard.programsUnread) return T.stopStates.programsUnread;
    if (guard.resends >= TIMINGS.stopResends) return T.stopStates.held;
    return T.stopStates.notApplied(guard.resends);
  }

  /** The message with what the user must see added: stops kept, counter held, parts not read. */
  withNotes(message) {
    let text = message;
    for (const guard of this.stopGuards.values()) {
      if (!guard.applied) {
        text = join(text, T.stopKept(this.stopLabel(guard), this.stopState(guard)));
      }
    }
    const held = this.counterGuard?.held;
    if (held) {
      text = join(text, T.held(held));
    }
    const failed = this.controller.failed ?? [];
    if (this.controller.online && failed.length > 0) {
      text = join(text, T.notRead(failed));
    }
    return text;
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const c = this.controller;
    if (this.configFailed) {
      // Asked again every 30 s; the stops still go with the configuration held.
      return [false, this.withNotes(T.configUnreadable)];
    }
    if (!this.configRead) {
      // Before the configuration: never "enter the address" (it may be there).
      return [false, this.withNotes(T.waitingConfig)];
    }
    if (!this.config.address) {
      if (this.config.credentialsInHost) {
        return [false, this.withNotes(T.hostCredentials)];
      }
      if (this.config.plainHttp) {
        return [false, this.withNotes(T.httpNotSupported)];
      }
      return [
        false,
        this.withNotes(this.config.invalidHost ? T.invalidHost(this.config.invalidHost) : T.noHost),
      ];
    }
    if (this.config.badPassword) {
      return [false, this.withNotes(T.invalidPassword)];
    }
    if (!this.config.password) {
      return [false, this.withNotes(T.noPassword)];
    }
    if (this.memoryUnreadable) {
      return [false, this.withNotes(T.dataUnreadable)];
    }
    if (!this.memoryReady) {
      return [false, this.withNotes(T.dataLoading)];
    }
    const refused = this.memory.refusedPin;
    if (refused && sameAddress(refused, this.config.address)) {
      return [false, this.withNotes(T.certificateChanged(refused.fingerprint))];
    }
    const pause = this.pauseMessage();
    if (pause) {
      return [false, this.withNotes(pause)];
    }
    if (this.blocked()) {
      return [false, this.withNotes(T.passwordRefused)];
    }
    if (c.online === false) {
      const wait = age(c.wait ?? this.interval);
      let message;
      if (c.error === ERROR_KINDS.STORAGE) message = T.pinNotSaved;
      else if (c.error === ERROR_KINDS.UNREACHABLE || c.error === ERROR_KINDS.TIMEOUT) {
        message = T.unreachable(addressKey(this.config.address), wait);
      } else message = T.failing(c.error ?? 'error', wait);
      return [false, this.withNotes(message)];
    }
    if (c.online === undefined || !c.zones) {
      return [false, this.withNotes(T.connecting)];
    }
    const watering = [...c.zones.values()].filter((z) => z.state === RUN_STATES.RUNNING);
    let summary = T.summary({
      name: controllerName(c),
      zones: [...c.zones.values()].filter((z) => z.active === true).length,
      watering: watering.map((z) => z.name ?? String(z.uid)),
    });
    if (!this.config.allowWatering) {
      summary = join(summary, T.wateringOff);
    }
    summary = this.withNotes(summary);
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus(generation = this.generation) {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message, generation);
      return;
    }
    const names = orphans
      .map((mac) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === controllerIds(this.gladys, mac).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${mac})`
          : mac;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherController(names)), generation);
  }

  // --- Gladys ----------------------------------------------------------------

  /** Whether the values of the last read may be sent as current (2 minutes at most). */
  fresh(mono = this.mono()) {
    return mono - this.controller.readAt <= TIMINGS.freshFor;
  }

  /**
   * The MACs of the controllers created in Gladys that the controller read
   * is not (another controller at this address, or an address changed).
   * Empty until a read succeeded since the start (a controller down is not
   * "another controller"), unless there is no address at all.
   */
  orphans() {
    const c = this.controller;
    if (this.config.address && c.readAt === -Infinity) {
      return [];
    }
    const macs = new Set();
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseDeviceId(this.gladys, device?.external_id);
      if (parsed && parsed.mac !== c.mac) {
        macs.add(parsed.mac);
      }
    }
    return [...macs];
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus(generation);
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const c = this.controller;
    if (!c.mac || !c.zones || c.readAt === -Infinity) {
      return;
    }
    const devices = buildDevices(this.gladys, c, {
      language: this.config.language,
      host: this.config.address?.host,
    });
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The states to send: those of a fresh read only. */
  queueStates(created = this.createdFeatures()) {
    const c = this.controller;
    if (!c.mac || c.online !== true || !this.fresh()) {
      return;
    }
    for (const { device_feature_external_id: id, ...value } of deviceStates(this.gladys, c, {
      counter: c.counterValue,
    })) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  async publishBadge() {
    const c = this.controller;
    const entries = [];
    const orphans = new Set(this.orphans());
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseDeviceId(this.gladys, device?.external_id);
      if (!parsed) continue;
      const reachable = parsed.mac === c.mac && c.online === true && !orphans.has(parsed.mac);
      if (parsed.mac !== c.mac && !orphans.has(parsed.mac)) continue;
      entries.push({
        external_id: device.external_id,
        transport: reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values at once, if fresh. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    if (this.fresh()) {
      // The counter of a device just created goes through its guard first.
      await this.evaluateCounter();
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  /** A device was deleted: its guard is dropped (a new device starts a new counter). */
  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id !== 'string') {
      return;
    }
    this.publisher.forget(device.external_id);
    const owned = (id) => typeof id === 'string' && id.startsWith(`${device.external_id}:`);
    if (owned(this.counterFeature)) {
      this.counterGuard = undefined;
      this.counterFeature = undefined;
      this.savedCounter = undefined;
      this.pendingAccept = undefined;
      this.controller.counterValue = undefined;
    }
    if (owned(this.memory.counter?.featureId)) {
      this.memory.counter = null;
      await this.saveMemory();
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /**
   * Reads the controller now if the interval allows it (a login even while
   * the password is refused, one a minute at most), else the last status.
   */
  async testConnection() {
    if (!this.config.address || !this.config.password || this.paused) {
      return this.status()[1];
    }
    const wait = this.dueIn();
    if (this.blocked()) {
      const left = Math.max(wait, TIMINGS.loginClickEvery - (this.mono() - this.loginClickAt));
      if (left > 0) {
        return join(this.status()[1], T.test.notSooner(age(left)));
      }
      await this.controller.running;
      this.clearTimer();
      this.controller.running = this.run({ login: 'click' }).finally(() => {
        this.controller.running = undefined;
      });
      await this.controller.running;
      return this.status()[1];
    }
    if (wait > 0 || this.controller.running) {
      await this.controller.running;
      const [, message] = this.status();
      return join(message, T.test.notSooner(age(wait)));
    }
    await this.tick();
    return this.status()[1];
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const target = parseFeatureId(this.gladys, feature?.external_id);
    const action = target ? COMMANDS[target.kind][target.key] : undefined;
    if (!action) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (action === 'stop') {
      // Never held back: whatever the value, the option, a read or a command.
      const kind = target.kind === 'controller' ? 'all' : target.kind;
      return this.protect({ kind, uid: target.uid, mac: target.mac }, received);
    }
    if (value !== PRESSED && value !== String(PRESSED)) {
      throw this.refusal(ERRORS.badButton);
    }
    if (!this.config.allowWatering) {
      throw this.refusal(ERRORS.disabled);
    }
    return this.queueStart(target, received);
  }

  /** The checks before any request of a start, and again right before its write. */
  checkCommand(generation, entry) {
    if (!this.config.allowWatering) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || !this.config.address || !this.config.password) {
      throw this.refusal(ERRORS.unknownController);
    }
    if (entry.seq !== this.protectSeq || this.stops.length > 0 || this.stopWorker) {
      throw this.refusal(ERRORS.stopMeanwhile);
    }
    // A "Stop all" kept (until a read shows it applied), or a stop of this zone
    // that never left: the start would undo it.
    if (this.stopGuards.has('all')) {
      throw this.refusal(ERRORS.stopAllKept);
    }
    if (
      entry.uid !== undefined &&
      this.stopGuards.get(stopKey('zone', entry.uid))?.written === false
    ) {
      throw this.refusal(ERRORS.stopZoneKept);
    }
    if (this.paused) {
      const wait = age(this.pausedUntil - this.mono());
      throw this.refusal(
        this.memory.pause?.reason === '5xx' ? ERRORS.pausedServer(wait) : ERRORS.paused(wait),
      );
    }
    if (this.blocked()) {
      throw this.refusal(ERRORS.passwordRefused);
    }
  }

  isPending(uid) {
    const until = this.pending.get(uid);
    return until !== undefined && this.mono() < until;
  }

  /** The seconds a zone started from Gladys waters: the configuration, bounded here again. */
  wateringSeconds() {
    const minutes = Math.min(
      WATERING_MINUTES.max,
      Math.max(WATERING_MINUTES.min, Math.floor(this.config.wateringMinutes)),
    );
    return Number.isInteger(minutes) ? minutes * 60 : WATERING_MINUTES.default * 60;
  }

  /**
   * A start clicked: queued. The starts waiting when the line comes are
   * handled together (a scene starting several zones): one fresh read
   * (identity and zones) begun after all of them arrived, one write each
   * (each checked again right before its byte, each by 3.5 s after its own
   * click), one read back. Each is answered by 4.3 s after its click.
   */
  queueStart(target, received) {
    const generation = this.generation;
    const entry = {
      uid: target.uid,
      mac: target.mac,
      seq: this.protectSeq,
      generation,
      received,
      sendBy: received + TIMINGS.commandSendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
      sent: false,
      settled: false,
    };
    const answer = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.settle = (error) => {
      if (entry.settled) return;
      entry.settled = true;
      this.timers.clearTimeout(entry.timer);
      if (error) entry.reject(error);
      else entry.resolve(undefined);
    };
    try {
      this.checkCommand(generation, entry);
      if (!this.configRead) {
        throw this.refusal(ERRORS.notReadYet);
      }
    } catch (err) {
      entry.settle(err);
      return answer;
    }
    // Answered by 4.3 s whatever the line does: never "not sent" once a byte may have left.
    entry.timer = this.timers.setTimeout(
      () => {
        entry.late = true;
        entry.settle(this.refusal(entry.sent ? ERRORS.sentUnconfirmed('timeout') : ERRORS.tooSlow));
      },
      Math.max(0, entry.answerBy - this.mono()),
    );
    this.startQueue.push(entry);
    this.runStarts();
    return answer;
  }

  runStarts() {
    if (this.startWorker) {
      return;
    }
    this.startWorker = (async () => {
      try {
        while (this.startQueue.length > 0) {
          await this.startBatch();
        }
      } finally {
        this.startWorker = undefined;
      }
    })();
  }

  /** Whether a start waits or runs (a check of the stops gives way to it). */
  get starting() {
    return this.startQueue.length > 0 || Boolean(this.startWorker);
  }

  /** One turn on the line for the starts waiting now. */
  async startBatch() {
    // The line, or nothing sent: a turn that never comes before the earliest
    // send deadline of the waiting starts is given up for those past it.
    const giveUp = new AbortController();
    const earliest = Math.min(...this.startQueue.map((e) => e.sendBy));
    const giveUpTimer = this.timers.setTimeout(
      () => giveUp.abort(),
      Math.max(0, earliest - TIMINGS.commandMinRequest - this.mono()),
    );
    let holder;
    try {
      holder = await this.lane.acquire('command', { signal: giveUp.signal });
    } catch {
      holder = undefined;
    } finally {
      this.timers.clearTimeout(giveUpTimer);
    }
    const mono = this.mono();
    const batch = [];
    for (const entry of this.startQueue.splice(0)) {
      if (entry.settled) continue;
      if (mono > entry.sendBy - TIMINGS.commandMinRequest) {
        entry.settle(this.refusal(ERRORS.tooSlow));
      } else if (!holder) {
        // Not its turn yet: back in the queue for the next one.
        this.startQueue.push(entry);
      } else {
        batch.push(entry);
      }
    }
    if (!holder) return;
    try {
      if (batch.length > 0) {
        await this.startsOnLine(batch, holder);
      }
    } catch (err) {
      this.logger.warn(`RainMachine: start failed: ${err.message}`);
      for (const entry of batch) {
        entry.settle(
          this.refusal(entry.sent ? ERRORS.sentUnconfirmed('error') : ERRORS.notSent('error')),
        );
      }
    } finally {
      holder.release();
    }
  }

  /** The fresh read of the starts, on the line they hold: the identity and the zones. */
  async freshRead(holder, until) {
    const address = this.config.address;
    const get = async (path, parse) => {
      if (this.mono() >= until) {
        throw new ControllerError(ERROR_KINDS.LATE, 'Fresh read too slow', { notSent: true });
      }
      const data = await this.call(address, {
        path,
        timeoutMs: Math.max(TIMINGS.commandMinRequest, until - this.mono()),
        signal: holder.signal,
      });
      return parse(data);
    };
    const wifi = await get(PATHS.wifi, parseWifi);
    const zones = await get(PATHS.zones, parseZones);
    return { mac: wifi.mac, zones };
  }

  /** The refusal of a start whose fresh read failed. */
  freshRefusal(err, entry) {
    if (err.kind === ERROR_KINDS.ABORTED && entry.seq !== this.protectSeq) {
      return this.refusal(ERRORS.stopMeanwhile);
    }
    if (err.kind === ERROR_KINDS.AUTH || err.blocked) {
      return this.refusal(ERRORS.passwordRefused);
    }
    if (err.kind === ERROR_KINDS.CERTIFICATE) {
      return this.refusal(ERRORS.certificate);
    }
    return this.refusal(
      err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.unknownState(errorReason(err)),
    );
  }

  /** What a fresh read says of one start: a refusal, 'done' (already so), or 'write'. */
  decideStart(entry, fresh) {
    if (entry.generation !== this.generation) {
      return this.refusal(ERRORS.unknownController);
    }
    if (fresh.mac !== entry.mac) {
      return this.refusal(ERRORS.otherController);
    }
    const zone = fresh.zones.get(entry.uid);
    if (!zone) {
      return this.refusal(ERRORS.noZone);
    }
    if (zone.active !== true) {
      return this.refusal(zone.active === false ? ERRORS.inactiveZone : ERRORS.missing);
    }
    if (zone.state === undefined) {
      return this.refusal(ERRORS.missing);
    }
    entry.before = zone.state;
    const guarded = this.stopGuards.has(stopKey('zone', entry.uid));
    // Never "already so" while a stop is kept: the start is written, and lets the stop go.
    if (zone.state === RUN_STATES.RUNNING && !this.isPending(entry.uid) && !guarded) {
      return 'done';
    }
    return 'write';
  }

  async startsOnLine(batch, holder) {
    const address = this.config.address;
    const sendBy = Math.max(...batch.map((e) => e.sendBy));
    let fresh;
    const readStart = this.mono();
    try {
      fresh = await this.freshRead(holder, sendBy - TIMINGS.commandMinRequest);
    } catch (err) {
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        // The pause starts now; its save to /data is never awaited under the line.
        this.pause(err, '429').catch(() => {});
      }
      for (const entry of batch) entry.settle(this.freshRefusal(err, entry));
      return;
    }
    if (readStart > this.lastSentAt) {
      this.applyFresh(fresh, readStart);
    }
    const written = [];
    for (const entry of batch) {
      if (entry.settled) continue;
      const decision = this.decideStart(entry, fresh);
      if (decision instanceof Error) {
        entry.settle(decision);
        continue;
      }
      if (decision === 'done') {
        entry.settle();
        continue;
      }
      if (await this.writeStart(entry, address, holder)) {
        written.push(entry);
      }
      if (holder.signal.aborted) break;
    }
    for (const entry of batch) {
      if (!entry.settled && !written.includes(entry)) {
        entry.settle(
          this.refusal(entry.seq !== this.protectSeq ? ERRORS.stopMeanwhile : ERRORS.tooSlow),
        );
      }
    }
    if (written.length === 0) return;
    this.followUp();
    // The read back alone confirms them.
    const answerBy = Math.min(...written.map((e) => e.answerBy));
    const wait = this.readBackWait(answerBy);
    if (wait === undefined) {
      // No time left for a read back: answered now, the follow-up reads check.
      for (const entry of written) {
        this.markPending(entry.uid);
        entry.settle(this.refusal(ERRORS.sentUnconfirmed('timeout')));
      }
      return;
    }
    await this.sleep(wait, holder.signal);
    let zones;
    const backStart = this.mono();
    try {
      const data = await this.call(address, {
        path: PATHS.zones,
        timeoutMs: Math.max(TIMINGS.commandMinRequest, answerBy - this.mono()),
        signal: holder.signal,
      });
      zones = parseZones(data);
      // Begun after the writes: the state to show now (never one read before them).
      if (backStart > this.lastSentAt) {
        this.applyFresh({ mac: fresh.mac, zones }, backStart);
      }
    } catch (err) {
      for (const entry of written) {
        this.markPending(entry.uid);
        entry.settle(this.refusal(ERRORS.sentUnconfirmed(errorReason(err))));
      }
      return;
    }
    for (const entry of written) {
      const back = zones.get(entry.uid);
      const queuedBefore = entry.before === RUN_STATES.QUEUED;
      // Queued before and after: taken only when its remaining time is the length written.
      const queuedNow =
        back?.state === RUN_STATES.QUEUED &&
        (!queuedBefore ||
          (back.remaining !== undefined && Math.abs(back.remaining - entry.seconds) <= 5));
      if (back?.state === RUN_STATES.RUNNING || queuedNow) {
        // Watering, or queued by the controller behind another zone (it waters
        // one at a time): the start is taken, for the length written.
        this.pending.delete(entry.uid);
        this.logger.info(
          `RainMachine: start of zone ${entry.uid} confirmed by the controller (${back.state === RUN_STATES.RUNNING ? 'watering' : 'queued'})`,
        );
        entry.settle();
        continue;
      }
      this.markPending(entry.uid);
      entry.settle(
        this.refusal(back?.state === entry.before ? ERRORS.notApplied : ERRORS.sentDiffers),
      );
    }
  }

  /** One start written; true when it may have left (and is not answered yet). */
  async writeStart(entry, address, holder) {
    const { uid } = entry;
    try {
      this.checkCommand(entry.generation, entry);
      if (this.mono() > entry.sendBy) {
        throw this.refusal(ERRORS.tooSlow);
      }
    } catch (err) {
      entry.settle(err);
      return false;
    }
    const seconds = this.wateringSeconds();
    // A last bound on the value written, whatever happened to the configuration.
    if (!(seconds >= WATERING_MINUTES.min * 60 && seconds <= WATERING_MINUTES.max * 60)) {
      entry.settle(this.refusal(ERRORS.missing));
      return false;
    }
    entry.seconds = seconds;
    this.logger.info(`RainMachine: start zone ${uid} for ${seconds / 60} min`);
    try {
      await this.call(address, {
        method: 'POST',
        path: PATHS.zoneStart(uid),
        body: { time: seconds, zid: uid },
        timeoutMs: Math.max(
          TIMINGS.commandMinRequest,
          entry.answerBy - TIMINGS.applyWait - this.mono(),
        ),
        signal: holder.signal,
        beforeSend: () => {
          // The option, the configuration and the stops checked again right before the byte.
          this.checkCommand(entry.generation, entry);
          if (this.mono() > entry.sendBy || entry.settled) {
            throw this.refusal(ERRORS.tooSlow);
          }
          entry.sent = true;
          this.lastSentAt = this.mono();
          this.lastStartAt.set(uid, this.lastSentAt);
        },
      });
    } catch (err) {
      // A start that left and was not clearly refused (a 5xx, a silence, a cut)
      // may have been applied: the newer intent wins, the stops it undoes are let go.
      if (entry.sent && !clearRefusal(err) && entry.seq === this.protectSeq) {
        this.dropStopsUndoneBy(uid, 'newer start, sent without confirmation');
      }
      try {
        this.startFailed(err, entry);
      } catch (refusal) {
        entry.settle(refusal);
      }
      return false;
    }
    if (entry.seq === this.protectSeq) {
      // A newer start clicked with the option and accepted: the stops before it
      // are let go, never one clicked while this start was on its way.
      this.dropStopsUndoneBy(uid, 'newer start');
    }
    return true;
  }

  markPending(uid) {
    this.pending.set(uid, this.mono() + TIMINGS.pendingFor);
  }

  /** A write that failed: never "not sent" once a byte may have left. */
  startFailed(err, entry) {
    const reason = errorReason(err);
    this.logger.warn(`RainMachine: start failed (${reason})`);
    if (!entry.sent) {
      if (err.beforeSend && err.cause instanceof Error) {
        // A refusal of beforeSend (option off, a stop, too late): its own words.
        throw err.cause;
      }
      if (err.kind === ERROR_KINDS.ABORTED && entry.seq !== this.protectSeq) {
        throw this.refusal(ERRORS.stopMeanwhile);
      }
      if (err.kind === ERROR_KINDS.AUTH || err.blocked) {
        throw this.refusal(ERRORS.passwordRefused);
      }
      throw this.refusal(ERRORS.notSent(reason));
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      this.pause(err, '429').catch(() => {});
    }
    if (clearRefusal(err)) {
      // Answered with a refusal: not applied.
      this.followUp();
      throw this.refusal(ERRORS.refused(reason));
    }
    // A 5xx, a silence, a cut: it may have reached the controller.
    this.markPending(entry.uid);
    this.followUp();
    throw this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /** The fresh read of a command, kept in memory and shown in the background. */
  applyFresh(fresh, readStart) {
    const c = this.controller;
    if (c.mac !== fresh.mac || c.readAt === -Infinity) {
      return;
    }
    c.zones = fresh.zones;
    this.observeStops({ mac: fresh.mac, zones: fresh.zones }, readStart);
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
  }

  /**
   * Spaced reads after a command: its effect, then a check (each a new read).
   * The reads of an earlier command not done yet are replaced.
   */
  followUp() {
    const generation = this.generation;
    const c = this.controller;
    for (const handle of c.followUps) {
      this.timers.clearTimeout(handle);
    }
    c.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        c.followUps.delete(handle);
        if (generation === this.generation && !this.paused && !this.blocked()) {
          Promise.resolve(c.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('RainMachine refresh failed'));
        }
      }, delay);
      c.followUps.add(handle);
    }
  }

  // --- The stops (protective) ---------------------------------------------------

  /** Where a stop goes: the configured address, else the last one read (in /data). */
  stopTarget() {
    if (this.config.address) {
      return { host: this.config.address.host, port: this.config.address.port };
    }
    const kept = this.memory.target;
    return kept ? { host: kept.host, port: kept.port } : undefined;
  }

  /** The MAC last read at an address, or undefined. */
  macAt(target) {
    const kept = this.memory.target;
    if (sameAddress(kept, target) && kept.mac) return kept.mac;
    if (sameAddress(target, this.config.address) && this.controller.mac) {
      return this.controller.mac;
    }
    return undefined;
  }

  /**
   * A stop clicked: queued before anything (it ends a read or a command on
   * the line), answered by 4.3 s after the click.
   */
  async protect({ kind, uid, mac }, received) {
    // Every start that arrived before this stop and has not left gives way.
    this.protectSeq += 1;
    // /data holds the address of the last read: known even before the
    // configuration (a hung disk never holds the stop back: 200 ms at most).
    await this.bounded(this.loadMemory(), TIMINGS.stopSaveWait);
    const target = this.stopTarget();
    if (!target) {
      throw this.refusal(ERRORS.noAddress);
    }
    const known = this.macAt(target);
    if (known && known !== mac) {
      // The last read showed another controller there: its zone N is not this one.
      throw this.refusal(ERRORS.stopOtherController);
    }
    const job = this.queueStop({ kind, uid, target, mac, received });
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      throw this.refusal(job.state.written ? ERRORS.stopUnconfirmed : ERRORS.stopPending);
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /** Queues a stop, in the order of the clicks; a click for the same stop still waiting is joined. */
  queueStop({ kind, uid, target, mac, received }) {
    const key = stopKey(kind, uid);
    let job = this.stops.find((j) => !j.running && j.key === key && sameAddress(j.target, target));
    if (job) {
      return job;
    }
    job = { key, kind, uid, target, mac, received, state: { written: false }, running: false };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    // Whatever holds the line ends when the stop asks for it (src/lane.js aborts it).
    this.runStops();
    return job;
  }

  runStops() {
    if (this.stopWorker) {
      return;
    }
    this.stopWorker = (async () => {
      try {
        while (this.stops.length > 0) {
          // Every stop waiting for the same address goes in this turn: all
          // written first, one read back for all of them.
          const target = this.stops[0].target;
          const batch = this.stops.filter((j) => sameAddress(j.target, target));
          for (const job of batch) job.running = true;
          try {
            await this.sendStops(batch);
          } catch (err) {
            this.logger.warn(`RainMachine: stop failed: ${err.message}`);
            for (const job of batch) job.resolve({ error: this.refusal(ERRORS.stopPending) });
          }
          this.stops = this.stops.filter((j) => !batch.includes(j));
        }
      } finally {
        this.stopWorker = undefined;
      }
    })();
  }

  newStopGuard({ kind, uid }, target, mac) {
    return {
      key: stopKey(kind, uid),
      kind,
      uid: kind === 'all' ? null : uid,
      target,
      mac: mac ?? null,
      since: this.now(),
      written: false,
      sentAt: undefined,
      resends: 0,
      /** Seen applied by the last read (a late start may still undo it). */
      applied: false,
      /** Until then, a start that left before the stop may still land: watched. */
      watchUntil: -Infinity,
    };
  }

  /** The stop path of a guard. */
  stopPath(guard) {
    if (guard.kind === 'zone') return PATHS.zoneStop(guard.uid);
    if (guard.kind === 'program') return PATHS.programStop(guard.uid);
    return PATHS.stopAll;
  }

  /** The body of a stop (the ids again, for a first generation controller: regenmaschine). */
  stopBody(guard) {
    if (guard.kind === 'zone') return { zid: guard.uid };
    if (guard.kind === 'program') return { pid: guard.uid };
    return {};
  }

  /** The last start that may undo this stop (monotonic, -Infinity when none). */
  lastStartFor(guard) {
    if (guard.kind === 'zone') return this.lastStartAt.get(guard.uid) ?? -Infinity;
    if (guard.kind === 'all') return Math.max(-Infinity, ...this.lastStartAt.values());
    return -Infinity;
  }

  /**
   * What a read says of a stop: 'done' (applied: the zone, the program, or
   * every zone and program not running nor queued), 'watch' (applied, but a
   * start sent less than 90 s before the stop may still land), 'wait' (read
   * too soon after the stop left), 'resend' (still watering, or nothing
   * readable: sent again, in doubt), 'hold' (sent again 3 times without
   * effect: held, said in the status, no more writes until a new click).
   */
  decideStop(guard, read, readStartedAt) {
    let applied;
    if (read && guard.mac && read.mac && read.mac !== guard.mac) {
      return 'other';
    }
    const zoneDry = (z) => z.state === RUN_STATES.NOT_RUNNING;
    if (guard.kind === 'zone' && read?.zones) {
      const zone = read.zones.get(guard.uid);
      applied = !zone || zoneDry(zone);
    } else if (guard.kind === 'program' && read?.programs) {
      const program = read.programs.get(guard.uid);
      applied = !program || program.status === RUN_STATES.NOT_RUNNING;
    } else if (guard.kind === 'all' && read?.zones && read?.programs) {
      guard.dryReads = 0;
      guard.programsUnread = false;
      applied =
        [...read.zones.values()].every(zoneDry) &&
        [...read.programs.values()].every((p) => p.status === RUN_STATES.NOT_RUNNING);
    } else if (guard.kind === 'all' && read?.zones) {
      // The programs cannot be read: let go only by two reads in a row showing
      // every zone dry (none watering nor queued), never by one, never by time.
      guard.programsUnread = true;
      const dry = [...read.zones.values()].every(zoneDry);
      guard.dryReads = dry ? (guard.dryReads ?? 0) + 1 : 0;
      applied = guard.dryReads >= 2;
    }
    if (applied) {
      guard.applied = true;
      return this.mono() < guard.watchUntil ? 'watch' : 'done';
    }
    guard.applied = false;
    if (!guard.written) {
      return 'resend';
    }
    if (guard.sentAt !== undefined && readStartedAt < guard.sentAt + TIMINGS.stopApplyDelay) {
      return 'wait';
    }
    return guard.resends >= TIMINGS.stopResends ? 'hold' : 'resend';
  }

  /** A read (poll or command) seen by the stops not applied: applied, or checked now. */
  observeStops(read, startedAt) {
    let check = false;
    this.retarget();
    for (const guard of [...this.stopGuards.values()]) {
      if (!sameAddress(guard.target, this.config.address)) continue;
      const decision = this.decideStop(guard, read, startedAt);
      if (decision === 'done') {
        this.dropStopGuard(guard, 'applied');
      } else if (decision === 'other') {
        this.dropStopGuard(guard, 'another controller at its address');
      } else if (decision === 'resend') {
        check = true;
      }
    }
    if (check && !this.checking) {
      this.armStopCheck(0);
    }
  }

  /**
   * The stop a start of zone `uid` undoes: that zone's own, already sent
   * (a start is refused while it never left). "Stop all" is never let go by
   * a start (it is about the programs and the other zones too).
   */
  dropStopsUndoneBy(uid, reason) {
    const guard = this.stopGuards.get(stopKey('zone', uid));
    if (guard?.written) this.dropStopGuard(guard, reason);
  }

  /**
   * The wait before a read back that must end by `answerBy`: the time the
   * controller needs to apply a write (500 ms), shortened so that the read
   * itself still fits (twice the last exchange); undefined when it cannot fit
   * at all (answered "without confirmation" at once, no connection opened).
   */
  readBackWait(answerBy) {
    const left = answerBy - this.mono() - TIMINGS.commandMinRequest;
    const need = Math.max(TIMINGS.commandMinRequest, this.exchangeMs ?? 0);
    if (left < need) return undefined;
    return Math.max(0, Math.min(TIMINGS.applyWait, left - 2 * need));
  }

  /**
   * The stops waiting for one address: every one written first (no read
   * before: a login when there is no token), each tried again every 250 ms
   * until 3 s after its click on a failure that may not have reached the
   * controller (the write is idempotent); the stops clicked meanwhile join
   * the turn; then one read back that alone confirms them. Not confirmed:
   * kept (in /data) and checked every 15 s.
   */
  async sendStops(jobs) {
    const target = jobs[0].target;
    const items = [];
    const prepare = (list) => {
      for (const job of list) items.push(this.prepareStop(job, target));
    };
    /** The stops clicked meanwhile for this address join this turn. */
    const adopt = () => {
      const late = this.stops.filter((j) => !j.running && sameAddress(j.target, target));
      for (const job of late) job.running = true;
      jobs.push(...late);
      return late;
    };
    prepare(jobs);
    // In /data before the first byte, so a restart sends them again; a save
    // that fails or hangs never holds a stop back (200 ms at most).
    await this.bounded(this.persistStops(), TIMINGS.stopSaveWait);
    for (;;) {
      const late = adopt();
      if (late.length > 0) {
        prepare(late);
        await this.bounded(this.persistStops(), TIMINGS.stopSaveWait);
      }
      const round = items.filter((i) => !i.accepted && !i.final);
      if (round.length === 0) break;
      const holder = await this.lane.acquire('stop');
      try {
        for (const item of round) {
          if (item.final) continue;
          if (!(await this.writeStop(item, target, holder))) {
            // The others cannot leave either (password, certificate, /data): kept, same reason.
            for (const other of round) {
              if (!other.accepted && !other.final) {
                other.failure = item.failure;
                other.final = true;
              }
            }
            break;
          }
        }
      } finally {
        holder.release();
      }
      for (const item of items) {
        if (!item.accepted && !item.final && this.mono() + TIMINGS.stopRetry >= item.retryUntil) {
          item.final = true;
        }
      }
      if (items.every((i) => i.accepted || i.final) && this.stops.every((j) => j.running)) break;
      if (items.some((i) => !i.accepted && !i.final)) await this.sleep(TIMINGS.stopRetry);
    }
    // One read back for all the stops accepted, once the controller had time to apply them.
    const accepted = items.filter((i) => i.accepted);
    let back;
    if (accepted.length > 0) {
      const answerBy = Math.min(...accepted.map((i) => i.job.received)) + TIMINGS.commandAnswerBy;
      const wait = this.readBackWait(answerBy);
      if (wait !== undefined) {
        const holder = await this.lane.acquire('stop');
        try {
          await this.sleep(wait, holder.signal);
          back = await this.readStopState(
            target,
            holder,
            answerBy,
            accepted.some((i) => i.guard.kind !== 'zone'),
          );
        } catch (err) {
          this.logger.debug(`RainMachine: read back of the stops failed (${errorReason(err)})`);
        } finally {
          holder.release();
        }
      }
    }
    let next = TIMINGS.stopCheck;
    for (const item of items) {
      const { guard, job } = item;
      const decision =
        back === undefined || !item.accepted ? undefined : this.decideStop(guard, back, Infinity);
      if (this.stopGuards.get(guard.key) === guard) {
        if (decision === 'done') this.dropStopGuard(guard, 'applied');
        else if (decision === 'watch') next = Math.min(next, this.watchDelay(guard));
      }
      job.resolve(this.stopResult(item, decision, back));
    }
    // Armed before /data is written, never awaited: a hung disk never stops
    // the checks nor holds the next click behind these.
    if (this.stopGuards.size > 0) {
      this.armStopCheck(next);
      this.persistStops().catch(() => {});
    }
    if (items.some((i) => i.job.state.written)) {
      this.followUp();
    }
    this.updateStatus().catch(() => {});
  }

  /** The guard of a stop clicked, renewed for this click (its resends from 0); its turn item. */
  prepareStop(job, target) {
    let guard = this.stopGuards.get(job.key);
    if (guard && !sameAddress(guard.target, target)) {
      this.dropStopGuard(guard, 'a stop to another address');
      guard = undefined;
    }
    if (!guard) {
      guard = this.newStopGuard(job, target, job.mac);
      this.stopGuards.set(job.key, guard);
    }
    guard.since = this.now();
    guard.resends = 0;
    guard.mac = job.mac ?? guard.mac;
    // A start that left less than 90 s before this click may still land: watched,
    // even when no byte of this stop leaves.
    guard.watchUntil = Math.max(guard.watchUntil, this.lastStartFor(guard) + TIMINGS.pendingFor);
    this.logger.info(`RainMachine: stop (${guard.key})`);
    return {
      job,
      guard,
      retryUntil: Math.max(job.received, this.mono()) + TIMINGS.stopRetryFor,
      failure: undefined,
      accepted: false,
      final: false,
    };
  }

  /**
   * One write of a stop clicked. False when the others cannot leave either
   * (password, certificate, /data); a failure that may not have reached the
   * controller is tried again in the next round (until 3 s after the click).
   */
  async writeStop(item, target, holder) {
    const { guard, job } = item;
    try {
      await this.call(target, {
        method: 'POST',
        path: this.stopPath(guard),
        body: this.stopBody(guard),
        // A whole exchange may take until the answer of the click (4.3 s): a slow
        // controller still gets the stop, never cut by the 3 s of the retries.
        timeoutMs: Math.max(
          TIMINGS.stopRetry,
          job.received + TIMINGS.commandAnswerBy - 200 - this.mono(),
        ),
        signal: holder.signal,
        login: 'click',
        beforeSend: () => {
          job.state.written = true;
          const at = this.mono();
          this.lastSentAt = at;
          if (this.stopGuards.get(guard.key) === guard) {
            guard.written = true;
            guard.sentAt = at;
            // A start that left shortly before may land after this stop.
            guard.watchUntil = Math.max(
              guard.watchUntil,
              this.lastStartFor(guard) + TIMINGS.pendingFor,
            );
          }
        },
      });
      item.accepted = true;
      item.failure = undefined;
      return true;
    } catch (err) {
      item.failure = err;
      this.noteStopRefused(guard, err);
      if (!transient(err)) item.final = true;
      return ![
        ERROR_KINDS.AUTH,
        ERROR_KINDS.NO_PASSWORD,
        ERROR_KINDS.CERTIFICATE,
        ERROR_KINDS.STORAGE,
      ].includes(err.kind);
    }
  }

  /** The answer to the click of a stop. */
  stopResult({ guard, job, failure }, decision, back) {
    if (decision === 'done' || decision === 'watch') {
      this.logger.info(`RainMachine: stop ${guard.key} confirmed by the controller`);
      return {};
    }
    if (failure) {
      const reason = errorReason(failure);
      this.logger.warn(`RainMachine: stop ${guard.key} failed (${reason})`);
      if (failure.kind === ERROR_KINDS.NO_PASSWORD) {
        return {
          error: this.refusal(failure.blocked ? ERRORS.stopPasswordRefused : ERRORS.stopNoPassword),
        };
      }
      if (failure.kind === ERROR_KINDS.AUTH) {
        return { error: this.refusal(ERRORS.stopPasswordRefused) };
      }
      if (failure.kind === ERROR_KINDS.CERTIFICATE) {
        return { error: this.refusal(ERRORS.stopCertificate) };
      }
      if (!job.state.written) {
        return { error: this.refusal(ERRORS.stopNotSent(reason)) };
      }
      return { error: this.refusal(ERRORS.stopSentUnconfirmed(reason)) };
    }
    return { error: this.refusal(back ? ERRORS.stopNotApplied : ERRORS.stopUnconfirmed) };
  }

  /** The identity, the zones and (when asked) the programs, on the line held, within `until`. */
  async readStopState(target, holder, until, withPrograms) {
    const get = async (path, parse) =>
      parse(
        await this.call(target, {
          path,
          timeoutMs: Math.max(TIMINGS.commandMinRequest, until - this.mono()),
          signal: holder.signal,
        }),
      );
    const read = {};
    // The identity tells "another controller" apart; unreadable, it proves nothing.
    try {
      read.mac = (await get(PATHS.wifi, parseWifi)).mac;
    } catch (err) {
      if (err.kind === ERROR_KINDS.ABORTED) throw err;
    }
    read.zones = await get(PATHS.zones, parseZones);
    if (withPrograms) {
      // Programs unreadable: the zones still decide what they can (src decideStop).
      try {
        read.programs = await get(PATHS.programs, parsePrograms);
      } catch (err) {
        if (err.kind === ERROR_KINDS.ABORTED) throw err;
      }
    }
    return read;
  }

  /** Whether a click or a command waits or runs: a check gives way to them. */
  checkMustYield() {
    return this.stops.length > 0 || Boolean(this.stopWorker) || this.starting;
  }

  /**
   * Whether a stop can try to leave now: a password known for its address and
   * not refused (a changed certificate is tried: `trust` refuses it before any
   * byte, and the pinned one back lets the stop leave).
   */
  canSend(guard) {
    return (
      Boolean(this.config.password) &&
      sameAddress(guard.target, this.config.address) &&
      !this.blocked()
    );
  }

  /**
   * The periodic check of the stops. A stop never written leaves first,
   * without a read before it (in doubt, the stop goes); then the state is
   * read once, and each stop is sent again when `decideStop` says so. It
   * gives its turn up to a click or a command (tried again a second later),
   * and checks once more right before each write. A stop that cannot leave
   * (no password, refused, certificate changed) waits, checked again when
   * that changes (a new configuration, a login, the certificate trusted).
   */
  async runCheck() {
    if (this.stopGuards.size === 0) return;
    if (this.checkMustYield() || this.checking) {
      this.armStopCheck(SECOND);
      return;
    }
    this.checking = true;
    let outcome = 'next';
    let next = TIMINGS.stopCheck;
    const written = [];
    let holder;
    try {
      outcome = await (async () => {
        this.retarget();
        const target = this.stopTarget();
        const guards = () =>
          [...this.stopGuards.values()].filter(
            (g) => sameAddress(g.target, target) && this.canSend(g),
          );
        if (guards().length === 0) return 'idle';
        holder = await this.lane.acquire('check');
        if (this.checkMustYield()) return 'yield';
        /** Sends one stop again; false when the others cannot leave either. */
        const send = async (guard) => {
          const wasWritten = guard.written;
          try {
            await this.call(target, {
              method: 'POST',
              path: this.stopPath(guard),
              body: this.stopBody(guard),
              timeoutMs: TIMINGS.readTimeout,
              signal: holder.signal,
              beforeSend: () => {
                if (this.checkMustYield() || this.stopGuards.get(guard.key) !== guard) {
                  throw new Error('a newer click or command');
                }
                this.logger.warn(`RainMachine: stop ${guard.key} sent (check)`);
                guard.written = true;
                guard.sentAt = this.mono();
                guard.watchUntil = Math.max(
                  guard.watchUntil,
                  this.lastStartFor(guard) + TIMINGS.pendingFor,
                );
                this.lastSentAt = guard.sentAt;
                written.push(guard);
              },
            });
            // Accepted by the controller: a resend (a refusal or a silence is not one).
            if (wasWritten) guard.resends += 1;
            next = Math.min(next, TIMINGS.stopApplyDelay + TIMINGS.applyWait);
            return true;
          } catch (err) {
            if (err.beforeSend) throw Object.assign(new Error('yield'), { yielded: true });
            if (err.kind === ERROR_KINDS.ABORTED) throw err;
            this.noteStopRefused(guard, err);
            // Not accepted: never counted. Unreachable or silent: the next check tries again.
            return ![
              ERROR_KINDS.AUTH,
              ERROR_KINDS.CERTIFICATE,
              ERROR_KINDS.NO_PASSWORD,
              ERROR_KINDS.STORAGE,
            ].includes(err.kind);
          }
        };
        // Never written: sent first, without a read (a stop that never left is never given up).
        for (const guard of guards().filter((g) => !g.written)) {
          if (!(await send(guard))) return 'next';
          next = Math.min(next, TIMINGS.stopApplyDelay + TIMINGS.applyWait);
        }
        const startedAt = this.mono();
        let read;
        try {
          read = await this.readStopState(
            target,
            holder,
            this.mono() + TIMINGS.readTimeout,
            guards().some((g) => g.kind !== 'zone'),
          );
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
          // Nothing readable: sent again, in doubt (the write is the stop).
          read = undefined;
        }
        for (const guard of guards()) {
          if (written.includes(guard)) continue;
          const decision = this.decideStop(guard, read, startedAt);
          if (decision === 'done') {
            this.dropStopGuard(guard, 'applied');
          } else if (decision === 'other') {
            this.dropStopGuard(guard, 'another controller at its address');
          } else if (decision === 'watch') {
            next = Math.min(next, this.watchDelay(guard));
          } else if (decision === 'wait' && guard.sentAt !== undefined) {
            next = Math.min(next, Math.max(0, guard.sentAt + TIMINGS.stopApplyDelay - this.mono()));
          } else if (decision === 'resend' && !(await send(guard))) {
            break;
          }
        }
        return 'next';
      })();
    } catch (err) {
      if (err?.yielded) {
        outcome = 'yield';
      } else if (err?.kind !== ERROR_KINDS.ABORTED) {
        this.logger.warn(`RainMachine: check of the stops failed (${errorReason(err)})`);
      } else {
        outcome = 'yield';
      }
    } finally {
      holder?.release();
      this.checking = false;
    }
    if (written.length > 0) {
      this.followUp();
    }
    if (this.stopGuards.size === 0) return;
    // Armed before /data is written (a hung disk never stops the checks). A
    // stop that cannot leave is checked again when that changes, and at the
    // next check otherwise.
    this.armStopCheck(outcome === 'yield' ? SECOND : next);
    this.persistStops().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /**
   * The stops kept for an address the configuration no longer has follow the
   * controller to its new address once a read there shows the same MAC.
   */
  retarget() {
    const address = this.config.address;
    const mac = this.controller.mac;
    if (!address || !mac || this.controller.readAt === -Infinity) return;
    for (const guard of this.stopGuards.values()) {
      if (!sameAddress(guard.target, address) && guard.mac === mac) {
        guard.target = { host: address.host, port: address.port };
      }
    }
  }

  /**
   * A stop answered with a refusal (a 4xx, a `statusCode`): not applied, so a
   * read right after it does not wait for it (`decideStop` 'wait').
   */
  noteStopRefused(guard, err) {
    if (clearRefusal(err)) {
      guard.sentAt = undefined;
    }
  }

  /** The next read of a stop watched for a late start: 15 s at most, the end of the watch at least. */
  watchDelay(guard) {
    return Math.max(0, Math.min(TIMINGS.stopCheck, guard.watchUntil - this.mono() + 1));
  }

  dropStopGuard(guard, reason) {
    if (this.stopGuards.get(guard.key) !== guard) return;
    this.stopGuards.delete(guard.key);
    this.logger.info(`RainMachine: stop ${guard.key} let go (${reason})`);
    if (this.stopGuards.size === 0 && this.checkTimer) {
      this.timers.clearTimeout(this.checkTimer);
      this.checkTimer = undefined;
      this.checkDueAt = Infinity;
    }
    this.persistStops().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** The next check of the stops: every 15 s, whatever the interval, the failures or a pause. */
  armStopCheck(delay = TIMINGS.stopCheck) {
    if (this.stopGuards.size === 0) return;
    const dueAt = this.mono() + delay;
    if (this.checkTimer) {
      // A check already due sooner (the configuration just arrived) is never pushed back.
      if (this.checkDueAt <= dueAt) return;
      this.timers.clearTimeout(this.checkTimer);
    }
    this.checkDueAt = dueAt;
    this.checkTimer = this.timers.setTimeout(() => {
      this.checkTimer = undefined;
      this.checkDueAt = Infinity;
      this.runCheck().catch((err) => this.logger.warn(`RainMachine: check: ${err.message}`));
    }, delay);
  }
}
