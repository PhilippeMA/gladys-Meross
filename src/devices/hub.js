// -----------------------------------------------------------------------------
// Device kind: HUB  (MSH300, MSH400...)
//
// A hub is not a device the user controls: it is a gateway. What matters are
// the battery-powered sub-devices paired to it — thermometers, thermostatic
// valves, leak and opening sensors — which never appear in the cloud device
// list and only exist behind their hub.
//
// So this kind is the one that maps ONE Meross device to MANY Gladys devices:
// the hub itself is never published, each sub-device is. Their external ids are
// `<hubUuid>-<subDeviceId>`, so a command can always be routed back to the
// right hub and the right sensor.
//
// Features are chosen from the DATA a sub-device actually reports, with its
// type as a fallback hint. Meross hub generations name their sub-device types
// inconsistently, but they all report a `tempHum` block for a thermometer and a
// `temperature` block for a valve — so reading the data is the reliable test.
//
// Values arrive in tenths (231 -> 23.1 °C); see `fromDeciUnit`.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  buildWaterControlPayload,
  fromDeciUnit,
  isHubNamespace,
  METHOD,
  NAMESPACE,
  toDeciUnit,
  WATER_ONOFF,
} from '../meross/protocol.js';
import {
  normalizePollFrequency,
  normalizeWateringDuration,
  WATERING_DURATION_MAX,
  WATERING_DURATION_MIN,
} from '../config.js';
import { buildFeatureKey, deviceIds, FEATURE_KIND, subDevicePlatformId } from './featureIds.js';

const logger = createLogger({ name: 'hub' });

export const KIND = 'hub';

/**
 * A hub keeps no useful state in its `Appliance.System.All` digest: everything
 * lives in the per-family hub namespaces. Tells the registry not to waste a
 * round trip reading it on every poll.
 */
export const readsDigest = false;

export function matches(device) {
  return Object.keys(device.ability ?? {}).some(isHubNamespace);
}

// --- Capability detection ----------------------------------------------------

/** A thermometer/hygrometer (MS100 and friends). */
function hasTempHum(sub) {
  return Boolean(sub.state?.tempHum) || sub.type?.startsWith('ms100');
}

/** A thermostatic radiator valve (MTS100, MTS100v3, MTS150). */
function hasThermostat(sub) {
  const temperature = sub.state?.temperature;
  const looksLikeValve =
    temperature && (temperature.room !== undefined || temperature.currentSet !== undefined);
  return Boolean(looksLikeValve) || sub.type?.startsWith('mts1');
}

/**
 * Anything behind a hub that opens and closes: a valve, but also a watering
 * timer (MST100), which is a plain relay as far as the hub is concerned.
 */
function hasToggle(sub) {
  return Boolean(sub.state?.togglex) || hasThermostat(sub) || isWateringTimer(sub);
}

/**
 * A watering timer (MST100 on an MSH400 sprinkler hub).
 *
 * Detected by type alone, unlike the other kinds: a timer reports nothing but
 * `togglex` and `battery`, which is indistinguishable from a generic relay.
 */
function isWateringTimer(sub) {
  return Boolean(sub.type?.startsWith('mst'));
}

/** A water leak sensor (MS400 / MS405). */
function hasLeak(sub) {
  return Boolean(sub.state?.waterLeak) || sub.type?.startsWith('ms4');
}

/** A door/window opening sensor (MS200). */
function hasOpening(sub) {
  return Boolean(sub.state?.doorWindow) || sub.type?.startsWith('ms200');
}

/** Nearly every sub-device runs on a battery and reports its level. */
function hasBattery(sub) {
  return sub.state?.battery?.value !== undefined;
}

// --- Discovery ---------------------------------------------------------------

/**
 * One Gladys device per sub-device. The hub itself is deliberately absent: it
 * has nothing the user can read or act on.
 */
export function buildGladysDevices(gladys, device, config) {
  const devices = [];

  for (const sub of device.subDevices?.values() ?? []) {
    const ids = deviceIds(gladys, subDevicePlatformId(device.uuid, sub.id));
    const features = buildSubDeviceFeatures(sub, ids);

    if (features.length === 0) {
      logger.info(
        `Skipping sub-device "${sub.name}" (${sub.type || 'unknown type'}) of hub ` +
          `${device.name}: no feature could be derived from ${JSON.stringify(sub.state ?? {})}`,
      );
      continue;
    }

    devices.push({
      name: sub.name,
      external_id: ids.device,
      poll_frequency: normalizePollFrequency(config.poll_frequency),
      features,
      params: [
        { name: 'MEROSS_UUID', value: String(device.uuid) },
        { name: 'MEROSS_HUB', value: String(device.name) },
        { name: 'MEROSS_SUBDEVICE_ID', value: String(sub.id) },
        { name: 'MEROSS_MODEL', value: String(sub.type || 'unknown') },
      ],
    });
  }

  return devices;
}

