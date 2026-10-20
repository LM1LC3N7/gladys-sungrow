# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTPS goes through `node:https`). It reads Sungrow
inverters and batteries through the official iSolarCloud OpenAPI, read only,
after an OAuth2 authorization of a developer app the user creates on the
Sungrow developer portal. Ported from pysolarcloud (MIT). Never tested with a
real account nor a real device, not affiliated with Sungrow.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          SungrowApp: authorization, renewal timer, cycle and its timer, pauses,
                    daily budget, stops, devices, states, index guards, badges, buttons
src/oauth.js        authorization address, pending sign-ins, pasted address, token endpoints
src/api.js          the 2 API calls (plant list, real-time data)
src/http.js         the only network access (node:https, bounded), errors of the API, JSON
src/model.js        API answers -> values and units (pure, port of pysolarcloud)
src/devices.js      plant -> plant / grid / battery devices and states (pure)
src/guard.js        the index guard of gladys-p1-monitor, maxKw as a parameter (pure)
src/publisher.js    states within 300/min
src/store.js        /data/sungrow-state.json (0600): tokens, stop, pause, budget, plants, guards
src/config.js       config_schema normalized, client key (hash of server, Appkey, Application Id)
src/constants.js    servers, paths, measure points, manifest keys, limits, timings
src/i18n.js         runtime texts, device and feature names (en/fr)
test/fixtures/      answers shaped like those pysolarcloud reads
test/helpers/       a fake iSolarCloud behind the transport; Gladys is the SDK's fake
```

## Rules

- **External ids are forever**: devices `plant:<ps_id>`, `grid:<ps_id>`,
  `battery:<ps_id>`, features by role (see `src/devices.js`). Never change
  how they are built.
- Manifest keys (`server`, `app_key`, `secret_key`, `app_id`,
  `redirect_uri`, `account`, `poll_minutes`, `max_power_kw`, `language`, the
  actions `finish_sign_in` (`url`), `test_connection`, `accept_index`) are
  frozen.
- **Authorization only on a click** (Connect, Finish the authorization):
  never from a start, a `connected`, a cycle or a retry. No password ever
  reaches this code. A refused renewal is the `expired` stop; an access
  refused with a fresh token, or a refused Appkey / Secret Key, the
  `unauthorized` stop: both persisted, never retried by themselves. Never
  log or put in a message a token, a code or the Secret Key; a text of
  iSolarCloud only classifies an error, only a safe code is shown.
- **Token renewal by a timer**: at the end minus min(5 min, half the
  lifetime), never twice within a minute, never during a pause.
- **Rate limits**: 5 minutes at least, all the plants in one request; 429 /
  "too frequent", 5xx / "busy" and the daily budget (600 requests per UTC
  day) pause every path and are kept in `/data`; never read again sooner
  than the interval after an error. A failing list with known plants never
  stops the reads.
- **Read only**: no command (no battery mode, no feed-in limit; the grid
  control of pysolarcloud is not ported).
- **Energy**: two indexes only (`energy-production-sensor/index` for the
  production total, `energy-sensor/index` for the energy bought total), both
  through `src/guard.js` (taken as is from gladys-p1-monitor); everything
  else is a plain sensor. Never a daily total nor the injection in an index;
  never 0 in an index.
- The Discovery list never shrinks; status and Discovery are sent again at
  every `connected`; a reconnection keeps tokens, stops and pauses.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`; a `secret`
  field is kept by Gladys in its database, never write otherwise.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network nor the system temp directory.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow (0.1.0 was set by
  hand once, see TODO.md).
