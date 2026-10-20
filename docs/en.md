# Sungrow iSolarCloud for Gladys Assistant

This integration reads your **Sungrow inverters and batteries** through the
official **iSolarCloud OpenAPI**, **read only**: nothing is ever commanded (no
battery mode, no feed-in limit).

> Unofficial connector, **not affiliated with Sungrow**. **Never tested with a
> real account** on iSolarCloud, and **never tested with a real device**
> (inverter, battery) yet: it follows the `pysolarcloud` library (MIT), used
> by Home Assistant. Feedback is welcome on the Gladys forum. Sungrow and
> iSolarCloud are trademarks of their owner.

## What you get

For each plant you authorize, up to three devices:

| Device                                  | Feature                                    | Unit / type                |
| --------------------------------------- | ------------------------------------------ | -------------------------- |
| **Plant** (always)                      | Solar power                                | W, production              |
|                                         | Solar production (index)                   | kWh, **production index**  |
|                                         | Solar production today                     | plain sensor (kWh)         |
|                                         | Home consumption power, today and total    | plain sensors (W, kWh)     |
| **Grid** (when iSolarCloud gives it)    | Energy bought from the grid (index)        | kWh, **consumption index** |
|                                         | Grid power (sign as given by iSolarCloud)  | plain sensor (W)           |
|                                         | Bought today, fed in today and in total    | plain sensors (kWh)        |
| **Battery** (when iSolarCloud gives it) | Battery charge                             | %                          |
|                                         | Battery power                              | plain sensor (W)           |
|                                         | Charged and discharged, today and in total | plain sensors (kWh)        |

### The two energy indexes

- **Solar production (index)**: the total produced by the plant since it was
  commissioned. Gladys derives the production of each half hour from it.
- **Energy bought from the grid (index)**: the total bought from the grid,
  counted by Gladys as electricity consumption (with its cost, according to
  your energy contract in Gladys).

If another meter already feeds Gladys (Linky, P1, a Zigbee meter…), **do not
add the "grid" device**: the same consumption would be counted twice. The
"plant" device is useful on its own.

Both indexes go through a **guard** (the same as the P1 Monitor integration)
before they reach Gladys, because Gladys counts every rise in full:

- a value of 0, or an absent one, is never sent;
- a plausible rise (no more than the **maximum power of the installation**
  since the previous read, 36 kW by default) goes through;
- a **drop** or a **jump** is never confirmed by time nor by repetition: the
  value is **held back** (the last accepted value is sent again), the status
  of the integration shows it, and it stays held across a restart;
- if the value held back is right (a replaced meter, a reset), click
  **Accept the held indexes**: it is taken at the next read, once, and only
  if it is the value shown (plus what may have been produced or drawn
  meanwhile).

Every other total and daily value is a **plain sensor**: Gladys counts it
nowhere.

## Step 1: create your Sungrow developer app

The iSolarCloud API needs a **developer app** you create yourself, once, on
the Sungrow portal. It is free, but Sungrow must **approve** it (it may take a
few days).

1. Open the iSolarCloud developer portal:
   <https://developer-api.isolarcloud.com/> and **create an account** (it is
   separate from your usual iSolarCloud account).
2. Create an **application**:
   - give it a name (e.g. "Gladys");
   - to "authorize with OAuth2.0", answer **Yes**;
   - **Redirect URL**: the address iSolarCloud sends your browser back to
     after the authorization. Two options:
     - **the return address of your Gladys** (recommended). To find it: do
       step 2 below without a redirect URL, click **Connect** once: the
       status of the integration shows "The return address of this Gladys
       is …". Copy it into the portal (it can be changed later);
     - **another https address of yours** (even a page that does not exist):
       you will then copy and paste the final address (see below).
3. Wait for Sungrow to **approve** the app (its state turns to approved in the
   portal).
4. In the portal, open your app and note:
   - the **Appkey**;
   - the **Secret Key**;
   - the **Application Id**: it appears in the authorize URL the portal
     shows, after `applicationId=` (a number).

## Step 2: configure the integration

In **Integrations → Sungrow iSolarCloud → Configuration**:

1. **iSolarCloud server**: the one of your account (**Europe** for France,
   Belgium, Switzerland). The developer app must be on the same server.
