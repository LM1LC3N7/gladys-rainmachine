# TODO — RainMachine v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, Node 22 and 24, Docker,
  store validator), `npm run audit`, then update README, `docs/en.md`,
  `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum post from a module session: the batch reserved in /t/10385
  (lot 18) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No `keywords` nor `countries` in the manifest yet (the core has not
  shipped them; `countries` would be US, CA).

## Status

- [x] **Milestone 1 — core** (2026-10-29): one controller by address and
      password over HTTPS (certificate pinned), devices for the controller,
      its active zones and its programs; watering, restrictions, time
      remaining, programs running, water used behind a counter guard; stops of
      a zone, a program, all (never held back, kept in `/data`, never given up
      before they left); start of a zone behind `allow_watering`, 1 to 60 min;
      never read sooner than the interval; docs en/fr, cover. Tested against
      fakes built from regenmaschine and its fixtures only.
- [ ] **Milestone 2 — real controller**: run against a real RainMachine (see
      "To check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: pause and resume (`watering/pauseall`), rain
      delay, program start, the leak counter of the flow sensor, several
      controllers, scene actions.

## To check on a real controller

- The answer of a wrong password: HTTP 401 with `statusCode` 2 (assumed), or
  200 with `statusCode` 2? Anything for too many tries?
- The answer of the start and stop commands (`{ statusCode: 0 }`, as the
  fixtures), and the time before `zone` shows the new state (read back after
  500 ms).
- Whether `zone/<uid>/stop` also removes a zone queued (`state` 2), and
  whether `watering/stopall` stops the programs too (assumed: the check reads
  both).
- `remaining` while queued; `flowSensorWateringClicks` after a reset of the
  sensor (the guard holds the drop).
- A first generation controller: the fallback to TLS 1.0 at security level 0
  with legacy renegotiation, with Node 24's OpenSSL; `restrictions/currently` answering `statusCode` 13 (read as absent,
  tried again hourly).
- The certificate of a controller across a firmware update (a new
  certificate means two clicks for the user).

## Decisions

- **Review r2 (2026-10-29)**:
  - B3: until /data is loaded, `trust()` refuses (no pin learnt, nothing
    sent, no secret) and `saveMemory()` writes nothing; the status says /data
    is being read; a stop clicked meanwhile is kept and checked once it is
    loaded (`armStopCheck(0)` at the end of the load).
  - I1: a test for the guard `protectSeq` of `checkCommand` (a start waiting
    for the line behind a stop answered with a refusal).
  - m1: "Stop all" while the programs cannot be read is let go by two reads
    in a row showing every zone dry (never by one, never by time); said in
    the status. The read back of the stops keeps the zones when the programs
    fail.
  - m2: the legacy TLS fallback only on an OpenSSL alert (`ERR_SSL_*`), never
    on a reset or a cut.
  - m3: tests for the 2 s bound of the saves, the shorter wait of the read
    back (the wait estimated from the last read, not a write), the status
    before the configuration. The reviewer's mutants "trust before load"
    (the save of a first pin also refuses before the load) are equivalent.

- **Review r1 (2026-10-29)**:
  - B1: every save to /data is bounded (2 s, `saveWait`); a read applies the
    stops before its saves; `start()` never waits for the read of the previous
    configuration nor for its own first read; the check of the stops is
    started (not awaited) at a new configuration and after a login, and armed
    again when it is idle; the retry of `getConfig()` is armed before /data
    is read.
  - B2: a start lets go only the stop of its own zone, once that stop left;
    a start is refused while "Stop all" is kept (a read alone lets it go) or
    while a stop of its zone has not left.
  - I1: the stops clicked together (and those clicked meanwhile) are all
    written first, one turn on the line, then one read back; each write may
    take until the answer of its click (4.3 s), never cut at 3 s.
  - I2: tests for a resend answered 503 or cut (not counted), the floor
    after an accepted drop, the option turned off during the handshake of the
    write, the bounded save of a lifted refusal (B1 test).
  - m1: the read back waits less when the answer nears (twice the last
    exchange kept for the read), and is skipped when it cannot fit; numbers
    of a scene documented (5 zones at 500 ms: all confirmed in 4.1 s; at
    900 ms: 2 written, 3 "nothing sent").
  - m2: modern TLS (1.2+) first; the legacy handshake (TLS 1.0, SECLEVEL 0,
    `SSL_OP_LEGACY_SERVER_CONNECT`) only when a controller refuses it at its
    first connection; the pin keeps which (`legacy`), a controller pinned
    modern is never spoken to in legacy TLS; documented with the risk.
  - m3: the status before the configuration never says "enter the address";
    "could not be read" while `getConfig()` fails. m4: a stop kept for another
    address says it waits for the same MAC at the new address. m5: docs.
    m6: a zone already queued is confirmed only by its remaining time equal
    to the length written.
  - Mutants (24, mine on the corrections): all killed by the suite then; the
    review r2 found 4 more surviving (I1 and m3 of r2), killed since.

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-rainmachine:0.1.0`): the first Release (patch)
  gives 0.1.1. SDK `^0.16.0` (latest published, `dist-tags.latest` checked
  2026-10-28; changelog read: nothing this module relies on changed).
