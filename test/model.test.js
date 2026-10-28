// -----------------------------------------------------------------------------
// The pure parts: configuration, answers -> values, errors of the API, the
// OAuth helpers, the devices, the /data state and the index guard (the tests
// of gladys-p1-monitor's guard, with `maxKw` as a parameter).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { POINT_IDS } from '../src/api.js';
import { clientKey, normalizeConfig } from '../src/config.js';
import { LIMITS, SERVERS } from '../src/constants.js';
import { KINDS, buildDevice, deviceStates, indexValues, kindsOf, uuidOf } from '../src/devices.js';
import { IndexGuard } from '../src/guard.js';
import {
  SungrowError,
  envelopeError,
  errorReason,
  parseJson,
  transientError,
} from '../src/http.js';
import { convert, number, parsePlants, parseRealtime, plantId } from '../src/model.js';
import { authorizeUrl, parseRedirect, tokenOf } from '../src/oauth.js';
import { normalizeMemory } from '../src/store.js';
import { MINUTE, NOW, PLANT_A, pointsDto, realtimeDto } from './fixtures/sungrow.js';

const p1Guard = (last, saved, loadedAt) =>
  new IndexGuard(last, saved, loadedAt, { maxKw: 100, slackKwh: 0.5 });

// --- Configuration ----------------------------------------------------------------------

test('configuration: keys without spaces, a numeric app id, bounded numbers, https redirect', () => {
  const c = normalizeConfig({
    server: 'EU',
    app_key: ' KEY ',
    secret_key: 'secret',
    app_id: ' 42 ',
    poll_minutes: 1,
    max_power_kw: 5000,
    redirect_uri: 'http://example.org/cb',
  });
  assert.equal(c.server, 'eu');
  assert.equal(c.appKey, 'KEY');
  assert.equal(c.appId, '42');
  assert.equal(c.pollMinutes, 5, 'never faster than iSolarCloud updates');
  assert.equal(c.maxKw, 1000);
  assert.equal(c.redirectUri, '', 'http only on localhost');
  assert.equal(c.client, clientKey('eu', 'KEY', '42'));
  assert.equal(
    normalizeConfig({ redirect_uri: 'http://localhost:8080/cb' }).redirectUri,
    'http://localhost:8080/cb',
  );
  assert.equal(normalizeConfig({ server: 'mars' }).server, 'eu');
  assert.equal(normalizeConfig({ server: '__proto__' }).server, 'eu');
  assert.equal(normalizeConfig({ app_key: 'a b', app_id: '1' }).client, '');
  assert.equal(normalizeConfig({ app_key: 'k', app_id: 'abc' }).client, '');
  assert.equal(normalizeConfig({}).maxKw, 36);
  assert.equal(normalizeConfig({ poll_minutes: '' }).pollMinutes, 5);
  assert.notEqual(clientKey('eu', 'k', '1'), clientKey('international', 'k', '1'));
});

// --- Model -------------------------------------------------------------------------------

test('numbers: numbers and numeric strings only', () => {
  assert.equal(number('12.5'), 12.5);
  assert.equal(number(' -3 '), -3);
  assert.equal(number(7), 7);
  for (const bad of ['--', '', null, undefined, NaN, Infinity, '1,5', '0x10', {}, []]) {
    assert.equal(number(bad), null, String(bad));
  }
});

test('units: from the point dictionary, Wh and W without one; unknown units dropped', () => {
  assert.equal(convert('energy', '12500', 'Wh'), 12.5);
  assert.equal(convert('energy', '12.5', 'kWh'), 12.5);
  assert.equal(convert('energy', '2', 'MWh'), 2000);
  assert.equal(convert('energy', '12500', undefined), 12.5);
  assert.equal(convert('energy', '1', 'm³'), null);
  assert.equal(convert('energy', '-5', 'kWh'), null, 'an energy is never below 0');
  assert.equal(convert('power', '3.2', 'kW'), 3200);
  assert.equal(convert('power', '-400', 'W'), -400);
  assert.equal(convert('power', '1', 'A'), null);
  assert.equal(convert('power', '1e9', 'W'), null, 'a glitch');
  assert.equal(convert('percent', '76', '%'), 76);
  assert.equal(convert('percent', '0.76', ''), 76);
  assert.equal(convert('percent', '120', '%'), null);
  assert.equal(convert('percent', '50', 'V'), null);
});

