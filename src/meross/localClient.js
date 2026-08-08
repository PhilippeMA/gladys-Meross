// -----------------------------------------------------------------------------
// Local transport: a direct HTTP POST to the device on the LAN.
//
// Meross devices expose an unadvertised HTTP endpoint on port 80:
//
//   POST http://<device-ip>/config
//   body: the very same signed envelope we would publish over MQTT
//
// Same message, different pipe — see src/meross/protocol.js. What we gain: no
// round trip through Meross' servers, so a light reacts in milliseconds and
// keeps working when the internet is down.
//
// Two honest limitations, both handled by the caller (src/meross/client.js):
//   1. we still need the account `key` from the cloud login to sign;
//   2. some firmware revisions answer nothing on /config. There is no way to
//      know but to try, so the client probes once and falls back to the cloud,
//      flagging the device as degraded rather than failing the command.
//
// The device IP is not in the cloud device list: it is read from
// `Appliance.System.All` -> `system.firmware.innerIp` (see client.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { buildMessage, isErrorNamespace, readPayloadError } from './protocol.js';

const logger = createLogger({ name: 'meross-local' });

/**
 * A LAN device answers in a few milliseconds. Keep the timeout short: it is
 * also the delay before we give up and fall back to the cloud, and the user is
 * waiting in front of a light switch.
 */
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Send one message directly to a device on the LAN.
 *
 * @param {object} options
 * @param {string} options.ip device LAN address
 * @param {string} options.key account key
 * @param {string} options.namespace
 * @param {string} options.method
 * @param {object} [options.payload]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} the reply payload
 */
export async function localRequest({
  ip,
  key,
  namespace,
  method,
  payload = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!ip) {
    throw new Error('No LAN address known for this device');
  }

  const message = buildMessage({ namespace, method, payload, key });

  logger.debug(`LAN ${method} ${namespace} -> ${ip}`);

  const response = await fetch(`http://${ip}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Meross LAN HTTP ${response.status} from ${ip}`);
  }

  const body = await response.json();

  // A device that refuses the message answers with an error namespace rather
  // than an HTTP status — most often a signature it does not accept.
  if (isErrorNamespace(body?.header?.namespace)) {
    throw new Error(
      `Meross device ${ip} refused the message (${body.header.namespace}): ` +
        JSON.stringify(body.payload),
    );
  }

  // A refusal can also hide in the body while the envelope looks perfect.
  const payloadError = readPayloadError(body?.payload);
  if (payloadError) {
    throw new Error(`Meross device ${ip} returned error ${payloadError.code} for ${namespace}`);
  }

  return body?.payload ?? {};
}

/**
 * Probe whether a device really answers on the LAN.
 *
 * Used once per device to decide the effective transport, so the user gets a
 * truthful `local` / `cloud` badge instead of the channel they merely asked
 * for.
 *
 * @returns {Promise<boolean>}
 */
export async function isReachable({ ip, key, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  try {
    await localRequest({
      ip,
      key,
      namespace: 'Appliance.System.All',
      method: 'GET',
      timeoutMs,
    });
    return true;
  } catch (err) {
    logger.debug(`Device ${ip} is not reachable on the LAN: ${err.message}`);
    return false;
  }
}
