'use strict';

/**
 * Cummins Connect Cloud mobile API client.
 *
 * Node.js port of tebrown/cummins_hacs `api.py` (see docs/HA-INTEGRATIONS.md
 * for the reverse-engineering write-up). Refresh-token driven: the only
 * long-lived secret is the Cognito refresh token; access + id tokens are
 * renewed on demand and kept in memory.
 *
 * The API requires BOTH tokens on every call:
 *   Authorization: Bearer <access_token>
 *   mobile-data: <id_token>
 * Omitting `mobile-data` yields a 401 ("Cannot read property 'sub' of null").
 *
 * Uses only Node built-ins (https) so it runs unmodified on every Homey Pro.
 */

const { httpRequest } = require('./http');

const COGNITO_DOMAIN = 'https://da-pcc-auth-production.auth.us-east-1.amazoncognito.com';
const TOKEN_URL = `${COGNITO_DOMAIN}/oauth2/token`;
const CLIENT_ID = '28oqvfr332v3mp11u1tikqm565'; // public PKCE client, no secret
const API_BASE = 'https://cc.aws.powercommandcloud.com/api/dashboard/v1/mobile';
const USER_AGENT = 'ConnectCloud_Maui/80 CFNetwork/3860.600.12 Darwin/25.5.0';

class CumminsAuthError extends Error {}
class CumminsApiError extends Error {}

class CumminsApi {

  /**
   * @param {string} refreshToken
   * @param {{ onTokenRotated?: (newToken: string) => void }} [opts]
   *   `onTokenRotated` is called when Cognito rotates the refresh token, so
   *   the caller can persist the new one.
   */
  constructor(refreshToken, opts = {}) {
    this.refreshToken = refreshToken;
    this.onTokenRotated = opts.onTokenRotated || null;
    this.accessToken = null;
    this.idToken = null; // sent as the 'mobile-data' header
    this.accessExpiry = 0;
    this._refreshing = null; // in-flight refresh promise, to dedupe
  }

