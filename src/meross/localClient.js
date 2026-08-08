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

/** Where the unadvertised HTTP endpoint listens. */
export const DEFAULT_PORT = 80;

/** The path it serves. */
export const DEFAULT_PATH = '/config';

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
  uuid,
  namespace,
  method,
  payload = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  port = DEFAULT_PORT,
  path = DEFAULT_PATH,
}) {
  if (!ip) {
    throw new Error('No LAN address known for this device');
  }

  const address = port === DEFAULT_PORT ? ip : `${ip}:${port}`;
  const url = `http://${address}${path}`;

  // The Meross app sends `from` and `uuid` on local requests; mirroring it
  // keeps us on the exact shape the firmware is known to accept.
  const message = buildMessage({
    namespace,
    method,
    payload,
    key,
    from: url,
    uuid,
  });

  logger.debug(`LAN ${method} ${namespace} -> ${url}`);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Node reports every network failure as a bare "fetch failed" and hides the
    // reason in `cause`. That reason is the whole diagnosis: EHOSTUNREACH and
    // ENETUNREACH mean there is no route to the device's network, ECONNREFUSED
    // means the host is there but nothing listens, and a timeout means packets
    // are being dropped. Surface it.
    throw new Error(`${describeNetworkError(err)} (${url})`, { cause: err });
  }

  if (!response.ok) {
    // Read the body before giving up. Meross firmware answers with non-standard
    // statuses (470 has been seen on an MSH400) and puts the reason in the body
    // — usually a normal Meross envelope with an error payload. Throwing on the
    // status alone discards the only explanation there is.
    // Read the headers too. An empty body says nothing; `server` or
    // `content-type` often names the service that answered, which is the
    // difference between "the Meross endpoint refused us" and "something else
    // entirely is listening on this port".
    throw new Error(
      `Meross LAN HTTP ${response.status} from ${url}: ${await readBody(response)}` +
        ` [${describeHeaders(response)}]`,
    );
  }

  const body = await response.json();

  // A device that refuses the message answers with an error namespace rather
  // than an HTTP status — most often a signature it does not accept.
  if (isErrorNamespace(body?.header?.namespace)) {
    throw new Error(
      `Meross device ${address} refused the message (${body.header.namespace}): ` +
        JSON.stringify(body.payload),
    );
  }

  // A refusal can also hide in the body while the envelope looks perfect.
  const payloadError = readPayloadError(body?.payload);
  if (payloadError) {
    throw new Error(
      `Meross device ${address} returned error ${payloadError.code} for ${namespace}`,
    );
  }

  return body?.payload ?? {};
}

/** The response headers worth naming when the body is empty. */
function describeHeaders(response) {
  const interesting = ['server', 'content-type', 'content-length', 'connection', 'allow'];
  const seen = interesting
    .map((name) => [name, response.headers?.get?.(name)])
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${value}`);
  return seen.length ? seen.join('; ') : 'no headers';
}

/** Whatever a failing response has to say, capped so a log line stays a line. */
async function readBody(response, limit = 400) {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return 'empty body';
    }
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch (err) {
    return `unreadable body (${err.message})`;
  }
}

/**
 * The first network error code buried anywhere under a fetch rejection.
 *
 * `err.cause` is not reliably the real error: Node nests causes, and when a
 * host resolves to several addresses it reports an `AggregateError` whose own
 * `code` is undefined and whose `errors` hold the real ones. Reading only
 * `cause.code` therefore yields a bare "fetch failed" precisely when the
 * diagnosis matters most.
 */
function findErrorCode(err, depth = 0) {
  if (!err || depth > 5) {
    return undefined;
  }
  if (typeof err.code === 'string') {
    return err.code;
  }
  for (const nested of err.errors ?? []) {
    const code = findErrorCode(nested, depth + 1);
    if (code) {
      return code;
    }
  }
  return findErrorCode(err.cause, depth + 1);
}

/** Turn an opaque fetch rejection into something a user can act on. */
export function describeNetworkError(err) {
  const code = findErrorCode(err);

  switch (code) {
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `no route to the device (${code}): the machine running Gladys is not on that network`;
    case 'ECONNREFUSED':
      return 'connection refused: something answered but nothing is listening on port 80';
    case 'EACCES':
      return 'connection blocked (EACCES): a firewall or container policy is in the way';
    case 'ETIMEDOUT':
    case 'ENETDOWN':
      return `no answer (${code}): packets are being dropped on the way`;
    default:
      break;
  }

  if (err?.name === 'TimeoutError' || /aborted due to timeout/i.test(err?.message ?? '')) {
    return 'no answer before the timeout: the address is filtered or the device is offline';
  }

  // A code we do not have a sentence for is still worth far more than the
  // "fetch failed" wrapper around it — `UND_ERR_SOCKET`, for instance, means
  // the device accepted the connection and then dropped it, which is a real
  // finding and reads as nothing at all without the code.
  const message = err?.message ?? 'unknown network error';
  if (code) {
    return `${message} (${code})`;
  }

  // No code anywhere: report the chain of causes instead. Something in it
  // names the failure, and a bare "fetch failed" has now cost several rounds
  // of guessing.
  // Consecutive duplicates carry nothing: a self-referencing cause would
  // otherwise print the same sentence six times.
  const trail = causeTrail(err).filter((label, index, all) => label !== all[index - 1]);
  return trail.length > 1 ? trail.join(' <- ') : message;
}

/** Every `name: message` down the cause chain, for a failure with no code. */
function causeTrail(err, depth = 0) {
  if (!err || depth > 5) {
    return [];
  }
  const label = `${err.name ?? 'Error'}: ${err.message ?? ''}`.trim();
  const nested = (err.errors ?? []).flatMap((entry) => causeTrail(entry, depth + 1));
  return [label, ...nested, ...causeTrail(err.cause, depth + 1)];
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
export async function isReachable({
  ip,
  key,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  port = DEFAULT_PORT,
}) {
  try {
    await localRequest({
      ip,
      key,
      namespace: 'Appliance.System.All',
      method: 'GET',
      timeoutMs,
      port,
    });
    return true;
  } catch (err) {
    logger.debug(`Device ${ip} is not reachable on the LAN: ${err.message}`);
    // The reason is what tells a route problem from a firewall problem.
    isReachable.lastError = describeNetworkError(err);
    return false;
  }
}
