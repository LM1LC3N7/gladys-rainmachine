// -----------------------------------------------------------------------------
// The RainMachine local API (version 4), as regenmaschine 2024.3.0 speaks it
// (client.py, controller.py, errors.py): a login with the password of the
// controller gives an access token, sent with every other request as the
// query parameter `access_token` (the API has no header for it); every answer
// is JSON, and an error is said by `statusCode` (2: not authenticated, 13: an
// unknown call, e.g. on a first generation controller).
//
// The token lives in memory only (never in /data, a log, a status or an
// error): a restart logs in again. It belongs to one address and one
// password: another one of either forgets it. A request refused for its token
// (HTTP 401 or `statusCode` 2) logs in once more and is sent again with the
// new token (a token expires); a login refused (HTTP 401 or `statusCode` 2)
// is a refused password (AUTH). A 400 or a 403 of the login is not one (a
// controller busy, a firmware oddity): an HTTP failure. A refusal right after
// a fresh login is not the password either (FORBIDDEN).
//
// Every exchange is its own TLS connection whose certificate is checked by
// `trust` before any byte is written (src/rainmachine/http.js). Nothing is
// retried here but the token renewal: the app spaces its own new tries, and a
// write is never sent twice by the client.
// -----------------------------------------------------------------------------

import { LIMITS, PATHS, STATUS_CODES } from '../constants.js';
import { ControllerError, ERROR_KINDS, exchange as tlsExchange, notSent } from './http.js';

const TOKEN = new RegExp(`^[A-Za-z0-9._~-]{1,${LIMITS.tokenMax}}$`);

