'use strict';

const Homey = require('homey');
const { CumminsApi, CumminsAuthError } = require('../../lib/CumminsApi');
const { EnergyEstimator } = require('../../lib/EnergyEstimator');

const REAUTH_MESSAGE = 'Cummins sign-in expired — repair this device to sign in again.';

/** How often to poll the (slow-moving) event feed, independent of telemetry. */
const EVENT_FETCH_INTERVAL_MS = 5 * 60 * 1000;

class GeneratorDevice extends Homey.Device {

  async onInit() {
    this.assetId = this.getData().id;
    this._pollTimer = null;
    this._pollBusy = false;
    this._remoteEnabled = null;
    this._failCount = 0;
    this._backoffUntil = 0;
    this._apiGeneration = 0;
    await this._syncCommandCapability();
    this.registerCapabilityListener('button.exercise', async () => {
      await this.sendGensetCommand('StartExercise', { requiresOptIn: false });
    });
    this._energy = new EnergyEstimator(
      this,
      () => Math.max(1, Number(this.getSetting('poll_interval')) || 2) * 60 * 1000,
    );
    await this.reconnect();
  }

  /**
   * (Re)create the API client from the stored refresh token and start
   * polling. Also called by the repair flow after a fresh sign-in.
   *
   * Bumps `_apiGeneration` so any poll still in flight against the OLD
   * client becomes a no-op: without that, a repair could be immediately
   * undone by the doomed poll it raced — the old poll's 401 would mark the
   * device unavailable again and set a 30-minute backoff, and its rotated
   * (old-account) token could overwrite the new one in the store.
   */
  async reconnect() {
    this._apiGeneration = (this._apiGeneration || 0) + 1;
    const generation = this._apiGeneration;
    const refreshToken = this.getStoreValue('refresh_token');
    if (!refreshToken) {
      await this._markUnavailable(REAUTH_MESSAGE);
      return;
    }
    this.api = new CumminsApi(refreshToken, {
      onTokenRotated: newToken => {
        if (generation !== this._apiGeneration) return; // superseded client
        this.setStoreValue('refresh_token', newToken).catch(this.error);
      },
    });
    this._failCount = 0;
    this._backoffUntil = 0;
    // A poll may still be running against the previous client; it will bail
    // out when it sees the generation changed, so don't wait on _pollBusy.
    this._pollBusy = false;
    this._startPolling(this.getSetting('poll_interval'));
    this.poll(true).catch(this.error);
  }

  _startPolling(intervalMinutes) {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    const minutes = Math.max(1, Number(intervalMinutes) || 2);
    this._pollTimer = this.homey.setInterval(() => {
      this.poll().catch(this.error);
    }, minutes * 60 * 1000);
  }

  /**
   * @param {boolean} [force] true for user-initiated refreshes — bypasses
   *   the failure backoff so a manual retry always goes out immediately.
   */
  async poll(force = false) {
    if (this._pollBusy || !this.api) return;
    if (!force && this._backoffUntil && Date.now() < this._backoffUntil) return;
    this._pollBusy = true;
    // Snapshot the client we're polling with; a repair mid-flight replaces
    // it, and this poll's result (success or 401) must then be discarded.
    const api = this.api;
    const generation = this._apiGeneration;
    try {
      const detail = await api.assetDetail(this.assetId);
      if (generation !== this._apiGeneration) return;
      this._failCount = 0;
      this._backoffUntil = 0;
      const t = CumminsApi.telemetry(detail);
      this._sawTransition = false;
      await this._applyTelemetry(t);
      // A state change means a matching event is landing right now — fetch
      // the feed immediately instead of waiting out the rate limit.
      await this._processEvents(this._sawTransition || force);
      this.lastErrorMessage = null;
      await this.setAvailable().catch(this.error);
    } catch (err) {
      // A failure from a client that has since been replaced (repair) says
      // nothing about the new one — dropping it is the whole point.
      if (generation !== this._apiGeneration) return;
      if (err instanceof CumminsAuthError) {
        this.error('Auth failed:', err.message);
        await this._markUnavailable(REAUTH_MESSAGE);
        // An expired token cannot fix itself — poll rarely until repaired.
        this._backoffUntil = Date.now() + 30 * 60 * 1000;
      } else {
        // Back off progressively on repeated cloud failures (outage on
        // their side shouldn't turn into a hammering loop on ours).
        this._failCount = (this._failCount || 0) + 1;
        if (this._failCount >= 3) {
          const interval = Math.max(1, Number(this.getSetting('poll_interval')) || 2) * 60 * 1000;
          this._backoffUntil = Date.now() + Math.min(this._failCount, 10) * interval;
        }
        this.error('Poll failed:', err.message);
        await this._markUnavailable(`Cummins Connect Cloud unreachable: ${err.message}`);
      }
    } finally {
      this._pollBusy = false;
    }
  }