  async _refreshAccessToken() {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: this.refreshToken,
    }).toString();

    const res = await httpRequest(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        'user-agent': USER_AGENT,
      },
      body,
    });
    if (res.status !== 200) {
      // 400 invalid_grant = refresh token expired/revoked -> user must re-pair
      throw new CumminsAuthError(`Token refresh failed (${res.status}): ${res.body.slice(0, 300)}`);
    }
    const tok = JSON.parse(res.body);
    this.accessToken = tok.access_token;
    if (tok.id_token) this.idToken = tok.id_token;
    if (tok.refresh_token && tok.refresh_token !== this.refreshToken) {
      this.refreshToken = tok.refresh_token;
      if (this.onTokenRotated) this.onTokenRotated(tok.refresh_token);
    }
    // renew 60s early to avoid edge-of-expiry 401s
    this.accessExpiry = Date.now() + ((tok.expires_in || 3600) - 60) * 1000;
  }

  async _validAccessToken() {
    if (!this.accessToken || Date.now() >= this.accessExpiry) {
      // Dedupe concurrent refreshes (poll + flow action can race)
      if (!this._refreshing) {
        this._refreshing = this._refreshAccessToken().finally(() => {
          this._refreshing = null;
        });
      }
      await this._refreshing;
    }
    return this.accessToken;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ params?: Record<string, string>, json?: any }} [options]
   */
  async _request(method, path, options = {}) {
    const { params, json } = options;
    let url = `${API_BASE}${path}`;
    if (params) url += `?${new URLSearchParams(params).toString()}`;

    let lastStatus = null;
    for (let attempt = 1; attempt <= 2; attempt++) { // one retry on 401
      const token = await this._validAccessToken();
      const headers = {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': USER_AGENT,
        authorization: `Bearer ${token}`,
        'mobile-data': this.idToken || '',
      };
      let body;
      if (json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(json);
      }
      const res = await httpRequest(url, { method, headers, body });
      if (res.status === 401 && attempt === 1) {
        this.accessToken = null; // force a fresh token, then retry once
        continue;
      }
      lastStatus = res.status;
      if (res.status >= 400) {
        throw new CumminsApiError(`${path} failed (${res.status}): ${res.body.slice(0, 300)}`);
      }
      return res.body ? JSON.parse(res.body) : null;
    }
    throw new CumminsApiError(`${path} failed (${lastStatus}) after retry`);
  }

  /**
   * @param {string} path
   * @param {Record<string, string>} [params]
   */
  _get(path, params) {
    return this._request('GET', path, { params });
  }

  /**
   * Issue a raw request and report the status/body instead of throwing.
   *
   * Used only by the command-endpoint probe (see `probeCommandEndpoints`),
   * where a 404 vs 400 distinction IS the answer we're after and an
   * exception would throw that information away.
   *
   * @param {string} method
   * @param {string} path
   * @param {{ params?: Record<string, string>, json?: any }} [options]
   * @returns {Promise<{status: number, body: string}>}
   */
  async rawRequest(method, path, options = {}) {
    const { params, json } = options;
    let url = `${API_BASE}${path}`;
    if (params) url += `?${new URLSearchParams(params).toString()}`;
    const token = await this._validAccessToken();
    const headers = {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${token}`,
      'mobile-data': this.idToken || '',
    };
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    try {
      const res = await httpRequest(url, { method, headers, body });
      return { status: res.status, body: (res.body || '').slice(0, 400) };
    } catch (err) {
      return { status: 0, body: `request failed: ${err.message}` };
    }
  }

  /** Cheap round trip to confirm the refresh token actually works. */
  async validate() {
    await this._refreshAccessToken();
    await this.profile();
  }

  profile() {
    return this._get('/Profile');
  }

  /** Your sites, each with its assets (generators). */
  sites() {
    return this._get('/Sites/Personal');
  }

  siteAssets(siteId) {
    return this._get('/Sites/GetAssets', { id: siteId });
  }

  /** Live telemetry snapshot for one generator. */
  assetDetail(assetId) {
    return this._get('/Assets/Detail', { id: assetId });
  }

  /** Event/fault history. `fromEpochMs` optional. */
  assetEvents(assetId, fromEpochMs) {
    const params = { id: assetId };
    if (fromEpochMs != null) params.from = String(fromEpochMs);
    return this._get('/Assets/Events', params);
  }

  /** Available commands + IsEnabled flags. */
  assetCommands(assetId) {
    return this._get('/Assets/Commands', { id: assetId });
  }

  /**
   * EXPERIMENTAL — send a command (StartGenset / StopGenset).
   *
   * The exact mobile POST shape was never captured upstream (tebrown's
   * DESIGN.md §3); the web app POSTs to /assets/{id}/command/<name>. We mirror
   * that shape here. Only reachable behind the app's opt-in "experimental
   * remote commands" setting, and callers must check /Assets/Commands
   * IsEnabled + isRemoteEnabled first.
   */
  async sendCommand(assetId, commandName) {
    return this._request('POST', `/Assets/${encodeURIComponent(assetId)}/command/${encodeURIComponent(commandName)}`, { json: {} });
  }

  /**
   * Work out where the mobile API actually accepts commands.
   *
   * The command POST shape has never been publicly captured. The path this
   * app first guessed — taken from a note about the *web* app — returns 404,
   * so this probes the plausible alternatives.
   *
   * SAFETY: every probe uses a deliberately bogus command name, so no probe
   * can ever start or stop a real engine. That also makes the result
   * readable: 404 means "no such endpoint", while 400/422/500 means "the
   * endpoint exists and rejected the command name" — i.e. the path we want.
   *
   * @param {string} assetId
   */
  async probeCommandEndpoints(assetId) {
    const BOGUS = 'ZzProbeNotARealCommand';
    const id = encodeURIComponent(assetId);

    /** @type {Array<{label: string, method: string, path: string, options?: any}>} */
    const candidates = [
      { label: 'POST /Assets/{id}/command/{name}  (current guess)', method: 'POST', path: `/Assets/${id}/command/${BOGUS}`, options: { json: {} } },
      { label: 'POST /assets/{id}/command/{name}  (lowercase)', method: 'POST', path: `/assets/${id}/command/${BOGUS}`, options: { json: {} } },
      { label: 'POST /Assets/Command  {Id, Command}', method: 'POST', path: '/Assets/Command', options: { json: { Id: assetId, Command: BOGUS } } },
      { label: 'POST /Assets/Commands {Id, Command}', method: 'POST', path: '/Assets/Commands', options: { json: { Id: assetId, Command: BOGUS } } },
      { label: 'POST /Assets/Command?id=&command=', method: 'POST', path: '/Assets/Command', options: { params: { id: assetId, command: BOGUS }, json: {} } },
      { label: 'POST /Assets/SendCommand {AssetId, CommandName}', method: 'POST', path: '/Assets/SendCommand', options: { json: { AssetId: assetId, CommandName: BOGUS } } },
      { label: 'POST /Assets/ExecuteCommand {AssetId, Command}', method: 'POST', path: '/Assets/ExecuteCommand', options: { json: { AssetId: assetId, Command: BOGUS } } },
      { label: 'PUT  /Assets/Command  {Id, Command}', method: 'PUT', path: '/Assets/Command', options: { json: { Id: assetId, Command: BOGUS } } },
    ];

    const probes = [];
    for (const c of candidates) {
      const result = await this.rawRequest(c.method, c.path, c.options);
      probes.push({
        label: c.label,
        status: result.status,
        body: result.body,
        // 404 = wrong path. Anything else means the server engaged with it.
        promising: result.status !== 404 && result.status !== 0,
      });
    }

    let commands = null;
    try {
      commands = await this.assetCommands(assetId);
    } catch (err) {
      commands = { error: err.message };
    }
    return { commands, probes };
  }

  /** Flatten Sites/Personal into [{ id, name, siteName }]. */
  async listAssets() {
    const assets = [];
    const entries = await this.sites();
    for (const entry of entries || []) {
      for (const site of entry.Sites || []) {
        const siteName = site.Name || site.SiteName || 'Cummins Site';
        for (const asset of site.Assets || []) {
          assets.push({
            id: asset.Id,
            name: asset.Name || asset.AssetName || 'Generator',
            siteName,
          });
        }
      }
    }
    return assets;
  }

  /** Turn Assets/Detail's LastTelemetry.Properties into { name: value }. */
  static telemetry(detail) {
    const out = {};
    const props = (detail && detail.LastTelemetry && detail.LastTelemetry.Properties) || [];
    for (const prop of props) {
      const { Name: name, Value: raw } = prop;
      if (name == null) continue;
      const num = Number(raw);
      out[name] = (raw !== null && raw !== '' && !Number.isNaN(num)) ? num : raw;
    }
    if (detail && detail.LastCheckIn) out.LastCheckIn = detail.LastCheckIn;
    return out;
  }

}

module.exports = { CumminsApi, CumminsAuthError, CumminsApiError, CLIENT_ID, TOKEN_URL, COGNITO_DOMAIN, USER_AGENT };
