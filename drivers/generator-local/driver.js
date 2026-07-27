'use strict';

const Homey = require('homey');
const { CumminsLocalApi } = require('../../lib/CumminsLocalApi');

class GeneratorLocalDriver extends Homey.Driver {

  async onInit() {
    this.triggers = {};
    for (const id of [
      'local_generator_started', 'local_generator_stopped',
      'local_utility_lost', 'local_utility_restored',
      'local_switched_to_generator', 'local_switched_to_utility',
      'local_exercise_started', 'local_exercise_completed',
      'local_fault_occurred', 'local_fault_cleared',
      'local_action_required', 'local_status_changed',
      'local_event_logged',
      'local_battery_below', 'local_load_above',
    ]) {
      this.triggers[id] = this.homey.flow.getDeviceTriggerCard(id);
    }

    this.triggers.local_battery_below.registerRunListener(
      async (args, state) => state.prev >= args.voltage && state.voltage < args.voltage,
    );
    this.triggers.local_load_above.registerRunListener(
      async (args, state) => state.prev <= args.percent && state.load > args.percent,
    );

    const capCondition = (cardId, capability) => {
      this.homey.flow.getConditionCard(cardId)
        .registerRunListener(async args => args.device.getCapabilityValue(capability) === true);
    };
    capCondition('local_is_running', 'generator_running');
    capCondition('local_utility_available', 'utility_power');
    capCondition('local_on_generator', 'on_generator_power');
    capCondition('local_is_exercising', 'generator_exercising');
    capCondition('local_has_fault', 'alarm_fault');
    capCondition('local_standby_enabled', 'standby_enabled');
    capCondition('local_action_required_cond', 'alarm_action_required');

    this.homey.flow.getConditionCard('local_status_is')
      .registerRunListener(async args => args.device.statusKey() === args.status);
    this.homey.flow.getConditionCard('local_battery_above')
      .registerRunListener(async args => args.device.getCapabilityValue('measure_voltage.battery') > args.voltage);

    const action = (cardId, fn) => {
      this.homey.flow.getActionCard(cardId).registerRunListener(async args => fn(args));
    };
    action('local_start_generator', args => args.device.api.start());
    action('local_stop_generator', args => args.device.api.stop());
    action('local_exercise_now', args => args.device.api.exerciseNow());
    action('local_standby_on', args => args.device.api.setStandby(true));
    action('local_standby_off', args => args.device.api.setStandby(false));
    action('local_set_exercise_schedule', args => args.device.api.setExerciseSchedule(
      args.frequency,
      parseInt(args.day, 10),
      args.hour,
      parseInt(args.minute, 10),
    ));
    action('local_sync_clock', args => args.device.syncClock());
    action('local_refresh', args => args.device.poll(true));

    this.log('Generator (Local) driver initialized');
  }

  async onPair(session) {
    let connection = null;
    /** @type {Array<{host: string, status: any}>} */
    let discovered = [];

    // Automatic discovery. These generators advertise no mDNS/SSDP service,
    // so this sweeps Homey's own /24 looking for the web-interface card's
    // distinctive index_data.html response. Manual entry stays available for
    // generators on a different subnet or a non-default port.
    session.setHandler('discover', async data => {
      const username = (data && data.username) || 'admin';
      const password = (data && data.password) || 'cummins';
      let localAddress;
      try {
        localAddress = await this.homey.cloud.getLocalAddress();
      } catch (err) {
        throw new Error(`Could not determine Homey's network address: ${err.message}`);
      }
      discovered = await CumminsLocalApi.discover(localAddress, username, password);
      return discovered.map(d => ({
        host: d.host,
        name: `Cummins Generator (${d.host})`,
        status: d.status.status,
        battery: d.status.batteryVoltage,
      }));
    });

    session.setHandler('connect', async data => {
      const api = new CumminsLocalApi(data.host, data.username, data.password);
      // Throws with a readable message on unreachable host / bad credentials
      await api.getStatus();
      connection = data;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!connection) throw new Error('Not connected yet.');
      return [{
        name: 'Cummins Generator',
        data: { id: `local-${connection.host}` },
        settings: {
          host: connection.host,
          username: connection.username,
          password: connection.password,
        },
      }];
    });
  }

}

module.exports = GeneratorLocalDriver;