  /**
   * Add or remove the on/off tile control to match the `commands_enabled`
   * setting.
   *
   * Start/stop is confirmed working, but it turns a real engine, so the
   * switch only exists once the user has explicitly opted in. Exercise and
   * fault-reset are always available and need no opt-in.
   */
  async _syncCommandCapability() {
    const wanted = this.getSetting('commands_enabled') === true;
    const present = this.hasCapability('onoff');
    if (wanted && !present) {
      await this.addCapability('onoff').catch(this.error);
      this.registerCapabilityListener('onoff', async value => {
        await this.sendGensetCommand(value ? 'StartGenset' : 'StopGenset');
      });
    } else if (!wanted && present) {
      await this.removeCapability('onoff').catch(this.error);
    } else if (wanted && present) {
      this.registerCapabilityListener('onoff', async value => {
        await this.sendGensetCommand(value ? 'StartGenset' : 'StopGenset');
      });
    }
  }

  /**
   * setUnavailable() plus a local copy of the reason — SDK v3 offers no way
   * to read it back, and the app settings page wants to show it.
   */
  async _markUnavailable(message) {
    this.lastErrorMessage = message;
    await this.setUnavailable(message).catch(this.error);
  }

  async _applyTelemetry(t) {
    const trig = /** @type {any} */ (this.driver).triggers;
    const now = Date.now();

    const running = t.isRunning != null ? Boolean(t.isRunning) : null;
    const utility = t.utilityAvailable != null ? Boolean(t.utilityAvailable) : null;
    const exercising = t.isExercising != null ? Boolean(t.isExercising) : null;
    const onGenerator = (running != null && utility != null) ? (running && !utility) : null;
    const fault = t.faultType != null ? t.faultType !== 0 : null;
    this._remoteEnabled = t.isRemoteEnabled != null ? Boolean(t.isRemoteEnabled) : null;

    // Exercise bookkeeping: a falling isExercising edge marks a completed
    // self-test (the Events feed refines this with the official timestamp).
    const prevExercising = this.getCapabilityValue('generator_exercising');
    if (prevExercising === true && exercising === false) {
      await this.setStoreValue('last_exercise_ts', now).catch(this.error);
    }

    // Stale-data + exercise-overdue alarms
    let stale = null;
    if (t.LastCheckIn) {
      const lastCheckIn = Date.parse(t.LastCheckIn);
      if (!Number.isNaN(lastCheckIn)) {
        const staleHours = Number(this.getSetting('stale_hours')) || 25;
        stale = now - lastCheckIn > staleHours * 3600 * 1000;
      }
    }
    const lastExerciseTs = this.getStoreValue('last_exercise_ts');
    let overdue = null;
    if (lastExerciseTs) {
      const overdueDays = Number(this.getSetting('exercise_overdue_days')) || 8;
      overdue = now - lastExerciseTs > overdueDays * 24 * 3600 * 1000;
    }

    // Boolean transitions -> named triggers (skipped on the very first poll,
    // when the previous capability value is still null)
    await this._transition('generator_running', running, {
      onTrue: () => trig.generator_started.trigger(this),
      onFalse: () => trig.generator_stopped.trigger(this, {
        runtime_hours: typeof t.engineRuntime === 'number' ? t.engineRuntime : 0,
      }),
    });
    await this._transition('utility_power', utility, {
      onTrue: () => trig.utility_power_restored.trigger(this),
      onFalse: () => {
        this._notify(`⚡ Utility power lost at ${this.getName()}`);
        return trig.utility_power_lost.trigger(this);
      },
    });
    await this._transition('on_generator_power', onGenerator, {
      onTrue: () => {
        this._notify(`🔌 ${this.getName()} is now supplying the house`);
        return trig.switched_to_generator.trigger(this);
      },
      onFalse: () => trig.switched_to_utility.trigger(this),
    });
    await this._transition('generator_exercising', exercising, {
      onTrue: () => trig.exercise_started.trigger(this),
      onFalse: () => trig.exercise_completed.trigger(this),
    });
    await this._transition('alarm_fault', fault, {
      onTrue: () => {
        this._notify(`⚠️ ${this.getName()} reported a fault (type ${t.faultType})`);
        return trig.fault_occurred.trigger(this, { fault_type: t.faultType || 0 });
      },
      onFalse: () => trig.fault_cleared.trigger(this),
    });
    await this._transition('alarm_data_stale', stale, {
      onTrue: () => trig.data_went_stale.trigger(this),
      onFalse: () => trig.data_fresh_again.trigger(this),
    });
    // Stale data also shows as a warning banner on the device tile
    if (stale === true) {
      await this.setWarning('The generator has not checked in to Cummins Connect Cloud recently — it may be offline.').catch(this.error);
    } else if (stale === false) {
      await this.unsetWarning().catch(this.error);
    }
    await this._transition('alarm_exercise_overdue', overdue, {
      onTrue: () => trig.exercise_became_overdue.trigger(this),
    });
    await this._setCapability('standby_enabled', t.isStandbyEnabled != null ? Boolean(t.isStandbyEnabled) : null);
    // Only present when remote start/stop is enabled; keep it in step
    // with reality so the toggle isn't lying after an auto-start.
    if (running != null) await this._setCapability('onoff', running);

    // Numeric telemetry (threshold triggers filter in their run listeners)
    await this._numeric('measure_voltage.battery', t.batteryVoltage, (value, prev) => {
      trig.battery_voltage_below
        .trigger(this, { voltage: value }, { voltage: value, prev })
        .catch(this.error);
    });
    await this._numeric('measure_generator_load', t.gensetPercentLoad, (value, prev) => {
      trig.load_above
        .trigger(this, { load: value }, { load: value, prev })
        .catch(this.error);
    });
    await this._numeric('measure_voltage.output', t.gensetVoltage);
    await this._numeric('measure_frequency', t.frequencyOP);
    await this._numeric('measure_engine_speed', t.averageEngineSpeed);
    await this._numeric('measure_engine_runtime', t.engineRuntime);
    await this._energy.update(
      t.gensetPercentLoad,
      running,
      (capability, value) => this._setCapability(capability, value),
    );

    // Status text + timestamps
    await this._setCapability('generator_status', this._statusText({
      running, utility, exercising, fault, stale,
    }));
    await this._setCapability('last_checkin', t.LastCheckIn ? this._formatTime(Date.parse(t.LastCheckIn)) : null);
    await this._setCapability('last_exercise', lastExerciseTs ? this._formatTime(lastExerciseTs) : null);

    // Diagnostic info -> device settings
    await this._updateInfoSettings({
      firmware_version: t.SoftwareVersion != null ? String(t.SoftwareVersion) : undefined,
      remote_control: this._remoteEnabled == null ? undefined : (this._remoteEnabled ? 'Yes' : 'No'),
      raw_genset_status: t.gensetStatus != null ? String(t.gensetStatus) : undefined,
      raw_load_status: t.loadStatus != null ? String(t.loadStatus) : undefined,
      raw_power_source: t.powerSource != null ? String(t.powerSource) : undefined,
    });
  }

