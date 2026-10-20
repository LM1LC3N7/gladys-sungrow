// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake iSolarCloud behind the transport. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SungrowApp } from '../src/app.js';
import { clientKey } from '../src/config.js';
import { ACTIONS, LIMITS, OAUTH_FIELD } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { SungrowError } from '../src/http.js';
import {
  APP_ID,
  APP_KEY,
  DAY,
  GLADYS_REDIRECT,
  HOUR,
  MINUTE,
  NOW,
  PLANT_A,
  PLANT_B,
  SECOND,
  SECRET_KEY,
  pointsDto,
} from './fixtures/sungrow.js';
import { answer, fakeSungrow, memoryStore, settle } from './helpers/fakeSungrow.js';

const CONFIG = { app_key: APP_KEY, secret_key: SECRET_KEY, app_id: APP_ID };
const device = (kind, id) => `ext:test-integration:${kind}:${id}`;
const feature = (kind, id, key) => `${device(kind, id)}:${key}`;

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    server = fakeSungrow(),
    now = NOW,
    signIn = store.data === null && Boolean(config.app_key),
    create = true,
    logs = [],
    mock = true,
    devices,
  } = {},
) {
  if (mock) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  }
  const gladys = createFakeGladys({ config, ...(devices ? { devices } : {}) });
  const app = new SungrowApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = 10 * SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  const connect = async (redirect = GLADYS_REDIRECT) => {
    const ack = await gladys.fake.oauthAuthorizeUrl(OAUTH_FIELD, redirect);
    assert.equal(ack.success, true, JSON.stringify(ack));
    return server.approve(ack.data.authorize_url);
  };
  if (signIn) {
    assert.equal(server.requests.length, 0, 'nothing sent before the click');
    const back = await connect();
    const ack = await gladys.fake.oauthCallback(OAUTH_FIELD, back);
    assert.equal(ack.success, true, JSON.stringify(ack));
    await settle();
  }
  if (create) {
    for (const d of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(d);
    }
    await advance(2 * SECOND, SECOND);
  }
  return { gladys, app, server, store, advance, connect, logs };
}

const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const last = (gladys, kind, id, key) => gladys.fake.lastState(feature(kind, id, key));

test('without the keys, the status asks for them, nothing is sent and Connect refuses', async (t) => {
  const { gladys, server, advance } = await setup(t, {
    config: { app_key: APP_KEY },
    signIn: false,
  });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /clé d’application/);
  const ack = await gladys.fake.oauthAuthorizeUrl(OAUTH_FIELD, GLADYS_REDIRECT);
  assert.equal(ack.success, false);
  await advance(HOUR, 5 * MINUTE);
  assert.equal(server.requests.length, 0);
});

test('signed out: never a request by itself; Connect builds the iSolarCloud address', async (t) => {
  const { gladys, server, advance, connect } = await setup(t, { signIn: false });
  assert.match(message(gladys).en, /Not signed in to iSolarCloud: click Connect/);
  await advance(2 * HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, 0);
  const ack = await gladys.fake.oauthAuthorizeUrl(OAUTH_FIELD, GLADYS_REDIRECT);
  const address = ack.data.authorize_url;
  const url = new URL(address);
  assert.equal(url.origin, 'https://web3.isolarcloud.eu');
  // The state BEFORE the fragment (single-page application, pysolarcloud).
  assert.ok(address.indexOf('?state=') < address.indexOf('#'));
  assert.ok(url.searchParams.get('state').length >= 16);
  const fragment = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1));
  assert.ok(url.hash.startsWith('#/authorized-app?'));
  assert.equal(fragment.get('cloudId'), '3');
  assert.equal(fragment.get('applicationId'), APP_ID);
  assert.equal(fragment.get('redirectUrl'), GLADYS_REDIRECT);
  assert.ok(!address.includes(SECRET_KEY), 'the secret key never goes to the browser');
  assert.ok(!address.includes(APP_KEY));
  // Not connected: the status shows the return address to register in the app.
  assert.match(message(gladys).en, /return address of this Gladys is https:\/\/gladys\.local/);
  await connect();
  assert.equal(server.requests.length, 0);
});

