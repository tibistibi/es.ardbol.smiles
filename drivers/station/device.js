'use strict';

const Homey = require('homey');
const SmilesApi = require('../../lib/SmilesApi');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_COMMAND_INTERVAL_MS = 30 * 1000; // the DTU forwards limits wirelessly; don't flood it
const MIN_LIMIT_INTERVAL_MS = 60 * 1000; // every %-limit write costs DTU flash + inverter EEPROM
const NOT_CONNECTED = /not connected/i; // cloud answer while a cloud-only inverter (2WB) is offline, e.g. at night

class StationDevice extends Homey.Device {

  async onInit() {
    this.resetApi();
    this._lastCommandAt = 0;
    this._lastLimitAt = 0;
    this._commandQueue = Promise.resolve();
    this._poll = this.homey.setInterval(() => this.refresh(), POLL_INTERVAL_MS);
    this.refresh();
  }

  resetApi() {
    this.api = new SmilesApi({
      log: this.log.bind(this),
      email: this.getStoreValue('email'),
      password: this.getStoreValue('password'),
    });
  }

  async refresh() {
    try {
      const data = await this.api.getRealData(this.getData().id);
      await this.setCapabilityValue('measure_power', data.power);
      await this.setCapabilityValue('meter_power.today', data.todayEnergy);
      await this.setCapabilityValue('meter_power', data.totalEnergy);
      // Keep the shown limit in sync with S-Miles, also after a manual change in the portal. Stations
      // without export management (no DTU-Pro/meter, e.g. an HMS-800-2WB) may refuse this: not fatal.
      const exportControl = await this.api.getExportControl(this.getData().id)
        .catch(err => this.log('No export control:', err.message));
      if (exportControl?.is_control === 1 && typeof exportControl.control_value === 'number') {
        await this.setCapabilityValue('smiles_output_limit', exportControl.control_value);
      }
      if (!this.getAvailable()) await this.setAvailable();
      this._applyWantedState().catch(err => this.error('Pending on/off failed:', err.message));
    } catch (err) {
      this.error('Refresh failed:', err.message);
      await this.setUnavailable(err.message).catch(this.error);
    }
  }

  /** Flow action: set the station's max output. Skips the call when the value is already set. */
  async setOutputLimit(kw) {
    const current = this.getCapabilityValue('smiles_output_limit');
    if (current === kw) {
      this.log(`Max output already ${kw} kW — nothing sent`);
      return;
    }
    const wait = this._lastCommandAt + MIN_COMMAND_INTERVAL_MS - Date.now();
    if (wait > 0) throw new Error(`Too soon after the previous command, try again in ${Math.ceil(wait / 1000)} s`);

    this._lastCommandAt = Date.now();
    await this.api.setOutputLimit(this.getData().id, kw);
    await this.setCapabilityValue('smiles_output_limit', kw);
    this.log(`Max output set to ${kw} kW`);
  }

  /**
   * Flow action: switch all micro-inverters of this station on or off. Works without DTU-Pro or meter
   * (e.g. HMS-800-2WB). Skipped when Homey already sent the same state (a change made in the S-Miles app
   * is not seen). A cloud-only 2WB is offline when its panels give no power (night): the wanted state is
   * then kept and sent by the next refresh once it is reachable again, without failing the flow.
   */
  async setInvertersOn(on) {
    await this.setStoreValue('inverters_wanted', on);
    return this._applyWantedState({ fromFlow: true });
  }

  _applyWantedState({ fromFlow = false } = {}) {
    return this._enqueue(async () => {
      const on = this.getStoreValue('inverters_wanted');
      if (typeof on !== 'boolean') return;
      if (this.getStoreValue('inverters_on') === on) {
        if (fromFlow) this.log(`Inverters already ${on ? 'on' : 'off'} — nothing sent`);
        return;
      }
      try {
        await this.api.setInvertersOn(this.getData().id, on);
      } catch (err) {
        if (!fromFlow || NOT_CONNECTED.test(err.message)) {
          this.log(`Inverters ${on ? 'on' : 'off'} pending, retry at next refresh: ${err.message}`);
          return;
        }
        throw err;
      }
      await this.setStoreValue('inverters_on', on);
      this.log(`Inverters switched ${on ? 'on' : 'off'}`);
    });
  }

  /** Flow action: set the power limit in % (2–100) of all inverters of this station. Only on change. */
  async setPowerLimitPercent(percent) {
    const pct = Math.round(percent);
    return this._enqueue(async () => {
      if (this.getStoreValue('power_limit_pct') === pct) {
        this.log(`Power limit already ${pct} % — nothing sent`);
        return;
      }
      const wait = this._lastLimitAt + MIN_LIMIT_INTERVAL_MS - Date.now();
      if (wait > 0) throw new Error(`Too soon after the previous limit, try again in ${Math.ceil(wait / 1000)} s`);

      this._lastLimitAt = Date.now();
      await this.setStoreValue('power_limit_pct', null); // unknown until the DTU confirms
      await this.api.setPowerLimitPercent(this.getData().id, pct);
      await this.setStoreValue('power_limit_pct', pct);
      this.log(`Power limit set to ${pct} %`);
    });
  }

  // One cloud command at a time per station; the DTU handles tasks one by one
  _enqueue(task) {
    const run = this._commandQueue.then(task);
    this._commandQueue = run.catch(() => {});
    return run;
  }

  async onDeleted() {
    this.homey.clearInterval(this._poll);
  }

}

module.exports = StationDevice;
