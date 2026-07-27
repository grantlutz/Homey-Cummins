'use strict';

/**
 * Pure-HTTP Salesforce/Cognito login for Cummins Connect Cloud.
 *
 * Node.js port of tebrown/cummins_hacs `aura_auth.py`.
 *
 * Derived from work Copyright (c) 2026 Travis Brown, MIT licensed — full
 * notice in THIRD-PARTY-NOTICES.md.
 *
 * Replicates the SSO dance without a browser:
 * Cognito hosted UI -> SAML federation into Cummins'
 * Salesforce site (mylogin.cummins.com) -> the custom Apex login bridge
 * (IAM_VisualforceToLightning.getDoLogin, spoken over the Aura protocol) ->
 * SAML response back to Cognito -> connectcloud:// callback carrying an
 * authorization code -> PKCE token exchange. Every hop is a static,
 * regex-parseable HTTP exchange — no JavaScript execution anywhere.
 *
 * TLS fingerprinting — CONFIRMED NOT BLOCKING (2026-07-27): Salesforce's edge
 * (server: sfdcedge) fingerprints the TLS ClientHello (JA3/JA4) and serves
 * Python `requests` a generic template with no Aura bootstrap, which is why
 * the upstream Python needs curl_cffi. Homey's Node TLS stack is served the
 * real page and this login works as-is against a live account. Salesforce
 * could tighten that at any time, though: the symptom would be a failure at
 * the "Aura bootstrap not found" step, which is raised with `blocked: true`
 * so callers can point the user at refresh-token pairing instead. Cognito
 * token refresh and the telemetry API are not behind this edge at all.
 *
 * No MFA support — accounts with MFA enabled will fail at getDoLogin.
 */

const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');
const { Session } = require('./http');
const { CLIENT_ID, TOKEN_URL, COGNITO_DOMAIN } = require('./CumminsApi');

const AUTHORIZE_URL = `${COGNITO_DOMAIN}/oauth2/authorize`;
const REDIRECT_URI = 'connectcloud://authentication/callback';
const SCOPE = 'openid profile';
const LOGIN_TIMEOUT = 30000;

// A consistent, current Chrome header set. We cannot impersonate Chrome's TLS
// fingerprint from Node, but a coherent browser header set maximizes the
// chance of being served the real login page.
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

class AuraLoginError extends Error {

  constructor(message, { blocked = false } = {}) {
    super(message);
    /** True when the failure smells like the TLS-fingerprint block, meaning
     * username/password login can't work from this device and the user
     * should pair with a refresh token instead. */
    this.blocked = blocked;
  }

}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Decode the handful of HTML entity forms Salesforce emits in attributes. */
function htmlUnescape(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function diagnostics(res) {
  const snippet = (res.body || '').slice(0, 500).replace(/\s+/g, ' ').trim();
  return `status=${res.status} url=${res.url} body[:500]=${JSON.stringify(snippet)}`;
}

/**
 * Pull the target out of one of Salesforce's two static bounce-page templates
 * (`var url = '...'` first — when present it's the real target — falling back
 * to a literal `window.location.replace('...')`).
 */
function extractJsRedirect(html, baseUrl) {
  let m = html.match(/var\s+url\s*=\s*'([^']+)'/);
  if (!m) m = html.match(/window\.location\.replace\('([^']+)'\)/);
  if (!m) {
    throw new AuraLoginError(
      "Expected a static JS redirect but didn't find one — Cummins' login page may have changed.",
    );
  }
  return new URL(m[1], baseUrl).toString();
}

/** Pull fwuid/app/loaded out of the login page's embedded Aura bootstrap. */
function extractLoginContext(html) {
  const fwuid = html.match(/"fwuid":"([^"]+)"/);
  const app = html.match(/"app":"([^"]+)"/);
  const loaded = html.match(/"loaded":\{"([^"]+)":"([^"]+)"\}/);
  if (!fwuid || !app || !loaded) {
    // The classic symptom of the TLS-fingerprint block: a generic Salesforce
    // template with no Aura bootstrap at all.
    throw new AuraLoginError(
      'Could not find the Aura bootstrap on the login page. Either Cummins changed '
      + 'their login page, or Salesforce is blocking this device\'s TLS fingerprint — '
      + 'in that case, pair using a refresh token instead (see the app\'s help).',
      { blocked: true },
    );
  }
  return {
    mode: 'PROD',
    fwuid: fwuid[1],
    app: app[1],
    loaded: { [loaded[1]]: loaded[2] },
    dn: [],
    globals: {},
    uad: true,
  };
}