test('plants: ids as digits, names bounded, duplicates and junk dropped, at most 20', () => {
  assert.equal(parsePlants({}), null);
  const plants = parsePlants({
    pageList: [
      { ps_id: 1234567, ps_name: ' Maison ' },
      { ps_id: '1234567', ps_name: 'again' },
      { ps_id: '12a', ps_name: 'bad' },
      { ps_id: 99 },
      null,
    ],
  });
  assert.deepEqual(plants, [
    { id: '1234567', name: 'Maison' },
    { id: '99', name: 'Sungrow 99' },
  ]);
  const many = parsePlants({ pageList: Array.from({ length: 50 }, (_, i) => ({ ps_id: i + 1 })) });
  assert.equal(many.length, LIMITS.plants);
  assert.equal(plantId(1.5), null);
  assert.equal(plantId('1'.repeat(21)), null);
});

test('real-time data: one entry per plant, the first point present wins, absent is null', () => {
  const data = parseRealtime(
    realtimeDto([pointsDto(PLANT_A, { p83067: '--', battery: false })]).result_data,
  );
  const values = data.get(PLANT_A);
  assert.equal(values.pv_power, 3200, '83067 absent: 83033');
  assert.equal(values.production_total, 25000);
  assert.equal(values.import_total, 4500);
  assert.equal(values.battery_level, null);
  assert.equal(values.charge_total, null);
  assert.equal(kindsOf(values).join(), 'plant,grid');
  // The wrapped shape is read too; prototype keys never become values.
  const wrapped = parseRealtime({
    device_point_list: [{ device_point: { ps_id: 5, p83033: '10', __proto__: { p83024: '1' } } }],
  });
  assert.equal(wrapped.get('5').pv_power, 10);
  assert.equal(wrapped.get('5').production_total, null);
  assert.equal(parseRealtime({}), null);
  const polluted = parseJson('{"device_point_list":[{"ps_id":1,"__proto__":{"p83033":"9"}}]}');
  assert.equal(parseRealtime(polluted).get('1').pv_power, null);
  assert.equal({}.p83033, undefined);
});

test('every point read is in the request', () => {
  assert.ok(POINT_IDS.includes('83105') && POINT_IDS.includes('83024'));
  assert.equal(new Set(POINT_IDS).size, POINT_IDS.length);
});

// --- Errors ------------------------------------------------------------------------------

test('errors of the API: classified from their text, only a safe code kept', () => {
  assert.equal(envelopeError({ result_code: '1', result_data: {} }), undefined);
  const cases = [
    [{ result_code: 'E900', result_msg: 'Access too frequent' }, 'rate_limited'],
    [{ result_code: '010', result_msg: '访问频繁' }, 'rate_limited'],
    [{ result_code: 'E1', result_msg: 'system busy' }, 'unavailable'],
    [{ result_code: 'E00001', result_msg: 'appkey is wrong' }, 'app_refused'],
    [{ result_code: 'E2', result_msg: 'x-access-key error' }, 'app_refused'],
    [{ result_code: 'E00003', result_msg: 'er_token_login_invalid' }, 'unauthorized'],
    [{ error: 'invalid_token' }, 'unauthorized'],
    [{ result_code: 'E5', result_msg: 'parameter error' }, 'api_error'],
  ];
  for (const [data, kind] of cases) {
    assert.equal(envelopeError(data).kind, kind, JSON.stringify(data));
  }
  const err = envelopeError({ result_code: 'E5', result_msg: 'token abc123secret is bad <b>' });
  assert.equal(err.detail, 'E5');
  assert.ok(!errorReason(err).includes('abc123secret'));
  assert.equal(envelopeError({ result_code: 'x y <z>', result_msg: 'oops' }).detail, undefined);
  assert.equal(envelopeError(null).kind, 'bad_response');
  assert.equal(
    transientError({ status: 429, headers: { 'retry-after': '60' } }, 0).retryAfter,
    60_000,
  );
  assert.equal(transientError({ status: 502 }, 0).kind, 'unavailable');
  assert.equal(transientError({ status: 200 }, 0), undefined);
  assert.throws(() => parseJson('<html>'), SungrowError);
});

