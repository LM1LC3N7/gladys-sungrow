// -----------------------------------------------------------------------------
// A fake iSolarCloud behind the transport of the app: the token endpoints
// (authorization code, refresh token) and the OpenAPI (plants, real-time
// data), on the European gateway. Every request is recorded;
// `queue(route, answer)` injects one answer.
// -----------------------------------------------------------------------------

import {
  APP_ID,
  APP_KEY,
  PLANT_A,
  SECRET_KEY,
  listDto,
  pointsDto,
  realtimeDto,
} from '../fixtures/sungrow.js';

const GATEWAY = 'https://gateway.isolarcloud.eu';
const ROUTES = {
  '/openapi/apiManage/token': 'token',
  '/openapi/apiManage/refreshToken': 'refresh',
  '/openapi/platform/queryPowerStationList': 'list',
  '/openapi/platform/getPowerStationRealTimeData': 'realtime',
};

export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** /data in memory. */
export function memoryStore(data = null) {
  return {
    data,
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(value) {
      this.saves += 1;
      this.data = JSON.parse(JSON.stringify(value));
    },
  };
}

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? '' : JSON.stringify(body),
});

export function fakeSungrow({ plants = [PLANT_A], expiresIn = 3600, wrapTokens = false } = {}) {
  const server = {
    requests: [],
    plants,
    expiresIn,
    wrapTokens,
    points: new Map(plants.map((id) => [id, pointsDto(id)])),
    issued: 0,
    access: null,
    refresh: null,
    /** code -> { redirectUri, appId } */
    codes: new Map(),
    queued: { token: [], refresh: [], list: [], realtime: [] },
    queue(route, answer, times = 1) {
      for (let i = 0; i < times; i += 1) {
        this.queued[route].push(answer);
      }
    },
    /** The user authorizes on the iSolarCloud page of `authorizeUrl`: the code and state of the return. */
    approve(authorizeUrl) {
      const url = new URL(authorizeUrl);
      const fragment = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1));
      const code = `code-${this.codes.size + 1}`;
      this.codes.set(code, {
        redirectUri: fragment.get('redirectUrl'),
        appId: fragment.get('applicationId'),
      });
      return {
        code,
        state: url.searchParams.get('state'),
        redirectUri: fragment.get('redirectUrl'),
      };
    },
    revokeAccess() {
      this.access = 'revoked';
    },
    issue() {
      this.issued += 1;
      this.access = `access-${this.issued}`;
      this.refresh = `refresh-${this.issued}`;
      const tokens = {
        access_token: this.access,
        refresh_token: this.refresh,
        expires_in: this.expiresIn,
        token_type: 'bearer',
      };
      return json(
        200,
        this.wrapTokens ? { result_code: '1', result_msg: 'success', result_data: tokens } : tokens,
      );
    },
    of(route) {
      return this.requests.filter((r) => r.route === route);
    },
    get tokenRequests() {
      return this.requests.filter((r) => r.route === 'token' || r.route === 'refresh');
    },
    get apiRequests() {
      return this.requests.filter((r) => r.route === 'list' || r.route === 'realtime');
    },
    transport: async (url, { method = 'POST', headers = {}, body, timeout } = {}) => {
      const request = { url, method, headers, body, timeout, route: undefined, json: undefined };
      server.requests.push(request);
      const path = url.startsWith(GATEWAY) ? url.slice(GATEWAY.length) : url;
      const route = ROUTES[path];
      if (!route) {
        return json(404, { message: 'not found' });
      }
      request.route = route;
      request.json = JSON.parse(body);
      const injected = server.queued[route].shift();
      if (injected) {
        return typeof injected === 'function' ? injected(request) : injected;
      }
      const data = request.json;
      if (data.appkey !== APP_KEY || headers['x-access-key'] !== SECRET_KEY) {
        return route === 'token' || route === 'refresh'
          ? json(401, { error: 'invalid_client' })
          : json(200, { result_code: 'E00001', result_msg: 'appkey or access key is wrong' });
      }
      if (route === 'token') {
        const entry = server.codes.get(data.code);
        server.codes.delete(data.code);
        if (
          !entry ||
          entry.appId !== APP_ID ||
          entry.redirectUri !== data.redirect_uri ||
          data.grant_type !== 'authorization_code'
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        return server.issue();
      }
      if (route === 'refresh') {
        if (data.refresh_token !== server.refresh) {
          return json(200, { result_code: 'E1005', result_msg: 'refresh_token is invalid' });
        }
        return server.issue();
      }
      if (headers.Authorization !== `Bearer ${server.access}` || !server.access) {
        return json(200, { result_code: 'E00003', result_msg: 'er_token_login_invalid' });
      }
      if (route === 'list') {
        return json(200, listDto(server.plants));
      }
      const ids = (data.ps_id_list ?? []).filter((id) => server.points.has(id));
      return json(200, realtimeDto(ids.map((id) => server.points.get(id))));
    },
  };
  return server;
}

export const answer = json;