export function buildSubDeviceFeatures(sub, ids) {
  const features = [];

  if (hasTempHum(sub)) {
    features.push(
      {
        name: 'Temperature',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.TEMPERATURE, 0)),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -30,
        max: 70,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Humidity',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.HUMIDITY, 0)),
        category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    );
  }

  if (hasThermostat(sub)) {
    const temperature = sub.state?.temperature ?? {};
    features.push(
      {
        name: 'Target temperature',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.TARGET_TEMPERATURE, 0)),
        category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
        type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        // The valve publishes the range it accepts; fall back to the usual one.
        min: fromDeciUnit(temperature.min) ?? 5,
        max: fromDeciUnit(temperature.max) ?? 35,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      },
      {
        name: 'Room temperature',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.TEMPERATURE, 0)),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -30,
        max: 70,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    );
  }

  if (isWateringTimer(sub)) {
    features.push(
      {
        name: 'Watering',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.WATERING, 0)),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: false,
        // The timer does report whether it is watering, through
        // `Appliance.Control.Water` — so a cycle started from the Meross app or
        // by the device's own schedule shows up here too.
        has_feedback: true,
        keep_history: true,
      },
      {
        name: 'Watering duration',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.WATERING_DURATION, 0)),
        category: DEVICE_FEATURE_CATEGORIES.DURATION,
        type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        unit: DEVICE_FEATURE_UNITS.MINUTES,
        min: WATERING_DURATION_MIN,
        max: WATERING_DURATION_MAX,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      },
    );
  }

  if (hasToggle(sub)) {
    features.push({
      // On a watering timer this switch is NOT a watering trigger: the device
      // accepts and adopts it, but nothing is watered. It enables the timer, so
      // name it for what it does — "On/Off" invites the wrong expectation.
      name: isWateringTimer(sub) ? 'Timer enabled' : 'On/Off',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.ON_OFF, 0)),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }

  if (hasLeak(sub)) {
    features.push({
      name: 'Water leak',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.LEAK, 0)),
      category: DEVICE_FEATURE_CATEGORIES.LEAK_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  if (hasOpening(sub)) {
    features.push({
      name: 'Opening',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.OPENING, 0)),
      category: DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  if (hasBattery(sub)) {
    features.push({
      name: 'Battery',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.BATTERY, 0)),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  return features;
}

// --- Reading states ----------------------------------------------------------

/**
 * States of every sub-device, each tagged with the platform id of the Gladys
 * device it belongs to (the hub owns several).
 */
export function buildStateEntries(device) {
  const entries = [];

  for (const sub of device.subDevices?.values() ?? []) {
    const platformId = subDevicePlatformId(device.uuid, sub.id);
    for (const { featureKey, state } of buildSubDeviceStates(sub)) {
      entries.push({ platformId, featureKey, state });
    }
  }

  return entries;
}

export function buildSubDeviceStates(sub) {
  const states = [];
  const state = sub.state ?? {};

  const temperature = fromDeciUnit(state.tempHum?.latestTemperature);
  if (temperature !== null) {
    states.push({ featureKey: buildFeatureKey(FEATURE_KIND.TEMPERATURE, 0), state: temperature });
  }

  const humidity = fromDeciUnit(state.tempHum?.latestHumidity);
  if (humidity !== null) {
    states.push({ featureKey: buildFeatureKey(FEATURE_KIND.HUMIDITY, 0), state: humidity });
  }

  const room = fromDeciUnit(state.temperature?.room);
  if (room !== null) {
    states.push({ featureKey: buildFeatureKey(FEATURE_KIND.TEMPERATURE, 0), state: room });
  }

  const target = fromDeciUnit(state.temperature?.currentSet);
  if (target !== null) {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.TARGET_TEMPERATURE, 0),
      state: target,
    });
  }

  if (state.togglex?.onoff !== undefined) {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.ON_OFF, 0),
      state: Number(state.togglex.onoff) === 1 ? 1 : 0,
    });
  }

  if (state.waterLeak?.latestWaterLeak !== undefined) {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.LEAK, 0),
      state: Number(state.waterLeak.latestWaterLeak) === 1 ? 1 : 0,
    });
  }

  if (state.doorWindow?.status !== undefined) {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.OPENING, 0),
      state: Number(state.doorWindow.status) === 1 ? 1 : 0,
    });
  }

  if (isWateringTimer(sub)) {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.WATERING_DURATION, 0),
      state: wateringDuration(sub),
    });

    // `Appliance.Control.Water` carries the real cycle state, both on poll and
    // on push: `onoff` is 1 while watering and 2 once stopped. Publishing that
    // rather than the value we commanded is what catches a watering started
    // from the Meross app or by the timer's own schedule.
    const onoff = Number(state.control?.onoff);
    if (Number.isFinite(onoff)) {
      states.push({
        featureKey: buildFeatureKey(FEATURE_KIND.WATERING, 0),
        state: onoff === WATER_ONOFF.START ? 1 : 0,
      });
    }
  }

  const battery = Number(state.battery?.value);
  if (Number.isFinite(battery)) {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.BATTERY, 0),
      state: Math.max(0, Math.min(100, Math.round(battery))),
    });
  }

  return states;
}