2. **Appkey**, **Secret Key**, **Application Id**: those of step 1.
3. Leave **Redirect URL** empty if the app sends back to Gladys; otherwise
   enter the address registered in the portal.
4. Save.

## Step 3: authorize

1. Click **Connect**: the iSolarCloud page opens.
2. Sign in with your usual iSolarCloud account. **Your password is typed on
   the iSolarCloud page only**: the integration never sees it.
3. **Tick the plant(s)** to share, then authorize.
4. iSolarCloud sends you back to Gladys: the integration reads your plants.
   Add the devices from the **Discovery** tab.

### With another redirect URL

1. After the authorization, the browser ends on your address (the page may
   show an error, that is expected). Copy **the whole address** from the
   address bar: it holds `code=` and `state=`.
2. Paste it into the **Finish the authorization** action, within 15 minutes.
   It must start with the configured redirect URL: another address is
   refused (the authorization then stays usable).

An authorization started serves once. If iSolarCloud is slow to answer (more
than 3.5 seconds on the return to Gladys), the integration shows
"iSolarCloud is slow to answer: click Connect again": start again.

## What the integration keeps

- The **Secret Key** is kept by Gladys in its database, as any configuration
  value: never shown again, sent only to iSolarCloud.
- The iSolarCloud **tokens** (access and renewal) are kept in clear in the
  file `/data/sungrow-state.json` of the integration's volume, readable by
  its container only (mode 0600), and sent only to iSolarCloud. The same file
  keeps the pauses, the stops, the list of plants, the number of requests of
  the day and the state of the index guards. No password is ever written
  there.

## Pace and API limits

- iSolarCloud updates its data **every 5 minutes**: the integration reads
  **all the plants in one request**, every 5 minutes by default (5 minutes at
  least, 60 at most).
- The list of plants is read again every 6 hours (and on request from
  Discovery).
- The token is renewed by a timer a little before its end, never twice
  within a minute.
- **At most 600 requests a day** (UTC) in all, authorization and renewals
  included: about 320 at the default pace. If that ceiling is reached (it
  never should), everything waits for the next day.
- After a restart, the first read waits for the end of the interval since the
  last read and for the end of a running pause.

Sungrow publishes no figures for its rate limits: the integration answers a
refusal (HTTP 429 or a "too frequent" answer) with a pause.

## Errors and stops

| Situation                                                | What the integration does                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| iSolarCloud asks to slow down (HTTP 429, "too frequent") | pause of 1 minute to 6 hours (15 minutes by default), kept across a restart |
| iSolarCloud unavailable (5xx error, "busy")              | pause of 5 minutes to 1 hour, kept across a restart                         |
| Daily ceiling of requests reached                        | pause until the next day (midnight UTC)                                     |
| Network down, unexpected answer                          | new try after the interval, then 5, 15, 30 minutes, kept across a restart   |
| One plant without data                                   | the others go on; its devices turn "unreachable"                            |
| Renewal refused by iSolarCloud                           | "session ended" stop, kept: click Connect                                   |
| Access refused even with a new token, or keys refused    | stop, kept: check the keys, then Connect or "Test iSolarCloud"              |

The integration never reconnects by itself and never retries a refusal: only
a click does. The **Test iSolarCloud** button reads the plants at once (once
every 30 seconds at most).

## Troubleshooting

- **"Enter the app key"**: Appkey, Secret Key or Application Id missing (the
  Application Id is a number).
- **iSolarCloud refuses the authorization**: wrong server, Appkey, Secret Key
  or redirect URL, app not yet approved by Sungrow, or a pasted address older
  than 15 minutes.
- **No plant**: click Connect again and tick the plant on the iSolarCloud
  page.
- **An index held back**: see "The two energy indexes" above.
- **A feature stays empty**: not every plant gives every measure point (it
  depends on the inverter model and the meter).

## Limits

- Read only: no command (no battery, no feed-in).
- The values come from the iSolarCloud cloud (updated every 5 minutes), not
  from the inverter locally.
- The sign of the grid and battery powers is the one of iSolarCloud, not
  checked.
- Never tested with a real account nor a real device: the measure points and
  units follow `pysolarcloud` 0.5.0.
