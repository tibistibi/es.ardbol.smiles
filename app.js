'use strict';

const Homey = require('homey');

class SmilesApp extends Homey.App {

  async onInit() {
    this.homey.flow.getActionCard('set_output_limit')
      .registerRunListener(({ device, kw }) => device.setOutputLimit(kw));
    this.homey.flow.getActionCard('set_inverter_onoff')
      .registerRunListener(({ device, state }) => device.setInvertersOn(state === 'on'));
    this.homey.flow.getActionCard('set_power_limit_pct')
      .registerRunListener(({ device, percent }) => device.setPowerLimitPercent(percent));
    this.log('Hoymiles S-Miles Cloud app started');
  }

}

module.exports = SmilesApp;
