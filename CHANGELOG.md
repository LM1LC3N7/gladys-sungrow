# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Sungrow inverters and batteries through the official iSolarCloud OpenAPI,
  read only: per plant, a plant device (solar power, solar production index,
  production today, home consumption), a grid device (energy bought index,
  grid power, bought and fed-in energy) and a battery device (charge, power,
  charged and discharged energy), the last two only when iSolarCloud gives
  them.
- The two energy indexes (solar production, energy bought from the grid) go
  through the plausibility guard of the P1 Monitor integration: never 0, a
  drop or a jump held back and shown in the status until the user clicks
  "Accept the held indexes", the margin set by the maximum power of the
  installation (36 kW by default).
- OAuth2 authorization of a developer app the user creates on the Sungrow
  developer portal (Appkey, Secret Key, Application Id, server), documented
  step by step: the Connect button returns to Gladys, or the address the
  browser ended on is pasted into "Finish the authorization". While not
  connected, the status shows the Gladys return address to register in the
  app. The password is typed on the iSolarCloud page only.
- The tokens are kept in `/data` (mode 0600) and renewed by a timer before
  their end; a refused renewal, access or developer app is a stop kept across
  restarts, lifted only by a click.
- Rate limits: one request for all the plants every 5 minutes (the pace of
  iSolarCloud), the list every 6 hours, 429 or "too frequent" and 5xx or
  "busy" pauses kept in `/data`, and a ceiling of 600 requests per UTC day.
- Transport badges, English and French texts, documentation, cover image.
- Never tested with a real account nor a real device yet.

[Unreleased]: https://github.com/LM1LC3N7/gladys-sungrow/commits/main
