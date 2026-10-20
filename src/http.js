// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to the iSolarCloud gateway, and the
// errors they end with. The body read is bounded, the promise settles once,
// nothing secret ever goes into an error message: a text of iSolarCloud is
// only read to classify the error, never shown nor logged (only its code).
// -----------------------------------------------------------------------------

import https from 'node:https';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed iSolarCloud call. `kind`:
 * - `refused`: the sign-in refused a code or the renewal token;
 * - `unauthorized`: the API refused the access token;
 * - `app_refused`: the API refused the app key or the secret key;
 * - `rate_limited`: 429 or "too frequent", `retryAfter` in ms when given;
 * - `unavailable`: 5xx;
 * - `budget`: the daily number of requests of this integration is reached;
 * - `network`, `timeout`: no answer;
 * - `api_error`: an error code of the API; `bad_response`, `size`: not the
 *   expected answer; `http`: any other status.
 */
export class SungrowError extends Error {
  constructor(kind, message, { status, retryAfter, detail } = {}) {
    super(message);
    this.name = 'SungrowError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> SungrowError (never the request: it carries tokens). */
export function networkError(err) {
  if (err instanceof SungrowError) {
    return err;
  }
  return new SungrowError('network', NETWORK_REASONS[err?.code] ?? 'network error');
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof SungrowError) {
    const code = err.detail ? ` ${err.detail}` : '';
    return err.status ? `${err.message}${code} (HTTP ${err.status})` : `${err.message}${code}`;
  }
  return 'unexpected error';
}

/** A code of iSolarCloud made safe for a message: letters, digits, `_.-`, 40 at most. */
export const safeCode = (value) => {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(text) ? text : undefined;
};

/**
 * One HTTPS request; resolves `{ status, headers, body }` whatever the status.
 * The tests replace it (the app takes a `transport`).
 */
export function httpsTransport(
  url,
  {
    method = 'POST',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      reject(new SungrowError('network', 'only HTTPS is used'));
      return;
    }
    let timer;
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = https.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new SungrowError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    timer = setTimeout(
      () => {
        settle(
          reject,
          new SungrowError('timeout', `no answer within ${Math.round(timeout / 1000)} s`),
        );
        req.destroy();
      },
      Math.max(1, timeout),
    );
    req.on('error', (err) => settle(reject, networkError(err)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * The JSON of a body, `undefined` when empty; `bad_response` when it is not
 * JSON. Keys that could reach a prototype are dropped.
 */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body, (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
  } catch {
    throw new SungrowError('bad_response', 'iSolarCloud sent an answer that is not JSON');
  }
}

/** The transient errors of the gateway: 429, 5xx. Undefined otherwise. */
export function transientError({ status, headers = {} }, now) {
  if (status === 429) {
    return new SungrowError('rate_limited', 'too many requests', {
      status,
      retryAfter: parseRetryAfter(headers['retry-after'], now),
    });
  }
  if (status >= 500) {
    return new SungrowError('unavailable', 'iSolarCloud is unavailable', { status });
  }
  return undefined;
}

const RATE = /frequen|too many|too often|rate.?limit|limit.?exceed|exceed.*limit|频繁|超过/i;
// Narrow on purpose, and checked after the app and the token: "token异常" is a refused token.
const BUSY = /busy|maintenance|try again later|temporarily|繁忙|系统异常|稍后/i;
// Only the token or the login: a text about one plant ("unauthorized", "authorization") is no stop.
const TOKEN = /token|login|登录/i;
const APP = /app.?key|access.?key|secret.?key|app.?id\b|application.?id/i;

/**
 * The error of an answer of the API, or undefined when it succeeded
 * (`result_code` "1"). The texts of iSolarCloud (`result_msg`, `error`,
 * `error_description`) only classify the error; only a safe code is kept.
 * Checked in this order: too frequent, the app refused, the token refused,
 * busy (a "busy" word next to a token text is a refused token, never a pause).
 */
export function envelopeError(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return new SungrowError('bad_response', 'iSolarCloud sent an empty answer');
  }
  const code = data.result_code;
  if ((code === '1' || code === 1) && data.error === undefined) {
    return undefined;
  }
  const text = [data.result_msg, data.error, data.error_description, code]
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).slice(0, 300))
    .join(' ');
  const detail = safeCode(code) ?? safeCode(data.error);
  if (RATE.test(text)) {
    return new SungrowError('rate_limited', 'iSolarCloud asks to slow down', { detail });
  }
  if (APP.test(text)) {
    return new SungrowError('app_refused', 'iSolarCloud refused the developer app', { detail });
  }
  if (TOKEN.test(text)) {
    return new SungrowError('unauthorized', 'iSolarCloud refused the access token', { detail });
  }
  if (BUSY.test(text)) {
    return new SungrowError('unavailable', 'iSolarCloud is busy', { detail });
  }
  return new SungrowError('api_error', 'iSolarCloud answered with an error', { detail });
}
