// -----------------------------------------------------------------------------
// The iSolarCloud OpenAPI (read only): the plants of the account and their
// real-time data. As pysolarcloud (AbstractAuth.request, Plants): POST JSON
// to the gateway, the secret key in `x-access-key`, the access token as a
// Bearer, the app key and the language in the body.
// -----------------------------------------------------------------------------

import { API_PATHS, LIMITS, POINTS } from './constants.js';
import { SungrowError, envelopeError, parseJson, transientError } from './http.js';

/** Every measure point read, once. */
export const POINT_IDS = [...new Set(Object.values(POINTS).flat())];

/** POST one path of the API with the access token -> the `result_data` of its answer. */
export async function apiPost(
  transport,
  path,
  data,
  { api, appKey, secretKey, token, now, timeout },
) {
  const body = JSON.stringify({ ...data, appkey: appKey, lang: '_en_US' });
  const res = await transport(`${api}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-access-key': secretKey,
      Authorization: `Bearer ${token}`,
    },
    body,
    timeout,
  });
  const transient = transientError(res, now);
  if (transient) {
    throw transient;
  }
  if (res.status === 401) {
    throw new SungrowError('unauthorized', 'iSolarCloud refused the access token', {
      status: 401,
    });
  }
  if (res.status !== 200) {
    // A 403 may come from a proxy in front of the gateway: never a refusal by itself.
    throw new SungrowError('http', 'unexpected answer of iSolarCloud', { status: res.status });
  }
  const json = parseJson(res.body);
  const error = envelopeError(json);
  if (error) {
    throw error;
  }
  const result = json.result_data;
  if (result === null || typeof result !== 'object') {
    throw new SungrowError('bad_response', 'no data in the answer of iSolarCloud');
  }
  return result;
}

/** The plants the user authorized (one page of 100: far above LIMITS.plants). */
export const listPlants = (transport, options) =>
  apiPost(transport, API_PATHS.plants, { page: 1, size: 100 }, options);

/** The real-time data of the plants, every point of POINTS, with the point dictionary. */
export const realtimeData = (transport, plantIds, options) =>
  apiPost(
    transport,
    API_PATHS.realtime,
    {
      ps_id_list: plantIds.slice(0, LIMITS.plants),
      point_id_list: POINT_IDS,
      is_get_point_dict: '1',
    },
    options,
  );
