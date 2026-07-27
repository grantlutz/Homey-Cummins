'use strict';

/**
 * Client for the local web interface on older Cummins RS-series generators
 * (the Ethernet web-interface card, HTTP basic auth, default admin/cummins).
 *
 * Reimplements the protocol decoded by mdedonato/cummins_generator and
 * mswilson/cummins-hass-integration (see docs/HA-INTEGRATIONS.md §3–4).
 * No upstream source is reproduced — these are facts about the generator's
 * own interface. Attribution in THIRD-PARTY-NOTICES.md.
 * Unlike the cloud API, the CONTROL protocol here is confirmed working
 * upstream: start/stop/exercise, standby enable/disable, exercise schedule
 * and clock writes all go through wr_logical.cgi.
 */

const { httpRequest } = require('./http');

const STATUS_CODES = {
  0: 'Stopped',
  1: 'Stopped',
  2: 'Starting',
  3: 'Starting',
  4: 'Running',
  5: 'Priming',
  6: 'Fault', // fault number appended by statusString()
  7: 'Engine Only',
  8: 'Test Mode',
  9: 'Voltage Adjust',
  20: 'Config Mode',
  21: 'Cycle Crank Pause',
  22: 'Exercising',
  23: 'Engine Cooldown',
};

// LCD status bit masks (index_data.html field 12)
const LCD_UTILITY_PRESENT = 0x01;
const LCD_UTILITY_CONNECTED = 0x02;
const LCD_RUNNING = 0x0C;
const LCD_STANDBY = 0x10; // inverted: standby enabled when bit is 0
const LCD_ACTION_REQUIRED = 0x60;

// wr_logical.cgi parameters (confirmed upstream)
const PARAMS = {
  ENGINE_STOP: '@242=1',
  ENGINE_START: '@242=2',
  ENGINE_EXERCISE: '@242=3',
  STANDBY_DISABLE: '@385=0',
  STANDBY_ENABLE: '@385=1',
};

const EXERCISE_FREQUENCIES = ['never', 'weekly', 'bimonthly', 'monthly']; // @425=0..3

class CumminsLocalError extends Error {}
class CumminsLocalAuthError extends CumminsLocalError {}

class CumminsLocalApi {