/** Retry-After in ms: seconds, or an HTTP date against the controller's own `Date`. */
function retryAfterOf(headers) {
  const raw = headers?.['retry-after'];
  if (typeof raw !== 'string') return undefined;
  if (/^\s*\d{1,6}\s*$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  const now = Date.parse(headers?.date ?? '');
  // Without a readable `Date` of the controller, a date is not compared with our clock.
  return Number.isFinite(at) && Number.isFinite(now) && at > now ? at - now : undefined;
}

/** The JSON of an answer, or undefined (an empty or broken body). */
function jsonOf(res) {
  if (typeof res?.body !== 'string' || res.body.trim() === '') return undefined;
  try {
    return JSON.parse(res.body);
  } catch {
    return undefined;
  }
}

const codeOf = (json) =>
  json && typeof json === 'object' && !Array.isArray(json) && Number.isInteger(json.statusCode)
    ? json.statusCode
    : undefined;

/**
 * What an answer says: `{ json }` for a success, `{ auth: true }` for a
 * refused token or password, or throws the failure.
 */
function classify(res) {
  const json = jsonOf(res);
  const code = codeOf(json);
  if (res.status === 401 || code === STATUS_CODES.NOT_AUTHENTICATED) {
    return { auth: true, status: res.status };
  }
  if (res.status === 429) {
    throw new ControllerError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status: 429,
      retryAfter: retryAfterOf(res.headers),
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ControllerError(ERROR_KINDS.HTTP, `HTTP ${res.status}`, {
      status: res.status,
      redirect: res.status >= 300 && res.status < 400,
    });
  }
  if (json === undefined || typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ControllerError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');
  }
  if (code !== undefined && code !== STATUS_CODES.OK) {
    throw new ControllerError(ERROR_KINDS.REJECTED, `statusCode ${code}`, { code });
  }
  return { json };
}

export class RainMachineClient {
  constructor({ exchange = tlsExchange } = {}) {
    this.exchange = exchange;
    /** `{ key, token }`: the token of one address and password (memory only). */
    this.session = undefined;
  }

  /** Forgets the token (new address, new password, a refused login). */
  reset() {
    this.session = undefined;
  }

  /** Whether a token is held for this key (address and password). */
  hasToken(key) {
    return this.session?.key === key;
  }

  /**
   * One exchange (one TLS connection). `signal` closes it; `beforeSend` runs
   * right before the bytes leave. Marks a failure `sent` when the request may
   * have reached the controller.
   */
  async once({ address, trust, method, path, body, until, now, signal, beforeSend }) {
    let sent = false;
    const left = () => Math.max(1, Math.round(until - now()));
    if (signal?.aborted) {
      throw new ControllerError(ERROR_KINDS.ABORTED, 'Given up', { notSent: true, sent: false });
    }
    let onAbort;
    try {
      return await this.exchange({
        host: address.host,
        port: address.port,
        timeoutMs: left(),
        trust,
        method,
        path,
        body: body === undefined ? undefined : JSON.stringify(body),
        beforeSend: () => {
          beforeSend?.();
          sent = true;
        },
        onOpen: (handle) => {
          onAbort = () => handle.close();
          signal?.addEventListener('abort', onAbort, { once: true });
        },
      });
    } catch (err) {
      if (err instanceof ControllerError) {
        err.sent = Boolean(err.sent) || (sent && !notSent(err));
        throw err;
      }
      // A refusal thrown by `beforeSend` (the app's own checks): nothing left.
      throw Object.assign(new ControllerError(ERROR_KINDS.ABORTED, 'Refused before sending'), {
        notSent: true,
        sent: false,
        cause: err,
        beforeSend: true,
      });
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Logs in with the password: the token, kept for `key`. Throws AUTH when refused. */
  async login({ address, password, key, trust, until, now, signal }) {
    if (!password) {
      throw new ControllerError(ERROR_KINDS.NO_PASSWORD, 'No password', { notSent: true });
    }
    this.session = undefined;
    const res = await this.once({
      address,
      trust,
      method: 'POST',
      path: PATHS.login,
      body: { pwd: password, remember: 1 },
      until,
      now,
      signal,
    });
    const answer = classify(res);
    if (answer.auth) {
      throw new ControllerError(ERROR_KINDS.AUTH, 'Password refused', {
        status: answer.status,
        sent: true,
      });
    }
    const token = answer.json.access_token;
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      throw new ControllerError(ERROR_KINDS.PROTOCOL, 'No access token', { sent: true });
    }
    this.session = { key, token };
    return token;
  }

  /**
   * One call of the API with the token of `key` (logged in first when there
   * is none; once more when it was refused). Resolves the JSON object of a
   * success. `beforeSend` runs before the call itself only (never before a
   * login); `onLogin` is told of every login accepted.
   */
  async call({
    address,
    password,
    key,
    trust,
    method = 'GET',
    path,
    body,
    timeoutMs,
    now,
    signal,
    beforeSend,
    onLogin,
  }) {
    const until = now() + timeoutMs;
    const base = { address, trust, until, now, signal };
    let fresh = false;
    if (!this.hasToken(key)) {
      await this.login({ ...base, password, key });
      fresh = true;
      onLogin?.();
    }
    for (;;) {
      const token = this.session.token;
      const res = await this.once({
        ...base,
        method,
        path: `${path}?access_token=${encodeURIComponent(token)}`,
        body,
        beforeSend,
      });
      let answer;
      try {
        answer = classify(res);
      } catch (err) {
        err.sent = true;
        throw err;
      }
      if (!answer.auth) {
        return answer.json;
      }
      if (fresh) {
        // Refused right after a login: not the password (a right missing, a firmware oddity).
        this.reset();
        throw new ControllerError(ERROR_KINDS.FORBIDDEN, 'Token refused', {
          status: answer.status,
          sent: true,
        });
      }
      // The token expired: a new one, then the call once more (it was refused, so not applied).
      if (this.session?.token === token) this.session = undefined;
      await this.login({ ...base, password, key });
      fresh = true;
      onLogin?.();
    }
  }
}

/** A short reason for the status and the logs (never a body, a path nor a header). */
export function errorReason(err) {
  if (err?.kind === ERROR_KINDS.HTTP) {
    return err.redirect ? `HTTP ${err.status} (redirect)` : `HTTP ${err.status}`;
  }
  if (err?.kind === ERROR_KINDS.REJECTED) {
    return `statusCode ${err.code}`;
  }
  return err?.kind ?? 'error';
}