- **Reference**: regenmaschine 2024.3.0 (MIT, Aaron Bach, commit `1c530f7`,
  LICENSE read), cloned read only in `~/code/ref/lot18/regenmaschine`; Home
  Assistant's `rainmachine` integration (Apache-2.0) read for the meaning of
  the fields (`~/code/ref/lot18/ha-rainmachine`). Neighbours followed:
  gladys-warp-charger (stop, lane, guard, approved r4), gladys-sma-ev-charger
  (pinned TLS transport), gladys-yardian (sprinklers).
- **Local API only**: the cloud (my.rainmachine.com, "remote access") is never
  used. HTTPS only (an `http://` address is said in the status).
- **The access token in the query string**: the API takes it nowhere else
  (regenmaschine). It travels only over the pinned TLS, lives in memory only,
  and the path with it is never logged nor put in an error.
- **The password is never in `/data`**: a stop kept across a restart leaves
  once Gladys gives the configuration (the controller wants a token for every
  request, a token wants the password). Documented in the list of the cases a
  stop does not leave at once.
- **A refused password** (login 401 or `statusCode` 2) is final until another
  password is saved, a login of "Test the connection" (one a minute) or of a
  stop click (one a minute) succeeds. A 400 or 403 of the login, or a refusal
  right after a fresh token, is not a refused password.
- **Identity**: the MAC address of `provision/wifi` (12 lower-case hex
  digits); external ids `rainmachine:<mac>`, `rainmachine-zone:<mac>-<uid>`,
  `rainmachine-program:<mac>-<uid>`. A read showing another MAC at the address:
  the old devices unreachable, starts refused, the stops of the old one let
  go (positive proof); an unreadable identity proves nothing.
- **Stops**: zone (`zone/<uid>/stop`), program (`program/<uid>/stop`), all
  (`watering/stopall`), one kept guard per target in `/data`. Applied when
  the zone (the program, every zone and program) reads not running nor
  queued. Never written: sent first at each check, without a read. Written:
  resent 3 times at most once the controller accepted it, then held. Let go
  by a newer start of that zone (or any zone for "all") that left from
  Gladys, never by time. A stop clicked during a start cuts it.
- **Start**: only for an active zone; the length is the configuration, 1 to
  60 min (bounded again before the write); confirmed only by `state` 1;
  `state` 2 (queued) is answered "queued". Never "already so" while a stop of
  that zone or "all" is kept.
- **No program start, no pause, no resume in v1**: a program waters for a
  length Gladys cannot bound; the API gives no pause state to confirm a
  pause, and "Stop all" is the protective. Milestone 3.
- **Water used**: litres = clicks × 1000 / clicks per m³ (Home Assistant);
  the app's gallons are a display unit only (the API is metric). Behind the
  p1-monitor guard (100 L/min, 50 L slack), accepted in two clicks.
- **Feature always built**: the water counter exists even without a flow
  sensor (it stays empty), so a republished device never loses it.
- **Mutation check** (2026-10-29): 43 mutants of the guards (option on
  arrival, in the checks and in `beforeSend`, stop sequence, send deadline,
  length bound, inactive zone, identity, confirmation, never "already so"
  under a kept stop, newer start, stop retries within 3 s, resends counted
  only once accepted, hold after 3, stop in /data before its byte and its
  bounded save, stops before the reads at a new configuration and after a
  login, login by a click only while refused, pin checked, first pin saved,
  another MAC, never sooner than the interval, read begun before a write,
  429 pause, secondary isolation, freshness, counter guard, two clicks,
  refusal of an old password, token refused right after a login, a bare 401
  of the login, strict integers, resends of a stop never written, strict
  `true`, certificate checked before the first byte). 38 killed by the
  tests; 5 equivalent and kept: the option checked on arrival (checked again
  at once in `queueStart`), "never written: resend" in `decideStop` (the
  same decision follows), no automatic login while refused (reads, checks
  and starts stop before), `/data` unreadable in `trust` (the save of a
  first pin fails then), the watch of a late start set before the stop's
  byte (set again in every `beforeSend`).

## Next patch

- r3 m1: two fixes have no test that catches their removal: the shorter wait before the read back
  (`src/app.js:2411`; with the full 500 ms, "5 starts at 500 ms" drops to 0/5 confirmed, s8b) and the reset of
  the dry-read count on a full read (`src/app.js:2344`; "Stop all" could be lifted by two non-consecutive dry
  reads).
- r3 m2: the TLS fallback checks the error code after the 40-character cap of `code()` (`src/http.js:91`), so
  `ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED` never triggers it (minor: a TLS 1.0-only controller first
  answers with the version alert).
- r3 m3: the "24 mutants, all killed" line above is out of date (r3: 50 mutants, 38 killed, 10 equivalent).
