'use strict';

/**
 * Minimal client for the Hoymiles S-Miles Cloud (neapi.hoymiles.com).
 *
 * UNOFFICIAL — the API is undocumented and reverse-engineered; Hoymiles may change it at any time.
 *
 * The login flow (v3 pre-insp + Argon2id via hash-wasm, client profiles, legacy fallback) is adapted
 * from homey-app-hoymiles-hione by ItsRaYnor (MIT), which in turn mirrors
 * homeassistant-hoymiles-cloud by Philra94 (MIT). See LICENSE.
 */

const { createHash } = require('crypto');
const { argon2id } = require('hash-wasm');

const DEFAULT_BASE_URL = 'https://neapi.hoymiles.com';

const ENDPOINTS = {
  PRE_INSP_V3: '/iam/pub/3/auth/pre-insp',
  LOGIN_V3: '/iam/pub/3/auth/login',
  LOGIN_V0: '/iam/pub/0/auth/login',
  STATIONS: '/pvm/api/0/station/select_by_page',
  REAL_DATA: '/pvm-data/api/0/station/data/count_station_real_data',
  DEVICE_TREE: '/pvm/api/0/station/select_device_of_tree',
  // Export control ("reflux control" in Hoymiles terms) — the web portal's Settings → max output (kW)
  REFLUX_FIND: '/pvm/api/0/station/reflux_control/find_by_station',
  REFLUX_CONFIG: '/pvm/api/0/station/reflux_control/config',
  // Push the station config to the DTU and follow the resulting task
  NETWORKING: '/pvm-ctl/api/0/station/networking',
  NETWORKING_STATUS: '/pvm-ctl/api/0/station/status',
};

const PUSH_POLL_INTERVAL_MS = 1_500;
const PUSH_TIMEOUT_MS = 120_000;

// Some accounts only accept logins that identify as a known Hoymiles client. Tried in order; the
// matching profile's headers are reused on data requests.
const CLIENT_PROFILES = [
  { name: 'web', headers: { 'User-Agent': 'Homey-SMiles' } },
  {
    name: 'installer',
    headers: {
      'User-Agent': 'S-Miles Installer/3.7.1',
      'App-Version': '3.7.1',
      'X-App-Version': '3.7.1',
      'X-Client-Type': 'mobile',
    },
  },
  {
    name: 'home',
    headers: { 'User-Agent': 'sma/ad/2.10.0/159/0' },
    authBaseUrl: 'https://euapi.hoymiles.com',
  },
];

const TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000; // cloud tokens are valid ~2h
const AUTH_COOLDOWN_MS = 30 * 60 * 1000; // back off after a failed login, protects the account

class SmilesApi {

  constructor({ log, email, password, baseUrl }) {
    this.log = log;
    this._email = email;
    this._password = password;
    this._baseUrl = baseUrl || DEFAULT_BASE_URL;
    this._token = null;
    this._tokenExpiry = 0;
    this._profileHeaders = CLIENT_PROFILES[0].headers;
    this._authCooldownUntil = 0;
    this._authInFlight = null;
  }

  // ── Authentication ──────────────────────────────────────────────────────

  async login() {
    if (!this._email || !this._password) throw new Error('Email and password are required');
    const attempts = [];

    for (const profile of CLIENT_PROFILES) {
      try {
        const token = await this._loginV3(profile);
        if (token) {
          this._profileHeaders = profile.headers;
          return this._storeToken(token, `v3 ${profile.name}`);
        }
      } catch (err) {
        attempts.push(`v3 ${profile.name}: ${err.message}`);
      }
    }

    try {
      const token = await this._loginLegacy();
      if (token) {
        this._profileHeaders = CLIENT_PROFILES[0].headers;
        return this._storeToken(token, 'legacy v0');
      }
    } catch (err) {
      attempts.push(`v0: ${err.message}`);
    }

    this._authCooldownUntil = Date.now() + AUTH_COOLDOWN_MS;
    throw new Error(`S-Miles login failed (${attempts.join('; ')})`);
  }

