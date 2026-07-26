'use strict';

/**
 * Offline smoke tests for lib/ — run with `node test/smoke.js`.
 * Spins up a throwaway local HTTP server to exercise the session/cookie/
 * redirect machinery and the local-generator protocol parser.
 */

const http = require('http');
const zlib = require('zlib');
const assert = require('assert');
const { Session, CookieJar, httpRequest } = require('../lib/http');
const { CumminsApi } = require('../lib/CumminsApi');
const { CumminsLocalApi } = require('../lib/CumminsLocalApi');
const { EnergyEstimator } = require('../lib/EnergyEstimator');

const INDEX_DATA_FIXTURE = [
  '3', '8', '138', '4', '12', '7', '241', '60', '1656',
  'January', '14', '2026', '13', '0', '58',
  'Genset exercise completed', 'No faults', 'Auto',
].join('\n');

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(null)));
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  try {
    await fn(`127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function testCookieJar() {
  const jar = new CookieJar();
  jar.store('https://a.example.com/login', ['sid=abc; Path=/; Domain=example.com', 'x=1']);
  assert.strictEqual(jar.headerFor('https://b.example.com/page'), 'sid=abc');
  assert.strictEqual(jar.headerFor('https://a.example.com/page'), 'sid=abc; x=1');
  assert.strictEqual(jar.headerFor('https://other.com/'), null);
  console.log('ok cookie jar');
}

async function testSessionRedirects() {
  await withServer((req, res) => {
    if (req.url === '/start') {
      res.setHeader('set-cookie', 'hop=1; Path=/');
      res.writeHead(302, { location: '/middle' });
      res.end();
    } else if (req.url === '/middle') {
      assert.ok((req.headers.cookie || '').includes('hop=1'), 'cookie must survive redirect');
      res.writeHead(302, { location: 'connectcloud://authentication/callback?code=XYZ' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  }, async host => {
    const session = new Session();
    const res = await session.get(`http://${host}/start`);
    // Custom-scheme redirect must be handed back, not followed
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.startsWith('connectcloud://'));

    const noFollow = await session.get(`http://${host}/start`, { followRedirects: false });
    assert.strictEqual(noFollow.status, 302);
    assert.strictEqual(noFollow.headers.location, '/middle');
  });
  console.log('ok session redirects + custom scheme');
}

async function testTelemetryFlattening() {
  const t = CumminsApi.telemetry({
    LastTelemetry: {
      Properties: [
        { Name: 'batteryVoltage', Value: '13.8' },
        { Name: 'isRunning', Value: '0' },
        { Name: 'SoftwareVersion', Value: '3.2.1' },
        { Name: 'gensetPercentLoad', Value: '42' },
      ],
    },
    LastCheckIn: '2026-07-26T01:00:00Z',
  });
  assert.strictEqual(t.batteryVoltage, 13.8);
  assert.strictEqual(t.isRunning, 0);
  assert.strictEqual(t.SoftwareVersion, '3.2.1');
  assert.strictEqual(t.gensetPercentLoad, 42);
  assert.strictEqual(t.LastCheckIn, '2026-07-26T01:00:00Z');
  console.log('ok cloud telemetry flattening');
}

async function testLocalStatusParsing() {
  await withServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Basic ${Buffer.from('admin:cummins').toString('base64')}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url.startsWith('/index_data.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(INDEX_DATA_FIXTURE);
    } else if (req.url.startsWith('/wr_logical.cgi')) {
      res.writeHead(200);
      res.end('OK');
    } else if (req.url.startsWith('/events.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><script>var page_data = "58\\nGenset exercise completed\\nJan 20 2026 10:15\\nx\\ny\\n12\\nUtility lost\\nJan 18 2026 08:00\\na\\nb";</script></html>');
    } else if (req.url.startsWith('/exercise.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><script>var match = 1;\nwriteSingleOption(0,match == 0, "Never");\nwriteDays(6);\nhrs24ToHrs12(10);\nvar match = 30;\n</script></html>');
    } else {
      res.writeHead(404);
      res.end();
    }
  }, async host => {
    const api = new CumminsLocalApi(host);
    const s = await api.getStatus();
    assert.strictEqual(s.batteryVoltage, 13.8);
    assert.strictEqual(s.statusCode, 4);
    assert.strictEqual(s.status, 'Running');
    assert.strictEqual(s.load1, 12);
    assert.strictEqual(s.load2, 7);
    assert.strictEqual(s.outputVoltage, 241);
    assert.strictEqual(s.outputFrequency, 60);
    assert.strictEqual(s.engineHours, 27.6);
    assert.strictEqual(s.faultCode, '0');
    assert.strictEqual(s.eventDescription, 'Genset exercise completed');
    assert.strictEqual(s.autoMode, 'Auto');
    // LCD 13 = 0b1101: utility present, not connected, running, standby bit 0
    assert.strictEqual(s.utilityPresent, true);
    assert.strictEqual(s.utilityConnected, false);
    assert.strictEqual(s.running, true);
    assert.strictEqual(s.standbyEnabled, true);
    assert.strictEqual(s.actionRequired, false);
    assert.strictEqual(s.exercising, false);
    assert.ok(s.generatorTime instanceof Date);

    // wrong password should raise the auth error
    const bad = new CumminsLocalApi(host, 'admin', 'wrong');
    await assert.rejects(() => bad.getStatus(), /rejected the username\/password/);

    // command writes go through
    await api.start();
    await api.setStandby(false);
    await api.syncClock(new Date(2026, 6, 26, 8, 30));

    // event log parsing (5 lines per entry: code, description, timestamp, ...)
    const log = await api.getEventLog(10);
    assert.strictEqual(log.length, 2);
    assert.deepStrictEqual(log[0], {
      code: '58', description: 'Genset exercise completed', timestamp: 'Jan 20 2026 10:15',
    });
    assert.strictEqual(log[1].code, '12');

    // exercise schedule parsing
    const sched = await api.getExerciseSchedule();
    assert.strictEqual(sched.frequency, 'weekly');
    assert.strictEqual(sched.day, 'Saturday');
    assert.strictEqual(sched.hour, 10);
    assert.strictEqual(sched.minute, 30);
  });
  console.log('ok local protocol parsing + commands + logs + schedule');
}