  /**
   * @param {string} host IP or hostname of the generator
   * @param {string} username basic-auth user (default admin)
   * @param {string} password basic-auth password (default cummins)
   */
  constructor(host, username = 'admin', password = 'cummins', { timeout = 10000 } = {}) {
    this.host = host;
    this.timeout = timeout;
    this.authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  /**
   * @param {string} page path (may include a query string)
   * @param {{ method?: string, body?: string }} [options]
   * @returns {Promise<string>} the response body
   */
  async _fetch(page, options = {}) {
    const { method = 'GET', body } = options;
    const headers = { authorization: this.authHeader };
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    let res;
    try {
      res = await httpRequest(`http://${this.host}/${page}`, {
        method, headers, body, timeout: this.timeout,
      });
    } catch (err) {
      throw new CumminsLocalError(`Could not reach generator at ${this.host}: ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new CumminsLocalAuthError(`Generator rejected the username/password (${res.status})`);
    }
    if (res.status >= 400) {
      throw new CumminsLocalError(`${page} failed (${res.status})`);
    }
    return res.body;
  }

  /**
   * Fetch and parse index_data.html.
   *
   * Field order (confirmed by both upstream projects): hour, minute,
   * battery×10, status code, load1 %, load2 %, output V, freq Hz,
   * engine minutes, month name, day, year, LCD bits, fault code, event code,
   * event description, fault description, auto mode.
   */
  async getStatus() {
    const raw = await this._fetch('index_data.html');
    // Line-based parse (descriptions may contain spaces); fall back to
    // whitespace-split when the page arrives as a single line.
    let fields = raw
      .split(/\r?\n/)
      .map(line => line.replace(/<[^>]*>/g, '').trim())
      .filter(Boolean);
    if (fields.length < 18) {
      fields = raw.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean);
    }
    if (fields.length < 18) {
      throw new CumminsLocalError(`Unexpected index_data.html shape (${fields.length} fields, expected >= 18)`);
    }

    const lcd = parseInt(fields[12], 10) || 0;
    const statusCode = parseInt(fields[3], 10);
    const running = Boolean(lcd & LCD_RUNNING);
    const utilityConnected = Boolean(lcd & LCD_UTILITY_CONNECTED);

    return {
      generatorTime: this._parseClock(fields),
      batteryVoltage: parseFloat(fields[2]) / 10,
      statusCode,
      status: CumminsLocalApi.statusString(statusCode, fields[13]),
      load1: parseInt(fields[4], 10),
      load2: parseInt(fields[5], 10),
      outputVoltage: parseInt(fields[6], 10),
      outputFrequency: parseFloat(fields[7]),
      engineHours: Math.round((parseFloat(fields[8]) / 60) * 10) / 10,
      faultCode: fields[13],
      eventCode: fields[14],
      eventDescription: fields[15],
      faultDescription: fields[16],
      autoMode: fields[17],
      lcd,
      utilityPresent: Boolean(lcd & LCD_UTILITY_PRESENT),
      utilityConnected,
      running,
      standbyEnabled: !(lcd & LCD_STANDBY),
      actionRequired: Boolean(lcd & LCD_ACTION_REQUIRED),
      // Running while still connected to utility = scheduled self-test
      exercising: (running && utilityConnected) || statusCode === 22,
      hasFault: statusCode === 6,
    };
  }

  _parseClock(fields) {
    // "January 14, 2026 01:18" — a naive wall-clock Date in the process's
    // frame (callers compare it against Homey's wall clock built the same
    // way, so the shared frame cancels out). Hour/minute arrive unpadded;
    // pad for maximum Date-parser compatibility.
    const hh = String(fields[0]).padStart(2, '0');
    const mm = String(fields[1]).padStart(2, '0');
    const dt = new Date(`${fields[9]} ${fields[10]}, ${fields[11]} ${hh}:${mm}`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  /**
   * @param {number} code index_data.html field 3
   * @param {string} [faultCode] appended when the code is the fault state
   */
  static statusString(code, faultCode) {
    const label = STATUS_CODES[code];
    if (label === undefined) return `Unknown status (${code})`;
    if (code === 6) return `${label} ${faultCode}`.trim();
    return label;
  }

  /** Send a wr_logical.cgi command (GET with query param, as upstream). */
  async _command(param) {
    await this._fetch(`wr_logical.cgi?${param}`);
  }

  start() {
    return this._command(PARAMS.ENGINE_START);
  }

  stop() {
    return this._command(PARAMS.ENGINE_STOP);
  }

  exerciseNow() {
    return this._command(PARAMS.ENGINE_EXERCISE);
  }

  setStandby(enabled) {
    return this._command(enabled ? PARAMS.STANDBY_ENABLE : PARAMS.STANDBY_DISABLE);
  }

  /**
   * Write the exercise schedule.
   * @param {string} frequency never|weekly|bimonthly|monthly
   * @param {number} day 0 (Sunday) .. 6 (Saturday)
   * @param {number} hour 0..23
   * @param {number} minute 0|15|30|45
   */
  async setExerciseSchedule(frequency, day, hour, minute) {
    const freqIndex = EXERCISE_FREQUENCIES.indexOf(frequency);
    if (freqIndex < 0) throw new CumminsLocalError(`Bad exercise frequency: ${frequency}`);
    await this._command(`@425=${freqIndex}`);
    if (freqIndex > 0) {
      await this._command(`@391=${day}`);
      await this._command(`@392=${hour}`);
      await this._command(`@393=${minute}`);
    }
  }

  /** Sync the generator clock to the given Date (local time fields). */
  async syncClock(now = new Date()) {
    const body = new URLSearchParams({
      '@448': String(now.getMonth() + 1),
      '@449': String(now.getDate()),
      '@450': String(now.getFullYear()),
      '@402': String(now.getHours()),
      '@403': String(now.getMinutes()),
    }).toString();
    await this._fetch('wr_logical.cgi', { method: 'POST', body });
  }

  /**
   * Parse events.html / faults.html: entries live in `var page_data = "..."`,
   * 5 lines per entry (code, description, timestamp, ...).
   */
  async _getLog(page, limit = 10) {
    const html = await this._fetch(page);
    const m = html.match(/var\s+page_data\s*=\s*["']([^"']+)["']/s);
    if (!m) return [];
    const lines = m[1].split('\\n').map(l => l.trim()).filter(Boolean);
    const entries = [];
    for (let i = 0; i + 2 < lines.length && entries.length < limit; i += 5) {
      entries.push({ code: lines[i], description: lines[i + 1], timestamp: lines[i + 2] });
    }
    return entries;
  }

  getEventLog(limit) {
    return this._getLog('events.html', limit);
  }

  getFaultLog(limit) {
    return this._getLog('faults.html', limit);
  }

  /**
   * Scan the local /24 for RS-series generators.
   *
   * These units predate mDNS/SSDP — the web-interface card advertises
   * nothing, so Homey's ManagerDiscovery has nothing to subscribe to. What
   * it does have is a completely distinctive fingerprint: `index_data.html`
   * returns ≥18 whitespace-separated fields whose 4th is a known status code
   * and whose 13th is an integer bit field. Probing for that is the only
   * automatic discovery available for this hardware, and it beats asking a
   * user to find an IP address by hand.
   *
   * @param {string} localAddress Homey's own LAN address ("192.168.1.10" or
   *   "192.168.1.10:80")
   * @param {string} username
   * @param {string} password
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<Array<{host: string, status: object}>>}
   */
  static async discover(localAddress, username = 'admin', password = 'cummins', onProgress) {
    const ip = String(localAddress).split(':')[0];
    const parts = ip.split('.');
    if (parts.length !== 4) throw new CumminsLocalError(`Could not read Homey's network address (${localAddress})`);
    const prefix = parts.slice(0, 3).join('.');

    const hosts = [];
    for (let i = 1; i <= 254; i++) {
      if (String(i) !== parts[3]) hosts.push(`${prefix}.${i}`);
    }

    const found = [];
    let done = 0;
    const CONCURRENCY = 24;
    let cursor = 0;

    const worker = async () => {
      while (cursor < hosts.length) {
        const host = hosts[cursor++];
        // Short timeout: a generator on the LAN answers in milliseconds, and
        // 253 dead addresses must not take minutes to rule out.
        const api = new CumminsLocalApi(host, username, password, { timeout: 1500 });
        try {
          const status = await api.getStatus();
          found.push({ host, status });
        } catch (err) {
          // Not a generator, unreachable, or wrong credentials — all
          // uninteresting here. A CumminsLocalAuthError does mean something
          // answered on port 80 with basic auth, but without valid
          // credentials we can't confirm it's a generator, so skip it.
        }
        done += 1;
        if (onProgress) onProgress(done, hosts.length);
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    return found.sort((a, b) => {
      const an = Number(a.host.split('.')[3]);
      const bn = Number(b.host.split('.')[3]);
      return an - bn;
    });
  }

  /** Read the exercise schedule out of exercise.html's inline JS. */
  async getExerciseSchedule() {
    const html = await this._fetch('exercise.html');
    const freqM = html.match(/var match = (\d+);[\s\S]*?writeSingleOption\(0,\s*match == 0,\s*"Never"\)/);
    const dayM = html.match(/writeDays\((\d+)\)/);
    const hourM = html.match(/hrs24ToHrs12\((\d+)\)/);
    const allMatches = [...html.matchAll(/var match = (\d+);/g)];
    const frequency = EXERCISE_FREQUENCIES[freqM ? parseInt(freqM[1], 10) : 0] || 'never';
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      frequency,
      day: days[dayM ? parseInt(dayM[1], 10) : 0] || 'Sunday',
      hour: hourM ? parseInt(hourM[1], 10) : 0,
      minute: allMatches.length ? parseInt(allMatches[allMatches.length - 1][1], 10) : 0,
    };
  }

}

module.exports = {
  CumminsLocalApi, CumminsLocalError, CumminsLocalAuthError, STATUS_CODES, EXERCISE_FREQUENCIES,
};