// --- Commands ----------------------------------------------------------------

export async function onSetValue(client, { gladys, device, subDeviceId, kind, value, config }) {
  if (!subDeviceId) {
    throw new Error(`A hub feature must address a sub-device (${device.name})`);
  }

  switch (kind) {
    case FEATURE_KIND.WATERING: {
      const sub = device.subDevices?.get(subDeviceId);
      const start = Number(value) === 1;
      const minutes = wateringDuration(sub, config);

      requireAbility(device, NAMESPACE.CONTROL_WATER, subDeviceId);
      // Normal routing — LAN when it answers, cloud otherwise. This namespace
      // looked LAN-only for a while because it kept timing out over MQTT, but
      // the cause was the payload shape: it is keyed `control` and targets the
      // sub-device by `subId`, and anything else is answered with silence.
      await client.request(
        device.uuid,
        NAMESPACE.CONTROL_WATER,
        METHOD.SET,
        buildWaterControlPayload({
          subId: subDeviceId,
          durationSeconds: minutes * 60,
          start,
        }),
      );

      logger.info(
        start
          ? `Watering started on ${subDeviceId} for ${minutes} min`
          : `Watering stopped on ${subDeviceId}`,
      );

      scheduleWateringStop(gladys, device, subDeviceId, start ? minutes * 60 : 0);
      return start ? 1 : 0;
    }

    case FEATURE_KIND.WATERING_DURATION: {
      const minutes = normalizeWateringDuration(value);
      const sub = device.subDevices?.get(subDeviceId);
      if (sub) {
        // Held per timer, so several timers can water for different lengths.
        sub.wateringDurationMinutes = minutes;
      }
      return minutes;
    }

    case FEATURE_KIND.ON_OFF: {
      const onoff = Number(value) === 1 ? 1 : 0;
      requireAbility(device, NAMESPACE.HUB_TOGGLEX, subDeviceId);
      await client.request(device.uuid, NAMESPACE.HUB_TOGGLEX, METHOD.SET, {
        togglex: [{ id: subDeviceId, onoff, channel: 0 }],
      });
      return confirmToggle(client, device, subDeviceId, onoff);
    }

    case FEATURE_KIND.TARGET_TEMPERATURE: {
      const celsius = Number(value);
      if (!Number.isFinite(celsius)) {
        throw new Error(`Invalid target temperature for ${device.name}`);
      }
      requireAbility(device, NAMESPACE.HUB_MTS100_TEMPERATURE, subDeviceId);
      // The valve expects tenths of a degree, in the `custom` preset.
      await client.request(device.uuid, NAMESPACE.HUB_MTS100_TEMPERATURE, METHOD.SET, {
        temperature: [{ id: subDeviceId, custom: toDeciUnit(celsius) }],
      });
      return celsius;
    }

    default:
      throw new Error(`Feature ${kind} is read-only on sub-device ${subDeviceId}`);
  }
}

/** How long a sub-device is given to adopt a command before we read it back. */
const SETTLE_DELAY_MS = 600;

/**
 * Watering duration for one timer, in minutes.
 *
 * Three sources, most specific first: what the user set in Gladys for THIS
 * timer, then what the timer itself holds (`dura`, in seconds — it remembers
 * the last duration it was given, so this survives a restart of the
 * integration), then the integration-wide default.
 */
