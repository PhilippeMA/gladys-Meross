// -----------------------------------------------------------------------------
// Cloud transport: the Meross MQTT broker.
//
// This is both the command channel (publish a SET, await the device's ack) and
// the real-time channel: whatever happens to a device — someone presses the
// physical button, the app changes a color — the device PUSHes it to the
// broker, and Gladys sees it without polling.
//
// Addressing:
//   - we publish to     /appliance/<uuid>/subscribe
//   - devices reply to  /app/<userId>-<appId>/subscribe   (our `from` header)
//   - broadcasts land on /app/<userId>/subscribe
//
// Credentials are derived from the login result, not stored anywhere:
//   clientId = "app:<appId>"      appId = md5("API" + uuid)
//   username = <userId>
//   password = md5(<userId> + <key>)
//
// Request/response correlation is by `messageId`: we keep a map of pending
// requests and resolve the matching one when its reply arrives.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  buildMessage,
  generateMessageId,
  isErrorNamespace,
  isSignatureValid,
  readPayloadError,
  md5,
  METHOD,
} from './protocol.js';

const logger = createLogger({ name: 'meross-mqtt' });

/** Meross brokers listen for TLS MQTT on 443. */
const MQTT_PORT = 443;

/** How long we wait for a device to answer a command over the cloud. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** `err.code` set on a request the device never answered. */
export const TIMEOUT_ERROR_CODE = 'MEROSS_TIMEOUT';

/**
 * How many inbound messages to remember, so a request that times out can say
 * what DID arrive while it was waiting. "No answer" and "an answer we failed to
 * recognise" look identical from the outside and have opposite fixes.
 */
const INBOUND_HISTORY = 8;

export class MerossMqttClient {
  /**
   * @param {object} options
   * @param {string} options.domain broker hostname
   * @param {string} options.userId
   * @param {string} options.key account key
   * @param {(uuid: string, message: object) => void} [options.onPush] called on
   *   every unsolicited device message (state changes, online/offline)
   */
  constructor({ domain, userId, key, onPush }) {
    this.domain = domain;
    this.userId = String(userId);
    this.key = key;
    this.onPush = onPush;

    // Identifies THIS client instance to the broker and in the reply topic.
    this.appId = md5(`API${randomUUID()}`);
    this.clientId = `app:${this.appId}`;
    this.replyTopic = `/app/${this.userId}-${this.appId}/subscribe`;
    this.broadcastTopic = `/app/${this.userId}/subscribe`;

    /** @type {import('mqtt').MqttClient | null} */
    this.client = null;
    /** messageId -> { namespace, resolve, reject, timer } */
    this.pending = new Map();
    /** Recent inbound messages, `[{ seq, label }]`, for timeout diagnostics. */
    this.inbound = [];
    this.inboundSeq = 0;
  }

  get connected() {
    return Boolean(this.client?.connected);
  }

  /** Connect and subscribe to the two inbound topics. */
  async connect() {
    const url = `mqtts://${this.domain}:${MQTT_PORT}`;
    logger.info(`Connecting to the Meross broker ${url}...`);

    this.client = mqtt.connect(url, {
      clientId: this.clientId,
      username: this.userId,
      password: md5(`${this.userId}${this.key}`),
      protocolVersion: 4,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 20_000,
      rejectUnauthorized: true,
    });

    this.client.on('message', (topic, payload) => this.handleInbound(topic, payload));
    this.client.on('error', (err) => logger.error('MQTT error', err));
    this.client.on('reconnect', () => logger.info('Reconnecting to the Meross broker...'));
    this.client.on('close', () => logger.debug('Meross broker connection closed'));

    await new Promise((resolve, reject) => {
      const onConnect = () => {
        this.client.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        this.client.off('connect', onConnect);
        reject(err);
      };
      this.client.once('connect', onConnect);
      this.client.once('error', onError);
    });

    await this.client.subscribeAsync([this.replyTopic, this.broadcastTopic]);
    logger.info('Connected to the Meross broker');
  }

  /**
   * Send a message to one device and wait for its reply.
   *
   * @param {string} uuid device uuid
   * @param {string} namespace
   * @param {string} method
   * @param {object} payload
   * @param {number} [timeoutMs]
   * @returns {Promise<object>} the reply payload
   */
  async request(uuid, namespace, method, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!this.connected) {
      throw new Error('Not connected to the Meross broker');
    }

    const messageId = generateMessageId();
    const message = buildMessage({
      namespace,
      method,
      payload,
      key: this.key,
      from: this.replyTopic,
      messageId,
    });