test('authorization, then one read: devices, states, indexes, status, tokens in /data, no secret logged', async (t) => {
  const logs = [];
  const server = fakeSungrow({ plants: [PLANT_A, PLANT_B] });
  server.points.set(PLANT_B, pointsDto(PLANT_B, { battery: false, grid: false }));
  const { gladys, store } = await setup(t, { server, logs });
  const [exchange] = server.of('token');
  assert.equal(exchange.json.grant_type, 'authorization_code');
  assert.equal(exchange.json.redirect_uri, GLADYS_REDIRECT);
  assert.equal(exchange.json.appkey, APP_KEY);
  assert.equal(exchange.headers['x-access-key'], SECRET_KEY);
  assert.deepEqual(
    server.apiRequests.map((r) => r.route),
    ['list', 'realtime'],
  );
  const realtime = server.of('realtime')[0];
  assert.deepEqual(realtime.json.ps_id_list, [PLANT_A, PLANT_B], 'one request for all the plants');
  assert.equal(realtime.headers.Authorization, `Bearer ${server.access}`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /Connected to iSolarCloud: 2 plant\(s\)/);

  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(ids.sort(), [
    device('battery', PLANT_A),
    device('grid', PLANT_A),
    device('plant', PLANT_A),
    device('plant', PLANT_B),
  ]);
  for (const d of gladys.fake.discoveredDevices) {
    assert.ok(d.features.every((f) => f.read_only === true));
  }
  const grid = gladys.fake.discoveredDevices.find((d) => d.external_id === device('grid', PLANT_A));
  assert.equal(grid.name, 'Maison – réseau');

  assert.equal(last(gladys, 'plant', PLANT_A, 'pv_power'), 3250);
  assert.equal(last(gladys, 'plant', PLANT_A, 'production_today'), 12.5);
  assert.equal(last(gladys, 'plant', PLANT_A, 'production_index'), 25000);
  assert.equal(last(gladys, 'plant', PLANT_A, 'load_power'), 850);
  assert.equal(last(gladys, 'grid', PLANT_A, 'import_index'), 4500);
  assert.equal(last(gladys, 'grid', PLANT_A, 'grid_power'), -1200);
  assert.equal(last(gladys, 'grid', PLANT_A, 'export_total'), 9000);
  assert.equal(last(gladys, 'battery', PLANT_A, 'battery_level'), 76);
  assert.equal(last(gladys, 'battery', PLANT_A, 'battery_power'), -400);
  assert.equal(last(gladys, 'plant', PLANT_B, 'production_index'), 25000);

  const saved = store.data;
  assert.equal(saved.session.client, clientKey('eu', APP_KEY, APP_ID));
  assert.equal(saved.session.refreshToken, server.refresh);
  assert.equal(saved.plants.list.length, 2);
  assert.deepEqual(saved.indexes[feature('grid', PLANT_A, 'import_index')].last.value, 4500);
  assert.ok(!JSON.stringify(saved).includes(SECRET_KEY), 'the secret key stays in Gladys');
  assert.deepEqual(
    [...new Set(gladys.fake.transports.map((e) => e.transport))],
    [DEVICE_TRANSPORTS.CLOUD],
  );
  const text = logs.join('\n');
  for (const secret of [SECRET_KEY, server.access, server.refresh, 'code-1']) {
    assert.ok(!text.includes(secret), 'a secret reached the logs');
  }
});

test('tokens given inside result_data are read too', async (t) => {
  const server = fakeSungrow({ wrapTokens: true });
  const { gladys } = await setup(t, { server });
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a return to Gladys with an unknown or missing state is refused, nothing exchanged', async (t) => {
  const { gladys, server, connect } = await setup(t, { signIn: false });
  const back = await connect();
  let ack = await gladys.fake.oauthCallback(OAUTH_FIELD, { ...back, state: 'forged' });
  assert.equal(ack.success, false);
  ack = await gladys.fake.oauthCallback(OAUTH_FIELD, { ...back, state: undefined });
  assert.equal(ack.success, false);
  assert.equal(server.requests.length, 0);
  ack = await gladys.fake.oauthCallback(OAUTH_FIELD, back);
  assert.equal(ack.success, true);
  ack = await gladys.fake.oauthCallback(OAUTH_FIELD, back);
  assert.equal(ack.success, false, 'one use only');
});

