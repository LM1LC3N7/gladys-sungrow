// -----------------------------------------------------------------------------
// Manifest keys, iSolarCloud constants, limits and timings.
//
// The gateways, the sign-in pages and their cloud ids, the API paths and the
// measure points are those of pysolarcloud (MIT, bugjam, 0.5.0): Server,
// AbstractAuth.auth_url, Plants and Plants.measure_points.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * The iSolarCloud servers: the API gateway, the sign-in page (a single-page
 * application) and its cloud id. The developer app belongs to one of them.
 */
export const SERVERS = {
  eu: { api: 'https://gateway.isolarcloud.eu', web: 'https://web3.isolarcloud.eu', cloudId: 3 },
  international: {
    api: 'https://gateway.isolarcloud.com.hk',
    web: 'https://web3.isolarcloud.com.hk',
    cloudId: 2,
  },
  china: {
    api: 'https://gateway.isolarcloud.com',
    web: 'https://web3.isolarcloud.com',
    cloudId: 1,
  },
  australia: {
    api: 'https://augateway.isolarcloud.com',
    web: 'https://auweb3.isolarcloud.com',
    cloudId: 7,
  },
  india: { api: 'https://gateway.isolarcloud.in', web: 'https://web3.isolarcloud.in', cloudId: 9 },
};

/** The paths of the OpenAPI, under the gateway of the server (all POST, JSON). */
export const API_PATHS = {
  token: '/openapi/apiManage/token',
  refresh: '/openapi/apiManage/refreshToken',
  plants: '/openapi/platform/queryPowerStationList',
  realtime: '/openapi/platform/getPowerStationRealTimeData',
};

/**
 * The measure points read (pysolarcloud measure_points), by role. The first
 * one present wins; the unit comes from the point dictionary of the answer
 * (Wh / W when it gives none, as documented by pysolarcloud).
 */
export const POINTS = {
  pv_power: ['83067', '83033'],
  production_today: ['83022'],
  production_total: ['83024'],
  load_power: ['83106'],
  load_today: ['83118'],
  load_total: ['83124'],
  grid_power: ['83549'],
  import_today: ['83102'],
  import_total: ['83105'],
  export_today: ['83072'],
  export_total: ['83075'],
  battery_level: ['83252', '83129'],
  battery_power: ['83326', '83238'],
  charge_today: ['83322'],
  discharge_today: ['83323'],
  charge_total: ['83324'],
  discharge_total: ['83325'],
};

/** The `oauth2` field of the manifest `config_schema` (the Connect button). */
export const OAUTH_FIELD = 'account';

export const ACTIONS = {
  FINISH_SIGN_IN: 'finish_sign_in',
  TEST_CONNECTION: 'test_connection',
  ACCEPT_INDEX: 'accept_index',
};

/** Refresh interval, in minutes: iSolarCloud updates its data every 5 minutes. */
export const POLL_MINUTES = { min: 5, max: 60, default: 5 };

/** The maximum power of the installation, in kW: the margin of the index guard. */
export const MAX_POWER_KW = { min: 1, max: 1000, default: 36 };

/** kWh always accepted on top of the margin of the guard (rounding, a late read). */
export const INDEX_SLACK_KWH = 0.5;

export const TIMINGS = {
  /** The list of plants: at start, on a scan, then every 6 hours. */
  listInterval: 6 * HOUR,
  requestTimeout: 15 * SECOND,
  /** A button waits less (actions time out after 60 s). */
  quickTimeout: 10 * SECOND,
  /** The code exchange of Gladys' OAuth return: Gladys waits for its answer. */
  callbackTimeout: 3500,
  /** A pause after an ordinary error, kept in /data, read back capped at this. */
  backoffMax: 30 * MINUTE,
  /** The list failing while plants are known: tried again 30 minutes later. */
  listRetry: 30 * MINUTE,
  /** Renewed this long before its end (at most half of its lifetime). */
  tokenMargin: 5 * MINUTE,
  /** Never two renewals within a minute (a token shorter than the margin, a clock ahead). */
  renewFloor: MINUTE,
  /** A renewal that did not reach iSolarCloud: tried again after 1, 5, 15, then 60 minutes. */
  renewRetry: [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR],
  /** Without an expiry in the answer, the token is renewed after this. */
  defaultTokenLife: HOUR,
  /** 429 or "too frequent": Retry-After when given, within 1 minute and 6 hours; 15 minutes without it. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 15 * MINUTE,
  /** 5xx: 5, 15, 30, then 60 minutes (never sooner than the interval). */
  unavailable: [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR],
  /** Other failures: never sooner than the interval, then 5, 15, 30 minutes. */
  backoff: [5 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  /** A sign-in started (Connect) can be finished for 15 minutes. */
  signInTtl: 15 * MINUTE,
  testCooldown: 30 * SECOND,
  /** An unchanged state is sent again every 30 minutes. */
  stateHeartbeat: 30 * MINUTE,
  flushInterval: SECOND,
};

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** A list or a real-time answer of a few plants: far below. */
  responseBytes: 1024 * 1024,
  plants: 20,
  signIns: 5,
  /**
   * Requests sent to iSolarCloud per UTC day, sign-in and renewals included:
   * 288 reads at the default pace, a few lists and renewals. Reached (a loop,
   * a bug), every path waits for the next UTC day.
   */
  dailyRequests: 600,
  /** Authorization codes, tokens: bounded before they are kept. */
  codeLength: 4096,
  tokenLength: 16384,
  pastedLength: 8192,
};
