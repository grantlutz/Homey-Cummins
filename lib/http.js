'use strict';

/**
 * Minimal HTTP helpers on top of Node's https module — no dependencies, so
 * the app runs unmodified on every Homey Pro model.
 *
 * `httpRequest` does a single request (no redirects). `Session` adds a cookie
 * jar and manual redirect-following, which the Cummins/Salesforce SSO login
 * chain needs (cookies must persist across cross-domain hops, and one hop
 * deliberately must NOT be followed because its Location is a custom
 * connectcloud:// scheme).
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 30000;

/**
 * @typedef {object} HttpOptions
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string|Buffer} [body]
 * @property {number} [timeout]
 */

/**
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {Record<string, any>} headers
 * @property {string} body
 * @property {string} url the URL the response actually came from
 */

/**
 * @param {string} url
 * @param {HttpOptions} [opts]
 * @returns {Promise<HttpResponse>}
 */
function httpRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'http:' ? http : https;
    const headers = { 'accept-encoding': 'gzip, deflate, br', ...(opts.headers || {}) };
    const req = mod.request(url, {
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeout || DEFAULT_TIMEOUT,
    }, res => {
      const chunks = [];
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      /** @type {import('stream').Transform|null} */
      let decompressor = null;
      if (encoding === 'gzip') decompressor = zlib.createGunzip();
      else if (encoding === 'deflate') decompressor = zlib.createInflate();
      else if (encoding === 'br') decompressor = zlib.createBrotliDecompress();

      /** @type {import('stream').Readable} */
      const stream = decompressor ? res.pipe(decompressor) : res;

      // A source error (socket destroyed mid-body) does NOT propagate through
      // .pipe(), so a truncated COMPRESSED response would otherwise settle
      // neither 'end' nor 'error' — leaving this promise pending forever and
      // permanently wedging whatever was polling. Watch the response itself.
      if (decompressor) {
        res.on('error', err => {
          decompressor.destroy();
          reject(err);
        });
        res.on('aborted', () => {
          decompressor.destroy();
          reject(new Error(`Response aborted: ${url}`));
        });
      }

      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        url,
      }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Just enough cookie jar for one short-lived SSO login session. */
class CookieJar {

  constructor() {
    /** @type {Map<string, {name:string, value:string, domain:string, path:string}>} */
    this.cookies = new Map();
  }

  store(url, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const requestHost = new URL(url).hostname;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const raw of list) {
      const parts = raw.split(';').map(p => p.trim());
      const eq = parts[0].indexOf('=');
      if (eq < 1) continue;
      const name = parts[0].slice(0, eq);
      const value = parts[0].slice(eq + 1);
      let domain = requestHost;
      let path = '/';
      for (const attr of parts.slice(1)) {
        const [k, v] = attr.split('=').map(s => (s || '').trim());
        if (/^domain$/i.test(k) && v) domain = v.replace(/^\./, '');
        else if (/^path$/i.test(k) && v) path = v;
      }
      this.cookies.set(`${domain}|${path}|${name}`, { name, value, domain, path });
    }
  }

  headerFor(url) {
    const { hostname, pathname } = new URL(url);
    const pairs = [];
    for (const c of this.cookies.values()) {
      const domainMatch = hostname === c.domain || hostname.endsWith(`.${c.domain}`);
      const pathMatch = pathname.startsWith(c.path);
      if (domainMatch && pathMatch) pairs.push(`${c.name}=${c.value}`);
    }
    return pairs.length ? pairs.join('; ') : null;
  }

}

/** HTTP session with cookies + redirect following (python-requests-ish). */
class Session {

  /** @param {Record<string, string>} [defaultHeaders] sent on every request */
  constructor(defaultHeaders = {}) {
    this.jar = new CookieJar();
    this.defaultHeaders = defaultHeaders;
  }

  /**
   * @param {string} url
   * @param {HttpOptions & { followRedirects?: boolean, maxRedirects?: number }} [opts]
   * @returns {Promise<HttpResponse>}
   */
  async request(url, opts = {}) {
    const { followRedirects = true, maxRedirects = 15, ...reqOpts } = opts;
    let currentUrl = url;
    let method = reqOpts.method || 'GET';
    let body = reqOpts.body;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      /** @type {Record<string, string>} */
      const headers = { ...this.defaultHeaders, ...(reqOpts.headers || {}) };
      const cookie = this.jar.headerFor(currentUrl);
      if (cookie) headers.cookie = cookie;

      const res = await httpRequest(currentUrl, { ...reqOpts, method, headers, body });
      this.jar.store(currentUrl, res.headers['set-cookie']);

      const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && res.headers.location;
      if (!isRedirect || !followRedirects) {
        res.url = currentUrl;
        return res;
      }
      const location = res.headers.location;
      // Custom-scheme redirect (connectcloud://...) — cannot be followed;
      // hand it back to the caller, who wants exactly this.
      if (!/^https?:/i.test(location) && !location.startsWith('/')) {
        res.url = currentUrl;
        return res;
      }
      currentUrl = new URL(location, currentUrl).toString();
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        body = undefined;
      }
    }
    throw new Error(`Too many redirects starting from ${url}`);
  }

  /**
   * @param {string} url
   * @param {HttpOptions & { followRedirects?: boolean, maxRedirects?: number }} [opts]
   */
  get(url, opts = {}) {
    return this.request(url, { ...opts, method: 'GET' });
  }

  /**
   * @param {string} url
   * @param {HttpOptions & { followRedirects?: boolean, maxRedirects?: number }} [opts]
   */
  post(url, opts = {}) {
    return this.request(url, { ...opts, method: 'POST' });
  }

}

module.exports = { httpRequest, Session, CookieJar };
