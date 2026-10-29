// -----------------------------------------------------------------------------
// A fake RainMachine controller behind the injected `exchange` (no network):
// its login, its zones and programs (shaped as the fixtures of regenmaschine,
// MIT, tests/fixtures), its writes, and failures on demand. Delays run on the
// injected timers (the test clock). `requests` logs "METHOD path" (without
// the query string: the token is never logged, even here).
// -----------------------------------------------------------------------------

import { ControllerError, ERROR_KINDS } from '../../src/rainmachine/http.js';

export const HOST = '192.168.1.60';
export const PASSWORD = 'S3cret pass!';
export const MAC = 'abcdef123456';
export const MAC_TEXT = 'ab:cd:ef:12:34:56';
export const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
  ':',
);
export const OTHER_FP = Array.from({ length: 32 }, (_, i) =>
  (i + 100).toString(16).toUpperCase(),
).join(':');
export const NOW = Date.UTC(2026, 9, 28, 10, 0, 0);

const answer = (status, body = '', headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const zone = (uid, name, extra = {}) => ({
  uid,
  name,
  state: 0,
  active: true,
  userDuration: 0,
  machineDuration: 0,
  remaining: 0,
  cycle: 0,
  noOfCycles: 0,
  restriction: false,
  type: 4,
  master: false,
  waterSense: false,
  ...extra,
});

/**
 * `applyDelayMs`: a start or a stop is applied that long after its answer
 * (0: at once). `failNext`: a list of failures for the next requests
 * (`'unreachable'`, `'silent'`, `'cut'`, a status number, or `{ code }`).
 */
export function fakeRainMachine({ timers = globalThis, latencyMs = 0, applyDelayMs = 0 } = {}) {
  const dev = {
    mac: MAC_TEXT,
    password: PASSWORD,
    fingerprint: FP,
    tokens: new Set(),
    latencyMs,
    applyDelayMs,
    zones: new Map([
      [1, zone(1, 'Landscaping')],
      [2, zone(2, 'Flower Box')],
      [3, zone(3, 'TEST', { active: false })],
    ]),
    programs: new Map([
      [1, { uid: 1, name: 'Morning', active: true, status: 0 }],
      [2, { uid: 2, name: 'Evening', active: true, status: 0 }],
    ]),
    restrictions: {
      hourly: false,
      freeze: false,
      month: false,
      weekDay: false,
      rainDelay: false,
      rainDelayCounter: -1,
      rainSensor: false,
    },
    flow: { useFlowSensor: true, clicks: 4000, perM3: 1000 },
    /** Paths answering `statusCode` 13 (an unknown call, as a first generation). */
    unknown: new Set(),
    /** Failures for the next requests of one 'METHOD path', in order. */
    failFor: new Map(),
    /** Failures for the next requests, in order. */
    failNext: [],
    /** Failure of every request while set (e.g. 'unreachable'). */
    down: undefined,
    /** Every request: "METHOD path" (no token). */
    requests: [],
    /** The writes: { path, body, at } (`at` from `now`). */
    writes: [],
    logins: 0,
    /** A start applied that long after its answer (on top of applyDelayMs). */
    startDelayMs: 0,
    /** A write answered that long after it arrived (the request already received). */
    writeDelayMs: 0,
    /** Latency of one 'METHOD path' (ms), else latencyMs: `(method, path) => number | undefined`. */
    latencyFor: undefined,
    /** Awaited during the handshake of each exchange: `(method, path) => Promise`. */
    duringHandshake: undefined,
    /** Called with each write as it arrives: `(write) => void`. */
    onWrite: undefined,
    /** The stops are answered OK but not applied (a controller that ignores them). */
    ignoreStops: false,
    open: 0,
    peak: 0,
    now: () => 0,
  };
  dev.count = (line) => dev.requests.filter((r) => r === line).length;
  dev.water = (uid, seconds = 600) => {
    const z = dev.zones.get(uid);
    z.state = 1;
    z.remaining = seconds;
  };

  const delay = (ms, handle) =>
    new Promise((resolve, reject) => {
      if (handle.closed) {
        reject(new ControllerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true }));
        return;
      }
      if (ms <= 0) {
        resolve();
        return;
      }
      const timer = timers.setTimeout(() => {
        handle.onClose = undefined;
        resolve();
      }, ms);
      handle.onClose = () => {
        timers.clearTimeout(timer);
        reject(new ControllerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true }));
      };
    });

  const apply = (fn, stop = false) => {
    if (stop && dev.ignoreStops) return;
    const wait = stop ? dev.applyDelayMs : Math.max(dev.applyDelayMs, dev.startDelayMs);
    if (wait > 0) timers.setTimeout(fn, wait);
    else fn();
  };

  const handle = (method, path, json) => {
    if (method === 'POST' && path === '/api/4/auth/login') {
      dev.logins += 1;
      if (json?.pwd !== dev.password) {
        return answer(401, { statusCode: 2, message: 'Not Authenticated !' });
      }
      const token = `tok${dev.logins}x${Math.floor(Math.random() * 1e6)}`;
      dev.tokens.add(token);
      return answer(200, {
        access_token: token,
        checksum: '98765',
        expires_in: 157680000,
        expiration: 'Tue, 06 Jun 2023 02:17:46 GMT',
        statusCode: 0,
      });
    }
    return undefined;
  };

  const routes = (method, path, json) => {
    if (dev.unknown.has(path)) return { statusCode: 13, message: 'API call unknown' };
    if (method === 'GET') {
      switch (path) {
        case '/api/4/provision/wifi':
          return { macAddress: dev.mac, ssid: null, interface: 'wlan0', ipAddress: HOST };
        case '/api/4/provision/name':
          return { name: 'My House' };
        case '/api/4/apiVer':
          return { apiVer: '4.5.0', hwVer: 3, swVer: '4.0.925' };
        case '/api/4/provision':
          return {
            system: {
              useFlowSensor: dev.flow.useFlowSensor,
              flowSensorWateringClicks: dev.flow.clicks,
              flowSensorClicksPerCubicMeter: dev.flow.perM3,
              flowSensorLeakClicks: 10,
            },
            location: { name: 'private' },
          };
        case '/api/4/zone':
          return { zones: [...dev.zones.values()].map((z) => ({ ...z })) };
        case '/api/4/program':
          return { programs: [...dev.programs.values()].map((p) => ({ ...p })) };
        case '/api/4/restrictions/currently':
          return { ...dev.restrictions };
        default:
          return undefined;
      }
    }
    let m = /^\/api\/4\/zone\/(\d+)\/(start|stop)$/.exec(path);
    if (m) {
      const z = dev.zones.get(Number(m[1]));
      if (!z) return { statusCode: 5, message: 'Not found' };
      if (m[2] === 'start') {
        apply(() => {
          z.state = 1;
          z.remaining = json?.time;
        });
      } else {
        apply(() => {
          z.state = 0;
          z.remaining = 0;
        }, true);
      }
      return { statusCode: 0, message: 'OK' };
    }
    m = /^\/api\/4\/program\/(\d+)\/stop$/.exec(path);
    if (m) {
      const p = dev.programs.get(Number(m[1]));
      if (!p) return { statusCode: 5, message: 'Not found' };
      apply(() => {
        p.status = 0;
      }, true);
      return { statusCode: 0, message: 'OK' };
    }
    if (path === '/api/4/watering/stopall') {
      apply(() => {
        for (const z of dev.zones.values()) {
          z.state = 0;
          z.remaining = 0;
        }
        for (const p of dev.programs.values()) p.status = 0;
      }, true);
      return { statusCode: 0, message: 'OK' };
    }
    return undefined;
  };

  dev.exchange = async ({ host, port, trust, method, path, body, beforeSend, onOpen }) => {
    const h = { closed: false, onClose: undefined };
    h.close = () => {
      if (h.closed) return;
      h.closed = true;
      h.onClose?.();
    };
    onOpen?.(h);
    dev.open += 1;
    dev.peak = Math.max(dev.peak, dev.open);
    try {
      const forPath = dev.failFor.get(`${method} ${path.split('?')[0]}`);
      const failure =
        forPath?.length > 0
          ? forPath.shift()
          : dev.failNext.length > 0
            ? dev.failNext.shift()
            : dev.down;
      if (failure === 'unreachable' || host !== HOST || port !== 8080) {
        await delay(0, h);
        throw new ControllerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      await delay(dev.latencyFor?.(method, path.split('?')[0]) ?? dev.latencyMs, h);
      // During the handshake (before the bytes of the request): the test may act.
      await dev.duringHandshake?.(method, path.split('?')[0]);
      await trust(dev.fingerprint);
      if (h.closed) {
        throw new ControllerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
      }
      const [bare, query] = path.split('?');
      beforeSend?.();
      dev.requests.push(`${method} ${bare}`);
      if (failure === 'silent') {
        await delay(10 * 60_000, h);
      }
      if (failure === 'cut') {
        throw new ControllerError(ERROR_KINDS.TIMEOUT, 'Connection lost');
      }
      if (typeof failure === 'number') {
        return answer(failure, failure === 429 ? '' : { statusCode: 99, message: 'error' });
      }
      if (failure && typeof failure === 'object') {
        return answer(200, { statusCode: failure.code, message: 'error' });
      }
      const json = body === undefined ? undefined : JSON.parse(body);
      const login = handle(method, bare, json);
      if (login) return login;
      const token = new URLSearchParams(query ?? '').get('access_token');
      if (!dev.tokens.has(token)) {
        return answer(401, { statusCode: 2, message: 'Not Authenticated !' });
      }
      if (method === 'POST') {
        const write = { path: bare, body: json, at: dev.now() };
        dev.writes.push(write);
        dev.onWrite?.(write);
        if (dev.writeDelayMs > 0) await delay(dev.writeDelayMs, h);
      }
      const result = routes(method, bare, json);
      return result === undefined ? answer(404, '') : answer(200, result);
    } finally {
      dev.open -= 1;
    }
  };
  return dev;
}
