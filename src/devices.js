// -----------------------------------------------------------------------------
// iSolarCloud plants -> Gladys devices, and their states (pure).
//
// Up to three Gladys devices per plant, the plant id being the `ps_id`
// iSolarCloud gives (stable, unique), all read only:
//   - `plant:<ps_id>`: the solar production and the consumption of the home;
//   - `grid:<ps_id>`: the exchanges with the grid, once iSolarCloud gives one;
//   - `battery:<ps_id>`: the battery, once iSolarCloud gives its charge.
// The grid is its own device so that a home whose grid meter already feeds
// Gladys (Linky, P1…) can leave it out: its import index would be counted
// twice.
//
// Energy rules of the Gladys core (lessons of the lots 5 and 6):
// - two indexes only, both through the guard (src/guard.js): the energy
//   bought from the grid (`grid` / `import_index`, `energy-sensor` / `index`,
//   the only one the core bills) and the solar production
//   (`plant` / `production_index`, `energy-production-sensor` / `index`).
//   Both are cumulative counters of iSolarCloud, never a daily total, never
//   the injection;
// - every other total or daily value is a plain sensor (`unknown` /
//   `decimal`, the unit in the name): counted by nobody;
// - the solar power is `energy-production-sensor` / `power`; the powers of
//   the grid (its sign is the one of iSolarCloud), of the home and of the
//   battery are plain sensors, so that no energy contract takes them for the
//   power drawn from the grid;
// - the charge of the battery is `battery` / `integer`, in %;
// - the production index carries its `thirty-minutes-production` feature
//   (`production_30min`), declared here because the core derives that one
//   for a consumption index only (as gladys-imeon and gladys-apsystems): its
//   id and `energy_parent_id` are UUID v5 of the external ids, so an
//   "Update" in Discovery keeps the same rows; the integration never
//   publishes a state on it.
// Units are only those the core lists for each category, fixed at creation.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_NAMES, FEATURE_NAMES, word } from './i18n.js';

/** Namespace of the feature ids of this integration (random, fixed forever). */
const ID_NAMESPACE = Buffer.from('8d3f2a6c71e94b0f9c5a1e7d4b2c6f30', 'hex');

