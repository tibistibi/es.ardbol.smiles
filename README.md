# Hoymiles S-Miles Cloud for Homey

Control Hoymiles microinverters (behind a DTU-Pro / DTU-Pro-S, or with built-in wifi such as the HMS-800-2WB)
from Homey **through the S-Miles Cloud** — no local connection between Homey and the DTU needed.

> **Unofficial.** Not affiliated with Hoymiles. The S-Miles Cloud API is undocumented and may change.

## Status (v0.2.0 — work in progress)
- ✅ Login to S-Miles Cloud (v3 / Argon2id), pairing of stations
- ✅ Station power, yield today, total yield (polled every 5 min)
- ✅ Flow action **"Set max output to X kW"** — sets the station's export limit (S-Miles: Settings → Export
  management, limit mode "total") and pushes it to the DTU, waiting for the DTU's confirmation. Request sequence
  matches a browser capture of the web portal; tested live on a DTU-Pro-S (confirmed by the DTU in ~12 s). Requires export management to be
  switched on (with a meter) in S-Miles.
- 🧪 Flow action **"Turn inverters on/off"** (new in 0.2.0) — sends power on (action 6) / power off (action 7) to
  every micro-inverter of the station via `pvm-ctl/dev/command/put` and waits for the DTU's confirmation (max 30 s
  per inverter). Needs no DTU-Pro and no meter, so it also works for a cloud-only HMS-800-2WB. Inverter and DTU
  serials are read from the station's device tree when the command is sent; nothing has to be configured.
- 🧪 Flow action **"Set power limit to X %"** (new in 0.2.0) — caps all inverters of the station at 2–100 % of their
  rated power (action 8, station-wide, the same request as the web portal's *Power Control → Active power*). Needs
  no meter. Not yet tested live.

### Which card for which installation?
| Installation | Card |
|---|---|
| DTU-Pro(-S) **with meter** and export management on | *Set max output to X kW* (export limit at the grid connection) |
| Without meter, e.g. HMS-800-2WB with built-in wifi | *Set power limit to X %* (production cap per inverter) and/or *Turn inverters on/off* |

The % limit and on/off cards also work on DTU-Pro stations, but act on all inverters of that station.

## Multiple installations
Each S-Miles station (one DTU) becomes its own Homey device with its own action card, so every
installation can get its own value in a flow.

## Use case
Off-grid site with a battery that is AC-coupled to Hoymiles microinverters. With the battery SOC from another
Homey app (e.g. Elekeeper for SAJ), flows like:
- SOC ≥ 80% → *Set max output to -0.1 kW* (slightly negative: guarantees no export, even briefly)
- SOC < 70% → *Set max output to 5 kW*

The action only sends a command when the value changes (spares DTU/inverter flash) and at most once per 30 s.

Without a meter (HMS-800-2WB):
- SOC ≥ 90% → *Turn inverters off* (or *Set power limit to 2 %*)
- SOC < 80% → *Turn inverters on* (or *Set power limit to 100 %*)

The % limit is written to DTU flash and inverter EEPROM, so the card only sends on change and at most once per
60 s. On/off only sends when the state differs from what Homey last sent; a change made in the S-Miles app is not
seen by Homey.

## Tip: use a dedicated account
Create a separate S-Miles account for Homey and share your station with it (with control rights), so your own
password never has to be stored in Homey.

## Install (development)
```
npm install
npx homey login
npx homey app install     # Homey must be on the same LAN as your computer
```

## Credits
S-Miles login code adapted from [homey-app-hoymiles-hione](https://github.com/ItsRaYnor/homey-app-hoymiles-hione)
by ItsRaYnor (MIT), which builds on [homeassistant-hoymiles-cloud](https://github.com/Philra94/homeassistant-hoymiles-cloud).
Device-command endpoints and action codes (power on/off, `dev_type`, task polling) from
[ioBroker.hoymiles](https://github.com/Eistee82/ioBroker.hoymiles) by Eistee82 (MIT), verified there on an HMS-800-2WB.