  /**
   * Post a Homey timeline notification, if the user left them enabled.
   * Fire-and-forget: a failed notification must never break a poll.
   */
  _notify(excerpt) {
    if (this.getSetting('notify_critical') === false) return;
    this.homey.notifications.createNotification({ excerpt }).catch(this.error);
  }

  _statusText({ running, utility, exercising, fault, stale }) {
    if (stale) return 'Offline (no check-in)';
    if (fault) return 'Fault';
    if (exercising) return 'Exercising';
    if (running && utility === false) return 'Running (backup power)';
    if (running) return 'Running';
    if (utility === false) return 'Utility out, not running';
    if (running === false) return 'Standby';
    return 'Unknown';
  }

  /**
   * Poll /Assets/Events for anything new since the last seen event and fire
   * the generator_event trigger. Also refines the last-exercise timestamp
   * from "Genset exercise completed" events. The first poll only baselines.
   *
   * @param {boolean} [immediate] skip the rate limit — passed when a state
   *   transition just happened, since that's exactly when a matching event
   *   is about to land and waiting would delay the trigger.
   */
  async _processEvents(immediate = false) {
    // The event feed is a second HTTP call per poll cycle. Telemetry can be
    // polled every minute, but events change far more slowly, so rate-limit
    // them independently rather than doubling the request count.
    const now = Date.now();
    if (!immediate && this._lastEventFetch && now - this._lastEventFetch < EVENT_FETCH_INTERVAL_MS) {
      return;
    }
    this._lastEventFetch = now;

    const lastSeen = this.getStoreValue('last_event_ts');
    const isBaseline = lastSeen == null;
    let raw;
    try {
      raw = await this.api.assetEvents(this.assetId, isBaseline ? undefined : lastSeen + 1);
    } catch (err) {
      // Events are a bonus feed — never fail the whole poll over them.
      this.error('Events fetch failed:', err.message);
      return;
    }
    const events = Array.isArray(raw) ? raw : (raw && (raw.Events || raw.Items)) || [];
    let maxTs = lastSeen || 0;
    let latestExercise = 0;

    for (const ev of events) {
      const ts = this._eventTimestamp(ev);
      if (ts > maxTs) maxTs = ts;
      const message = String(ev.Message || ev.Description || '');
      if (/exercise/i.test(message) && /complete/i.test(message) && ts > latestExercise) {
        latestExercise = ts;
      }
      if (!isBaseline && (lastSeen == null || ts > lastSeen)) {
        /** @type {any} */ (this.driver).triggers.generator_event.trigger(this, {
          severity: String(ev.Severity != null ? ev.Severity : ''),
          code: String(ev.Code != null ? ev.Code : ''),
          message,
        }).catch(this.error);
      }
    }
    if (latestExercise > (this.getStoreValue('last_exercise_ts') || 0)) {
      await this.setStoreValue('last_exercise_ts', latestExercise).catch(this.error);
      await this._setCapability('last_exercise', this._formatTime(latestExercise));
    }
    if (maxTs !== (lastSeen || 0)) {
      await this.setStoreValue('last_event_ts', maxTs).catch(this.error);
    }
  }