  async _loginV3(profile) {
    // Consumer accounts must authenticate against their regional gateway
    const authBase = profile.authBaseUrl || this._baseUrl;
    const preInspect = async () => {
      const pre = await this._request(`${authBase}${ENDPOINTS.PRE_INSP_V3}`, { u: this._email }, false, profile.headers);
      if (!pre?.data?.n) throw new Error('pre-insp returned no nonce');
      return pre.data;
    };

    let preData = await preInspect();

    // Salted account → Argon2id over password + salt (as the web client does)
    if (preData.a) {
      const ch = await argon2id({
        password: this._password,
        salt: decodeSalt(preData.a),
        iterations: 3,
        memorySize: 32768,
        parallelism: 1,
        hashLength: 32,
        outputType: 'hex',
      });
      const resp = await this._request(`${authBase}${ENDPOINTS.LOGIN_V3}`,
        { u: this._email, ch, n: preData.n }, false, profile.headers);
      return resp?.data?.token ?? null;
    }

    // No salt → the observed unsalted hash variants; each attempt consumes the nonce
    const pw = this._password;
    const candidates = [
      `${createHash('md5').update(pw).digest('hex')}.${createHash('sha256').update(pw).digest('base64')}`,
      createHash('sha256').update(pw).digest('hex'),
    ];
    for (let i = 0; i < candidates.length; i++) {
      if (i > 0) preData = await preInspect();
      try {
        const resp = await this._request(`${authBase}${ENDPOINTS.LOGIN_V3}`,
          { u: this._email, ch: candidates[i], n: preData.n }, false, profile.headers);
        if (resp?.data?.token) return resp.data.token;
      } catch (_) {
        // try next variant
      }
    }
    return null;
  }

  async _loginLegacy() {
    const md5Hex = createHash('md5').update(this._password).digest('hex');
    const resp = await this._request(ENDPOINTS.LOGIN_V0, { user_name: this._email, password: md5Hex }, false);
    return resp?.data?.token ?? null;
  }

  _storeToken(token, method) {
    this._token = token;
    this._tokenExpiry = Date.now() + TOKEN_LIFETIME_MS;
    this._authCooldownUntil = 0;
    this.log(`[SmilesApi] Login successful (${method})`);
    return true;
  }

  async ensureToken() {
    if (this._token && Date.now() < this._tokenExpiry) return;
    if (Date.now() < this._authCooldownUntil) {
      const mins = Math.ceil((this._authCooldownUntil - Date.now()) / 60000);
      throw new Error(`Login failed earlier — not retrying for ~${mins} min`);
    }
    if (!this._authInFlight) {
      this._authInFlight = this.login().finally(() => { this._authInFlight = null; });
    }
    await this._authInFlight;
  }

  // ── Data ────────────────────────────────────────────────────────────────

  async getStations() {
    await this.ensureToken();
    const stations = [];
    for (let page = 1; ; page++) {
      const resp = await this._request(ENDPOINTS.STATIONS, { page_num: page, page_size: 100 });
      const list = Array.isArray(resp?.data?.list) ? resp.data.list : [];
      if (list.length === 0) break;
      for (const s of list) stations.push({ id: String(s.id), name: s.name || `Station ${s.id}` });
      if (list.length < 100) break;
    }
    return stations;
  }

  async getRealData(stationId) {
    await this.ensureToken();
    const resp = await this._request(ENDPOINTS.REAL_DATA, { sid: Number(stationId) });
    const d = resp?.data;
    if (!d) throw new Error('Empty real-data response');
    return {
      power: num(d.real_power),            // W
      todayEnergy: num(d.today_eq) / 1000, // Wh → kWh
      totalEnergy: num(d.total_eq) / 1000, // Wh → kWh
    };
  }

  /** Raw device tree (DTUs + microinverters) of a station — used to find DTU serials. */
  async getDeviceTree(stationId) {
    await this.ensureToken();
    const resp = await this._request(ENDPOINTS.DEVICE_TREE, { id: Number(stationId) });
    return resp?.data ?? null;
  }

  // ── Control ─────────────────────────────────────────────────────────────