// --- OAuth --------------------------------------------------------------------------------

test('the authorization address: the state before the fragment, as pysolarcloud', () => {
  assert.equal(
    authorizeUrl(SERVERS.eu, {
      appId: '123',
      redirectUri: 'https://example.com/callback',
      state: 'flow/123',
    }),
    'https://web3.isolarcloud.eu?state=flow%2F123#/authorized-app?cloudId=3&applicationId=123&redirectUrl=https%3A%2F%2Fexample.com%2Fcallback',
  );
  assert.equal(
    authorizeUrl(SERVERS.india, { appId: '123', redirectUri: 'https://example.com/callback' }),
    'https://web3.isolarcloud.in/#/authorized-app?cloudId=9&applicationId=123&redirectUrl=https%3A%2F%2Fexample.com%2Fcallback',
  );
  assert.equal(SERVERS.australia.cloudId, 7);
});

test('a pasted address: code and state from the query or a fragment, bounded', () => {
  assert.deepEqual(parseRedirect('https://a.example/cb?code=C&state=S'), {
    code: 'C',
    state: 'S',
    error: null,
    errorDescription: null,
    base: 'https://a.example/cb',
  });
  assert.equal(parseRedirect('https://a.example/#/x?code=C&state=S').code, 'C');
  assert.equal(parseRedirect('?code=C&state=S').base, null);
  assert.equal(parseRedirect('hello'), null);
  assert.equal(parseRedirect(`https://a.example/cb?code=${'x'.repeat(5000)}&state=S`), null);
});

test('token answers: at the top or in result_data; a bounded life', () => {
  const top = tokenOf({ access_token: 'a', refresh_token: 'r', expires_in: 600 }, 1000);
  assert.deepEqual(top, {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 601_000,
    obtainedAt: 1000,
  });
  const wrapped = tokenOf(
    { result_code: '1', result_data: { access_token: 'a', expires_in: '60' } },
    0,
  );
  assert.equal(wrapped.expiresAt, 60_000);
  assert.equal(wrapped.refreshToken, null);
  assert.equal(tokenOf({ access_token: 'a' }, 0).expiresAt, 60 * MINUTE);
  assert.equal(tokenOf({ result_code: 'E1' }, 0), null);
  assert.equal(tokenOf({ access_token: 'x'.repeat(LIMITS.tokenLength + 1) }, 0), null);
});

// --- Devices -----------------------------------------------------------------------------

test('devices: read only, units of the core, two indexes only, the indexes apart from the states', () => {
  const gladys = createFakeGladys({ config: {} });
  const plant = { id: PLANT_A, name: 'Maison' };
  const indexes = [];
  for (const kind of Object.keys(KINDS)) {
    const d = buildDevice(gladys, kind, plant, 'fr');
    assert.ok(d.features.every((f) => f.read_only && !f.has_feedback));
    for (const f of d.features) {
      if (f.type === 'index') {
        indexes.push(`${f.category}/${f.external_id.split(':').at(-1)}`);
        assert.equal(f.unit, 'kilowatt-hour');
      }
      if (f.category === 'unknown') {
        assert.equal(f.unit, undefined, 'a plain sensor has its unit in its name');
      }
    }
  }
  assert.deepEqual(indexes.sort(), [
    'energy-production-sensor/production_index',
    'energy-sensor/import_index',
  ]);
  const values = parseRealtime(realtimeDto([pointsDto(PLANT_A)]).result_data).get(PLANT_A);
  const states = deviceStates(gladys, 'grid', PLANT_A, values).map(([id]) => id.split(':').at(-1));
  assert.ok(!states.includes('import_index'));
  assert.deepEqual(
    indexValues(gladys, 'grid', PLANT_A, values).map(([, v, role]) => [role, v]),
    [['import_index', 4500]],
  );
  assert.equal(buildDevice(gladys, 'battery', plant, 'en').name, 'Maison – battery');
  assert.equal(buildDevice(gladys, 'plant', plant, 'en').name, 'Maison');
});

