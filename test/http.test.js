// -----------------------------------------------------------------------------
// The real transport (src/rainmachine/http.js) and the real client against
// real TLS servers on the loopback (the testkit's device certificate, an
// impostor, a refused port): the certificate checked BEFORE any byte is
// written (the password included), no byte of an impostor read, the token
// renewed once, a refused login told from other failures, the bounds of the
// answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RainMachineClient } from '../src/rainmachine/client.js';
import {
  AnswerParser,
  ControllerError,
  ERROR_KINDS,
  exchange,
  normalizeFingerprint,
} from '../src/rainmachine/http.js';
import { certs, httpsServer, impostorServer, refusePort, reply } from './kit/index.mjs';

const PIN = normalizeFingerprint(certs.device.fingerprint256);
const pinned =
  (expected = PIN) =>
  async (fingerprint) => {
    if (fingerprint !== expected) {
      throw new ControllerError(ERROR_KINDS.CERTIFICATE, 'changed', {
        notSent: true,
        fingerprint,
      });
    }
  };

async function controller(t, { password = 'pass "word"', extra = {} } = {}) {
  const state = { token: 'tok1', logins: 0 };
  const authed = (r) => r.query.access_token === state.token;
  const srv = await httpsServer({
    routes: {
      'POST /api/4/auth/login': (r) => {
        state.logins += 1;
        if (r.json?.pwd !== password)
          return reply(401, { statusCode: 2, message: 'Not Authenticated !' });
        state.token = `tok${state.logins}`;
        return { access_token: state.token, expires_in: 157680000, statusCode: 0 };
      },
      'GET /api/4/provision/wifi': (r) =>
        authed(r)
          ? { macAddress: 'ab:cd:ef:12:34:56' }
          : { statusCode: 2, message: 'Not Authenticated !' },
      'POST /api/4/zone/1/stop': (r) =>
        authed(r) ? { statusCode: 0, message: 'OK' } : reply(401, { statusCode: 2 }),
      ...extra,
    },
  });
  t.after(() => srv.close());
  return { srv, state };
}

const callOf = (client, srv, options = {}) =>
  client.call({
    address: { host: srv.host, port: srv.port },
    password: 'pass "word"',
    key: 'k',
    trust: pinned(),
    timeoutMs: 3_000,
    now: () => performance.now(),
    path: '/api/4/provision/wifi',
    ...options,
  });

test('the real client over TLS: login, the token as a query parameter, a write', async (t) => {
  const { srv } = await controller(t);
  const client = new RainMachineClient();
  const wifi = await callOf(client, srv);
  assert.equal(wifi.macAddress, 'ab:cd:ef:12:34:56');
  assert.deepEqual(srv.requests[0].json, { pwd: 'pass "word"', remember: 1 });
  assert.equal(srv.requests[0].query.access_token, undefined);
  assert.equal(srv.requests[1].query.access_token, 'tok1');
  assert.equal(srv.requests[1].headers.connection, 'close');
  await callOf(client, srv, { method: 'POST', path: '/api/4/zone/1/stop', body: { zid: 1 } });
  assert.deepEqual(srv.requests.at(-1).json, { zid: 1 });
  assert.equal(srv.requests.length, 3, 'the token kept: no second login');
});

test('an expired token: one login more, the call sent again once', async (t) => {
  const { srv, state } = await controller(t);
  const client = new RainMachineClient();
  await callOf(client, srv);
  state.token = 'renewed elsewhere';
  await callOf(client, srv);
  assert.deepEqual(
    srv.requests.map((r) => `${r.method} ${r.path}`),
    [
      'POST /api/4/auth/login',
      'GET /api/4/provision/wifi',
      'GET /api/4/provision/wifi',
      'POST /api/4/auth/login',
      'GET /api/4/provision/wifi',
    ],
  );
});

test('a refused password is AUTH; a 400 or a 403 of the login is not; a refusal on a fresh token is FORBIDDEN', async (t) => {
  const { srv } = await controller(t, { password: 'other' });
  await assert.rejects(
    callOf(new RainMachineClient(), srv),
    (err) => err.kind === ERROR_KINDS.AUTH,
  );
  const { srv: bare401 } = await controller(t, {
    extra: { 'POST /api/4/auth/login': () => reply(401, '') },
  });
  await assert.rejects(
    callOf(new RainMachineClient(), bare401),
    (err) => err.kind === ERROR_KINDS.AUTH,
  );
  const { srv: s400 } = await controller(t, {
    extra: { 'POST /api/4/auth/login': () => reply(400, { statusCode: 1 }) },
  });
  await assert.rejects(
    callOf(new RainMachineClient(), s400),
    (err) => err.kind === ERROR_KINDS.HTTP && err.status === 400,
  );
  const { srv: s403 } = await controller(t, {
    extra: { 'POST /api/4/auth/login': () => reply(403, '') },
  });
  await assert.rejects(
    callOf(new RainMachineClient(), s403),
    (err) => err.kind === ERROR_KINDS.HTTP,
  );
  const { srv: forbidden } = await controller(t, {
    extra: { 'GET /api/4/provision/wifi': () => ({ statusCode: 2 }) },
  });
  await assert.rejects(
    callOf(new RainMachineClient(), forbidden),
    (err) => err.kind === ERROR_KINDS.FORBIDDEN,
  );
});