test('a refused code tells the user, nothing is retried', async (t) => {
  const { gladys, server, connect, advance } = await setup(t, { signIn: false });
  const back = await connect();
  server.queue('token', answer(400, { error: 'invalid_grant' }));
  const ack = await gladys.fake.oauthCallback(OAUTH_FIELD, back);
  assert.equal(ack.success, false);
  assert.match(ack.error, /invalid_grant/);
  await advance(HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, 1);
});

test('another redirect URL: the pasted address finishes the authorization', async (t) => {
  const redirect = 'https://my.example.org/sungrow/return';
  const { gladys, server, connect } = await setup(t, {
    config: { ...CONFIG, redirect_uri: redirect },
    signIn: false,
  });
  const back = await connect();
  assert.equal(back.redirectUri, redirect, 'the configured address, not Gladys');
  let ack = await gladys.fake.action(ACTIONS.FINISH_SIGN_IN, { url: 'hello' });
  assert.match(ack.data.message.en, /No authorization code/);
  ack = await gladys.fake.action(ACTIONS.FINISH_SIGN_IN, {
    url: `${redirect}?error=access_denied&state=${back.state}`,
  });
  assert.match(ack.data.message.en, /did not authorize the app \(access_denied\)/);
  ack = await gladys.fake.action(ACTIONS.FINISH_SIGN_IN, { url: `${redirect}?code=${back.code}` });
  assert.match(ack.data.message.en, /No authorization code/);
  for (const other of [
    `https://evil.example/sungrow/return?state=${back.state}&code=${back.code}`,
    `https://my.example.org/other?state=${back.state}&code=${back.code}`,
  ]) {
    ack = await gladys.fake.action(ACTIONS.FINISH_SIGN_IN, { url: other });
    assert.match(ack.data.message.en, /not the redirect URL/);
  }
  assert.equal(server.requests.length, 0, 'nothing exchanged');
  ack = await gladys.fake.action(ACTIONS.FINISH_SIGN_IN, {
    url: `${redirect}?code=${back.code}&state=${back.state}`,
  });
  assert.match(ack.data.message.en, /Authorized by iSolarCloud/);
  await settle();
  const [exchange] = server.of('token');
  assert.equal(exchange.json.redirect_uri, redirect);
  assert.equal(exchange.timeout, 10 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the return relayed by Gladys: exchanged within 3.5 s, a slow iSolarCloud asks for a new click', async (t) => {
  const { gladys, server, connect } = await setup(t, { signIn: false });
  const back = await connect();
  server.queue('token', async (request) => {
    assert.equal(request.timeout, 3500);
    throw new SungrowError('timeout', 'no answer within 4 s');
  });
  let ack = await gladys.fake.oauthCallback(OAUTH_FIELD, back);
  assert.equal(ack.success, false);
  assert.match(ack.error, /iSolarCloud lent, cliquez de nouveau sur Connecter/);
  ack = await gladys.fake.oauthCallback(OAUTH_FIELD, back);
  assert.equal(ack.success, false);
  assert.equal(server.of('token').length, 1);
});

test('the token is renewed by a timer before its end, never twice within a minute', async (t) => {
  const server = fakeSungrow({ expiresIn: 600 });
  const { advance, gladys } = await setup(t, { server });
  assert.equal(server.of('token').length, 1);
  // 600 s token: margin min(5 min, 300 s) -> renewed at 300 s.
  await advance(290 * SECOND);
  assert.equal(server.of('refresh').length, 0);
  await advance(20 * SECOND);
  assert.equal(server.of('refresh').length, 1);
  assert.equal(server.of('refresh')[0].json.refresh_token, 'refresh-1');
  assert.equal(server.of('refresh')[0].headers['x-access-key'], SECRET_KEY);
  server.expiresIn = 10;
  await advance(10 * MINUTE, 5 * SECOND);
  const renewals = server.of('refresh').length - 1;
  assert.ok(renewals >= 1 && renewals <= 11, `${renewals} renewals in 10 minutes`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a refused renewal stops everything, kept across a restart; only an authorization resumes', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow({ expiresIn: 600 });
  const { gladys, app, advance } = await setup(t, { server, store });
  server.refresh = 'rotated-elsewhere';
  await advance(6 * MINUTE);
  assert.match(message(gladys).en, /session ended/);
  assert.equal(store.data.block.kind, 'expired');
  assert.equal(store.data.session, null);
  const before = server.requests.length;
  await advance(3 * HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, before, 'nothing retried by itself');
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /session ended/);
  assert.equal(server.requests.length, before);

  app.stop();
  const again = await setup(t, { server, store, mock: false, create: false });
  assert.match(message(again.gladys).en, /session ended/);
  await again.advance(HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, before);
  const back = await again.connect();
  const ok = await again.gladys.fake.oauthCallback(OAUTH_FIELD, back);
  assert.equal(ok.success, true);
  await settle();
  assert.equal(store.data.block, null);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
});

test('a 429 pauses every path, kept in /data across a restart and a reconnection', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const { gladys, app, advance } = await setup(t, { server, store });
  server.queue('realtime', answer(429, {}, { 'retry-after': '1800' }));
  await advance(5 * MINUTE);
  assert.match(message(gladys).en, /slow down: pause of 30 min/);
  assert.equal(store.data.pause.kind, 'rate');
  const before = server.requests.length;
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /slow down/);
  await advance(20 * MINUTE, MINUTE);
  assert.equal(server.requests.length, before, 'nothing during the pause');
  app.stop();
  const again = await setup(t, { server, store, mock: false, create: false });
  assert.match(message(again.gladys).en, /slow down/);
  await again.advance(5 * MINUTE, MINUTE);
  assert.equal(server.requests.length, before);
  await again.advance(10 * MINUTE, MINUTE);
  assert.ok(server.requests.length > before, 'read again after the pause');
  assert.equal(store.data.pause, null);
});