// --- /data ---------------------------------------------------------------------------------

test('the /data state: repaired, pauses capped, a new day starts the budget again', () => {
  const m = normalizeMemory(
    {
      session: { client: 'zz', refreshToken: 'r' },
      block: { kind: 'other', client: '0123456789abcdef' },
      pause: { kind: 'rate', until: NOW + 100 * 24 * 3600 * 1000 },
      requests: { day: 1, count: 500 },
      indexes: {
        'ext:x:grid:1:import_index': { last: { value: 5, at: 1 }, held: { direction: 'sideways' } },
        notours: { last: { value: 1, at: 1 } },
      },
    },
    NOW,
  );
  assert.equal(m.session, null);
  assert.equal(m.block, null);
  assert.equal(m.pause.until, NOW + 6 * 3600 * 1000);
  assert.equal(m.requests.count, 0);
  assert.deepEqual(Object.keys(m.indexes), ['ext:x:grid:1:import_index']);
  assert.equal(m.indexes['ext:x:grid:1:import_index'].held, null);
});

// --- The index guard (tests of gladys-p1-monitor) -----------------------------------------

test('index guard: never 0, a normal rise goes through', () => {
  const guard = p1Guard();
  assert.equal(guard.accept(0, 0), false, 'never 0, even as the first reference');
  assert.equal(guard.accept(1000, 0), true);
  assert.equal(guard.accept(1000.2, MINUTE), true);
  for (let i = 2; i < 200; i += 1) {
    assert.equal(guard.accept(0, i * MINUTE), false);
  }
  assert.equal(guard.accept(1000.3, 200 * MINUTE), true);
  assert.equal(p1Guard().accept(-1, 0), false);
  assert.equal(p1Guard().accept(NaN, 0), false);
  assert.equal(p1Guard({ value: 100, at: 0 }).accept(400, 24 * 60 * MINUTE), true);
});

test('index guard: maxKw is a parameter', () => {
  // +10 kWh in an hour: fine at 36 kW, held at 5 kW.
  assert.equal(
    new IndexGuard({ value: 100, at: 0 }, null, 0, { maxKw: 36 }).accept(110, 60 * MINUTE),
    true,
  );
  assert.equal(
    new IndexGuard({ value: 100, at: 0 }, null, 0, { maxKw: 5 }).accept(110, 60 * MINUTE),
    false,
  );
  assert.equal(new IndexGuard(undefined, null, 0, { maxKw: -1 }).maxKw, 100);
});

test('index guard: a jump up is never confirmed by repetition, only by the user', () => {
  const guard = p1Guard({ value: 1000, at: 0 });
  for (let i = 1; i <= 500; i += 1) {
    assert.equal(guard.accept(6000 + i * 0.01, i * MINUTE), false);
  }
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 1000,
    to: 6005,
    threshold: 6000.01,
    at: 500 * MINUTE,
  });
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 6005 });
  assert.equal(guard.accept(6005.01, 501 * MINUTE), true);
  assert.equal(guard.held, undefined);
  const back = p1Guard({ value: 1000, at: 0 });
  back.accept(9000, MINUTE);
  assert.equal(back.accept(1000.1, 2 * MINUTE), true);
  assert.equal(back.held, undefined);
  back.acceptHeld();
  assert.equal(back.accept(9000, 3 * MINUTE), false, 'an old acceptance never covers a new jump');
});