/**
 * Minimal stand-in for a Homey Device: just the settings + store + logger
 * surface EnergyEstimator touches.
 * @returns {any}
 */
function fakeDevice(settings) {
  const store = {};
  return {
    getSetting: key => settings[key],
    getStoreValue: key => store[key],
    setStoreValue: async (key, value) => { store[key] = value; },
    error: () => {},
    _store: store,
  };
}

async function testEnergyEstimator() {
  const caps = {};
  const set = async (capability, value) => { caps[capability] = value; };

  // No rating configured -> nothing published at all
  const off = new EnergyEstimator(fakeDevice({ rated_kw: 0 }));
  await off.update(50, true, set);
  assert.deepStrictEqual(caps, {}, 'must stay silent without a kW rating');

  // 20 kW genset polled every 20 minutes -> 60-minute integration window
  const device = fakeDevice({ rated_kw: 20 });
  const est = new EnergyEstimator(device, () => 20 * 60 * 1000);

  // 50% of a 20 kW genset = 10 kW
  await est.update(50, true, set);
  assert.strictEqual(caps.measure_generator_output, 10000);
  assert.strictEqual(caps.meter_generator_energy, 0);

  // Half an hour later at the same load: 10 kW * 0.5 h = 5 kWh.
  // (Reach into the estimator's clock rather than sleeping.)
  est._lastTs -= 30 * 60 * 1000;
  await est.update(50, true, set);
  assert.strictEqual(caps.meter_generator_energy, 5);

  // Not running -> 0 W regardless of the reported load percentage
  await est.update(50, false, set);
  assert.strictEqual(caps.measure_generator_output, 0);

  // A gap longer than the cap must not invent energy
  const before = caps.meter_generator_energy;
  est._lastTs -= 24 * 60 * 60 * 1000;
  est._lastWatts = 10000;
  await est.update(50, true, set);
  assert.strictEqual(caps.meter_generator_energy, before, 'long gaps must not accumulate');

  // A slow poll interval must still accumulate: 90 min apart, 3h window
  const slowCaps = {};
  const slowSet = async (c, v) => { slowCaps[c] = v; };
  const slow = new EnergyEstimator(fakeDevice({ rated_kw: 10 }), () => 60 * 60 * 1000);
  await slow.update(100, true, slowSet);
  slow._lastTs -= 90 * 60 * 1000;
  await slow.update(100, true, slowSet);
  assert.strictEqual(slowCaps.meter_generator_energy, 15, '10 kW for 1.5 h = 15 kWh');

  // A fresh estimator republishes the stored total immediately
  const caps2 = {};
  const resumed = new EnergyEstimator(device, () => 20 * 60 * 1000);
  await resumed.update(0, false, async (c, v) => { caps2[c] = v; });
  assert.strictEqual(caps2.meter_generator_energy, before);
  console.log('ok energy estimation + integration guards');
}

/**
 * Regression: a truncated COMPRESSED response must reject, not hang.
 * Source-stream errors do not propagate through .pipe(), so without an
 * explicit handler on the response this promise never settled — which left
 * `_pollBusy` stuck true and permanently froze the device's polling.
 */
async function testTruncatedCompressedResponse() {
  for (const gzip of [false, true]) {
    await withServer((req, res) => {
      const payload = Buffer.from('y'.repeat(20000));
      const body = gzip ? zlib.gzipSync(payload) : payload;
      const headers = { 'content-length': String(body.length) };
      if (gzip) headers['content-encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => res.socket.destroy(), 30);
    }, async host => {
      const outcome = await Promise.race([
        httpRequest(`http://${host}/`, { timeout: 1500 }).then(() => 'resolved', () => 'rejected'),
        new Promise(resolve => setTimeout(() => resolve('hung'), 3000)),
      ]);
      assert.strictEqual(outcome, 'rejected', `${gzip ? 'gzip' : 'identity'} truncation must reject`);
    });
  }
  console.log('ok truncated responses reject (no hang)');
}

(async () => {
  await testCookieJar();
  await testSessionRedirects();
  await testTruncatedCompressedResponse();
  await testTelemetryFlattening();
  await testLocalStatusParsing();
  await testEnergyEstimator();
  console.log('\nAll smoke tests passed');
})().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
