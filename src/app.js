// -----------------------------------------------------------------------------
// The integration: the iSolarCloud account (OAuth2 of the developer app,
// started by a click), the token renewed by a timer before its end, one read
// of the real-time data of every plant per cycle (5 minutes at least: the
// pace of iSolarCloud), the list of plants every 6 hours, the Gladys devices
// and their states (read only), the two energy indexes behind their guards,
// the transport badges and the configuration buttons. index.js only wires
// the SDK handlers to it.
//
// Never by itself: a sign-in, a retry of a refused renewal or access, a read
// sooner than the interval after an error, more than LIMITS.dailyRequests
// requests a day. Pauses (429, "too frequent", 5xx, daily budget) and stops
// are kept in /data; a reconnection to Gladys resends the status and the
// Discovery list without touching them.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { listPlants, realtimeData } from './api.js';
import { normalizeConfig } from './config.js';
import { DAY, INDEX_SLACK_KWH, LIMITS, MINUTE, SECOND, SERVERS, TIMINGS } from './constants.js';
import { KINDS, buildDevice, deviceIds, deviceStates, indexValues, kindsOf } from './devices.js';
import { IndexGuard } from './guard.js';
import { SungrowError, errorReason, httpsTransport, networkError, safeCode } from './http.js';
import { FEATURE_NAMES, T, age, join } from './i18n.js';
import { parsePlants, parseRealtime } from './model.js';
import { SignIns, authorizeUrl, baseOf, parseRedirect, tokenRequest } from './oauth.js';
import { StatePublisher } from './publisher.js';
import { dayOf, fileStore, normalizeMemory } from './store.js';

/** The stops kept in /data: only the user lifts them. */
const PERSISTED = new Set(['expired', 'unauthorized']);
/** Their status message, and those of the stops that are not kept. */
const STOP_MESSAGES = {
  no_client: T.noClient,
  signed_out: T.signedOut,
  expired: T.expired,
  unauthorized: T.unauthorized,
};
/** The pauses that hold every path (the sign-in, the renewal, the reads). */
const HARD = new Set(['rate', 'unavailable', 'budget']);
/** Errors after which the account counts as unreachable (badges). */
const OFFLINE = new Set(['network', 'timeout', 'unavailable', 'bad_response', 'size', 'http']);
/** The fields of a Gladys feature that a publication carries. */
const FEATURE_FIELDS = [
  'id',
  'energy_parent_id',
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];
/** An access token closer than this to its end is not used (renewed first). */
const TOKEN_SLACK = 10 * SECOND;

/** One message in both languages, for an error thrown to Gladys. */
const thrown = (message) => new Error(`${message.en} / ${message.fr}`);

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

