'use strict';

/**
 * Estimates a generator's power output and cumulative energy production.
 *
 * Neither the cloud API nor the local web interface reports watts — both
 * report a load PERCENTAGE. Multiplied by the nameplate rating the user
 * enters in device settings (`rated_kw`), that gives a usable power figure,
 * and integrating it over time gives energy produced.
 *
 * These are ESTIMATES: load% is itself rounded upstream, and a generator's
 * real output also depends on power factor. They're good enough to answer
 * "roughly how hard is it working" and "roughly how much did this outage
 * cost me in fuel", which is what the HA integrations' users wanted, but
 * they are deliberately exposed as custom capabilities rather than Homey's
 * standard `measure_power`/`meter_power` so Homey's Energy dashboard never
 * mistakes generated power for household consumption.
 */

/**
 * Floor for the "how long a gap still counts" limit (see `_maxGapMs`).
 * Never integrate across a gap shorter than this even if polling is very
 * fast — a couple of missed polls shouldn't punch a hole in the total.
 */
const MIN_INTEGRATION_GAP_MS = 15 * 60 * 1000;

/**
 * Gaps larger than this many poll intervals are treated as "we don't know
 * what happened" rather than "the last load persisted". Three consecutive
 * missed polls is a real outage of information, not jitter.
 */
const GAP_POLL_INTERVALS = 3;

class EnergyEstimator {

  /**
   * @param {import('homey').Device} device the Homey Device (store + settings)
   * @param {() => number} [pollIntervalMs] the device's current poll
   *   interval; the integration gap limit scales with it, so a slow poll
   *   interval doesn't silently stop energy from accumulating at all.
   */
  constructor(device, pollIntervalMs = null) {
    this.device = device;
    this._pollIntervalMs = pollIntervalMs;
    this._lastWatts = null;
    this._lastTs = null;
  }

  _maxGapMs() {
    const interval = this._pollIntervalMs ? Number(this._pollIntervalMs()) : 0;
    if (!interval || Number.isNaN(interval)) return MIN_INTEGRATION_GAP_MS;
    return Math.max(MIN_INTEGRATION_GAP_MS, interval * GAP_POLL_INTERVALS);
  }

  /**
   * Recompute output/energy from the current load and push them onto the
   * device's capabilities. No-ops when the user hasn't set a rating.
   *
   * @param {number|null} loadPercent 0-100, or null when unknown
   * @param {boolean} running false forces output to 0 regardless of load
   * @param {(capability: string, value: number) => Promise<void>} setCapability
   */
  async update(loadPercent, running, setCapability) {
    const ratedKw = Number(this.device.getSetting('rated_kw')) || 0;
    if (ratedKw <= 0) return;

    const percent = running === false ? 0 : loadPercent;
    if (typeof percent !== 'number' || Number.isNaN(percent)) return;

    const watts = Math.round((ratedKw * 1000 * percent) / 100);
    const now = Date.now();

    if (this._lastWatts != null && this._lastTs != null) {
      const gapMs = now - this._lastTs;
      if (gapMs > 0 && gapMs <= this._maxGapMs()) {
        // Trapezoidal integration between the two samples
        const averageWatts = (this._lastWatts + watts) / 2;
        const kWh = (averageWatts / 1000) * (gapMs / 3600000);
        if (kWh > 0) {
          const total = (Number(this.device.getStoreValue('energy_kwh')) || 0) + kWh;
          await this.device.setStoreValue('energy_kwh', total).catch(this.device.error);
          await setCapability('meter_generator_energy', Math.round(total * 100) / 100);
        }
      }
    } else {
      // First sample after a restart: publish the stored total so the
      // capability isn't blank until the generator next runs.
      const stored = Number(this.device.getStoreValue('energy_kwh')) || 0;
      await setCapability('meter_generator_energy', Math.round(stored * 100) / 100);
    }

    this._lastWatts = watts;
    this._lastTs = now;
    await setCapability('measure_generator_output', watts);
  }

}

module.exports = { EnergyEstimator, MIN_INTEGRATION_GAP_MS, GAP_POLL_INTERVALS };
