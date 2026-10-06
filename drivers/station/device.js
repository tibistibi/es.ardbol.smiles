'use strict';

const Homey = require('homey');
const SmilesApi = require('../../lib/SmilesApi');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_COMMAND_INTERVAL_MS = 30 * 1000; // the DTU forwards limits wirelessly; don't flood it

class StationDevice extends Homey.Device {

  async onInit() {
    this.resetApi();
    this._lastCommandAt = 0;
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
      if (!this.getAvailable()) await this.setAvailable();
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

  async onDeleted() {
    this.homey.clearInterval(this._poll);
  }

}

module.exports = StationDevice;
