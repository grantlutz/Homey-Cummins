'use strict';

const Homey = require('homey');

class CumminsGeneratorApp extends Homey.App {

  async onInit() {
    // Widget: generator picker autocomplete + status endpoint backing
    try {
      this.homey.dashboards
        .getWidget('generator-status')
        .registerSettingAutocompleteListener('device', async query => {
          const q = (query || '').toLowerCase();
          return this._allDevices()
            .map(device => ({
              id: device.getData().id,
              name: device.getName(),
            }))
            .filter(item => item.name.toLowerCase().includes(q));
        });
    } catch (err) {
      this.log('Dashboard widgets unavailable:', err.message);
    }

    this.log('Cummins Generator app started');
  }

  /** @returns {Array<{device: any, driverId: string}>} */
  _allDeviceEntries() {
    const entries = [];
    for (const driverId of ['generator', 'generator-local']) {
      try {
        for (const device of this.homey.drivers.getDriver(driverId).getDevices()) {
          entries.push({ device, driverId });
        }
      } catch (err) {
        // driver not initialized yet
      }
    }
    return entries;
  }

  /** @returns {any[]} */
  _allDevices() {
    return this._allDeviceEntries().map(entry => entry.device);
  }

  /**
   * Whole-generator load %, from whichever capability the driver provides.
   * Returns null (not 0) when unknown, so callers can omit it rather than
   * claiming a running generator is at 0% load.
   *
   * @param {(id: string) => any} cap
   * @returns {number|null}
   */
  _loadPercent(cap) {
    const single = cap('measure_generator_load');
    if (typeof single === 'number') return single;
    const line1 = cap('measure_generator_load.line1');
    const line2 = cap('measure_generator_load.line2');
    if (typeof line1 !== 'number' && typeof line2 !== 'number') return null;
    return Math.max(line1 || 0, line2 || 0);
  }

  /** Backing data for the app settings page. */
  async getDiagnostics() {
    return this._allDeviceEntries().map(({ device, driverId }) => {
      const cap = id => (device.hasCapability(id) ? device.getCapabilityValue(id) : null);
      return {
        id: device.getData().id,
        name: device.getName(),
        driver: driverId,
        available: device.getAvailable(),
        // SDK v3 has no getter for the unavailable message, so devices
        // stash their own copy when they call setUnavailable().
        unavailableMessage: device.getAvailable() ? null : (device.lastErrorMessage || null),
        status: cap('generator_status'),
        running: cap('generator_running') === true,
        fault: cap('alarm_fault') === true,
        stale: cap('alarm_data_stale') === true,
        battery: cap('measure_voltage.battery'),
        runtime: cap('measure_engine_runtime'),
        lastCheckIn: cap('last_checkin'),
      };
    });
  }

  /** "Refresh all generators now" button on the settings page. */
  async refreshAll() {
    const devices = this._allDevices();
    await Promise.all(devices.map(device => device.poll(true).catch(err => {
      this.error(`Refresh failed for ${device.getName()}:`, err.message);
    })));
    return { refreshed: devices.length };
  }

  /**
   * Find the mobile API's real command endpoint for a cloud generator.
   *
   * The published command path returns 404, so this asks the API what
   * commands it advertises and probes candidate endpoints with a bogus
   * command name — nothing can be executed, and a non-404 identifies the
   * right path. Results are surfaced on the app settings page.
   *
   * @param {string} deviceId
   */
  async probeCommands(deviceId) {
    const entry = this._allDeviceEntries()
      .find(e => e.driverId === 'generator' && e.device.getData().id === deviceId);
    if (!entry) throw new Error('Pick a Connect Cloud generator first.');
    if (!entry.device.api) throw new Error('That generator is not signed in — repair it first.');
    return entry.device.api.probeCommandEndpoints(entry.device.assetId);
  }

  /** Data source for the generator-status widget. */
  async getGeneratorStatus(deviceId) {
    const device = this._allDevices().find(d => d.getData().id === deviceId);
    if (!device) return null;
    const cap = id => (device.hasCapability(id) ? device.getCapabilityValue(id) : null);
    return {
      name: device.getName(),
      available: device.getAvailable(),
      status: cap('generator_status'),
      running: cap('generator_running') === true,
      fault: cap('alarm_fault') === true,
      stale: cap('alarm_data_stale') === true,
      utility: cap('utility_power'),
      battery: cap('measure_voltage.battery'),
      load: this._loadPercent(cap),
      output: cap('measure_generator_output'),
    };
  }

}

module.exports = CumminsGeneratorApp;