test('statusCode 13 is an unknown call; a 429 keeps its Retry-After', async (t) => {
  const { srv } = await controller(t, {
    extra: {
      'GET /api/4/restrictions/currently': () => ({ statusCode: 13, message: 'API call unknown' }),
      'GET /api/4/zone': () => reply(429, '', { 'Retry-After': '120' }),
    },
  });
  const client = new RainMachineClient();
  await assert.rejects(
    callOf(client, srv, { path: '/api/4/restrictions/currently' }),
    (err) => err.kind === ERROR_KINDS.REJECTED && err.code === 13,
  );
  await assert.rejects(
    callOf(client, srv, { path: '/api/4/zone' }),
    (err) => err.kind === ERROR_KINDS.RATE_LIMITED && err.retryAfter === 120_000,
  );
});

test('the password is never written to another certificate', async (t) => {
  const { srv } = await controller(t);
  await assert.rejects(
    callOf(new RainMachineClient(), srv, { trust: pinned('AA:' + PIN.slice(3)) }),
    (err) => err.kind === ERROR_KINDS.CERTIFICATE && err.notSent === true,
  );
  assert.equal(srv.requests.length, 0);
});

test('an impostor writing first: refused on its certificate, nothing written to it', async (t) => {
  const imp = await impostorServer();
  t.after(() => imp.close());
  await assert.rejects(
    exchange({
      host: imp.host,
      port: imp.port,
      timeoutMs: 2_000,
      trust: pinned(),
      method: 'POST',
      path: '/api/4/auth/login',
      body: '{"pwd":"secret"}',
    }),
    (err) => err.kind === ERROR_KINDS.CERTIFICATE,
  );
  assert.equal(imp.received, 0, 'nothing written to the impostor');
});

test('a refused port is unreachable, nothing sent; a silent controller times out after sending', async (t) => {
  const port = await refusePort();
  await assert.rejects(
    exchange({
      host: '127.0.0.1',
      port,
      timeoutMs: 1_000,
      trust: pinned(),
      method: 'GET',
      path: '/',
    }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
  const { srv } = await controller(t, { extra: { 'GET /api/4/zone': 'silent' } });
  const client = new RainMachineClient();
  await callOf(client, srv);
  const started = performance.now();
  await assert.rejects(
    callOf(client, srv, { path: '/api/4/zone', timeoutMs: 300 }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT && err.sent === true,
  );
  assert.ok(performance.now() - started < 2_000);
});

test('an answer above 64 KB is cut before it is read whole', async (t) => {
  const { srv } = await controller(t);
  const client = new RainMachineClient();
  await callOf(client, srv);
  srv.bigBody = 200 * 1024;
  await assert.rejects(
    callOf(client, srv),
    (err) => err.kind === ERROR_KINDS.PROTOCOL && /too large/.test(err.message),
  );
});

test('beforeSend refusing: nothing written, its own error kept', async (t) => {
  const { srv } = await controller(t);
  const client = new RainMachineClient();
  await callOf(client, srv);
  const before = srv.requests.length;
  const refusal = new Error('option off');
  await assert.rejects(
    callOf(client, srv, {
      method: 'POST',
      path: '/api/4/zone/1/stop',
      beforeSend: () => {
        throw refusal;
      },
    }),
    (err) => err.notSent === true && err.beforeSend === true && err.cause === refusal,
  );
  assert.equal(srv.requests.length, before);
});

test('an aborted signal closes the exchange: nothing sent', async (t) => {
  const { srv } = await controller(t);
  const controllerAbort = new AbortController();
  controllerAbort.abort();
  await assert.rejects(
    callOf(new RainMachineClient(), srv, { signal: controllerAbort.signal }),
    (err) => err.kind === ERROR_KINDS.ABORTED && err.sent === false,
  );
  assert.equal(srv.requests.length, 0);
});

test('the answer parser: chunked, interim answers, bounded head', () => {
  const parser = new AnswerParser();
  const done = parser.push(
    Buffer.from(
      'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n',
    ),
  );
  assert.equal(done, true);
  assert.equal(parser.result().body, 'abc');
  const big = new AnswerParser();
  assert.throws(
    () => big.push(Buffer.from(`HTTP/1.1 200 OK\r\nX: ${'a'.repeat(9000)}`)),
    /Head too large/,
  );
});
