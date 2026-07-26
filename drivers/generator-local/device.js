'use strict';

const Homey = require('homey');
const { CumminsLocalApi } = require('../../lib/CumminsLocalApi');
const { EnergyEstimator } = require('../../lib/EnergyEstimator');

// index_data.html status code -> the local_status_is condition dropdown id
const STATUS_KEYS = {
  0: 'stopped',
  1: 'stopped',
  2: 'starting',
  3: 'starting',
  4: 'running',
  5: 'priming',
  6: 'fault',
  7: 'engine_only',
  8: 'test_mode',
  9: 'volt_adj',
  20: 'config',
  21: 'crank_pause',
  22: 'exercising',
  23: 'cooldown',
};

class GeneratorLocalDevice extends Homey.Device {

  async onInit() {
    this._pollTimer = null;
    this._pollBusy = false;
    this._pollCount = 0;
    this._statusCode = null;
    this._failCount = 0;
    this._backoffUntil = 0;
    this._energy = new EnergyEstimator(
      this,
      () => Math.max(5, Number(this.getSetting('poll_interval_s')) || 30) * 1000,
    );
    this._connect();

    this.registerCapabilityListener('button.exercise', async () => {
      await this.api.exerciseNow();
    });
    this.registerCapabilityListener('button.sync_clock', async () => {
      await this.syncClock();
    });
  }

  _connect() {
    const { host, username, password } = this.getSettings();
    this.api = new CumminsLocalApi(host, username, password);
    this._failCount = 0;
    this._backoffUntil = 0;
    this._startPolling(this.getSetting('poll_interval_s'));
    this.poll(true).catch(this.error);
  }

  _startPolling(intervalSeconds) {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    const seconds = Math.max(5, Number(intervalSeconds) || 30);
    this._pollTimer = this.homey.setInterval(() => {
      this.poll().catch(this.error);
    }, seconds * 1000);
  }

  /**
   * Current status as a `local_status_is` dropdown id. Falls back to the
   * persisted capability text when `_statusCode` isn't known yet (memory
   * only, so blank from app start until the first successful poll) — better
   * than reporting "stopped" for a generator that is actually running.
   */
  statusKey() {
    if (this._statusCode != null && STATUS_KEYS[this._statusCode]) {
      return STATUS_KEYS[this._statusCode];
    }
    const text = this.getCapabilityValue('generator_status');
    if (!text) return null;
    const match = Object.entries(STATUS_KEYS)
      .find(([code]) => CumminsLocalApi.statusString(Number(code), '').startsWith(String(text).split(' ')[0]));
    return match ? match[1] : null;
  }

  /**
   * Post a Homey timeline notification, if the user left them enabled.
   * Fire-and-forget: a failed notification must never break a poll.
   */
  _notify(excerpt) {
    if (this.getSetting('notify_critical') === false) return;
    this.homey.notifications.createNotification({ excerpt }).catch(this.error);
  }

  /**
   * @param {boolean} [force] true for user-initiated refreshes — bypasses
   *   the failure backoff so a manual retry always goes out immediately.
   */
  async poll(force = false) {
    if (this._pollBusy || !this.api) return;
    if (!force && this._backoffUntil && Date.now() < this._backoffUntil) return;
    this._pollBusy = true;
    try {
      const s = await this.api.getStatus();
      this._failCount = 0;
      this._backoffUntil = 0;
      await this._applyStatus(s);
      // Check the log pages on the 1st poll and every Nth after — note the
      // -1, without which N=1 (`n % 1` is always 0) would never match.
      const logEvery = Math.max(1, Number(this.getSetting('log_poll_cycles')) || 10);
      if (this._pollCount % logEvery === 0) {
        await this._checkLogs();
        await this._checkSchedule();
      }
      this._pollCount += 1;
      await this._maybeSyncClock(s);
      this.lastErrorMessage = null;
      await this.setAvailable().catch(this.error);
    } catch (err) {
      // Back off progressively on repeated failures so an unplugged
      // generator doesn't get hammered every poll tick forever.
      this._failCount = (this._failCount || 0) + 1;
      if (this._failCount >= 3) {
        const interval = Math.max(5, Number(this.getSetting('poll_interval_s')) || 30) * 1000;
        this._backoffUntil = Date.now() + Math.min(this._failCount, 10) * interval;
      }
      this.error('Poll failed:', err.message);
      // Keep a local copy of the reason: SDK v3 offers no way to read it
      // back, and the app settings page wants to show it.
      this.lastErrorMessage = `Generator unreachable: ${err.message}`;
      await this.setUnavailable(this.lastErrorMessage).catch(this.error);
    } finally {
      this._pollBusy = false;
    }
  }

