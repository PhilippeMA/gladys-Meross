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
// This uses `node:http` and not `fetch`, and that is not a style choice. Meross
// firmware ends its HTTP status line with a bare LF instead of CRLF. `fetch`
// parses strictly and throws the whole response away over that one byte,
// reporting `TypeError: fetch failed` — which reads exactly like an unreachable
// device, and cost this integration days of chasing routes, firewalls and ports.
// `node:http` accepts `insecureHTTPParser`, which tolerates it; `fetch` has no
// equivalent.
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

import http from 'node:http';
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
    response = await postJson({ ip, port, path, body: JSON.stringify(message), timeoutMs });
  } catch (err) {
    // EHOSTUNREACH and ENETUNREACH mean there is no route to the device's
    // network, ECONNREFUSED means the host is there but nothing listens, and a
    // timeout means packets are being dropped. Each points somewhere different.
    throw new Error(`${describeNetworkError(err)} (${url})`, { cause: err });
  }

  if (response.status < 200 || response.status >= 300) {
    // Report the body AND the headers. Meross firmware answers with
    // non-standard statuses (470 on an MSH400) and the status alone means
    // nothing; when the body is empty too, `server` or `content-type` is what
    // separates "the Meross endpoint refused us" from "something else entirely
    // is listening on this port".
    throw new Error(
      `Meross LAN HTTP ${response.status} from ${url}: ${describeBody(response.text)}` +
        ` [${describeHeaders(response.headers)}]`,
    );
  }

  let body;
  try {
    body = JSON.parse(response.text);
  } catch (err) {
    throw new Error(
      `Meross device ${url} answered HTTP ${response.status} with something that is not ` +
        `JSON: ${describeBody(response.text)}`,
      { cause: err },
    );
  }

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

/**
 * POST a JSON body, tolerating the firmware's malformed response line.
 *
 * `insecureHTTPParser` is the entire reason this is not `fetch`: Meross ends
 * its HTTP status line with a bare LF instead of CRLF, and a strict parser
 * discards the whole response over that one missing byte. The option's name is
 * alarming and the risk here is not: the peer is a device on the user's own
 * network, reached by IP, answering a request we signed.
 */
function postJson({ ip, port, path, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: ip,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
        insecureHTTPParser: true,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );

    // `timeout` only fires an event: without destroying the request the socket
    // stays open and this promise never settles.
    request.on('timeout', () =>
      request.destroy(Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' })),
    );
    request.on('error', reject);
    request.end(body);
  });
}

/** The response headers worth naming when the body is empty. */
function describeHeaders(headers = {}) {
  const interesting = ['server', 'content-type', 'content-length', 'connection', 'allow'];
  const seen = interesting
    .filter((name) => headers[name] !== undefined)
    .map((name) => `${name}: ${headers[name]}`);
  return seen.length ? seen.join('; ') : 'no headers';
}

/** Whatever a failing response has to say, capped so a log line stays a line. */
function describeBody(text, limit = 400) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return 'empty body';
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * The first network error code buried anywhere under a rejection.
 *
 * `err.cause` is not reliably the real error: Node nests causes, and when a
 * host resolves to several addresses it reports an `AggregateError` whose own
 * `code` is undefined and whose `errors` hold the real ones. Reading only
 * `cause.code` therefore yields a bare wrapper message precisely when the
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