export class SungrowApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'sungrow' }),
    transport = httpsTransport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    // Every request counts in the daily budget; a socket error becomes a SungrowError.
    this.transport = async (...args) => {
      this.countRequest();
      try {
        return await transport(...args);
      } catch (err) {
        throw networkError(err);
      }
    };
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.signIns = new SignIns({ now });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** Moved on by every sign-in: a renewal started before it is dropped. */
    this.epoch = 0;
    this.generation = 0;
    this.timer = undefined;
    this.renewTimer = undefined;
    this.running = undefined;
    this.renewing = undefined;
    this.started = false;
    this.lastStatus = undefined;
    this.lastTestAt = -Infinity;
    /** Every device published in this run, by external id: a publication never shrinks. */
    this.known = new Map();
    /** The guards of the index features: feature id -> { guard, plant, role }. */
    this.guards = new Map();
    this.reset();
  }

  /** Forgets the account state of this run. A 429, 5xx or budget pause stays. */
  reset() {
    this.plants = [];
    /** plant id -> the values of its last read. */
    this.values = new Map();
    /** When the values were read (the date of the indexes). */
    this.valuesAt = undefined;
    /** plant id -> the kinds of device it showed: only grows. */
    this.kinds = new Map();
    /** The plants missing from the last real-time answer. */
    this.failedPlants = new Set();
    this.listAt = -Infinity;
    this.published = undefined;
    this.badges = new Map();
    /** undefined | 'no_client' | 'signed_out' | 'expired' | 'unauthorized' */
    this.blocked = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.renewFailures = 0;
    this.renewRetryAt = 0;
    this.renewError = undefined;
    this.cycleStart = -Infinity;
    this.guards = new Map();
    if (!HARD.has(this.pauseKind) || this.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      /** 'rate', 'unavailable', 'budget': every path waits, kept in /data; 'backoff': the reads. */
      this.pauseKind = undefined;
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    // A renewal or an exchange still in flight belongs to the previous keys: dropped.
    this.epoch += 1;
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    this.signIns.clear();
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    const pause = this.memory.pause;
    if (pause && pause.until > Math.max(this.now(), this.pausedUntil)) {
      this.pausedUntil = pause.until;
      this.pauseKind = pause.kind;
    }
    this.publisher.start();
    const { client } = this.config;
    if (!client || !this.config.secretKey) {
      this.blocked = 'no_client';
      await this.setStatus(false, T.noClient);
      return;
    }
    if (this.memory.plants?.client === client) {
      this.plants = this.memory.plants.list;
      await this.publishDevices();
    }
    if (this.memory.block?.client === client) {
      // A stop on this very client survives a restart (never retried by itself).
      this.blocked = this.memory.block.kind;
      await this.setStatus(false, STOP_MESSAGES[this.blocked]);
      return;
    }
    if (!this.session) {
      this.blocked = 'signed_out';
      await this.setStatus(false, T.signedOut);
      return;
    }
    this.scheduleRenew();
    // The first read: not sooner than the interval after the last cycle (kept in
    // /data, never in the future) nor before the end of a pause (capped when read).
    const due = Math.max((this.memory.lastCycleAt ?? -Infinity) + this.interval, this.pausedUntil);
    if (due > this.now()) {
      // The status says when the read comes, never "reading" while it waits.
      // The last cycle succeeded and nothing failed nor paused since: still connected.
      const success = this.memory.lastSuccessAt;
      if (
        this.pausedUntil <= this.now() &&
        success !== null &&
        success >= (this.memory.lastCycleAt ?? -Infinity)
      ) {
        this.connectedOnce = true;
        await this.setStatus(true, join(this.okMessage(), T.nextRead(age(due - this.now()))));
        this.scheduleAt(due);
        return;
      }
      await this.setStatus(false, this.pauseMessage() ?? T.nextRead(age(due - this.now())));
      this.scheduleAt(due);
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.clearRenewTimer();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clearRenewTimer() {
    if (this.renewTimer) {
      this.timers.clearTimeout(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  /** The session of the configured client, or null. */
  get session() {
    const s = this.memory.session;
    return s && s.client === this.config.client ? s : null;
  }

  /** The server of the configuration, its gateway and keys for a request. */
  options(token, timeout) {
    return {
      api: SERVERS[this.config.server].api,
      appKey: this.config.appKey,
      secretKey: this.config.secretKey,
      token,
      now: this.now(),
      timeout,
    };
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges). The pauses, the stops and the session stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges = new Map();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** New keys restart; a new interval reschedules; a new language renames; a new power rebuilds the guards. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.client !== previous.client || next.secretKey !== previous.secretKey) {
      return this.start(raw);
    }
    this.config = next;
    if (next.maxKw !== previous.maxKw) {
      // Rebuilt from /data with the new margin at the next read.
      this.guards = new Map();
    }
    if (next.pollMinutes !== previous.pollMinutes && this.timer) {
      this.scheduleNext();
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
      this.queueStates();
      await this.flush();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The read interval: the configured one (5 minutes at least, the pace of iSolarCloud). */
  get interval() {
    return this.config.pollMinutes * MINUTE;
  }

  /** One more request today; refused once the daily budget is spent. */
  countRequest() {
    const day = dayOf(this.now());
    if (this.memory.requests.day !== day) {
      this.memory.requests = { day, count: 0 };
    }
    if (this.memory.requests.count >= LIMITS.dailyRequests) {
      throw new SungrowError('budget', 'daily number of requests reached');
    }
    this.memory.requests.count += 1;
  }

  // --- Pauses and stops ----------------------------------------------------------

  /** A 429, a 5xx or the daily budget: a pause of every path, kept in /data. Returns its length. */
  async pause(err) {
    let wait;
    if (err.kind === 'rate_limited') {
      wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      this.pauseKind = 'rate';
    } else if (err.kind === 'budget') {
      // Until the next UTC day, plus a minute.
      wait = (dayOf(this.now()) + 1) * DAY - this.now() + MINUTE;
      this.pauseKind = 'budget';
    } else {
      const step = TIMINGS.unavailable[Math.min(this.failures, TIMINGS.unavailable.length - 1)];
      wait = Math.max(this.interval, step);
      this.pauseKind = 'unavailable';
      this.offline = true;
    }
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.memory.pause = { kind: this.pauseKind, until: this.pausedUntil };
    this.memory.lastSuccessAt = null;
    await this.saveMemory();
    return this.pausedUntil - this.now();
  }

  /** The message of a hard pause still running, for every path. */
  pauseMessage() {
    const left = this.pausedUntil - this.now();
    if (left <= 0) {
      return undefined;
    }
    switch (this.pauseKind) {
      case 'rate':
        return T.rateLimited(age(left));
      case 'unavailable':
        return T.unavailable(age(left));
      case 'budget':
        return T.budget(age(left));
      default:
        return undefined;
    }
  }

  get hardPaused() {
    return HARD.has(this.pauseKind) && this.now() < this.pausedUntil;
  }

  /** A stop only the user lifts: kept in /data with its client. */
  async block(kind) {
    this.blocked = kind;
    this.memory.lastSuccessAt = null;
    this.clearTimer();
    if (kind === 'expired') {
      // The renewal token is useless now: a new authorization replaces it.
      this.memory.session = null;
      this.clearRenewTimer();
    }
    if (PERSISTED.has(kind)) {
      this.memory.block = { kind, client: this.config.client };
    }
    await this.saveMemory();
    this.logger.warn(`iSolarCloud stopped: ${kind}`);
    await this.setStatus(false, STOP_MESSAGES[kind]);
    await this.publishBadges();
  }

  // --- Token renewal ----------------------------------------------------------

  /**
   * The renewal timer: at the end of the token minus a margin (5 minutes, at
   * most half of its lifetime), never within a minute of the last renewal,
   * nor during a hard pause, nor before the next try after a failure.
   */
  scheduleRenew() {
    this.clearRenewTimer();
    const s = this.session;
    if (!s || PERSISTED.has(this.blocked)) {
      return;
    }
    const lifetime = Math.max(0, s.expiresAt - s.obtainedAt);
    const margin = Math.min(TIMINGS.tokenMargin, lifetime / 2);
    let at = Math.max(
      s.expiresAt - margin,
      (this.memory.lastRenewAt ?? -Infinity) + TIMINGS.renewFloor,
      this.renewRetryAt,
    );
    if (this.hardPaused) {
      at = Math.max(at, this.pausedUntil);
    }
    const generation = this.generation;
    this.renewTimer = this.timers.setTimeout(
      () => {
        this.renewTimer = undefined;
        if (generation !== this.generation) {
          return;
        }
        this.renew().catch((err) => this.renewFailed(err, generation));
      },
      Math.max(0, at - this.now()),
    );
  }

  /** A renewal of the timer failed: a pause, a later try, or a stop (refused). */
  async renewFailed(err, generation) {
    if (generation !== this.generation || this.blocked) {
      return;
    }
    this.logger.info(`iSolarCloud: token renewal failed (${errorReason(err)})`);
    if (['rate_limited', 'unavailable', 'budget'].includes(err.kind)) {
      await this.pause(err);
      await this.setStatus(this.connectedOnce && err.kind !== 'unavailable', this.pauseMessage());
    } else if (err.kind === 'renew_wait' || err.kind === 'paused') {
      // A renewal ran less than a minute ago, or a pause runs: the timer comes back after it.
    } else if (this.session && this.now() >= this.session.expiresAt) {
      await this.setStatus(
        false,
        T.renewWaiting(errorReason(err), age(this.renewRetryAt - this.now())),
      );
    }
    this.scheduleRenew();
  }

  /** One renewal at a time. */
  renew(timeout) {
    if (!this.renewing) {
      this.renewing = this.doRenew(timeout).finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  async doRenew(timeout = TIMINGS.requestTimeout) {
    const s = this.session;
    if (!s || this.blocked) {
      throw new SungrowError('signed_out', 'not signed in to iSolarCloud');
    }
    const now = this.now();
    if (now < (this.memory.lastRenewAt ?? -Infinity) + TIMINGS.renewFloor) {
      throw new SungrowError('renew_wait', 'renewed less than a minute ago');
    }
    if (this.hardPaused) {
      // Nothing sent: the pause already running is neither extended nor restarted.
      throw new SungrowError('paused', 'paused');
    }
    const epoch = this.epoch;
    this.memory.lastRenewAt = now;
    let token;
    try {
      token = await tokenRequest(
        this.transport,
        'refresh',
        { refresh_token: s.refreshToken },
        this.options(undefined, timeout),
      );
    } catch (err) {
      if (epoch !== this.epoch) {
        // A sign-in finished meanwhile: this failure belongs to the old session.
        throw new SungrowError('renew_wait', 'a new sign-in replaced the session');
      }
      if (err.kind === 'refused') {
        // Never tried again by itself: only a new authorization clears it.
        await this.block('expired');
      } else if (!['rate_limited', 'unavailable', 'budget'].includes(err.kind)) {
        this.renewRetryAt =
          this.now() +
          TIMINGS.renewRetry[Math.min(this.renewFailures, TIMINGS.renewRetry.length - 1)];
        this.renewFailures += 1;
        this.renewError = err;
        await this.saveMemory();
      } else {
        await this.saveMemory();
      }
      throw err;
    }
    if (epoch !== this.epoch) {
      return;
    }
    this.memory.session = {
      client: this.config.client,
      ...token,
      // iSolarCloud may answer without a new renewal token: the old one stays.
      refreshToken: token.refreshToken ?? s.refreshToken,
    };
    this.renewFailures = 0;
    this.renewRetryAt = 0;
    this.renewError = undefined;
    await this.saveMemory();
    this.scheduleRenew();
  }

  /** A usable access token: renewed first when it ended (and a renewal is allowed). */
  async accessToken(timeout) {
    const s = this.session;
    if (!s) {
      throw new SungrowError('signed_out', 'not signed in to iSolarCloud');
    }
    if (s.accessToken && this.now() < s.expiresAt - TOKEN_SLACK) {
      return s.accessToken;
    }
    if (this.now() < this.renewRetryAt) {
      throw new SungrowError(
        'renew_wait',
        this.renewError ? errorReason(this.renewError) : 'renewal failed',
      );
    }
    await this.renew(timeout);
    const fresh = this.session;
    if (!fresh?.accessToken) {
      throw new SungrowError('signed_out', 'not signed in to iSolarCloud');
    }
    return fresh.accessToken;
  }

  /**
   * An API call; a refused token renews once (when a renewal is allowed) and
   * tries again. Refused again with a token of this cycle: a stop.
   */
  async call(fn, timeout) {
    let token = await this.accessToken(timeout);
    try {
      return await fn(token);
    } catch (err) {
      if (err.kind !== 'unauthorized') {
        throw err;
      }
      const current = this.session?.accessToken;
      if (current && current !== token) {
        // Renewed by the timer meanwhile: tried once more with the new token.
        token = current;
      } else {
        if ((this.session?.obtainedAt ?? 0) >= this.cycleStart) {
          throw new SungrowError('unauthorized_block', 'iSolarCloud refused a new access token', {
            detail: err.detail,
          });
        }
        if (this.now() < this.renewRetryAt) {
          throw new SungrowError(
            'renew_wait',
            this.renewError ? errorReason(this.renewError) : 'renewal failed',
          );
        }
        await this.renew(timeout);
        token = this.session?.accessToken;
        if (!token) {
          throw err;
        }
      }
    }
    try {
      return await fn(token);
    } catch (err) {
      if (err.kind === 'unauthorized') {
        throw new SungrowError('unauthorized_block', 'iSolarCloud refused a new access token', {
          detail: err.detail,
        });
      }
      throw err;
    }
  }

  // --- Polling ---------------------------------------------------------------

  /** Read again after the interval, or at the end of a pause. */
  scheduleNext() {
    this.clearTimer();
    if (this.blocked) {
      return;
    }
    const now = this.now();
    this.scheduleAt(now + Math.max(this.interval, this.pausedUntil - now, this.renewRetryAt - now));
  }

  /** The next read at `at`. */
  scheduleAt(at) {
    this.clearTimer();
    const delay = at - this.now();
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) =>
            this.logger.error(`iSolarCloud refresh failed: ${err.message}`),
          );
        }
      },
      Math.max(0, delay),
    );
  }

  /** One run at a time: a tick during a run joins it. `quick`: for a button. */
  tick({ quick = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false } = {}) {
    const generation = this.generation;
    if (this.blocked) {
      return;
    }
    if (this.now() < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    const timeout = quick ? TIMINGS.quickTimeout : TIMINGS.requestTimeout;
    this.cycleStart = this.now();
    // Kept in /data: a restart never reads sooner than the interval after this cycle.
    this.memory.lastCycleAt = this.cycleStart;
    try {
      const read = await this.readAll(timeout);
      if (generation !== this.generation) {
        return;
      }
      if (read) {
        this.applyIndexes();
      }
      // A stop raised meanwhile (a refused renewal by the timer) is never covered.
      if (!this.blocked) {
        await this.succeeded();
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.saveMemory();
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadges();
    this.scheduleNext();
  }

  /** The list (when due), then the real-time data of every plant in one request. */
  async readAll(timeout) {
    if (this.now() - this.listAt >= TIMINGS.listInterval) {
      try {
        const plants = parsePlants(
          await this.call(
            (token) => listPlants(this.transport, this.options(token, timeout)),
            timeout,
          ),
        );
        if (!plants) {
          throw new SungrowError('bad_response', 'no list of plants in the answer');
        }
        this.listAt = this.now();
        await this.setPlants(plants);
      } catch (err) {
        // The plants already known are still read (the list is secondary then).
        if (this.plants.length === 0 || this.critical(err)) {
          throw err;
        }
        // Tried again in 30 minutes, not at every cycle.
        this.listAt = this.now() - TIMINGS.listInterval + TIMINGS.listRetry;
        this.logger.warn(`iSolarCloud: the list of plants failed (${errorReason(err)})`);
      }
    }
    if (this.plants.length === 0) {
      return false;
    }
    const data = parseRealtime(
      await this.call(
        (token) =>
          realtimeData(
            this.transport,
            this.plants.map((p) => p.id),
            this.options(token, timeout),
          ),
        timeout,
      ),
    );
    if (!data) {
      throw new SungrowError('bad_response', 'no real-time data in the answer');
    }
    this.valuesAt = this.now();
    this.failedPlants = new Set();
    for (const plant of this.plants) {
      const values = data.get(plant.id);
      if (!values) {
        this.failedPlants.add(plant.id);
        this.values.delete(plant.id);
        continue;
      }
      this.values.set(plant.id, values);
      const kinds = this.kinds.get(plant.id) ?? new Set(['plant']);
      for (const kind of kindsOf(values)) {
        kinds.add(kind);
      }
      this.kinds.set(plant.id, kinds);
    }
    return true;
  }

  /** Errors that stop the whole cycle: a pause of the account, the session, the app. */
  critical(err) {
    return [
      'rate_limited',
      'budget',
      'app_refused',
      'unauthorized_block',
      'refused',
      'signed_out',
      'renew_wait',
      'paused',
    ].includes(err?.kind);
  }

  /** The plants listed: kept in /data (a failing list later never stops the reads). */
  async setPlants(plants) {
    const ids = new Set(plants.map((p) => p.id));
    for (const id of [...this.values.keys()]) {
      if (!ids.has(id)) {
        this.values.delete(id);
        this.failedPlants.delete(id);
      }
    }
    this.plants = plants;
    const stored = { client: this.config.client, list: plants };
    if (JSON.stringify(stored) !== JSON.stringify(this.memory.plants)) {
      this.memory.plants = stored;
      await this.saveMemory();
    }
  }

  async succeeded() {
    this.failures = 0;
    this.offline = false;
    this.connectedOnce = true;
    this.pauseKind = undefined;
    this.pausedUntil = 0;
    // Kept in /data: a restart before the next read stays connected (cleared by any failure).
    this.memory.lastSuccessAt = this.cycleStart;
    if (this.memory.pause) {
      this.memory.pause = null;
      await this.saveMemory();
    }
    await this.setStatus(true, this.okMessage());
  }

  /** The status of a good read: the plants, those without data, the indexes held back. */
  okMessage() {
    let message = this.plants.length === 0 ? T.noPlant : T.connected(this.plants.length);
    if (this.failedPlants.size > 0) {
      const names = this.plants.filter((p) => this.failedPlants.has(p.id)).map((p) => p.name);
      message = join(message, T.partial(names));
    }
    for (const entry of this.guards.values()) {
      if (entry.guard.held) {
        message = join(message, T.held(this.indexName(entry), entry.guard.held));
      }
    }
    return message;
  }

  async failed(err) {
    const reason = errorReason(err);
    this.memory.lastSuccessAt = null;
    switch (err.kind) {
      case 'signed_out':
        if (!this.blocked) {
          this.blocked = 'signed_out';
          await this.setStatus(false, T.signedOut);
        }
        return;
      case 'refused':
        // The renewal was refused: block('expired') already ran.
        return;
      case 'unauthorized_block':
      case 'app_refused':
        await this.block('unauthorized');
        return;
      case 'paused':
        // A hard pause already runs: kept as it is.
        return;
      default:
        break;
    }
    if (this.blocked) {
      // A stop raised meanwhile keeps its message.
      return;
    }
    let message;
    if (['rate_limited', 'unavailable', 'budget'].includes(err.kind)) {
      await this.pause(err);
      message = this.pauseMessage();
    } else if (err.kind === 'renew_wait') {
      // The token could not be renewed yet: the reads wait for the renewal.
      const wait = Math.max(this.interval, this.renewRetryAt - this.now());
      this.pauseKind = 'backoff';
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      message = T.renewWaiting(reason, age(wait));
    } else {
      // Never read again sooner than the interval.
      const wait = Math.max(
        this.interval,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.pauseKind = 'backoff';
      this.offline = OFFLINE.has(err.kind) || this.offline;
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      message = T.unreachable(reason, age(wait));
    }
    if (this.pauseKind === 'backoff') {
      // Kept in /data (capped): a restart does not read sooner either.
      this.memory.pause = {
        kind: 'backoff',
        until: Math.min(this.pausedUntil, this.now() + TIMINGS.backoffMax),
      };
    }
    this.failures += 1;
    const connected =
      err.kind !== 'unavailable' && this.pauseKind !== 'backoff' && this.connectedOnce;
    await this.setStatus(connected, message);
    this.logger.warn(
      `iSolarCloud: ${reason}; next try in ${Math.round(this.interval / 1000)} s or later`,
    );
  }

  // --- Energy indexes ------------------------------------------------------------

  /** The name of an index as shown: the plant and the feature. */
  indexName({ plant, role }) {
    const name = FEATURE_NAMES[role];
    return { en: `${plant} – ${name.en}`, fr: `${plant} – ${name.fr}` };
  }

  /** The guard of a created index feature, from Gladys and /data when needed. */
  guardOf(featureId, device, plant, role) {
    let entry = this.guards.get(featureId);
    if (!entry) {
      const guard = new IndexGuard(
        lastValueOf(device, featureId),
        this.memory.indexes[featureId],
        this.now(),
        { maxKw: this.config.maxKw, slackKwh: INDEX_SLACK_KWH },
      );
      entry = { guard, plant: plant.name, role };
      this.guards.set(featureId, entry);
    }
    entry.plant = plant.name;
    return entry;
  }

  /**
   * The indexes of the last read through their guards: a plausible value is
   * published; while a value is held, the last one accepted is sent again (no
   * delta for the core); nothing before a first plausible value. Only the
   * features of created devices: a guard needs the value Gladys holds.
   */
  applyIndexes() {
    if (this.valuesAt === undefined) {
      return;
    }
    const created = this.createdDevices();
    for (const plant of this.plants) {
      const values = this.values.get(plant.id);
      if (!values) {
        continue;
      }
      for (const kind of this.kinds.get(plant.id) ?? []) {
        const device = created.get(deviceIds(this.gladys, kind, plant.id).device);
        if (!device) {
          continue;
        }
        const features = new Set((device.features ?? []).map((f) => f.external_id));
        for (const [featureId, value, role] of indexValues(this.gladys, kind, plant.id, values)) {
          if (value === null || !features.has(featureId)) {
            continue;
          }
          const { guard } = this.guardOf(featureId, device, plant, role);
          const plausible = guard.accept(value, this.valuesAt);
          this.memory.indexes[featureId] = guard.state();
          if (!plausible) {
            this.logger.warn(
              `iSolarCloud ${role} ${guard.held?.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held indexes" button takes it`,
            );
          }
          const sent = plausible ? value : guard.held ? guard.last?.value : undefined;
          if (typeof sent === 'number' && Number.isFinite(sent) && sent > 0) {
            this.publisher.push(featureId, { state: sent });
          }
        }
      }
    }
  }

  /** The "Accept the held indexes" button: every index held, as shown now. */
  async acceptIndex() {
    const names = [];
    for (const entry of this.guards.values()) {
      if (entry.guard.acceptHeld()) {
        names.push(this.indexName(entry));
      }
    }
    if (names.length === 0) {
      return T.accept.nothing;
    }
    this.logger.info(`iSolarCloud: ${names.length} held index(es) accepted by the user`);
    return T.accept.done(names);
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevices() {
    return new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /**
   * The devices of the plants, merged so that nothing ever disappears: a
   * created device keeps its features as Gladys has them (types and units
   * are fixed at creation), plus any new one; a device or a feature seen
   * earlier in this run stays published. A created grid or battery device
   * stays offered even when the read does not show it.
   */
  async publishDevices() {
    const created = this.createdDevices();
    for (const plant of this.plants) {
      const kinds = this.kinds.get(plant.id) ?? new Set(['plant']);
      for (const kind of Object.keys(KINDS)) {
        if (created.has(deviceIds(this.gladys, kind, plant.id).device)) {
          kinds.add(kind);
        }
      }
      this.kinds.set(plant.id, kinds);
      for (const kind of kinds) {
        const fresh = buildDevice(this.gladys, kind, plant, this.config.language);
        const previous = this.known.get(fresh.external_id);
        const mine = created.get(fresh.external_id);
        const features = new Map();
        for (const f of mine?.features ?? []) {
          features.set(
            f.external_id,
            Object.fromEntries(
              FEATURE_FIELDS.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [
                k,
                f[k],
              ]),
            ),
          );
        }
        for (const f of [...(previous?.features ?? []), ...fresh.features]) {
          if (!features.has(f.external_id)) {
            features.set(f.external_id, f);
          }
        }
        if (!previous && this.known.size >= LIMITS.plants * 3) {
          continue;
        }
        this.known.set(fresh.external_id, { ...fresh, features: [...features.values()] });
      }
    }
    const list = [...this.known.values()];
    const json = JSON.stringify(list);
    if (list.length === 0 || json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** The states of the last read (the indexes apart: applyIndexes). */
  queueStates(created = this.createdFeatures()) {
    for (const plant of this.plants) {
      const values = this.values.get(plant.id);
      if (!values) {
        continue;
      }
      for (const kind of this.kinds.get(plant.id) ?? []) {
        for (const [featureId, value] of deviceStates(this.gladys, kind, plant.id, values)) {
          if (created.has(featureId)) {
            this.publisher.push(featureId, { state: value });
          }
        }
      }
    }
  }

  /** One badge per created device: cloud, or unreachable (stopped, offline, no data). */
  async publishBadges() {
    const entries = [];
    const owners = new Map();
    for (const plant of this.plants) {
      for (const kind of Object.keys(KINDS)) {
        owners.set(deviceIds(this.gladys, kind, plant.id).device, plant);
      }
    }
    for (const device of this.gladys.devices ?? []) {
      if (!this.known.has(device.external_id)) {
        continue;
      }
      const plant = owners.get(device.external_id);
      const unreachable =
        Boolean(this.blocked) || this.offline || !plant || this.failedPlants.has(plant.id);
      const transport = unreachable ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD;
      if (this.badges.get(device.external_id) !== transport) {
        entries.push({ external_id: device.external_id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.badges.set(entry.external_id, entry.transport);
        }
      } catch (err) {
        this.logger.warn(`Transport badges failed: ${err.message}`);
      }
    }
  }

  /**
   * A device created: its index features start without a reference (nor a
   * value held in /data for a deleted device of the same id); its values of
   * the last read right away.
   */
  async deviceCreated(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
      for (const f of device.features ?? []) {
        if (Object.hasOwn(this.memory.indexes, f.external_id)) {
          delete this.memory.indexes[f.external_id];
        }
        this.guards.delete(f.external_id);
      }
      await this.saveMemory();
    }
    await this.deviceUpdated(device);
  }

  /** A device updated (new features): its values of the last read right away. */
  async deviceUpdated(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
    }
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    this.applyIndexes();
    await this.saveMemory();
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
      this.publisher.forget(device.external_id);
      for (const id of [...this.guards.keys()]) {
        if (id.startsWith(`${device.external_id}:`)) {
          this.guards.delete(id);
        }
      }
      // Its guard states in /data go too: a device created again starts afresh.
      let changed = false;
      for (const id of Object.keys(this.memory.indexes)) {
        if (id.startsWith(`${device.external_id}:`)) {
          delete this.memory.indexes[id];
          changed = true;
        }
      }
      if (changed) {
        await this.saveMemory();
      }
    }
  }

  /** The Discovery tab asks for a scan: the plants known now; the list is read again at the next cycle. */
  async scan() {
    this.listAt = -Infinity;
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Sign-in -----------------------------------------------------------------

  /** The Connect button: the iSolarCloud authorization address (a new state). */
  async oauthAuthorizeUrl(_key, redirectUri) {
    if (!this.config.client || !this.config.secretKey) {
      throw thrown(T.noClient);
    }
    if (this.hardPaused) {
      throw thrown(this.pauseMessage());
    }
    const redirect = this.config.redirectUri || redirectUri;
    if (!redirect) {
      throw thrown(T.signIn.noRedirect);
    }
    if (this.blocked && !this.config.redirectUri) {
      // Not connected: the status shows the return address to register in the app.
      await this.setStatus(
        false,
        join(STOP_MESSAGES[this.blocked] ?? T.signedOut, T.signIn.redirectHint(baseOf(redirect))),
      );
    }
    const state = this.signIns.begin({ redirectUri: redirect });
    return authorizeUrl(SERVERS[this.config.server], {
      appId: this.config.appId,
      redirectUri: redirect,
      state,
    });
  }

  /** iSolarCloud redirected to Gladys: the code of an authorization started here. */
  async oauthCallback(_key, { code, state } = {}) {
    if (typeof code !== 'string' || !code || code.length > LIMITS.codeLength) {
      throw thrown(T.signIn.noCode);
    }
    // Gladys' return carries the state: a missing one never matches an authorization.
    const signIn = typeof state === 'string' && state ? this.signIns.take(state) : null;
    if (!signIn) {
      throw thrown(T.signIn.unknown);
    }
    // Gladys waits for this answer: the exchange must end well before its timeout.
    const result = await this.exchange(code, signIn, { timeout: TIMINGS.callbackTimeout });
    if (result !== T.signIn.done) {
      throw thrown(result);
    }
  }

  /** The address pasted by the user (redirect address other than Gladys'). */
  async finishSignIn(fields) {
    const parsed = parseRedirect(fields?.url);
    if (!parsed) {
      return T.signIn.noCode;
    }
    if (parsed.error) {
      // Only a safe code: a text of the pasted address is never shown back.
      return T.signIn.cancelled(safeCode(parsed.error) ?? 'error');
    }
    // The state ties the address to an authorization started here: never guessed.
    if (!parsed.state || !parsed.code) {
      return T.signIn.noCode;
    }
    const pending = this.signIns.peek(parsed.state);
    if (!pending) {
      return T.signIn.unknown;
    }
    // A whole address must be the redirect address of that authorization (left unused otherwise).
    if (parsed.base !== null && parsed.base !== baseOf(pending.redirectUri)) {
      return T.signIn.wrongAddress;
    }
    const signIn = this.signIns.take(parsed.state);
    if (!signIn) {
      return T.signIn.unknown;
    }
    return this.exchange(parsed.code, signIn, { timeout: TIMINGS.quickTimeout, pasted: true });
  }

  /** The code -> a new session, kept in /data; then one read. */
  async exchange(code, signIn, { timeout = TIMINGS.quickTimeout, pasted = false } = {}) {
    if (!this.config.client || !this.config.secretKey) {
      return T.noClient;
    }
    if (this.hardPaused) {
      this.signIns.restore(signIn);
      return this.pauseMessage();
    }
    // New keys saved during the exchange (a restart) drop its answer.
    const epoch = this.epoch;
    const client = this.config.client;
    let token;
    try {
      token = await tokenRequest(
        this.transport,
        'token',
        {
          code,
          grant_type: 'authorization_code',
          redirect_uri: signIn.entry.redirectUri,
        },
        this.options(undefined, timeout),
      );
    } catch (err) {
      this.logger.warn(`iSolarCloud authorization failed: ${errorReason(err)}`);
      if (err.kind === 'timeout') {
        // The code may have been used by iSolarCloud meanwhile: a new authorization is the safe way.
        return T.signIn.slow;
      }
      if (err.kind === 'refused') {
        return T.signIn.refused(err.detail ?? 'HTTP 400');
      }
      if (['rate_limited', 'unavailable', 'budget'].includes(err.kind)) {
        await this.pause(err);
        this.signIns.restore(signIn);
        return this.pauseMessage();
      }
      if (!pasted) {
        // Gladys' return cannot be replayed: only a new click on Connect helps.
        return T.signIn.retryConnect(errorReason(err));
      }
      // iSolarCloud was not reached: the same address can be pasted again.
      this.signIns.restore(signIn);
      return T.signIn.failed(errorReason(err));
    }
    if (epoch !== this.epoch || client !== this.config.client) {
      return T.signIn.unknown;
    }
    if (!token.refreshToken) {
      return T.signIn.noRefresh;
    }
    // A renewal still running with the previous session must not overwrite this one.
    this.epoch += 1;
    this.memory.session = { client: this.config.client, ...token };
    this.memory.block = null;
    this.blocked = undefined;
    this.failures = 0;
    this.renewFailures = 0;
    this.renewRetryAt = 0;
    this.renewError = undefined;
    // Another authorization may give other plants: the list is read again.
    this.listAt = -Infinity;
    if (this.pauseKind === 'backoff') {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
      this.memory.pause = null;
    }
    await this.saveMemory();
    this.logger.info('iSolarCloud: authorized');
    this.scheduleRenew();
    await this.setStatus(false, T.connecting);
    this.tick({ quick: true }).catch((err) =>
      this.logger.error(`iSolarCloud refresh failed: ${err.message}`),
    );
    return T.signIn.done;
  }

  // --- Configuration buttons ----------------------------------------------------

  async testConnection() {
    if (!this.config.client || !this.config.secretKey) {
      return T.noClient;
    }
    if (this.blocked === 'signed_out' || this.blocked === 'expired') {
      return STOP_MESSAGES[this.blocked];
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    if (this.blocked === 'unauthorized') {
      // One read per click: the button is how a refused access is tried again.
      this.lastTestAt = this.now();
      this.blocked = undefined;
      this.memory.block = null;
      if (this.pauseKind === 'backoff') {
        this.pausedUntil = 0;
        this.pauseKind = undefined;
        this.memory.pause = null;
      }
      await this.saveMemory();
      this.scheduleRenew();
      await this.tick({ quick: true });
      return this.lastMessage ?? T.signedOut;
    }
    // Otherwise never sooner than the interval, nor during an error pause:
    // the last result and when the next read comes.
    const due = Math.max(
      (this.memory.lastCycleAt ?? -Infinity) + this.interval,
      this.pausedUntil,
      this.renewRetryAt,
    );
    if (due > this.now()) {
      const next = T.nextRead(age(due - this.now()));
      const last = this.lastMessage;
      return last ? join(last, next) : next;
    }
    this.lastTestAt = this.now();
    await this.tick({ quick: true });
    return this.lastMessage ?? T.signedOut;
  }
}
