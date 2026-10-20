// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { MAX_POWER_KW, POLL_MINUTES, SERVERS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  server: 'eu',
  poll_minutes: POLL_MINUTES.default,
  max_power_kw: MAX_POWER_KW.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** A short hash of the server, the app key and the app id: the session in /data belongs to it. */
export const clientKey = (server, appKey, appId) =>
  createHash('sha256').update(`${server}\n${appKey}\n${appId}`).digest('hex').slice(0, 16);

const bounded = (raw, { min, max, default: fallback }) => {
  const value = Number(raw);
  return raw === null || raw === undefined || raw === '' || !Number.isFinite(value)
    ? fallback
    : Math.round(Math.max(min, Math.min(max, value)));
};

/** A short text without spaces (keys and ids of the developer app), or ''. */
const token = (raw, max = 256) => {
  const text = String(raw ?? '').trim();
  return text && text.length <= max && !/\s/.test(text) ? text : '';
};

/** An http(s) address without spaces, or '' (a wrong one is ignored). */
function address(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 2048 || /\s/.test(text)) {
    return '';
  }
  try {
    const url = new URL(text);
    // HTTPS only, except a local address (the code never crosses a network in clear).
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function normalizeConfig(raw = {}) {
  const typedServer = String(raw?.server ?? DEFAULTS.server)
    .trim()
    .toLowerCase();
  const server = Object.hasOwn(SERVERS, typedServer) ? typedServer : DEFAULTS.server;
  const appKey = token(raw?.app_key);
  const appId = /^\d{1,20}$/.test(String(raw?.app_id ?? '').trim())
    ? String(raw.app_id).trim()
    : '';
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const ready = Boolean(appKey && appId);
  return {
    server,
    appKey,
    appId,
    secretKey: token(raw?.secret_key, 1024),
    redirectUri: address(raw?.redirect_uri),
    // The client key is computed from the values kept, never from refused ones.
    client: ready ? clientKey(server, appKey, appId) : '',
    pollMinutes: bounded(raw?.poll_minutes, POLL_MINUTES),
    maxKw: bounded(raw?.max_power_kw, MAX_POWER_KW),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
