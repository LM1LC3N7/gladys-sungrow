// -----------------------------------------------------------------------------
// The iSolarCloud account: the OAuth2 authorization of the developer app the
// user created on the Sungrow developer portal, as pysolarcloud runs it
// (AbstractAuth.auth_url, async_fetch_tokens, async_refresh_tokens).
//
// The sign-in page is a single-page application: the `state` goes in the
// query BEFORE the `#`, the app id, the cloud id and the redirect address in
// the fragment. The browser comes back to the redirect address of the app:
//   - Gladys' own address (the Connect button of the `oauth2` field): Gladys
//     relays the code to onOAuthCallback;
//   - another one (configuration "redirect address"): the user pastes the
//     address the browser ended on into the "Finish the sign-in" action.
// The password is typed on the iSolarCloud page only: it never reaches this
// code. Nothing here logs a token, a code or the secret key.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { API_PATHS, LIMITS, TIMINGS } from './constants.js';
import { SungrowError, envelopeError, parseJson, safeCode, transientError } from './http.js';

/** The sign-in address of iSolarCloud for a server, an app id, a redirect address, a state. */
export function authorizeUrl(server, { appId, redirectUri, state }) {
  const query = state ? `?state=${encodeURIComponent(state)}` : '/';
  return (
    `${server.web}${query}#/authorized-app?cloudId=${server.cloudId}` +
    `&applicationId=${encodeURIComponent(appId)}&redirectUrl=${encodeURIComponent(redirectUri)}`
  );
}

/**
 * The parameters of a pasted address: `{ code, state, error, errorDescription,
 * base }`, or null when nothing usable is in it. Takes the whole address
 * (`base`: its origin and path, checked against the redirect address), or
 * only its query string ("?code=…&state=…" or "code=…&state=…", `base` null).
 */
export function parseRedirect(input) {
  const text = String(input ?? '')
    .trim()
    .slice(0, LIMITS.pastedLength);
  if (!text) {
    return null;
  }
  let query;
  let base = null;
  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text.split(/\s/)[0]);
    } catch {
      return null;
    }
    // The code comes in the query; a fragment is read too.
    query = `${url.search.slice(1)}&${url.hash.slice(1).replace(/^[^?]*\?/, '')}`;
    base = baseOf(url);
  } else if (/^[?#]?(?:code|state|error)=/.test(text)) {
    query = text.replace(/^[?#]/, '').split(/\s/)[0];
  } else {
    return null;
  }
  const params = new URLSearchParams(query);
  const code = params.get('code') || null;
  const result = {
    code: code && code.length <= LIMITS.codeLength ? code : null,
    state: params.get('state') || null,
    error: params.get('error') || null,
    errorDescription: params.get('error_description') || null,
    base,
  };
  return result.code || result.error ? result : null;
}

/** The origin and path of an address (no query, no fragment), or null. */
export function baseOf(address) {
  try {
    const url = address instanceof URL ? address : new URL(address);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

const str = (value) =>
  typeof value === 'string' && value !== '' && value.length <= LIMITS.tokenLength
    ? value
    : undefined;

/**
 * The token answer -> the token kept, or null without an access token. The
 * tokens are read at the top of the answer (as pysolarcloud) or in its
 * `result_data`.
 */
export function tokenOf(data, now) {
  const source = str(data?.access_token) ? data : data?.result_data;
  const accessToken = str(source?.access_token);
  if (!accessToken) {
    return null;
  }
  const expiresIn = Number(source.expires_in);
  return {
    accessToken,
    refreshToken: str(source.refresh_token) ?? null,
    expiresAt:
      now +
      (Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.min(expiresIn * 1000, 400 * 24 * 3600 * 1000)
        : TIMINGS.defaultTokenLife),
    obtainedAt: now,
  };
}

/**
 * The token endpoints (`token`: a code; `refresh`: the renewal token), JSON,
 * the secret key in `x-access-key`. 400/401 or an answer without a token:
 * `refused`, with a safe code as detail; 429, 5xx and "too frequent" / "busy"
 * answers: transient; anything else: `http`.
 */
export async function tokenRequest(
  transport,
  kind,
  form,
  { api, appKey, secretKey, now, timeout },
) {
  const body = JSON.stringify({ appkey: appKey, ...form });
  const res = await transport(`${api}${API_PATHS[kind]}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-access-key': secretKey,
    },
    body,
    timeout,
  });
  const transient = transientError(res, now);
  if (transient) {
    throw transient;
  }
  let data;
  try {
    data = parseJson(res.body);
  } catch (err) {
    if (res.status >= 400) {
      data = undefined;
    } else {
      throw err;
    }
  }
  if (res.status === 400 || res.status === 401) {
    const detail = safeCode(data?.error) ?? safeCode(data?.result_code) ?? `HTTP ${res.status}`;
    throw new SungrowError('refused', 'iSolarCloud refused the sign-in', {
      status: res.status,
      detail,
    });
  }
  if (res.status !== 200) {
    throw new SungrowError('http', 'unexpected answer of the sign-in', { status: res.status });
  }
  const token = tokenOf(data, now);
  if (token) {
    return token;
  }
  const error = envelopeError(data ?? null);
  if (error && (error.kind === 'rate_limited' || error.kind === 'unavailable')) {
    throw error;
  }
  throw new SungrowError('refused', 'iSolarCloud refused the sign-in', {
    detail: error?.detail ?? 'no token',
  });
}

/** The sign-ins started (Connect), waiting for their code: state -> { redirectUri, at }. */
export class SignIns {
  constructor({ now }) {
    this.now = now;
    this.pending = new Map();
  }

  /** A new sign-in: its state, kept 15 minutes. */
  begin({ redirectUri }) {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (now - entry.at > TIMINGS.signInTtl) {
        this.pending.delete(state);
      }
    }
    while (this.pending.size >= LIMITS.signIns) {
      this.pending.delete(this.pending.keys().next().value);
    }
    const state = randomBytes(16).toString('base64url');
    this.pending.set(state, { redirectUri, at: now });
    return state;
  }

  /** The sign-in of `state` still valid, without using it (null when none). */
  peek(state) {
    const entry = typeof state === 'string' && state ? this.pending.get(state) : undefined;
    return entry && this.now() - entry.at <= TIMINGS.signInTtl ? entry : null;
  }

  /** The sign-in of `state` (a state is required); it serves once. */
  take(state) {
    const entry = typeof state === 'string' && state ? this.pending.get(state) : undefined;
    if (!entry) {
      return null;
    }
    this.pending.delete(state);
    return this.now() - entry.at <= TIMINGS.signInTtl ? { key: state, entry } : null;
  }

  /** Put a sign-in back (iSolarCloud was not reached: the same code may be tried again). */
  restore({ key, entry }) {
    this.pending.set(key, entry);
  }

  clear() {
    this.pending.clear();
  }
}