test('index guard: a held jump is never covered by the margin growing over time', () => {
  const guard = p1Guard({ value: 2.5, at: 0 });
  assert.equal(guard.accept(12345, MINUTE), false);
  assert.equal(guard.accept(12345.5, 200 * 60 * MINUTE), false);
  assert.equal(guard.held.threshold, 12345);
  assert.equal(guard.accept(2.6, 200 * 60 * MINUTE + MINUTE), true);
});

test('index guard: a drop is never confirmed by time; back up, nothing fictive is counted', () => {
  const guard = p1Guard({ value: 50_000, at: 0 });
  for (let i = 1; i <= 7 * 24 * 60; i += 60) {
    assert.equal(guard.accept(10 + i * 0.0001, i * MINUTE), false, `minute ${i}`);
  }
  assert.equal(guard.held.direction, 'down');
  assert.deepEqual(guard.last, { value: 50_000, at: 0 });
  assert.equal(guard.accept(50_001, 7 * 24 * 60 * MINUTE + MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: a drop accepted by the user, then the values rise normally', () => {
  const guard = p1Guard({ value: 50_000, at: 0 });
  assert.equal(guard.accept(10, MINUTE), false);
  guard.acceptHeld();
  assert.equal(guard.accept(10.01, 2 * MINUTE), true);
  assert.equal(guard.accept(10.5, 3 * MINUTE), true);
  assert.equal(guard.accept(50_000, 4 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
});

test('index guard: a frozen reading never shrinks the margin of the next rise', () => {
  const guard = p1Guard({ value: 1000, at: 0 });
  for (let i = 1; i <= 180; i += 1) {
    assert.equal(guard.accept(1000, i * MINUTE), true);
  }
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.accept(1004, 181 * MINUTE), true);
});

test('index guard: its state survives a restart; same value, the oldest date', () => {
  const guard = p1Guard({ value: 1000, at: 0 });
  guard.accept(1050, MINUTE);
  const saved = JSON.parse(JSON.stringify(guard.state()));
  const again = p1Guard({ value: 900, at: -1000 * MINUTE }, saved);
  assert.deepEqual(again.last, { value: 1000, at: 0 });
  assert.equal(again.accept(1050.1, 60 * MINUTE), false, 'still held after the restart');
  again.acceptHeld();
  assert.equal(again.accept(1050.2, 61 * MINUTE), true);
  assert.deepEqual(p1Guard({ value: 1100, at: 5 }, saved).last, { value: 1100, at: 5 });
  assert.deepEqual(p1Guard({ value: 1000, at: 50 }, saved).last, { value: 1000, at: 0 });
});

test('index guard: an acceptance is bounded to the value shown and the margin since', () => {
  const guard = p1Guard({ value: 1000, at: 0 });
  assert.equal(guard.accept(1005, MINUTE), false);
  guard.acceptHeld();
  assert.equal(guard.accept(5000, 2 * MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.accepted, undefined);
  const below = p1Guard({ value: 1000, at: 0 });
  below.accept(1005, MINUTE);
  below.acceptHeld();
  assert.equal(below.accept(1004, 2 * MINUTE), false);
  const drop = p1Guard({ value: 1000, at: 0 });
  drop.accept(10, MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(900, 2 * MINUTE), false, 'not the drop shown');
  assert.equal(p1Guard({ value: 1, at: 0 }).acceptHeld(), undefined, 'nothing held');
});

test('index guard: a value held read back from /data is dated at its loading', () => {
  const DAY = 24 * 60 * MINUTE;
  const saved = {
    last: { value: 1000, at: 0 },
    held: { direction: 'up', from: 1000, to: 1005, threshold: 1005, at: 0 },
  };
  const guard = p1Guard(undefined, saved, 5 * DAY);
  assert.equal(guard.held.at, 5 * DAY);
  guard.acceptHeld();
  assert.equal(guard.accept(5000, 5 * DAY + MINUTE), false, 'the old date never widens it');
});

test('index guard: under a held jump, an old reference never lets a big rise through', () => {
  const DAY = 24 * 60 * MINUTE;
  const guard = p1Guard({ value: 1000, at: 0 });
  assert.equal(guard.accept(15_000, MINUTE), false);
  assert.equal(guard.accept(15_000, 10 * DAY), false);
  assert.equal(guard.accept(14_000, 10 * DAY + MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 14_000);
  assert.equal(guard.accept(1000.2, 10 * DAY + 2 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('the 30-minute production: fixed UUID v5 ids tied to the production index, no state', () => {
  const gladys = createFakeGladys({ config: {} });
  const plant = { id: PLANT_A, name: 'Maison' };
  const d = buildDevice(gladys, 'plant', plant, 'en');
  const index = d.features.find((f) => f.external_id.endsWith(':production_index'));
  const derived = d.features.find((f) => f.external_id.endsWith(':production_30min'));
  assert.equal(derived.category, 'energy-production-sensor');
  assert.equal(derived.type, 'thirty-minutes-production');
  assert.equal(derived.unit, 'kilowatt-hour');
  assert.equal(index.id, uuidOf(index.external_id));
  assert.equal(derived.id, uuidOf(derived.external_id));
  assert.equal(derived.energy_parent_id, index.id);
  assert.match(index.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(buildDevice(gladys, 'plant', plant, 'fr').features[2].id, derived.id, 'stable');
  const values = parseRealtime(realtimeDto([pointsDto(PLANT_A)]).result_data).get(PLANT_A);
  const roles = deviceStates(gladys, 'plant', PLANT_A, values).map(([id]) => id.split(':').at(-1));
  assert.ok(!roles.includes('production_30min') && !roles.includes('production_index'));
  assert.deepEqual(
    indexValues(gladys, 'plant', PLANT_A, values).map(([, , role]) => role),
    ['production_index'],
  );
  // The other features carry no id of ours.
  assert.equal(d.features.find((f) => f.external_id.endsWith(':pv_power')).id, undefined);
});

test('a text about a plant or an authorization is no token refusal', () => {
  assert.equal(
    envelopeError({ result_code: 'E7', result_msg: 'unauthorized plant' }).kind,
    'api_error',
  );
  assert.equal(
    envelopeError({ result_code: 'E8', result_msg: 'no authorization for ps_id' }).kind,
    'api_error',
  );
  assert.equal(
    envelopeError({ result_code: 'E9', result_msg: '系统异常，请稍后重试' }).kind,
    'unavailable',
  );
  // A token or login text wins over a "busy" word: a refused token is never a pause.
  for (const text of [
    'token异常',
    '登录异常',
    '系统检测到token已失效',
    'token invalid, try again later',
  ]) {
    assert.equal(envelopeError({ result_code: 'E1', result_msg: text }).kind, 'unauthorized', text);
  }
  assert.equal(envelopeError({ result_code: 'E1', result_msg: 'appkey异常' }).kind, 'app_refused');
  assert.equal(envelopeError({ result_code: 'E1', result_msg: '异常' }).kind, 'api_error');
});

test('index guard: an accepted drop is the floor, a lower value later is held', () => {
  const guard = p1Guard({ value: 1000, at: 0 }, undefined, 0);
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  assert.equal(guard.accept(5, 2 * MINUTE), false, 'never 5 kWh without a click');
  assert.equal(guard.held.to, 5);
  assert.equal(guard.last.value, 1000);
  // The value accepted comes back: it follows, from the floor accepted.
  assert.equal(guard.accept(12.1, 3 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: readings under an accepted floor for hours never widen the acceptance', () => {
  const guard = p1Guard({ value: 1000, at: 0 }, undefined, 0);
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  let t = 2 * MINUTE;
  for (; t < 15 * 60 * MINUTE; t += MINUTE) assert.equal(guard.accept(5, t), false);
  assert.equal(guard.accept(212, t), false, '212 kWh after 15 h under the floor: held');
  assert.equal(guard.held.to, 212);
  // A value above the acceptance dropped it: 12.1 needs a new acceptance.
  assert.equal(guard.accept(12.1, t + MINUTE), false);
  assert.equal(guard.held.direction, 'down');
});