  _eventTimestamp(ev) {
    const raw = ev.Timestamp != null ? ev.Timestamp : (ev.Time || ev.CreatedOn);
    if (typeof raw === 'number') return raw;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Send a command via Cummins Connect Cloud.
   *
   * @param {string} commandName
   * @param {{ requiresOptIn?: boolean }} [options] engine start/stop requires
   *   the user to have opted in; exercise and fault-reset do not, since an
   *   exercise is the routine self-test the generator runs on its own
   *   schedule and a fault reset only clears an indication.
   */
  async sendGensetCommand(commandName, options = {}) {
    const { requiresOptIn = true } = options;
    if (requiresOptIn && this.getSetting('commands_enabled') !== true) {
      throw new Error('Remote start/stop is disabled — enable it in the device settings first.');
    }
    if (this._remoteEnabled === false) {
      throw new Error('The generator reports remote control as disabled.');
    }
    let commands;
    try {
      commands = await this.api.assetCommands(this.assetId);
    } catch (err) {
      throw new Error(`Could not check available commands: ${err.message}`);
    }
    const list = Array.isArray(commands) ? commands : (commands && (commands.Commands || commands.Items)) || [];
    const match = list.find(c => String(c.Name || c.CommandName || '').toLowerCase() === commandName.toLowerCase());
    if (match && match.IsEnabled === false) {
      throw new Error(`Cummins reports the ${commandName} command as disabled for this generator.`);
    }
    try {
      await this.api.sendCommand(this.assetId, commandName);
    } catch (err) {
      // A 404 means the guessed path doesn't exist on the mobile API — a
      // known open question, not something the user did wrong. Point them at
      // the tool that can actually find the right endpoint.
      if (/\(4\d\d\)/.test(err.message)) {
        throw new Error(
          `Cummins rejected ${commandName}: ${err.message.replace(/^\S+ failed /, '')}`,
        );
      }
      throw err;
    }
    this.log(`Sent ${commandName}`);
    // Re-poll shortly to reflect the (possible) state change
    this.homey.setTimeout(() => this.poll().catch(this.error), 15 * 1000);
  }

  /**
   * Set a boolean capability and fire edge triggers. Deliberately does
   * nothing on the first poll after pairing (previous value still null),
   * so adding a device never replays its current state as fresh events.
   *
   * @param {string} capability
   * @param {boolean|null} value
   * @param {{ onTrue?: () => any, onFalse?: () => any }} [handlers]
   */
  async _transition(capability, value, handlers = {}) {
    const { onTrue, onFalse } = handlers;
    if (value == null) return;
    const prev = this.getCapabilityValue(capability);
    await this._setCapability(capability, value);
    if (prev == null || prev === value) return;
    this._sawTransition = true;
    if (value === true && onTrue) await Promise.resolve(onTrue()).catch(this.error);
    if (value === false && onFalse) await Promise.resolve(onFalse()).catch(this.error);
  }

  /**
   * Set a numeric capability. `onChanged` fires only when the value actually
   * moved AND a previous value existed, so threshold Flow cards can compare
   * both sides of the crossing.
   *
   * @param {string} capability
   * @param {number|null|undefined} value
   * @param {(value: number, prev: number) => void} [onChanged]
   */
  async _numeric(capability, value, onChanged) {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    const prev = this.getCapabilityValue(capability);
    await this._setCapability(capability, value);
    if (onChanged && prev != null && prev !== value) onChanged(value, prev);
  }

  async _setCapability(capability, value) {
    if (value === undefined || !this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  async _updateInfoSettings(values) {
    const changed = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && this.getSetting(key) !== value) changed[key] = value;
    }
    if (Object.keys(changed).length) {
      await this.setSettings(changed).catch(this.error);
    }
  }

  _formatTime(timestampMs) {
    try {
      return new Date(timestampMs).toLocaleString('en-US', {
        timeZone: this.homey.clock.getTimezone(),
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch (err) {
      return new Date(timestampMs).toISOString();
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this._startPolling(newSettings.poll_interval);
    }
    if (changedKeys.includes('commands_enabled')) {
      // getSetting() still returns the old value inside onSettings, so apply
      // the change on the next tick once Homey has committed it.
      this.homey.setTimeout(() => this._syncCommandCapability().catch(this.error), 500);
    }
    if (changedKeys.includes('stale_hours') || changedKeys.includes('exercise_overdue_days')) {
      // Forced: the user just changed a threshold and expects to see the
      // alarm re-evaluate, even if a backoff is currently in effect.
      this.homey.setTimeout(() => this.poll(true).catch(this.error), 1000);
    }
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }

  async onUninit() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }

}

module.exports = GeneratorDevice;