  /** Current export-control settings of a station, as the web portal reads them. */
  async getExportControl(stationId) {
    await this.ensureToken();
    const resp = await this._request(ENDPOINTS.REFLUX_FIND, { id: Number(stationId) });
    return resp?.data ?? null;
  }

  /**
   * Set the station's export limit ("max output", kW) exactly as the web portal's Settings → Export
   * management page does (verified with a browser capture, 6-10-2026):
   *   1. POST reflux_control/config with the current grid type and meters, total limit = kW
   *   2. POST station/networking → task id; the cloud pushes the config to the DTU
   *   3. poll station/status until code 0 (2 = running, 1 = failed, 3 = timeout)
   * Only "total" mode on a station where export management is already on is supported; anything
   * else is refused rather than guessed. (The portal's preceding station_config call only switches
   * export management on and is skipped here, so other station options are never touched.)
   */
  async setOutputLimit(stationId, kw) {
    const current = await this.getExportControl(stationId);
    if (!current) throw new Error('No export-control settings found for this station');
    if (current.is_control !== 1) throw new Error('Export management is not enabled for this station in S-Miles');
    if (current.control_type !== 1) {
      throw new Error(`Unsupported export-limit mode ${current.control_type} (only "total" is supported)`);
    }

    const payload = {
      sid: Number(stationId),
      grid_type: current.grid_type,
      // Same shape the portal sends: meters with an id, ct_gain left empty
      meter_list: (current.meter_list || [])
        .filter(m => Array.isArray(m.meter_id) && m.meter_id[0])
        .map(m => ({ location: m.location, meter_id: m.meter_id, ct_gain: [] })),
      is_control: 1,
      control_type: 1,
      control_value: Number(kw),
    };
    if (current.gpc_cfg_param) payload.gpc_cfg = current.gpc_cfg_param;

    this.log(`[SmilesApi] Export limit station ${stationId} → ${kw} kW`);
    await this._request(ENDPOINTS.REFLUX_CONFIG, payload);
    await this._pushToDtu(stationId);
  }

  async _pushToDtu(stationId) {
    const resp = await this._request(ENDPOINTS.NETWORKING, { id: Number(stationId) });
    const taskId = resp?.data;
    if (!taskId) throw new Error('Cloud returned no task id for pushing the config to the DTU');

    const deadline = Date.now() + PUSH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, PUSH_POLL_INTERVAL_MS));
      const status = await this._request(ENDPOINTS.NETWORKING_STATUS, { id: String(taskId) });
      const code = status?.data?.code;
      if (code === 0) {
        this.log(`[SmilesApi] DTU confirmed config (task ${taskId})`);
        return;
      }
      if (code === 1) throw new Error('DTU rejected the config');
      if (code === 3) throw new Error('DTU did not respond in time (cloud timeout)');
    }
    throw new Error(`No confirmation from the DTU within ${PUSH_TIMEOUT_MS / 1000} s`);
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  async _request(endpoint, body = {}, authenticated = true, profileHeaders = null) {
    const url = endpoint.startsWith('http') ? endpoint : `${this._baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(profileHeaders || this._profileHeaders),
    };
    // The API expects the raw token (no Bearer prefix)
    if (authenticated && this._token) headers.Authorization = this._token;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Network error on ${endpoint}: ${err.message}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${endpoint}`);

    let json;
    try {
      json = await res.json();
    } catch (_) {
      throw new Error(`Invalid JSON from ${endpoint}`);
    }
    if (String(json.status ?? '0') !== '0') {
      // Expired/invalid token → drop it so the next call re-authenticates
      if (String(json.status) === '100') this._token = null;
      throw new Error(`API error on ${endpoint}: ${json.message ?? `status ${json.status}`}`);
    }
    return json;
  }

}

// Observed salt formats: plain hex (browser captures) or base64
function decodeSalt(value) {
  const s = String(value).trim();
  if (s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return Buffer.from(s, 'base64');
  return Buffer.from(s, 'utf8');
}

function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

module.exports = SmilesApi;