export function wateringDuration(sub, config) {
  if (sub?.wateringDurationMinutes !== undefined) {
    return normalizeWateringDuration(sub.wateringDurationMinutes);
  }

  const seconds = Number(sub?.state?.control?.dura);
  if (Number.isFinite(seconds) && seconds > 0) {
    return normalizeWateringDuration(Math.round(seconds / 60));
  }

  return normalizeWateringDuration(config?.watering_duration);
}

/**
 * Turn the Watering switch back off when the watering ends.
 *
 * The timer waters for `dura` seconds and stops by itself. The next poll of
 * `Appliance.Control.Water` sees that and is the authority, but a poll can be a
 * whole minute away — this simply spares the user a switch left visibly on
 * after the water has stopped. Starting a new watering, or stopping one,
 * replaces the pending timer.
 */
function scheduleWateringStop(gladys, device, subDeviceId, durationSeconds) {
  const sub = device.subDevices?.get(subDeviceId);
  if (!sub) {
    return;
  }

  clearTimeout(sub.wateringTimer);
  sub.wateringTimer = undefined;

  if (durationSeconds <= 0) {
    return;
  }

  const externalId = deviceIds(gladys, subDevicePlatformId(device.uuid, subDeviceId)).feature(
    buildFeatureKey(FEATURE_KIND.WATERING, 0),
  );

  sub.wateringTimer = setTimeout(() => {
    sub.wateringTimer = undefined;
    logger.info(`Watering finished on ${subDeviceId}`);
    gladys
      .publishState(externalId, 0)
      .catch((err) => logger.error(`Could not clear the watering state of ${subDeviceId}`, err));
  }, durationSeconds * 1000);

  // Never keep the process alive just to clear a switch.
  sub.wateringTimer.unref?.();
}

/**
 * Read the sub-device back and return the state it ACTUALLY holds.
 *
 * A hub can accept a message — no error, no refusal — and the sub-device still
 * not act on it. That is what a watering timer does with a plain on/off: the
 * command is acknowledged and ignored. Publishing the REQUESTED value there
 * makes Gladys show a switch that flips on and then falls back on the next
 * poll, with nothing to explain why.
 *
 * So the requested value is never assumed: it is read back and the truth is
 * published, with a warning naming the mismatch.
 */
async function confirmToggle(client, device, subDeviceId, requested) {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));

  try {
    // Force a fresh read: the coalescing window would otherwise return the
    // state cached just before the command.
    await client.refreshSubDeviceStates(device, { maxAgeMs: 0 });
  } catch (err) {
    // The command was accepted; only the verification failed. Report what was
    // asked for rather than inventing a state.
    logger.warn(`Could not read ${subDeviceId} back after the command`, err);
    return requested;
  }

  const actual = device.subDevices?.get(subDeviceId)?.state?.togglex?.onoff;
  if (actual === undefined) {
    return requested;
  }

  const applied = Number(actual) === 1 ? 1 : 0;
  if (applied !== requested) {
    logger.warn(
      `Sub-device ${subDeviceId} did not adopt on/off=${requested} (still ${applied}). ` +
        `The hub accepted the message but the device ignored it — a watering timer, ` +
        `for instance, cannot be started by a plain on/off.`,
    );
  }

  return applied;
}

/**
 * Refuse to send a namespace the hub does not advertise.
 *
 * Sending it anyway is worse than failing: a hub answers an unsupported
 * namespace with an error reply, and before that reply was surfaced the command
 * looked like it had worked while nothing moved. Failing here names the
 * namespace that is missing and lists what the hub DOES offer, which is the
 * information needed to add support for the sub-device.
 */
function requireAbility(device, namespace, subDeviceId) {
  if (namespace in (device.ability ?? {})) {
    return;
  }
  const available = Object.keys(device.ability ?? {})
    .filter(isHubNamespace)
    .join(', ');
  throw new Error(
    `Hub "${device.name}" does not support ${namespace}, needed to control sub-device ` +
      `${subDeviceId}. Hub namespaces available: ${available || 'none'}`,
  );
}

/**
 * Refresh the sub-device values from the hub. The cloud sub-device LIST is not
 * re-read here: names and pairings change when the user acts in the Meross app,
 * which the "Refresh the device list" action already covers.
 */
export async function poll(client, device, config) {
  // Coalesce only the burst of simultaneous sub-device polls — never longer
  // than half the interval the user asked for, so a fast setting stays fast.
  const pollFrequency = normalizePollFrequency(config?.poll_frequency);
  await client.refreshSubDeviceStates(device, { maxAgeMs: Math.min(5000, pollFrequency / 2) });
  return [];
}
