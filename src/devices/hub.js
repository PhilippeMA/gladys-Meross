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
import { fromDeciUnit, isHubNamespace, METHOD, NAMESPACE, toDeciUnit } from '../meross/protocol.js';
import { normalizePollFrequency } from '../config.js';
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
  return Boolean(sub.state?.togglex) || hasThermostat(sub) || sub.type?.startsWith('mst1');
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

  if (hasToggle(sub)) {
    features.push({
      name: 'On/Off',
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

export async function onSetValue(client, { device, subDeviceId, kind, value }) {
  if (!subDeviceId) {
    throw new Error(`A hub feature must address a sub-device (${device.name})`);
  }

  switch (kind) {
    case FEATURE_KIND.ON_OFF: {
      const onoff = Number(value) === 1 ? 1 : 0;
      await client.request(device.uuid, NAMESPACE.HUB_TOGGLEX, METHOD.SET, {
        togglex: [{ id: subDeviceId, onoff, channel: 0 }],
      });
      return onoff;
    }

    case FEATURE_KIND.TARGET_TEMPERATURE: {
      const celsius = Number(value);
      if (!Number.isFinite(celsius)) {
        throw new Error(`Invalid target temperature for ${device.name}`);
      }
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
