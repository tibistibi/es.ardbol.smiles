'use strict';

const Homey = require('homey');

class SmilesApp extends Homey.App {

  async onInit() {
    this.homey.flow.getActionCard('set_output_limit')
      .registerRunListener(({ device, kw }) => device.setOutputLimit(kw));
    this.log('Hoymiles S-Miles Cloud app started');
  }

}

module.exports = SmilesApp;
