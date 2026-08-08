// -----------------------------------------------------------------------------
// Meross cloud HTTP API: log in and enumerate the account's devices.
//
// This is the ONLY step that always needs the internet, even when the user
// prefers local control: the login returns the account `key`, and every device
// — LAN or cloud — refuses a message that is not signed with it.
//
// Request shape (all endpoints):
//   POST https://iotx-<region>.meross.com/v1/...
//   Content-Type: application/json
//   body: { params, sign, timestamp, nonce }
//     params    = base64(JSON.stringify(data))
//     sign      = md5(SECRET + timestamp + nonce + params)
//     timestamp = milliseconds
//     nonce     = random 16-char string
//
// The API always answers HTTP 200; the real outcome is in `apiStatus`
// (0 = success). `checkApiStatus` turns anything else into a readable error.
//
// This protocol is not publicly documented by Meross: it is the shape used by
// the mobile app, and it can change without notice.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { md5 } from './protocol.js';

const logger = createLogger({ name: 'meross-cloud' });

/** Shared secret of the Meross mobile app, used to sign every HTTP call. */
const SECRET = '23x17ahWarFH6w29';

/** Endpoints per region, as offered in the Configuration screen. */
export const REGION_ENDPOINTS = {
  eu: 'https://iotx-eu.meross.com',
  us: 'https://iotx-us.meross.com',
  ap: 'https://iotx-ap.meross.com',
  global: 'https://iotx.meross.com',
};

export const LOGIN_PATH = '/v1/Auth/signIn';
export const DEVICE_LIST_PATH = '/v1/Device/devList';
export const LOGOUT_PATH = '/v1/Profile/logout';

/**
 * `apiStatus` codes worth explaining to the user in their own words. Anything
 * missing here falls back to the `info` message returned by the API, so an
 * unknown code is still actionable instead of being swallowed.
 */
const API_STATUS_MESSAGES = {
  1001: 'Wrong password.',
  1002: 'This Meross account does not exist.',
  1004: 'Wrong email or password.',
  1005: 'Invalid email address.',
  1006: 'Wrong password format.',
  1008: 'This email is not registered on Meross.',
  1019: 'Meross session expired, a new login is required.',
  1200: 'Meross token invalid or expired, a new login is required.',
  1301: 'Too many active Meross sessions: log out of some devices and retry.',
};

/** Statuses that mean "your stored token is dead, log in again". */
export const TOKEN_EXPIRED_STATUSES = new Set([1019, 1200]);

export class MerossApiError extends Error {
  constructor(apiStatus, info) {
    const explanation = API_STATUS_MESSAGES[apiStatus] ?? info ?? 'Unknown error';
    super(`Meross API error ${apiStatus}: ${explanation}`);
    this.name = 'MerossApiError';
    this.apiStatus = apiStatus;
    this.info = info;
  }

  /** True when re-authenticating from scratch is the right recovery. */
  get isTokenExpired() {
    return TOKEN_EXPIRED_STATUSES.has(this.apiStatus);
  }
}

/** Random nonce, in the alphabet the Meross app uses (uppercase + digits). */
function generateNonce(length = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let nonce = '';
  for (let i = 0; i < length; i += 1) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}

/**
 * Build the signed body of a cloud request. Exported for the unit tests: the
 * signature is the part that silently breaks everything when it drifts.
 *
 * @param {object} data endpoint-specific parameters
 * @param {number} [timestamp] forced timestamp in ms (tests)
 * @param {string} [nonce] forced nonce (tests)
 */
export function buildSignedBody(data, timestamp = Date.now(), nonce = generateNonce()) {
  const params = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  return {
    params,
    sign: md5(`${SECRET}${timestamp}${nonce}${params}`),
    timestamp,
    nonce,
  };
}

/** Throw a readable error unless the response carries `apiStatus: 0`. */
export function checkApiStatus(body) {
  const apiStatus = Number(body?.apiStatus ?? -1);
  if (apiStatus !== 0) {
    throw new MerossApiError(apiStatus, body?.info);
  }
  return body.data;
}

/**
 * Low-level POST to the Meross cloud.
 *
 * @param {object} options
 * @param {string} options.baseUrl regional endpoint
 * @param {string} options.path e.g. '/v1/Device/devList'
 * @param {object} [options.data] endpoint parameters
 * @param {string} [options.token] session token, for authenticated calls
 * @param {number} [options.timeoutMs]
 */
export async function post({ baseUrl, path, data = {}, token, timeoutMs = 15_000 }) {
  const headers = {
    'Content-Type': 'application/json',
    // The app identifies itself with these; the API rejects calls without them.
    AppVersion: '4.5.0',
    AppLanguage: 'EN',
    'User-Agent': 'okhttp/3.12.1',
    vender: 'meross',
  };
  if (token) {
    headers.Authorization = `Basic ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildSignedBody(data)),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Meross cloud HTTP ${response.status} on ${path}`);
  }

  return checkApiStatus(await response.json());
}

/**
 * Log in and open a session.
 *
 * @param {object} options
 * @param {string} options.baseUrl regional endpoint
 * @param {string} options.email
 * @param {string} options.password
 * @returns {Promise<{ userId: string, key: string, token: string, mqttDomain: string }>}
 */
export async function login({ baseUrl, email, password }) {
  logger.info(`Logging in to the Meross cloud (${baseUrl})...`);

  const data = await post({
    baseUrl,
    path: LOGIN_PATH,
    data: {
      email,
      // encryption: 1 tells the API the password is already md5-hashed, so the
      // clear-text password never leaves this process.
      password: md5(password),
      encryption: 1,
      accountCountryCode: '',
      agree: 0,
    },
  });

  if (!data?.token || !data?.key) {
    throw new Error('Meross login succeeded but returned no token/key');
  }

  logger.info('Meross login successful');

  return {
    userId: String(data.userid),
    key: data.key,
    token: data.token,
    // The account's broker. Devices may override it with their own `domain`.
    mqttDomain: data.mqttDomain || data.domain || 'mqtt.meross.com',
  };
}

/**
 * List the devices bound to the account.
 *
 * @returns {Promise<Array<object>>} raw device descriptors
 */
export async function listDevices({ baseUrl, token }) {
  const devices = await post({ baseUrl, path: DEVICE_LIST_PATH, token });
  const list = Array.isArray(devices) ? devices : [];
  logger.info(`Meross cloud returned ${list.length} device(s)`);
  return list;
}

/**
 * Close the session server-side. Meross counts concurrent tokens per account
 * and starts refusing new logins (apiStatus 1301) once too many pile up, so
 * releasing the token on shutdown keeps the account healthy.
 */
export async function logout({ baseUrl, token }) {
  await post({ baseUrl, path: LOGOUT_PATH, token });
  logger.info('Meross session closed');
}