test('"too frequent" in the answer is a rate pause too, never a stop', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const { gladys, advance } = await setup(t, { server, store });
  server.queue(
    'realtime',
    answer(200, { result_code: 'E900', result_msg: 'Access too frequent, please try later' }),
  );
  await advance(5 * MINUTE);
  assert.equal(store.data.pause.kind, 'rate');
  assert.equal(store.data.block, null);
  assert.match(message(gladys).en, /pause of 15 min/);
  const before = server.requests.length;
  await advance(14 * MINUTE, MINUTE);
  assert.equal(server.requests.length, before);
});

test('5xx: a pause kept in /data, never sooner than the interval', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const { gladys, advance } = await setup(t, { server, store });
  server.queue('realtime', answer(503, {}));
  await advance(5 * MINUTE);
  assert.match(message(gladys).en, /unavailable/);
  assert.equal(store.data.pause.kind, 'unavailable');
  const before = server.of('realtime').length;
  await advance(4 * MINUTE, 30 * SECOND);
  assert.equal(server.of('realtime').length, before);
  await advance(2 * MINUTE, 30 * SECOND);
  assert.equal(server.of('realtime').length, before + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a refused token: one renewal and one retry; refused again, a stop only a click lifts', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const { gladys, advance } = await setup(t, { server, store });
  server.revokeAccess();
  await advance(5 * MINUTE);
  assert.equal(server.of('refresh').length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const refused = answer(200, { result_code: 'E00003', result_msg: 'er_token_login_invalid' });
  server.queue('realtime', refused, 2);
  server.revokeAccess();
  await advance(5 * MINUTE);
  assert.match(message(gladys).en, /refused the access/);
  assert.equal(store.data.block.kind, 'unauthorized');
  const before = server.requests.length;
  await advance(2 * HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, before, 'nothing retried by itself');
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /Connected to iSolarCloud/);
  assert.equal(store.data.block, null);
});

