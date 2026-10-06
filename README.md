# Hoymiles S-Miles Cloud for Homey

Control Hoymiles microinverters (behind a DTU-Pro / DTU-Pro-S) from Homey **through the S-Miles Cloud** —
no local connection between Homey and the DTU needed.

> **Unofficial.** Not affiliated with Hoymiles. The S-Miles Cloud API is undocumented and may change.

## Status (v0.1.0 — work in progress)
- ✅ Login to S-Miles Cloud (v3 / Argon2id), pairing of stations
- ✅ Station power, yield today, total yield (polled every 5 min)
- 🧪 Flow action **"Set max output to X kW"** — sets the station's export limit (S-Miles: Settings → export
  control, total limit) via `/pvm/api/0/station/reflux_control/config`. Derived from the web portal; being
  verified against a real installation. Requires export control to be enabled (with a meter) in S-Miles.

## Multiple installations
Each S-Miles station (one DTU) becomes its own Homey device with its own action card, so every
installation can get its own value in a flow.

## Use case
Off-grid site with a battery that is AC-coupled to Hoymiles microinverters. With the battery SOC from another
Homey app (e.g. Elekeeper for SAJ), flows like:
- SOC ≥ 80% → *Set max output to 0 kW*
- SOC < 70% → *Set max output to 5 kW*

The action only sends a command when the value changes (spares DTU/inverter flash) and at most once per 30 s.

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
