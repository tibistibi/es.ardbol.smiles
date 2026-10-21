'use strict';

/**
 * Live test of the S-Miles cloud commands outside Homey.
 *
 *   SMILES_EMAIL=... SMILES_PASSWORD=... node tools/test-station.js                 list stations + inverters
 *   SMILES_EMAIL=... SMILES_PASSWORD=... node tools/test-station.js <id> limit 50   power limit 50 %
 *   SMILES_EMAIL=... SMILES_PASSWORD=... node tools/test-station.js <id> off|on     inverters off / on
 *
 * Every command writes flash (DTU) / EEPROM (inverter): test sparingly.
 */

const SmilesApi = require('../lib/SmilesApi');

async function main() {
  const { SMILES_EMAIL: email, SMILES_PASSWORD: password } = process.env;
  if (!email || !password) throw new Error('Set SMILES_EMAIL and SMILES_PASSWORD');
  const api = new SmilesApi({ log: (...a) => console.log(...a), email, password });
  const [stationId, command, value] = process.argv.slice(2);

  if (!stationId) {
    for (const s of await api.getStations()) {
      console.log(`\nStation ${s.id}: ${s.name}`);
      try {
        const micros = await api.getMicroInverters(s.id);
        for (const m of micros) console.log(`  micro ${m.sn} (DTU ${m.dtuSn})`);
      } catch (err) {
        console.log(`  inverters: ${err.message}`);
      }
      try {
        console.log('  export control:', JSON.stringify(await api.getExportControl(s.id)));
      } catch (err) {
        console.log(`  export control: ${err.message}`);
      }
    }
    return;
  }

  const started = Date.now();
  if (command === 'limit') await api.setPowerLimitPercent(stationId, value);
  else if (command === 'on' || command === 'off') await api.setInvertersOn(stationId, command === 'on');
  else throw new Error(`Unknown command "${command}" (use limit <pct>, on or off)`);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
