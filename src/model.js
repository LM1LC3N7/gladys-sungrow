// -----------------------------------------------------------------------------
// iSolarCloud answers -> plain values (pure). Ported from pysolarcloud
// (plants.py, MIT): the list of plants (`pageList`, `ps_id`, `ps_name`), the
// real-time data (`device_point_list`, one entry per plant, a key `p<point>`
// per measure point) and its point dictionary (`point_dict`, the unit of each
// point). Only the fields named here are read: the answers never become
// objects of this code, and each list is walked once.
// -----------------------------------------------------------------------------

import { LIMITS, POINTS } from './constants.js';

const text = (value, max = 100) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;

const round = (value, digits) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** A plant id as iSolarCloud gives it (a number): safe in an external id. */
export const plantId = (value) => {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && /^\d{1,20}$/.test(id) ? id : null;
};

/** The list of plants -> [{ id, name }] (at most LIMITS.plants), or null without a list. */
export function parsePlants(result) {
  const list = Array.isArray(result?.pageList) ? result.pageList : null;
  if (!list) {
    return null;
  }
  const plants = [];
  const seen = new Set();
  for (const plant of list) {
    if (plants.length >= LIMITS.plants) {
      break;
    }
    const id = plantId(plant?.ps_id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    plants.push({ id, name: text(plant.ps_name) ?? `Sungrow ${id}` });
  }
  return plants;
}

/** A number, or a numeric string; null otherwise ("--", "", null, NaN). */
export function number(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const ENERGY_FACTORS = { wh: 0.001, kwh: 1, mwh: 1000, '': 0.001 };
const POWER_FACTORS = { w: 1, kw: 1000, mw: 1_000_000, '': 1 };
/** Beyond these, a value is a glitch: never published. */
const MAX_ENERGY_KWH = 1e9;
const MAX_POWER_W = 1e7;

/** The kind of each role: energy (kWh), power (W) or a state of charge (%). */
export const KINDS = Object.fromEntries(
  Object.keys(POINTS).map((role) => [
    role,
    role === 'battery_level' ? 'percent' : role.endsWith('_power') ? 'power' : 'energy',
  ]),
);

/** A raw value and the unit of its point -> the value of its role, or null. */
export function convert(kind, raw, unit) {
  const value = number(raw);
  if (value === null) {
    return null;
  }
  const u = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
  if (kind === 'energy') {
    const factor = ENERGY_FACTORS[u];
    const kwh = factor === undefined ? null : value * factor;
    return kwh === null || kwh < 0 || kwh > MAX_ENERGY_KWH ? null : round(kwh, 3);
  }
  if (kind === 'power') {
    const factor = POWER_FACTORS[u];
    const watts = factor === undefined ? null : value * factor;
    return watts === null || Math.abs(watts) > MAX_POWER_W ? null : round(watts, 0);
  }
  // A state of charge: "%" as is; without a unit, a fraction of 1 is turned into %.
  let percent = null;
  if (u === '%') {
    percent = value;
  } else if (u === '') {
    percent = value <= 1 ? value * 100 : value;
  }
  return percent === null || percent < 0 || percent > 100 ? null : round(percent, 0);
}

/** The point dictionary -> Map point id -> unit. */
function unitsOf(dict) {
  const units = new Map();
  if (!Array.isArray(dict)) {
    return units;
  }
  for (const point of dict.slice(0, 1000)) {
    const id = number(point?.point_id);
    if (id !== null && Number.isSafeInteger(id)) {
      units.set(
        String(id),
        typeof point.point_unit === 'string' ? point.point_unit.slice(0, 20) : '',
      );
    }
  }
  return units;
}

/**
 * The real-time data -> Map plant id -> { role: value | null }. The first
 * point of a role that holds a value wins; an absent point is null (never 0).
 */
export function parseRealtime(result) {
  const list = Array.isArray(result?.device_point_list) ? result.device_point_list : null;
  if (!list) {
    return null;
  }
  const units = unitsOf(result.point_dict);
  const plants = new Map();
  for (const entry of list.slice(0, LIMITS.plants * 5)) {
    const point =
      entry?.device_point && typeof entry.device_point === 'object' ? entry.device_point : entry;
    const id = plantId(point?.ps_id);
    if (!id || plants.has(id) || plants.size >= LIMITS.plants) {
      continue;
    }
    const values = {};
    for (const [role, ids] of Object.entries(POINTS)) {
      values[role] = null;
      for (const pid of ids) {
        const value = Object.hasOwn(point, `p${pid}`)
          ? convert(KINDS[role], point[`p${pid}`], units.get(pid))
          : null;
        if (value !== null) {
          values[role] = value;
          break;
        }
      }
    }
    plants.set(id, values);
  }
  return plants;
}
