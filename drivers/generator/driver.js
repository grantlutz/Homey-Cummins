'use strict';

const Homey = require('homey');
const { CumminsApi } = require('../../lib/CumminsApi');
const { login: auraLogin, AuraLoginError } = require('../../lib/AuraAuth');

/**
 * A pasted Cognito refresh token instead of a password: real passwords are
 * never this long, and Cognito refresh tokens are ~1500-char JWEs.
 */
function looksLikeRefreshToken(secret) {
  return typeof secret === 'string' && secret.length > 100 && !/\s/.test(secret.trim());
}

class GeneratorDriver extends Homey.Driver {

  async onInit() {
    // Device-scoped trigger cards, fetched once and fired from device.js
    this.triggers = {};
    for (const id of [
      'generator_started', 'generator_stopped',
      'utility_power_lost', 'utility_power_restored',
      'switched_to_generator', 'switched_to_utility',
      'exercise_started', 'exercise_completed',
      'fault_occurred', 'fault_cleared',
      'data_went_stale', 'data_fresh_again',
      'exercise_became_overdue',
      'battery_voltage_below', 'load_above',
      'generator_event',
    ]) {
      this.triggers[id] = this.homey.flow.getDeviceTriggerCard(id);
    }

    this.triggers.battery_voltage_below.registerRunListener(
      async (args, state) => state.prev >= args.voltage && state.voltage < args.voltage,
    );
    this.triggers.load_above.registerRunListener(
      async (args, state) => state.prev <= args.percent && state.load > args.percent,
    );

    const capCondition = (cardId, capability) => {
      this.homey.flow.getConditionCard(cardId)
        .registerRunListener(async args => args.device.getCapabilityValue(capability) === true);
    };
    capCondition('is_running', 'generator_running');
    capCondition('utility_available', 'utility_power');
    capCondition('on_generator', 'on_generator_power');
    capCondition('is_exercising', 'generator_exercising');
    capCondition('has_fault', 'alarm_fault');
    capCondition('is_stale', 'alarm_data_stale');
    capCondition('is_exercise_overdue', 'alarm_exercise_overdue');
    capCondition('standby_is_enabled', 'standby_enabled');

    this.homey.flow.getConditionCard('battery_above')
      .registerRunListener(async args => args.device.getCapabilityValue('measure_voltage.battery') > args.voltage);
    this.homey.flow.getConditionCard('load_is_above')
      .registerRunListener(async args => args.device.getCapabilityValue('measure_generator_load') > args.percent);

    this.homey.flow.getActionCard('refresh_now')
      .registerRunListener(async args => args.device.poll(true));
    // Start/stop act on a real engine, so they stay behind the opt-in
    // setting. Exercise and fault-reset don't: an exercise is the same
    // self-test the generator runs weekly on its own.
    this.homey.flow.getActionCard('start_generator_experimental')
      .registerRunListener(async args => args.device.sendGensetCommand('StartGenset'));
    this.homey.flow.getActionCard('stop_generator_experimental')
      .registerRunListener(async args => args.device.sendGensetCommand('StopGenset'));
    this.homey.flow.getActionCard('start_exercise')
      .registerRunListener(async args => args.device.sendGensetCommand('StartExercise', { requiresOptIn: false }));
    this.homey.flow.getActionCard('stop_exercise')
      .registerRunListener(async args => args.device.sendGensetCommand('StopExercise', { requiresOptIn: false }));
    this.homey.flow.getActionCard('fault_reset')
      .registerRunListener(async args => args.device.sendGensetCommand('FaultReset', { requiresOptIn: false }));

    this.log('Generator (Connect Cloud) driver initialized');
  }

  /**
   * Shared login logic for pair and repair. Returns { refreshToken, api }.
   * Throwing an Error surfaces its message in the pairing UI.
   */
  async loginWithCredentials(username, password) {
    if (looksLikeRefreshToken(password)) {
      // Advanced path: the user pasted a refresh token into the password
      // field (obtained e.g. via tebrown/cummins_hacs tools/bootstrap_login.py).
      const api = new CumminsApi(password.trim());
      await api.validate();
      return { refreshToken: api.refreshToken, api };
    }

    let tokens;
    try {
      tokens = await auraLogin(username, password);
    } catch (err) {
      if (err instanceof AuraLoginError && err.blocked) {
        throw new Error(
          'Cummins\' login service blocked this sign-in method (TLS fingerprinting). '
          + 'Workaround: obtain a refresh token on a computer (see the app\'s README) '
          + 'and paste it into the password field.',
        );
      }
      throw err;
    }
    const api = new CumminsApi(tokens.refresh_token);
    api.accessToken = tokens.access_token;
    api.idToken = tokens.id_token;
    api.accessExpiry = Date.now() + ((tokens.expires_in || 3600) - 60) * 1000;
    return { refreshToken: tokens.refresh_token, api };
  }

  async onPair(session) {
    let api = null;
    let refreshToken = null;

    session.setHandler('login', async data => {
      const result = await this.loginWithCredentials(data.username, data.password);
      api = result.api;
      refreshToken = result.refreshToken;
      return true;
    });

    session.setHandler('list_devices', async () => {
      const assets = await api.listAssets();
      if (!assets.length) {
        throw new Error('No generators found on this Cummins account.');
      }
      return assets.map(asset => ({
        name: asset.name,
        data: { id: asset.id },
        store: { refresh_token: refreshToken },
        settings: { site_name: asset.siteName },
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async data => {
      const result = await this.loginWithCredentials(data.username, data.password);
      await device.setStoreValue('refresh_token', result.refreshToken);
      await device.reconnect();
      return true;
    });
  }

}

module.exports = GeneratorDriver;
