'use strict';

const Homey = require('homey');
const SmilesApi = require('../../lib/SmilesApi');

class StationDriver extends Homey.Driver {

  async onPair(session) {
    let api = null;
    let credentials = null;

    session.setHandler('login', async ({ username, password }) => {
      const candidate = new SmilesApi({ log: this.log.bind(this), email: username, password });
      await candidate.login(); // throws with the cloud's message on failure
      api = candidate;
      credentials = { email: username, password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      const stations = await api.getStations();
      return stations.map(s => ({
        name: s.name,
        data: { id: s.id },
        store: credentials,
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      const candidate = new SmilesApi({ log: this.log.bind(this), email: username, password });
      await candidate.login();
      await device.setStoreValue('email', username);
      await device.setStoreValue('password', password);
      await device.resetApi();
      return true;
    });
  }

}

module.exports = StationDriver;
