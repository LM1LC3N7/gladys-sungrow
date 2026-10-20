// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never a password (it is typed on the iSolarCloud page only)
// nor the secret key (kept by Gladys):
//   - the session: the access and renewal tokens with their ends, and the
//     client they belong to (a hash of the server, the app key and the app id);
//   - a stop that only the user can lift (renewal refused, access or app
//     refused), with its client, so a restart never retries it;
//   - the end of a 429, 5xx, daily budget or error pause, capped when read
//     again, and when the last read cycle started (a restart never reads sooner);
//   - when the token was last renewed (never two renewals within a minute);
//   - the requests sent today (the daily budget);
//   - the plants last listed, so a failing list never stops the reads;
//   - the state of each index guard (reference and value held back).
// The tokens are kept as iSolarCloud gives them, in clear, in a file readable
// by the container user only (0600).
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { DAY, LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/sungrow-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(text);
          // On disk before it replaces the previous state (a power cut keeps one of the two).
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

const time = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value, max) =>
  typeof value === 'string' && value !== '' && value.length <= max ? value : undefined;
const client = (value) =>
  typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value : undefined;

const BLOCKS = new Set(['expired', 'unauthorized']);
export const PAUSES = {
  rate: TIMINGS.rateLimitMax,
  unavailable: TIMINGS.unavailable.at(-1),
  budget: DAY,
  backoff: TIMINGS.backoffMax,
};

function session(raw) {
  const s = raw?.session;
  const owner = client(s?.client);
  const refreshToken = str(s?.refreshToken, LIMITS.tokenLength);
  if (!owner || !refreshToken) {
    return null;
  }
  return {
    client: owner,
    accessToken: str(s.accessToken, LIMITS.tokenLength) ?? null,
    refreshToken,
    expiresAt: time(s.expiresAt) ?? 0,
    obtainedAt: time(s.obtainedAt) ?? 0,
  };
}

function plants(raw) {
  const p = raw?.plants;
  const owner = client(p?.client);
  if (!owner || !Array.isArray(p.list)) {
    return null;
  }
  const list = [];
  for (const plant of p.list.slice(0, LIMITS.plants)) {
    const id = str(plant?.id, 20);
    if (!id || !/^\d+$/.test(id)) {
      continue;
    }
    list.push({ id, name: str(plant.name, 100) ?? `Sungrow ${id}` });
  }
  return { client: owner, list };
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** The guard states, by feature external id (only what IndexGuard reads back). */
function indexes(raw) {
  const out = {};
  const source = raw?.indexes;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return out;
  }
  for (const [id, state] of Object.entries(source).slice(0, LIMITS.plants * 2)) {
    if (typeof id !== 'string' || id.length > 200 || !id.startsWith('ext:')) {
      continue;
    }
    const last =
      state?.last && finite(state.last.value) && finite(state.last.at)
        ? { value: state.last.value, at: state.last.at }
        : null;
    const h = state?.held;
    const held =
      h &&
      (h.direction === 'up' || h.direction === 'down') &&
      [h.from, h.to, h.threshold, h.at].every(finite)
        ? { direction: h.direction, from: h.from, to: h.to, threshold: h.threshold, at: h.at }
        : null;
    out[id] = { last, held };
  }
  return out;
}

/** The UTC day of a time: the daily budget counts from 00:00 UTC. */
export const dayOf = (now) => Math.floor(now / DAY);

/** The persisted state, repaired; the pause end is capped from `now`. */
export function normalizeMemory(raw, now = Date.now()) {
  const block = raw?.block;
  const pause = raw?.pause;
  const until = time(pause?.until);
  const lastRenewAt = time(raw?.lastRenewAt);
  const lastCycleAt = time(raw?.lastCycleAt);
  const requests = raw?.requests;
  return {
    session: session(raw),
    block:
      BLOCKS.has(block?.kind) && client(block?.client)
        ? { kind: block.kind, client: block.client }
        : null,
    pause:
      pause && Object.hasOwn(PAUSES, pause.kind) && until !== undefined && until > now
        ? { kind: pause.kind, until: Math.min(until, now + PAUSES[pause.kind]) }
        : null,
    // A time ahead of the clock counts as now (never a renewal blocked for long).
    lastRenewAt: lastRenewAt === undefined ? null : Math.min(lastRenewAt, now),
    // The start of the last read cycle: the first read after a restart waits the interval.
    lastCycleAt: lastCycleAt === undefined ? null : Math.min(lastCycleAt, now),
    // The requests of today only; another day starts from 0.
    requests:
      requests && requests.day === dayOf(now) && Number.isSafeInteger(requests.count)
        ? { day: requests.day, count: Math.max(0, requests.count) }
        : { day: dayOf(now), count: 0 },
    plants: plants(raw),
    indexes: indexes(raw),
  };
}
