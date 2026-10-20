// -----------------------------------------------------------------------------
// Answers of the iSolarCloud OpenAPI in the shapes pysolarcloud reads
// (queryPowerStationList, getPowerStationRealTimeData with its point_dict).
// Invented values: never checked on a real account.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** 2026-10-20 10:00 UTC. */
export const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);

export const APP_KEY = 'TESTAPPKEY0123456789';
export const SECRET_KEY = 'test-secret-key-value-0123';
export const APP_ID = '4242';
export const GLADYS_REDIRECT = 'https://gladys.local/dashboard/integration/oauth';

export const PLANT_A = '1234567';
export const PLANT_B = '7654321';

export const plantDto = (id, overrides = {}) => ({
  ps_id: Number(id),
  ps_name: id === PLANT_A ? 'Maison' : 'Garage',
  ps_type: 1,
  ps_status: 1,
  ...overrides,
});

export const listDto = (ids) => ({
  req_serial_num: 'r1',
  result_code: '1',
  result_msg: 'success',
  result_data: { pageList: ids.map((id) => plantDto(id)), rowCount: ids.length },
});

export const POINT_DICT = [
  { point_id: 83067, point_name: 'Total Active Power of PV', point_unit: 'W' },
  { point_id: 83033, point_name: 'Plant Power', point_unit: 'W' },
  { point_id: 83022, point_name: 'Daily Yield of Plant', point_unit: 'Wh' },
  { point_id: 83024, point_name: 'Plant Total Yield', point_unit: 'Wh' },
  { point_id: 83106, point_name: 'Load Power', point_unit: 'W' },
  { point_id: 83118, point_name: 'Daily Load Consumption', point_unit: 'Wh' },
  { point_id: 83124, point_name: 'Total Load Consumption', point_unit: 'Wh' },
  { point_id: 83549, point_name: 'Grid active power', point_unit: 'W' },
  { point_id: 83102, point_name: 'Energy Purchased Today', point_unit: 'Wh' },
  { point_id: 83105, point_name: 'Total Purchased Energy', point_unit: 'Wh' },
  { point_id: 83072, point_name: 'Feed-in Energy Today', point_unit: 'Wh' },
  { point_id: 83075, point_name: 'Feed-in Energy Total', point_unit: 'Wh' },
  { point_id: 83252, point_name: 'Battery Level (SOC)', point_unit: '%' },
  { point_id: 83326, point_name: 'Energy storage active power', point_unit: 'W' },
  { point_id: 83322, point_name: 'ESS Daily Charge', point_unit: 'Wh' },
  { point_id: 83323, point_name: 'ESS Daily Discharge', point_unit: 'Wh' },
  { point_id: 83324, point_name: 'Energy Storage Cumulative Charge', point_unit: 'Wh' },
  { point_id: 83325, point_name: 'Cumulative Discharge', point_unit: 'Wh' },
];

/** One plant of the real-time answer; `battery`/`grid` false leave those points out. */
export const pointsDto = (id, { battery = true, grid = true, ...overrides } = {}) => ({
  ps_id: Number(id),
  p83067: '3250',
  p83033: '3200',
  p83022: '12500',
  p83024: '25000000',
  p83106: '850.0',
  p83118: '7400',
  p83124: '11000000',
  ...(grid
    ? {
        p83549: '-1200',
        p83102: '2100',
        p83105: '4500000',
        p83072: '6200',
        p83075: '9000000',
      }
    : {}),
  ...(battery
    ? {
        p83252: '76',
        p83326: '-400',
        p83322: '3100',
        p83323: '2900',
        p83324: '1500000',
        p83325: '1400000',
      }
    : {}),
  ...overrides,
});

export const realtimeDto = (plants) => ({
  req_serial_num: 'r2',
  result_code: '1',
  result_msg: 'success',
  result_data: {
    device_point_list: plants,
    point_dict: POINT_DICT,
  },
});