/** A deterministic UUID (version 5, RFC 9562) of a name (as gladys-imeon). */
export function uuidOf(name) {
  const hash = createHash('sha1').update(ID_NAMESPACE).update(String(name), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const plain = (min, max) => ({ category: C.UNKNOWN, type: TY.SENSOR.DECIMAL, min, max });
const ENERGY_MAX = 100_000_000;

/** The features of each kind of device, by role; `source`: the value read (the role by default). */
export const KINDS = {
  plant: {
    pv_power: {
      category: C.ENERGY_PRODUCTION_SENSOR,
      type: TY.ENERGY_PRODUCTION_SENSOR.POWER,
      unit: U.WATT,
      min: 0,
      max: 10_000_000,
    },
    production_index: {
      category: C.ENERGY_PRODUCTION_SENSOR,
      type: TY.ENERGY_PRODUCTION_SENSOR.INDEX,
      unit: U.KILOWATT_HOUR,
      min: 0,
      max: ENERGY_MAX,
      source: 'production_total',
      index: true,
    },
    // Declared here: the core derives it from the index (energy_parent_id) for a
    // consumption index only. Never published by the integration.
    production_30min: {
      category: C.ENERGY_PRODUCTION_SENSOR,
      type: TY.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
      unit: U.KILOWATT_HOUR,
      min: 0,
      max: ENERGY_MAX,
      derived: true,
      parent: 'production_index',
    },
    production_today: plain(0, ENERGY_MAX),
    load_power: plain(0, 10_000_000),
    load_today: plain(0, ENERGY_MAX),
    load_total: plain(0, ENERGY_MAX),
  },
  grid: {
    import_index: {
      category: C.ENERGY_SENSOR,
      type: TY.ENERGY_SENSOR.INDEX,
      unit: U.KILOWATT_HOUR,
      min: 0,
      max: ENERGY_MAX,
      source: 'import_total',
      index: true,
    },
    grid_power: plain(-10_000_000, 10_000_000),
    import_today: plain(0, ENERGY_MAX),
    export_today: plain(0, ENERGY_MAX),
    export_total: plain(0, ENERGY_MAX),
  },
  battery: {
    battery_level: {
      category: C.BATTERY,
      type: TY.BATTERY.INTEGER,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    },
    battery_power: plain(-10_000_000, 10_000_000),
    charge_today: plain(0, ENERGY_MAX),
    discharge_today: plain(0, ENERGY_MAX),
    charge_total: plain(0, ENERGY_MAX),
    discharge_total: plain(0, ENERGY_MAX),
  },
};

/** The source of a feature: the value read it shows. */
export const sourceOf = (role, spec) => spec.source ?? role;

/**
 * The kinds of device a plant shows, from what it gave: the plant always,
 * the grid once a grid value is there, the battery once its charge is.
 */
export function kindsOf(values) {
  const kinds = ['plant'];
  if (
    values &&
    ['grid_power', 'import_total', 'import_today', 'export_total', 'export_today'].some(
      (role) => values[role] !== null && values[role] !== undefined,
    )
  ) {
    kinds.push('grid');
  }
  if (values && values.battery_level !== null && values.battery_level !== undefined) {
    kinds.push('battery');
  }
  return kinds;
}

export const deviceIds = (gladys, kind, plantId) => gladys.externalIds(kind, plantId);

/** The roles that are the parent of a derived feature (they carry a fixed id). */
const PARENTS = new Set(
  Object.values(KINDS)
    .flatMap((features) => Object.values(features))
    .filter((spec) => spec.derived)
    .map((spec) => spec.parent),
);

/** The Gladys device of one kind of a plant, its names in `language`. */
export function buildDevice(gladys, kind, plant, language) {
  const ids = deviceIds(gladys, kind, plant.id);
  const suffix = word(DEVICE_NAMES[kind], language);
  const name = `${plant.name}${suffix ? ` – ${suffix}` : ''}`.slice(0, 100);
  return {
    name,
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'plant_id', value: plant.id }],
    features: Object.entries(KINDS[kind]).map(([role, spec]) => ({
      name: word(FEATURE_NAMES[role], language).slice(0, 100),
      external_id: ids.feature(role),
      // The ids tie the 30-minute feature to its index: fixed, from the external ids.
      ...(spec.derived || PARENTS.has(role) ? { id: uuidOf(ids.feature(role)) } : {}),
      ...(spec.derived ? { energy_parent_id: uuidOf(ids.feature(spec.parent)) } : {}),
      category: spec.category,
      type: spec.type,
      ...(spec.unit ? { unit: spec.unit } : {}),
      min: spec.min,
      max: spec.max,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    })),
  };
}

/**
 * The current states of one kind of device: `[[featureId, value]]`, only for
 * the values present and within the bounds of the feature (an absent value
 * is never published as 0). The indexes are left out (they go through the
 * guard, src/app.js), and so is the 30-minute production (the core's).
 */
export function deviceStates(gladys, kind, plantId, values) {
  const ids = deviceIds(gladys, kind, plantId);
  const states = [];
  for (const [role, spec] of Object.entries(KINDS[kind])) {
    if (spec.index || spec.derived) {
      continue;
    }
    const value = values?.[sourceOf(role, spec)];
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= spec.min &&
      value <= spec.max
    ) {
      states.push([ids.feature(role), value]);
    }
  }
  return states;
}

/** The index features of one kind of device: `[[featureId, value | null, role]]`. */
export function indexValues(gladys, kind, plantId, values) {
  const ids = deviceIds(gladys, kind, plantId);
  return Object.entries(KINDS[kind])
    .filter(([, spec]) => spec.index)
    .map(([role, spec]) => {
      const value = values?.[sourceOf(role, spec)];
      return [
        ids.feature(role),
        typeof value === 'number' && Number.isFinite(value) ? value : null,
        role,
      ];
    });
}