  async _applyStatus(s) {
    const trig = /** @type {any} */ (this.driver).triggers;
    this._statusCode = s.statusCode;

    await this._transition('generator_running', s.running, {
      onTrue: () => trig.local_generator_started.trigger(this),
      onFalse: () => trig.local_generator_stopped.trigger(this, { runtime_hours: s.engineHours || 0 }),
    });
    await this._transition('utility_power', s.utilityPresent, {
      onTrue: () => trig.local_utility_restored.trigger(this),
      onFalse: () => {
        this._notify(`⚡ Utility power lost at ${this.getName()}`);
        return trig.local_utility_lost.trigger(this);
      },
    });
    // On generator power: running while the utility is NOT feeding the house
    const onGenerator = s.running && !s.utilityConnected && !s.exercising;
    await this._transition('on_generator_power', onGenerator, {
      onTrue: () => {
        this._notify(`🔌 ${this.getName()} is now supplying the house`);
        return trig.local_switched_to_generator.trigger(this);
      },
      onFalse: () => trig.local_switched_to_utility.trigger(this),
    });
    await this._transition('generator_exercising', s.exercising, {
      onTrue: () => trig.local_exercise_started.trigger(this),
      onFalse: () => trig.local_exercise_completed.trigger(this),
    });
    await this._transition('alarm_fault', s.hasFault, {
      onTrue: () => {
        this._notify(`⚠️ ${this.getName()}: ${s.faultDescription || `fault ${s.faultCode}`}`);
        return trig.local_fault_occurred.trigger(this, {
          code: String(s.faultCode || ''),
          description: String(s.faultDescription || ''),
        });
      },
      onFalse: () => trig.local_fault_cleared.trigger(this),
    });
    await this._transition('alarm_action_required', s.actionRequired, {
      onTrue: () => trig.local_action_required.trigger(this),
    });
    // Surface "action required" in the device tile too, not just the alarm
    if (s.actionRequired === true) {
      await this.setWarning('The generator\'s front panel is asking for attention.').catch(this.error);
    } else if (s.actionRequired === false) {
      await this.unsetWarning().catch(this.error);
    }
    await this._setCapability('standby_enabled', s.standbyEnabled);

    await this._numeric('measure_voltage.battery', s.batteryVoltage, (value, prev) => {
      trig.local_battery_below
        .trigger(this, { voltage: value }, { voltage: value, prev })
        .catch(this.error);
    });
    // Threshold trigger uses the busier of the two lines. Read both previous
    // values BEFORE writing, and require both to be non-null — otherwise the
    // first poll after pairing would treat "unknown" as 0 and fire a bogus
    // "load rose above X" for a generator that was already loaded.
    const prevLine1 = this.getCapabilityValue('measure_generator_load.line1');
    const prevLine2 = this.getCapabilityValue('measure_generator_load.line2');
    await this._numeric('measure_generator_load.line1', s.load1);
    await this._numeric('measure_generator_load.line2', s.load2);
    if (prevLine1 != null && prevLine2 != null) {
      const maxLoad = Math.max(s.load1 || 0, s.load2 || 0);
      const prevMaxLoad = Math.max(prevLine1, prevLine2);
      if (maxLoad !== prevMaxLoad) {
        trig.local_load_above
          .trigger(this, { load: maxLoad }, { load: maxLoad, prev: prevMaxLoad })
          .catch(this.error);
      }
    }
    await this._numeric('measure_voltage.output', s.outputVoltage);
    await this._numeric('measure_frequency', s.outputFrequency);
    await this._numeric('measure_engine_runtime', s.engineHours);
    // Two load lines on these units — average them for a whole-genset figure
    await this._energy.update(
      ((s.load1 || 0) + (s.load2 || 0)) / 2,
      s.running,
      (capability, value) => this._setCapability(capability, value),
    );

    const prevStatus = this.getCapabilityValue('generator_status');
    await this._setCapability('generator_status', s.status);
    if (prevStatus != null && prevStatus !== s.status) {
      trig.local_status_changed.trigger(this, { status: s.status }).catch(this.error);
    }

    await this._updateInfoSettings({
      auto_mode: s.autoMode != null ? String(s.autoMode) : undefined,
      generator_clock: s.generatorTime ? s.generatorTime.toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }) : undefined,
    });
  }

  /** New entries in the on-device event log -> local_event_logged trigger. */
  async _checkLogs() {
    let events;
    try {
      events = await this.api.getEventLog(5);
    } catch (err) {
      return; // logs are a bonus — don't degrade availability over them
    }
    if (!events || !events.length) return;
    const signature = ev => `${ev.code}|${ev.timestamp}`;
    const lastSeen = this.getStoreValue('last_event_signature');
    if (lastSeen == null) {
      // First check only baselines — don't replay history
      await this.setStoreValue('last_event_signature', signature(events[0])).catch(this.error);
      return;
    }
    if (signature(events[0]) === lastSeen) return;
    // Entries are newest-first; fire every entry that appeared since the
    // stored one (oldest first, so flows see them in order). If the stored
    // entry rolled off the log entirely, everything fetched is new.
    const seenIndex = events.findIndex(ev => signature(ev) === lastSeen);
    const fresh = seenIndex === -1 ? events.slice() : events.slice(0, seenIndex);
    for (const ev of fresh.reverse()) {
      /** @type {any} */ (this.driver).triggers.local_event_logged.trigger(this, {
        code: String(ev.code || ''),
        description: String(ev.description || ''),
      }).catch(this.error);
    }
    await this.setStoreValue('last_event_signature', signature(events[0])).catch(this.error);
  }

  async _checkSchedule() {
    try {
      const sched = await this.api.getExerciseSchedule();
      const text = sched.frequency === 'never'
        ? 'Never'
        : `${sched.frequency} on ${sched.day} at ${sched.hour}:${String(sched.minute).padStart(2, '0')}`;
      await this._updateInfoSettings({ exercise_schedule: text });
    } catch (err) {
      // best-effort
    }
  }

  /**
   * "Now" as a wall-clock Date in Homey's configured timezone, constructed
   * in the process's own frame. The generator's clock is parsed the same way
   * (a naive wall-clock string -> process-frame Date), so BOTH sides live in
   * the same frame and drift comparison is meaningful even though the app
   * process itself may run in UTC.
   */
  _homeyLocalNow() {
    const tz = this.homey.clock.getTimezone();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const get = type => parseInt(parts.find(p => p.type === type).value, 10);
    return new Date(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  }

  async _maybeSyncClock(s) {
    if (this.getSetting('auto_sync_clock') !== true || !s.generatorTime) return;
    const thresholdMin = Math.max(1, Number(this.getSetting('clock_drift_min')) || 5);
    const driftMin = Math.abs(this._homeyLocalNow().getTime() - s.generatorTime.getTime()) / 60000;
    if (driftMin >= thresholdMin) {
      this.log(`Generator clock drift ${driftMin.toFixed(1)} min — syncing`);
      await this.syncClock().catch(this.error);
    }
  }

  async syncClock() {
    // The generator keeps local wall-clock time; write Homey's local time
    await this.api.syncClock(this._homeyLocalNow());
  }

  async _transition(capability, value, handlers = {}) {
    const { onTrue, onFalse } = handlers;
    if (value == null) return;
    const prev = this.getCapabilityValue(capability);
    await this._setCapability(capability, value);
    if (prev == null || prev === value) return;
    if (value === true && onTrue) await Promise.resolve(onTrue()).catch(this.error);
    if (value === false && onFalse) await Promise.resolve(onFalse()).catch(this.error);
  }

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

  async onSettings({ newSettings, changedKeys }) {
    if (['host', 'username', 'password'].some(k => changedKeys.includes(k))) {
      this.homey.setTimeout(() => {
        this.api = new CumminsLocalApi(newSettings.host, newSettings.username, newSettings.password);
        // Correcting the address or password is the user telling us the old
        // failures are fixed — clear the backoff and force the retry, or
        // they'd watch it stay "unreachable" for minutes with no attempts.
        this._failCount = 0;
        this._backoffUntil = 0;
        this.poll(true).catch(this.error);
      }, 500);
    }
    if (changedKeys.includes('poll_interval_s')) {
      this._startPolling(newSettings.poll_interval_s);
    }
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }

  async onUninit() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }

}

module.exports = GeneratorLocalDevice;