    // Everything that arrives after this point is a candidate explanation if
    // the request ends up timing out.
    const mark = this.inboundSeq;

    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        const err = new Error(
          `Meross device ${uuid} did not answer ${namespace} in time. ${this.#describeSilence(mark)}`,
        );
        // Tagged so callers can tell "not answering at all" from "answering
        // with a refusal": silence means the namespace is a dead end, while a
        // refusal only means this particular request was wrong.
        err.code = TIMEOUT_ERROR_CODE;
        reject(err);
      }, timeoutMs);
      // `unref` so a pending command never keeps the process alive on shutdown.
      timer.unref?.();
      this.pending.set(messageId, { namespace, resolve, reject, timer });
    });

    try {
      await this.client.publishAsync(`/appliance/${uuid}/subscribe`, JSON.stringify(message));
    } catch (err) {
      // The message never left: drop the pending entry now instead of leaving
      // it to expire on a timeout that can no longer be answered.
      const waiting = this.pending.get(messageId);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.pending.delete(messageId);
      }
      throw err;
    }

    return reply;
  }

  /**
   * Route an inbound message: either a reply we are waiting for, or a push.
   *
   * Public rather than private only so tests can drive it without a broker.
   */
  handleInbound(topic, rawPayload) {
    let message;
    try {
      message = JSON.parse(rawPayload.toString());
    } catch {
      logger.warn(`Undecodable MQTT message on ${topic}`);
      return;
    }

    // Devices sign their messages with the account key. A bad signature means
    // the message is not from our account: never turn it into a Gladys state.
    if (!isSignatureValid(message, this.key)) {
      logger.warn(`Dropping MQTT message with an invalid signature on ${topic}`);
      return;
    }

    const { messageId, method, namespace } = message.header ?? {};
    this.#recordInbound(namespace, method);

    // A reply is identified by the messageId WE generated, confirmed by the
    // namespace we asked about — or by an error namespace, which is how a
    // refusal comes back.
    //
    // The METHOD is deliberately not part of the test. A hub acknowledges some
    // commands by PUSHing the state that resulted from them rather than by
    // sending a SETACK; requiring a SETACK there means timing out on a reply
    // already in hand. `Appliance.Control.Water` is one such namespace.
    const waiting = this.pending.get(messageId);
    if (waiting && (namespace === waiting.namespace || isErrorNamespace(namespace))) {
      clearTimeout(waiting.timer);
      this.pending.delete(messageId);

      // A refusal comes back as a normal, correctly signed reply carrying an
      // error namespace. Resolving it would report success for a command that
      // did nothing at all.
      if (isErrorNamespace(namespace)) {
        waiting.reject(
          new Error(
            `Meross refused the message (${namespace}): ${JSON.stringify(message.payload)}`,
          ),
        );
        return;
      }

      // Same namespace, valid signature, and the failure hidden in the body.
      const payloadError = readPayloadError(message.payload);
      if (payloadError) {
        waiting.reject(new Error(`Meross returned error ${payloadError.code} for ${namespace}`));
        return;
      }

      logger.debug(`Reply ${method} ${namespace}: ${JSON.stringify(message.payload)}`);
      waiting.resolve(message.payload ?? {});

      // A SETACK is spent once it has resolved the command. A PUSH is not: it
      // is also the device announcing its new state, and the push path below is
      // what turns that into a Gladys state. So it keeps going.
      if (method !== METHOD.PUSH) {
        return;
      }
    }

    // Unsolicited: a state change pushed by the device.
    const uuid = extractUuid(message.header?.from);
    if (uuid && typeof this.onPush === 'function') {
      try {
        this.onPush(uuid, message);
      } catch (err) {
        logger.error('Push handler failed', err);
      }
    }
  }

  /** Remember an inbound message, so a timeout can report what arrived instead. */
  #recordInbound(namespace, method) {
    this.inboundSeq += 1;
    this.inbound.push({ seq: this.inboundSeq, label: `${method} ${namespace}` });
    if (this.inbound.length > INBOUND_HISTORY) {
      this.inbound.shift();
    }
  }

  /** What arrived on the reply topic since `mark`, phrased for a log line. */
  #describeSilence(mark) {
    const since = this.inbound.filter((entry) => entry.seq > mark).map((entry) => entry.label);
    if (since.length === 0) {
      return 'Nothing at all arrived on the reply topic while it waited.';
    }
    return `Received meanwhile, but matching no pending request: ${since.join(', ')}.`;
  }

  /** Disconnect and fail every in-flight request. */
  async disconnect() {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('Meross broker connection closed'));
    }
    this.pending.clear();

    if (this.client) {
      try {
        await this.client.endAsync(true);
      } catch (err) {
        logger.error('Failed to close the MQTT connection cleanly', err);
      }
      this.client = null;
    }
  }
}

/**
 * Extract the device uuid from a `from` header such as
 * `/appliance/1234abcd.../publish`.
 */
export function extractUuid(from) {
  if (typeof from !== 'string') {
    return null;
  }
  const match = from.match(/^\/appliance\/([^/]+)\//);
  return match ? match[1] : null;
}