test('the developer app refused (wrong secret key): a stop, never retried by itself', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const { gladys, advance } = await setup(t, { server, store });
  server.queue(
    'realtime',
    answer(200, { result_code: 'E00001', result_msg: 'appkey or access key is wrong' }),
  );
  await advance(5 * MINUTE);
  assert.equal(store.data.block.kind, 'unauthorized');
  assert.match(message(gladys).en, /check the app key and the secret key/);
  const before = server.requests.length;
  await advance(3 * HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, before);
});

test('the daily budget of requests: reached, everything waits for the next UTC day', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const { gladys, app, advance } = await setup(t, { server, store });
  app.memory.requests.count = LIMITS.dailyRequests;
  await advance(5 * MINUTE);
  assert.equal(store.data.pause.kind, 'budget');
  assert.match(message(gladys).en, /daily number of requests/);
  const before = server.requests.length;
  // 10:05 UTC: 13 h 55 min to midnight, plus a minute.
  await advance(13 * HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, before);
  await advance(2 * HOUR, 5 * MINUTE);
  assert.ok(server.requests.length > before, 'read again the next day');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('index: a jump is held (the last value sent again), shown, and taken only once accepted', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const { gladys, advance } = await setup(t, { server, store });
  const id = feature('grid', PLANT_A, 'import_index');
  // +10,000 kWh in 5 minutes: impossible at 36 kW.
  server.points.set(PLANT_A, pointsDto(PLANT_A, { p83105: '14500000' }));
  await advance(5 * MINUTE);
  assert.equal(gladys.fake.lastState(id), 4500);
  assert.match(
    message(gladys).en,
    /Index held back, Maison – Energy bought.*4,500 kWh → 14,500 kWh \(jump\)/,
  );
  assert.equal(store.data.indexes[id].held.direction, 'up');
  // Never confirmed by repetition nor by time.
  await advance(HOUR, 5 * MINUTE);
  assert.equal(gladys.fake.lastState(id), 4500);
  const ack = await gladys.fake.action(ACTIONS.ACCEPT_INDEX);
  assert.match(ack.data.message.en, /Accepted: Maison – Energy bought from the grid/);
  await advance(5 * MINUTE);
  assert.equal(gladys.fake.lastState(id), 14500);
  assert.equal(store.data.indexes[id].held, null);
  const none = await gladys.fake.action(ACTIONS.ACCEPT_INDEX);
  assert.match(none.data.message.en, /No index is held back/);
});

test('index: 0 or an absent total is never published; a drop is held across a restart', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const { gladys, app, advance } = await setup(t, { server, store });
  const id = feature('plant', PLANT_A, 'production_index');
  server.points.set(PLANT_A, pointsDto(PLANT_A, { p83024: '0' }));
  await advance(5 * MINUTE);
  assert.equal(gladys.fake.lastState(id), 25000);
  server.points.set(PLANT_A, pointsDto(PLANT_A, { p83024: '--' }));
  await advance(5 * MINUTE);
  assert.equal(gladys.fake.lastState(id), 25000);
  server.points.set(PLANT_A, pointsDto(PLANT_A, { p83024: '1000000' }));
  await advance(5 * MINUTE);
  assert.equal(gladys.fake.lastState(id), 25000);
  assert.equal(store.data.indexes[id].held.direction, 'down');
  app.stop();
  // Gladys restarted too: the created devices come back with the connection.
  const again = await setup(t, {
    server,
    store,
    mock: false,
    create: false,
    devices: gladys.devices,
  });
  await again.advance(10 * MINUTE, MINUTE);
  assert.equal(store.data.indexes[id].held.direction, 'down', 'still held after the restart');
  // Back to the real value: the hold ends, nothing fictive counted.
  server.points.set(PLANT_A, pointsDto(PLANT_A, { p83024: '25001000' }));
  await again.advance(5 * MINUTE, MINUTE);
  assert.equal(store.data.indexes[id].held, null);
  assert.equal(store.data.indexes[id].last.value, 25001);
});