/**
 * Pull the auto-submitting SAML form's action + hidden inputs.
 * @param {string} html
 * @returns {{ actionUrl: string, fields: Record<string, string> }}
 */
function extractSamlForm(html) {
  const action = html.match(/<form[^>]*action="([^"]+)"/i);
  if (!action) {
    throw new AuraLoginError("Could not find the SAML auto-submit form after login — Cummins' login page may have changed.");
  }
  /** @type {Record<string, string>} */
  const fields = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) {
    fields[htmlUnescape(m[1])] = htmlUnescape(m[2]);
  }
  if (!('SAMLResponse' in fields)) {
    throw new AuraLoginError("SAML form found but missing SAMLResponse — Cummins' login page may have changed.");
  }
  return { actionUrl: htmlUnescape(action[1]), fields };
}

async function postAura(session, auraEndpoint, action, context, pageUri) {
  const data = new URLSearchParams({
    message: JSON.stringify({ actions: [action] }),
    'aura.context': JSON.stringify(context),
    'aura.pageURI': pageUri,
    'aura.token': 'null',
  }).toString();

  const res = await session.post(`${auraEndpoint}?${new URLSearchParams({ r: '0', 'aura.ApexAction.execute': '1' })}`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: data,
    timeout: LOGIN_TIMEOUT,
  });
  if (res.status >= 400) {
    throw new AuraLoginError(`Aura call failed: ${diagnostics(res)}`);
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch (err) {
    throw new AuraLoginError(`Unexpected non-JSON Aura response [${diagnostics(res)}]`);
  }
  if (!body.actions) {
    throw new AuraLoginError(`Unexpected Aura response shape: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const result = body.actions[0];
  if (result.state !== 'SUCCESS') {
    // Confirmed shape for a wrong password (live-tested upstream):
    // {"state":"ERROR","error":[{"message":"Your login attempt has failed. ..."}]}
    const errors = result.error || [];
    const message = errors[0] && errors[0].message;
    throw new AuraLoginError(message || `Aura action ${action.params.method} failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return result.returnValue;
}

/**
 * Log in with username/password, no browser.
 * @returns {Promise<{access_token:string, id_token:string, refresh_token:string, expires_in:number}>}
 */
async function login(username, password) {
  const { verifier, challenge } = pkce();
  const state = base64url(crypto.randomBytes(32));
  const session = new Session(BROWSER_HEADERS);

  const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  // 1. Kick off the SAML dance; redirects end on an anonymous /clw/idp/login
  //    hit that 401s with a static bounce page.
  let res = await session.get(authorizeUrl, { timeout: LOGIN_TIMEOUT });
  if (res.status !== 401) {
    throw new AuraLoginError(`Expected the initial SAML hop to land on a 401 bounce page, got ${res.status} at ${res.url}`);
  }
  let bounceUrl;
  try {
    bounceUrl = extractJsRedirect(res.body, res.url);
  } catch (err) {
    throw new AuraLoginError(`${err.message} [${diagnostics(res)}]`, { blocked: err.blocked });
  }

  // The bounce URL's own startURL param is exactly what getDoLogin wants back.
  const innerStartUrl = new URL(bounceUrl).searchParams.get('startURL');
  if (!innerStartUrl) {
    throw new AuraLoginError(`Bounce URL missing startURL param: ${bounceUrl.slice(0, 200)}`);
  }

  // 2. Follow the bounce to the actual (guest-session) login page.
  res = await session.get(bounceUrl, { timeout: LOGIN_TIMEOUT });
  if (res.status >= 400) throw new AuraLoginError(`Login page fetch failed [${diagnostics(res)}]`);
  const loginPage = new URL(res.url);
  const pageUri = loginPage.pathname + (loginPage.search || '');
  let context;
  try {
    context = extractLoginContext(res.body);
  } catch (err) {
    throw new AuraLoginError(`${err.message} [${diagnostics(res)}]`, { blocked: err.blocked });
  }
  const auraEndpoint = `${loginPage.protocol}//${loginPage.host}/clw/s/sfsites/aura`;

  // 3. Submit credentials via the Apex bridge the real login page uses.
  const action = {
    id: '0;a',
    descriptor: 'aura://ApexActionController/ACTION$execute',
    callingDescriptor: 'UNKNOWN',
    params: {
      namespace: '',
      classname: 'IAM_VisualforceToLightning',
      method: 'getDoLogin',
      params: {
        fedID: username,
        password,
        startURL: innerStartUrl,
        resourceURL: null,
        appID: null,
        lang: 'en_US',
      },
      cacheable: false,
      isContinuation: false,
    },
  };
  const returnValue = await postAura(session, auraEndpoint, action, context, pageUri);
  const frontdoorUrl = returnValue && typeof returnValue === 'object' ? returnValue.returnValue : null;
  if (typeof frontdoorUrl !== 'string' || !frontdoorUrl.includes('frontdoor.jsp')) {
    throw new AuraLoginError("Sign-in didn't return a usable session — wrong username/password, or Cummins' login flow changed.");
  }

  // 4. Redeem the frontdoor URL, then follow its bounce back into SAML.
  res = await session.get(frontdoorUrl, { timeout: LOGIN_TIMEOUT });
  if (res.status >= 400) throw new AuraLoginError(`frontdoor redemption failed [${diagnostics(res)}]`);
  let samlContinueUrl;
  try {
    samlContinueUrl = extractJsRedirect(res.body, res.url);
  } catch (err) {
    throw new AuraLoginError(`${err.message} [${diagnostics(res)}]`);
  }
  res = await session.get(samlContinueUrl, { timeout: LOGIN_TIMEOUT });
  if (res.status >= 400) throw new AuraLoginError(`SAML continue failed [${diagnostics(res)}]`);

  // 5. POST the auto-submitting SAML form to Cognito ourselves.
  let samlForm;
  try {
    samlForm = extractSamlForm(res.body);
  } catch (err) {
    throw new AuraLoginError(`${err.message} [${diagnostics(res)}]`);
  }
  res = await session.post(samlForm.actionUrl, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(samlForm.fields).toString(),
    followRedirects: false,
    timeout: LOGIN_TIMEOUT,
  });
  if (![301, 302, 303, 307, 308].includes(res.status)) {
    throw new AuraLoginError(`Expected Cognito to redirect after the SAML POST, got ${res.status}`);
  }
  const callbackUrl = res.headers.location || '';
  if (!callbackUrl.startsWith(REDIRECT_URI)) {
    throw new AuraLoginError(`Unexpected redirect target after SAML POST: ${callbackUrl.slice(0, 200)}`);
  }

  // 6. Extract + validate the authorization code, exchange it for tokens.
  const cbParams = new URL(callbackUrl.replace(/^connectcloud:/, 'https:')).searchParams;
  const code = cbParams.get('code');
  const returnedState = cbParams.get('state');
  if (returnedState && returnedState !== state) {
    throw new AuraLoginError('State mismatch on the OAuth callback — please retry.');
  }
  if (!code) {
    throw new AuraLoginError(`No authorization code in callback: ${callbackUrl.slice(0, 200)}`);
  }

  const tokenRes = await session.post(TOKEN_URL, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
    timeout: LOGIN_TIMEOUT,
  });
  if (tokenRes.status !== 200) {
    throw new AuraLoginError(`Token exchange failed (${tokenRes.status}): ${tokenRes.body.slice(0, 300)}`);
  }
  return JSON.parse(tokenRes.body);
}

module.exports = { login, AuraLoginError };
