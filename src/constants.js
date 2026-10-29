// -----------------------------------------------------------------------------
// RainMachine constants, manifest keys, limits and timings.
//
// A RainMachine sprinkler controller (Mini-8, Touch HD, Pro, Gen 1 to 3)
// answers its local REST API (version 4) over HTTPS on port 8080, with a
// self-signed certificate:
//   - `POST /api/4/auth/login` with `{ pwd, remember }` gives an
//     `access_token`, passed with every other request as the query parameter
//     `access_token` (the API has no header for it);
//   - every answer is JSON; an error says `statusCode` (0 OK, 2 "Not
//     Authenticated", 13 "API call unknown", others refused).
// Only the paths below are read or written. Ported from regenmaschine
// 2024.3.0 (MIT, Aaron Bach, the library of Home Assistant's `rainmachine`),
// checked against Home Assistant's integration (Apache-2.0) for the meaning
// of the fields. The cloud ("remote access", my.rainmachine.com) is never
// used.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 8080;

/** The paths read (GET) and written (POST). Never any other. */
export const PATHS = {
  login: '/api/4/auth/login',
  wifi: '/api/4/provision/wifi',
  name: '/api/4/provision/name',
  versions: '/api/4/apiVer',
  provision: '/api/4/provision',
  zones: '/api/4/zone',
  programs: '/api/4/program',
  restrictions: '/api/4/restrictions/currently',
  zoneStart: (uid) => `/api/4/zone/${uid}/start`,
  zoneStop: (uid) => `/api/4/zone/${uid}/stop`,
  programStop: (uid) => `/api/4/program/${uid}/stop`,
  stopAll: '/api/4/watering/stopall',
};

/** `statusCode` of an answer (regenmaschine errors.py). */
export const STATUS_CODES = {
  OK: 0,
  NOT_AUTHENTICATED: 2,
  UNKNOWN_CALL: 13,
};

/** The run states of a zone (`state`) and of a program (`status`): HA util.py RUN_STATE_MAP. */
export const RUN_STATES = {
  NOT_RUNNING: 0,
  RUNNING: 1,
  QUEUED: 2,
};

/** External id types (`gladys.externalIds(type, id)`): frozen. */
export const EXTERNAL_ID_TYPES = {
  CONTROLLER: 'rainmachine',
  ZONE: 'rainmachine-zone',
  PROGRAM: 'rainmachine-program',
};

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  // Controller.
  WATERING: 'watering',
  RAIN_DELAY: 'rain_delay',
  FREEZE: 'freeze',
  RAIN_SENSOR: 'rain_sensor',
  HOURLY: 'hourly',
  MONTH: 'month',
  WEEKDAY: 'weekday',
  WATER_USED: 'water_used',
  STOP_ALL: 'stop_all',
  // Zone.
  REMAINING: 'remaining',
  START: 'start',
  STOP: 'stop',
  // Program.
  RUNNING: 'running',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  TRUST_CERTIFICATE: 'trust_certificate',
  ACCEPT_HELD_COUNTER: 'accept_held_counter',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/**
 * The watering length of a zone started from Gladys, in minutes: the
 * configuration, bounded here again before every write.
 */
export const WATERING_MINUTES = { min: 1, max: 60, default: 10 };

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = { min: 15, max: 600, default: 60 };

/**
 * The water counter guard (src/guard.js): the most a home irrigation may
 * draw on average between two reads (100 L/min), and the litres always
 * accepted on top (rounding, a late read).
 */
export const COUNTER_MAX_PER_HOUR = 6000;
export const COUNTER_SLACK = 50;

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** The largest answer read (provision is a few KB): cut beyond. */
  responseBytes: 64 * 1024,
  headerBytes: 8 * 1024,
  /** The most zones and programs read from one controller. */
  zones: 64,
  programs: 64,
  /** Longest name kept from an answer (controller, zone, program). */
  textLength: 60,
  /** The password of the controller: printable ASCII, bounded. */
  secretMin: 1,
  secretMax: 128,
  /** An access token of the controller: letters and digits only, bounded. */
  tokenMax: 256,
  /** Stops kept at once (one per zone, per program, and "all"). */
  stops: 130,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (TLS handshake included; a Gen 1 is slow). */
  readTimeout: 8 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429: Retry-After bounded to 1 min .. 6 h, 5 min without; a 5xx pauses as a failed read. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** A secondary path that fails: tried again after twice the interval, doubling up to 1 h. */
  secondaryMaxWait: HOUR,
  /** The name and the versions: at the start, then every hour. */
  slowRefresh: HOUR,
  /** The time of the last read is written to /data at most this often, before the read. */
  attemptWriteEvery: MINUTE,
  /** `getConfig()` failed: tried again this often, forever. */
  configRetry: 30 * SECOND,
  /** A login (with the password) at most this often when asked by a click while refused. */
  loginClickEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** Values older than this are never sent as new (reconnection, device created). */
  freshFor: 2 * MINUTE,
  /** Two-click buttons: the second click 3 s to 5 min after the first. */
  confirmAfter: 3 * SECOND,
  confirmWithin: 5 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the write must leave by 3.5 s
   * after the click, or the command is refused unsent; the ack comes by
   * 4.3 s, after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The least time a request of a command gets. */
  commandMinRequest: 250,
  /** After a write, the read back waits this long. */
  applyWait: 500,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A start not confirmed: a new one is always sent for this long (never "already so"). */
  pendingFor: 90 * SECOND,
  /** The stop: tried again every 250 ms until 3 s after the click. */
  stopRetry: 250,
  stopRetryFor: 3_000,
  /** The stop waits at most this long for /data (a failing disk never holds it). */
  stopSaveWait: 200,
  /** The first pin waits at most this long for /data before the password leaves. */
  pinSaveWait: SECOND,
  /** A stop not seen applied: checked every 15 s. */
  stopCheck: 15 * SECOND,
  /** A read that started this soon after the stop left may not show it yet. */
  stopApplyDelay: 2 * SECOND,
  /** A stop not applied is written again at most 3 times (then held, said in the status). */
  stopResends: 3,
};
