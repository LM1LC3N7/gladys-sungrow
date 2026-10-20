# TODO — Sungrow iSolarCloud v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 10, wave 1) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-20): OAuth2 of the user's developer
      app (Connect returning to Gladys, or a pasted address; the Gladys
      return address shown in the status while not connected), tokens in
      `/data` renewed by a timer, plant list and real-time data ported from
      pysolarcloud 0.5.0, plant / grid / battery devices (read only), the two
      energy indexes behind gladys-p1-monitor's guard, persisted stops and
      pauses, daily budget of requests, badges, docs en/fr with the developer
      app step by step, cover. Tested against made-up answers only (Node 22
      and 24). The store validator cannot run from the development sandbox: it
      runs at publication. No Docker on this PC: the image was not built here
      (the CI builds it).
- [x] **Milestone 1 fixes — review 1** (2026-10-20): the 30-minute
      production feature declared under the production index (UUID v5 ids);
      a restart after a good read stays connected; the test button never
      reads sooner than the interval nor during a pause (one read only to
      lift "access refused"); an unknown error of the renewal keeps the
      session (tried again 1, 5, 15, 60 min), "系统异常" is a busy pause; the
      developer app guide holds to pysolarcloud's four steps, the rest marked
      unverified; new keys during a renewal or an exchange drop its answer; a
      deleted device takes its guard states out of `/data`; the token pattern
      no longer matches "authorization"; only a safe code of a pasted error.
- [ ] **Milestone 2 — real account**: run against a real account and
      inverter (see "To check on a real account"), turn the answers
      (anonymized) into fixtures, fix what differs.
- [ ] **Later**: per-device data (`getDeviceListByPsId`, inverter
      temperature, MPPT strings) if users ask; a battery `charge-index` /
      `discharge-index` (`battery-storage`) once every supported Gladys knows
      the category; the grid as `grid-sensor` likewise.

## To check on a real account

- The developer portal (only pysolarcloud's four steps are documented as
  facts): whether it takes the Sungrow account's credentials (other projects
  say so) or needs a separate account, the exact wording of the app form
  ("authorize with OAuth2.0"), where the Application Id shows, how long the
  approval takes and how the portal shows it, whether the app is tied to one
  server, whether the redirect URL may be any https address (and whether a
  `http://localhost` one is accepted).
- The authorization page: that `state` comes back in the query of the
  redirect (pysolarcloud says it does when placed before the `#`); without
  it, the return is refused ("unknown authorization") and the pasted address
  too. Whether the page lets the user pick the plants.
