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
// - the charge of the battery is `battery` / `integer`, in %.
// Units are only those the core lists for each category, fixed at creation.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_NAMES, FEATURE_NAMES, word } from './i18n.js';

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
 * is never published as 0). The indexes are left out: they go through the
 * guard (src/app.js).
 */
export function deviceStates(gladys, kind, plantId, values) {
  const ids = deviceIds(gladys, kind, plantId);
  const states = [];
  for (const [role, spec] of Object.entries(KINDS[kind])) {
    if (spec.index) {
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