test('one plant without data never stops the other; its devices show unreachable', async (t) => {
  const server = fakeSungrow({ plants: [PLANT_A, PLANT_B] });
  const { gladys, advance } = await setup(t, { server });
  server.points.delete(PLANT_B);
  server.points.set(PLANT_A, pointsDto(PLANT_A, { p83067: '1500' }));
  await advance(5 * MINUTE);
  assert.equal(last(gladys, 'plant', PLANT_A, 'pv_power'), 1500);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /No data this time for: Garage/);
  const badges = gladys.fake.transports.filter(
    (e) => e.device_external_id === device('plant', PLANT_B),
  );
  assert.equal(badges.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});

test('a network failure is never read again sooner than the interval', async (t) => {
  const server = fakeSungrow();
  const { gladys, advance } = await setup(t, { server, config: { ...CONFIG, poll_minutes: 10 } });
  server.queue('realtime', async () => {
    throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
  });
  await advance(10 * MINUTE);
  assert.match(message(gladys).en, /could not be read \(connection reset\)/);
  const before = server.of('realtime').length;
  await advance(9 * MINUTE, MINUTE);
  assert.equal(server.of('realtime').length, before);
  await advance(2 * MINUTE, MINUTE);
  assert.equal(server.of('realtime').length, before + 1);
});

test('the list failing: the plants kept in /data are still read; a restart waits the interval', async (t) => {
  const store = memoryStore();
  const server = fakeSungrow();
  const first = await setup(t, { server, store });
  first.app.stop();
  server.queue('list', answer(500, {}));
  server.points.set(PLANT_A, pointsDto(PLANT_A, { p83067: '4000' }));
  const before = server.requests.length;
  const { gladys, advance } = await setup(t, { server, store, mock: false });
  assert.equal(server.requests.length, before);
  assert.match(message(gladys).en, /next read in 5 min/);
  await advance(5 * MINUTE);
  assert.equal(server.of('list').length, 2);
  assert.equal(last(gladys, 'plant', PLANT_A, 'pv_power'), 4000);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a reconnection to Gladys resends the status and the Discovery list', async (t) => {
  const { gladys } = await setup(t);
  const statuses = gladys.fake.connectionStatuses.length;
  const lists = gladys.fake.bodies('POST', '/discovered_device').length;
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, lists + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a created battery or grid device stays offered when the read no longer shows it', async (t) => {
  const server = fakeSungrow();
  const { gladys, app, advance } = await setup(t, { server });
  const before = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  server.points.set(PLANT_A, pointsDto(PLANT_A, { battery: false, grid: false }));
  await app.scan();
  await advance(5 * MINUTE);
  const after = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(after, before);
  for (const d of gladys.fake.discoveredDevices) {
    assert.ok(d.features.length > 0);
  }
});

test('new keys drop the session of the previous app', async (t) => {
  const server = fakeSungrow();
  const { gladys, advance } = await setup(t, { server });
  const before = server.requests.length;
  await gladys.fake.configUpdated({ ...CONFIG, app_key: 'ANOTHERKEY' });
  await settle();
  assert.match(message(gladys).en, /Not signed in/);
  await advance(HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, before);
});

test('the test button reads at once, then waits 30 seconds between clicks', async (t) => {
  const { gladys, server } = await setup(t);
  const before = server.of('realtime').length;
  let ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /Connected to iSolarCloud/);
  assert.equal(server.of('realtime').length, before + 1);
  ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /less than 30 seconds/);
  assert.equal(server.of('realtime').length, before + 1);
});

test('the reads stay within the daily budget at the default pace', async (t) => {
  const server = fakeSungrow({ expiresIn: 3600 });
  const { advance } = await setup(t, { server });
  const before = server.requests.length;
  await advance(DAY, 5 * MINUTE);
  const sent = server.requests.length - before;
  const routes = server.requests
    .slice(before)
    .reduce((acc, r) => ({ ...acc, [r.route]: (acc[r.route] ?? 0) + 1 }), {});
  // 288 reads; a read that meets a renewal of the timer is sent once more with the new token.
  assert.ok(routes.refresh <= 27, JSON.stringify(routes));
  assert.ok(routes.list <= 5, JSON.stringify(routes));
  assert.ok(routes.realtime <= 288 + routes.refresh + 1, JSON.stringify(routes));
  assert.ok(sent < LIMITS.dailyRequests);
});