- The token answer: top level (pysolarcloud) or in `result_data` (both
  read), `expires_in` (seconds?), whether the refresh token rotates (handled
  either way), how long the refresh token lives (pysolarcloud's README says
  the user must approve again once the tokens expired: then the "session
  ended" stop asks for Connect).
- The error answers: the `result_code` values and texts of a refused token,
  a refused Appkey / Secret Key, a too frequent access, a busy server. They
  are classified from their text here (`src/http.js` `envelopeError`);
  adjust the patterns to the real codes. The token pattern (`token`,
  `login`, "未登录") was narrowed after review: a text about one plant
  ("unauthorized", "authorization") is an ordinary error, not a stop; check
  what a plant the app may not read answers.
- Rate limits: none published by Sungrow. 5 minutes per read (one request for
  all the plants), the list every 6 hours, at most 600 requests a day.
- The real-time data: which points a hybrid inverter (SH series) and a
  string inverter (SG series) give, their units in `point_dict`, the sign of
  `83549` (grid power) and `83326` (battery power), whether `83252` is in %
  or a fraction of 1 (both handled), whether `83105` (total purchased) and
  `83024` (total yield) only go up.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-sungrow:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Licenses**: pysolarcloud is MIT (`LICENSE.txt`, "Copyright 2025 Tore
  Green"), checked on 0.5.0 (commit `9e45e63`, 2026-09-19) before use; its
  logic is ported (full MIT notice in `THIRD_PARTY_NOTICES.md`, shipped in
  the image). `LICENSE`: the standard Apache-2.0 text, no name.
- **Official API only**: the iSolarCloud OpenAPI with the user's own
  developer app, as pysolarcloud. No login with the app's password, no
  imitation of the iSolarCloud app (no User-Agent nor app key of Sungrow's
  own apps, no reverse-engineered endpoints).
- **Configuration**: server (select, Europe by default, the five of
  pysolarcloud), Appkey (`string`), Secret Key (`secret`: kept by Gladys in
  its database, never shown again, sent only to iSolarCloud in
  `x-access-key`; never in `/data`, never in a URL), Application Id (digits
  only), optional redirect URL (https, http on localhost only), the `oauth2`
  field, the interval (5–60 min), the maximum power (1–1000 kW, 36 by
  default: the largest French residential contract), the language. The
  session belongs to a client key (sha256 of server, Appkey, Application Id):
  new keys ignore the old session; a new Secret Key restarts too.
- **Two ways back** (as gladys-weheat): Gladys' redirect address with
  `onOAuthCallback` (state required, one use, 15 min, 5 pending at most), or
  the configured redirect URL and the `finish_sign_in` action (the pasted
  address must carry its state and start with that redirect URL). While not
  connected, a click on Connect shows the Gladys return address in the
  status, so the user can register it in the developer app. Gladys' return
  is exchanged within 3.5 s (10 s for the pasted address); a timeout asks for
  a new click and never reuses the code.
- **Renewal by timer** (as gladys-weheat): at `expiresAt - min(5 min,
lifetime / 2)`, floored at the last renewal + 1 minute and at the end of a
  pause or of a failed renewal (1, 5, 15, 60 min). A 400/401 of the refresh
  endpoint, or an answer without a token that refuses the token or the app,
  is the `expired` stop: session dropped, stop kept in `/data`, only a new
  authorization lifts it. Any other answer without a token (an unknown code
  or text) is NOT a refusal (review 1): the session is kept and the renewal
  tried again after 1, 5, 15, 60 min; "too frequent" / "busy" (Chinese
  "系统", "异常" included) are pauses. Without `expires_in`, one hour. New
  keys saved while a renewal or a code exchange is in flight move the epoch:
  its answer is dropped, never stored under the new client.
- **A refused token** (envelope text about the token, or HTTP 401): when the
  timer renewed the token meanwhile, one retry with the new token; otherwise
  one renewal and one retry; refused with a token obtained in this cycle, the
  `unauthorized` stop (kept, lifted by Connect or the test button). A refused
  Appkey / Secret Key (`app_refused`) is the same stop at once. A stop raised
  by the timer during a read is never covered by that read's status.
- **Rate limits**: one `getPowerStationRealTimeData` for all the plants
  (at most 20) per cycle, every 5 minutes by default (iSolarCloud updates
  every 5 minutes; never faster); `queryPowerStationList` every 6 hours, on a
  scan and after an authorization; a failing list with known plants is tried
  again after 30 min. 429 or a "too frequent" text: pause of every path,
  `Retry-After` bounded to 1 min – 6 h, 15 min without it. 5xx or "busy":
  5, 15, 30, 60 min. Other errors: the interval, then 5, 15, 30 min. A hard
  budget of 600 requests per UTC day (every request counts, sign-in and
  renewals included; about 320 at the default pace, 26 more when each
  renewal meets a read): reached, every path waits for the next UTC day.
  Pauses, budget and last cycle kept in `/data`, capped when read back, kept
  across a reconnection.
- **Test button** (review 1): never a read sooner than the interval since the
  last cycle, nor during any pause (backoff included): it answers the last
  status and when the next read comes. One click = one read only to lift the
  `unauthorized` stop. 30 seconds between clicks.
- **Restart after a good read** (review 1): the start of the last cycle that
  succeeded is kept in `/data` (`lastSuccessAt`, cleared by any failure,
  pause or stop); a restart before the next read shows "connected, N
  plant(s), next read in X" and still waits for the interval.
- **Devices**: per plant, `plant:<ps_id>` always, `grid:<ps_id>` once a grid
  value shows, `battery:<ps_id>` once a state of charge shows; created ones
  stay offered. The grid is its own device so that a home already metered in
  Gladys (Linky, P1) can leave it out (its consumption would count twice).
- **Energy** (lessons of the lots 5 and 6): two indexes only, cumulative
  counters of iSolarCloud, both through the guard: solar production
  `energy-production-sensor/index` (83024 total yield) and energy bought
  `energy-sensor/index` (83105 total purchased). The home consumption total
  is NOT an index (it includes the solar energy used on site, not billed),
  the feed-in total is never in an index. Daily values and every other total
  are plain sensors. Solar power `energy-production-sensor/power` W; grid,
  home and battery powers plain sensors (the grid sign is unknown, and no
  energy contract must take them for the power drawn); charge
  `battery/integer` %. `battery-storage` and `grid-sensor` are left for
  later (not known by every supported Gladys).
- **30-minute production** (review 1, as gladys-imeon and gladys-apsystems):
  the core derives `thirty-minutes-production` for a consumption index only,
  so `production_30min` (`energy-production-sensor/thirty-minutes-production`,
  kWh) is declared on the plant device, its `id` and `energy_parent_id` UUID
  v5 of the external ids of itself and of `production_index` (which carries
  its UUID v5 `id` too), so an "Update" in Discovery keeps the same rows. The
  integration never publishes a state on it. The energy bought index gets
  its 30-minute feature from the core.
- **Index guard**: `src/guard.js` is gladys-p1-monitor's approved guard taken
  as is, with `maxKw` and the slack (0.5 kWh) as parameters (`indexOfTariffs`,
  specific to a P1 meter, left out). `maxKw` comes from the configuration.
  The guard state (reference and value held) is kept in `/data` per feature;
  a newly created device starts without it; the reference is also taken from
  the value Gladys holds (`last_value`, `last_value_changed`). While a value
  is held, the last accepted one is sent again; the status lists every held
  index; "Accept the held indexes" accepts them all, as shown (bounded), taken
  at the next read. The guard dates each value with the time of the read;
  the state is published to Gladys without a date (Gladys dates it on
  receipt). A deleted device takes its guard states out of `/data`; the
  stored states are bounded (80, the most recent kept).
- **Units**: from the `point_dict` of the answer (Wh, kWh, MWh; W, kW, MW;
  %); without a unit, Wh and W as documented by pysolarcloud; another unit
  drops the value. Glitches (an energy below 0, a power above 10 MW, a
  charge outside 0–100) are never published. A state of charge without a
  unit and at most 1 is read as a fraction.
- **Hostile answers**: bodies read up to 1 MiB, JSON parsed without
  `__proto__` / `constructor` / `prototype` keys, only named fields and own
  keys read, plant ids digits only (1–20), at most 20 plants, the point
  dictionary walked once. A text of iSolarCloud never reaches a log or a
  status: only a safe code (`[A-Za-z0-9_.-]{1,40}`).
- **Badges**: unreachable when stopped, after a network or server error, or
  when the plant was missing from the last real-time answer.
- **Publication never shrinks** (lot 6 lesson): a created device is
  published with its features as Gladys has them, plus new ones; a device
  seen earlier stays. Status, Discovery and badges are sent again at every
  `connected`; a reconnection keeps tokens, stops, pauses and the budget.
- **No scene trigger** in v1, so no `publishSceneEvent`.
- **Category `energy`** in the store.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was proposed
  (lot 10, `_ref/lot10/proposition.md`).
