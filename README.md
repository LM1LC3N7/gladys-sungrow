# gladys-sungrow

[Gladys Assistant](https://gladysassistant.com) external integration for
**Sungrow** inverters and batteries, through the official **iSolarCloud
OpenAPI**, read only: solar power and production, home consumption, energy
bought from and fed into the grid, battery charge and power, and two energy
indexes (production, energy bought) behind a plausibility guard. **Never
tested with a real account nor a real device. Not affiliated with Sungrow.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SungrowApp)
                                  ├─ src/oauth.js      authorization address, pending sign-ins, pasted address, token endpoints
                                  ├─ src/api.js        plant list, real-time data
                                  ├─ src/http.js       the only HTTPS access, errors of the API, bounds, JSON
                                  ├─ src/model.js      answers -> values, units (port of pysolarcloud, pure)
                                  ├─ src/devices.js    plant -> plant / grid / battery devices and states (pure)
                                  ├─ src/guard.js      plausibility of the two indexes (gladys-p1-monitor's guard)
                                  ├─ src/publisher.js  states within 300/min
                                  └─ src/store.js      /data/sungrow-state.json (0600)
```

- **Developer app**: the user creates an app on the Sungrow developer portal
  (OAuth2 enabled, a redirect URL, approved by Sungrow) and enters its
  Appkey, Secret Key and Application Id, and the server (Europe by default).
  The docs walk through it step by step.
- **Authorization** (as pysolarcloud): the Connect button of the `oauth2`
  field opens `web3.isolarcloud.<server>?state=…#/authorized-app?cloudId=…&applicationId=…&redirectUrl=…`
  (the state before the fragment of the single-page application). The return
  to Gladys goes to `onOAuthCallback` (state checked, one use, 15 minutes);
  with another redirect URL, the user pastes the final address into _Finish
  the authorization_. While not connected, the status shows the Gladys
  return address to register in the app. Nothing signs in without a click.
- **Tokens**: `POST /openapi/apiManage/token` and `/refreshToken` (JSON,
  `appkey` in the body, Secret Key in `x-access-key`), read at the top of the
  answer or in `result_data`. Kept in `/data` with the client they belong to
  (hash of server, Appkey and Application Id); renewed by a timer at the end
  minus min(5 min, half the lifetime), never twice within a minute, never
  during a pause. A refused renewal is the persisted "session ended" stop; a
  refused token renews once and retries once (or retries with a token the
  timer renewed meanwhile), refused again it is the persisted "access
  refused" stop, as is a refused Appkey / Secret Key. Lifted only by a click.
- **Reads**: `queryPowerStationList` every 6 h (and on a scan, kept in
  `/data`), `getPowerStationRealTimeData` for all the plants in one request
  every 5 minutes (iSolarCloud's own pace), with the point dictionary for the
  units. Answers read up to 1 MiB, linear parsing, prototype keys dropped.
- **Rate limits**: HTTP 429 or a "too frequent" answer pauses every path
  (`Retry-After` bounded to 1 min – 6 h, 15 min without it); 5xx or "busy"
  5 min – 1 h; a hard ceiling of 600 requests per UTC day (sign-in and
  renewals included, about 320 at the default pace) pauses everything until
  the next day. All kept in `/data`, capped when read back, kept across a
  reconnection. Other errors: never sooner than the interval, then 5, 15,
  30 min.
- **Gladys side**: per plant, `plant:<ps_id>`, `grid:<ps_id>` (once a grid
  value shows) and `battery:<ps_id>` (once a state of charge shows), all
  read only. Two indexes only: `energy-production-sensor/index` (solar
  production total) and `energy-sensor/index` (energy bought total), both
  through the guard of gladys-p1-monitor (never 0, drops and jumps held,
  never confirmed by time, two-click bounded acceptance, `maxKw` from the
  configuration). Solar power is `energy-production-sensor/power`, the
  charge `battery/integer` (%), everything else plain sensors. The Discovery
  list never shrinks; status and Discovery are sent again at every
  reconnection to Gladys.

## Credits

The gateways, the authorization address, the token endpoints, the API paths,
the measure points and the reading of the answers are ported from
[pysolarcloud](https://github.com/bugjam/pysolarcloud) (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The structure follows the
sibling integrations [gladys-weheat](https://github.com/LM1LC3N7/gladys-weheat)
(OAuth) and [gladys-apsystems](https://github.com/LM1LC3N7/gladys-apsystems);
the index guard is the one of
[gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: iSolarCloud is a fake behind the injected
transport (token endpoints, plant list, real-time data), Gladys is the SDK's
fake.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
with its notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also
shipped in the Docker image).
