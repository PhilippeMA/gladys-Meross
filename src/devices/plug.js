// -----------------------------------------------------------------------------
// Device kind: PLUG / SWITCH  (MSS110, MSS210, MSS310, MSS425, MSS550...)
//
// Covers every Meross relay: single smart plugs, wall switches, and
// multi-outlet power strips (one on/off feature per outlet, all under a single
// Gladys device).
//
// The power-monitoring references advertise a metering namespace, and there are
// TWO generations of each — a device carries one or the other, never both:
//
//   live values   Appliance.Control.Electricity   |  Appliance.Control.ElectricityX
//   energy        Appliance.Control.ConsumptionX  |  Appliance.Control.ConsumptionH
//
// Matching only the older pair is why an MOP320 came up as a bare on/off switch:
// it advertises ElectricityX and ConsumptionH, so every metering feature was
// silently skipped. Detection is by capability, so a plain MSS110 still stays a
// plain on/off device.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { METHOD, NAMESPACE, normalizeElectricity } from '../meross/protocol.js';
import { createLogger } from '@gladysassistant/integration-sdk';
import { buildFeatureKey, FEATURE_KIND } from './featureIds.js';

const logger = createLogger({ name: 'plug' });

export const KIND = 'plug';

/** A relay is anything that can be toggled but is not a light. */
export function matches(device) {
  const hasToggle =
    NAMESPACE.CONTROL_TOGGLEX in device.ability || NAMESPACE.CONTROL_TOGGLE in device.ability;
  return hasToggle && !(NAMESPACE.CONTROL_LIGHT in device.ability);
}

/** True when the device reports live electricity measurements, either generation. */
export function hasElectricity(device) {
  return (
    NAMESPACE.CONTROL_ELECTRICITY in device.ability ||
    NAMESPACE.CONTROL_ELECTRICITYX in device.ability
  );
}

/** True when the device keeps an energy history, either generation. */
export function hasConsumption(device) {
  return (
    NAMESPACE.CONTROL_CONSUMPTIONX in device.ability ||
    NAMESPACE.CONTROL_CONSUMPTIONH in device.ability
  );
}

/**
 * Human name of one outlet. A power strip exposes its master as channel 0
 * ("all outlets"), then one entry per physical socket.
 */
export function channelName(device, channel) {
  if (device.channelCount <= 1) {
    return 'On/Off';
  }
  const declared = device.channelNames?.[channel];
  if (declared) {
    return declared;
  }
  return channel === 0 ? 'All outlets' : `Outlet ${channel}`;
}

export function buildFeatures(device, ids) {
  const features = [];

  for (let channel = 0; channel < device.channelCount; channel += 1) {
    features.push({
      name: channelName(device, channel),
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.ON_OFF, channel)),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }

  // Measurements always describe the whole device: channel 0.
  if (hasElectricity(device)) {
    features.push(
      {
        name: 'Power',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.POWER, 0)),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
        unit: DEVICE_FEATURE_UNITS.WATT,
        min: 0,
        max: 3680,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Voltage',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.VOLTAGE, 0)),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
        unit: DEVICE_FEATURE_UNITS.VOLT,
        min: 0,
        max: 260,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Current',
        external_id: ids.feature(buildFeatureKey(FEATURE_KIND.CURRENT, 0)),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
        unit: DEVICE_FEATURE_UNITS.AMPERE,
        min: 0,
        max: 16,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    );
  }

  if (hasConsumption(device)) {
    features.push({
      name: 'Energy today',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.ENERGY_TODAY, 0)),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  return features;
}

/**
 * Read the on/off state of every channel out of the cached digest.
 * Modern firmware reports `togglex` (per channel); the oldest one reports a
 * single `toggle` object.
 */
export function buildStates(device) {
  const states = [];
  const togglex = device.digest?.togglex;

  if (Array.isArray(togglex)) {
    for (const entry of togglex) {
      const channel = Number(entry?.channel ?? 0);
      if (channel < device.channelCount) {
        states.push({
          featureKey: buildFeatureKey(FEATURE_KIND.ON_OFF, channel),
          state: Number(entry?.onoff) === 1 ? 1 : 0,
        });
      }
    }
    return states;
  }

  const toggle = device.digest?.toggle;
  if (toggle && typeof toggle === 'object') {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.ON_OFF, 0),
      state: Number(toggle.onoff) === 1 ? 1 : 0,
    });
  }

  return states;
}

/** Turn a channel on or off. */
export async function onSetValue(client, { device, kind, channel, value }) {
  if (kind !== FEATURE_KIND.ON_OFF) {
    throw new Error(`Feature ${kind} is read-only on ${device.name}`);
  }

  const onoff = Number(value) === 1 ? 1 : 0;

  if (NAMESPACE.CONTROL_TOGGLEX in device.ability) {
    await client.request(device.uuid, NAMESPACE.CONTROL_TOGGLEX, METHOD.SET, {
      togglex: { channel, onoff },
    });
  } else {
    await client.request(device.uuid, NAMESPACE.CONTROL_TOGGLE, METHOD.SET, {
      toggle: { onoff },
    });
  }

  return onoff;
}

/**
 * Poll the measurements the digest does NOT carry: electricity is only
 * available on demand, and the energy history needs its own namespace.
 */
export async function poll(client, device) {
  const states = [];

  if (hasElectricity(device)) {
    // The client says which generation answered, because the caller cannot
    // scale the numbers without it: the two disagree on volts by 100x.
    const measured = await client.fetchElectricity(device.uuid, 0);
    if (measured) {
      const { power, voltage, current } = normalizeElectricity(
        measured.reading,
        measured.namespace,
      );
      states.push(
        { featureKey: buildFeatureKey(FEATURE_KIND.POWER, 0), state: power },
        { featureKey: buildFeatureKey(FEATURE_KIND.VOLTAGE, 0), state: voltage },
        { featureKey: buildFeatureKey(FEATURE_KIND.CURRENT, 0), state: current },
      );
    }
  }

  const today = await readEnergyToday(client, device);
  if (today !== null) {
    states.push({ featureKey: buildFeatureKey(FEATURE_KIND.ENERGY_TODAY, 0), state: today });
  }

  return states;
}

/** Today's energy in kWh, from whichever history namespace the device has. */
async function readEnergyToday(client, device) {
  if (NAMESPACE.CONTROL_CONSUMPTIONX in device.ability) {
    return readTodayConsumption(await client.fetchConsumption(device.uuid));
  }

  if (NAMESPACE.CONTROL_CONSUMPTIONH in device.ability) {
    const entry = await client.fetchConsumptionH(device.uuid, 0);
    const today = readTodayConsumptionH(entry);
    if (today === null && entry) {
      logger.debug(`${device.name} reported no hourly energy for today: ${JSON.stringify(entry)}`);
    }
    return today;
  }

  return null;
}

/**
 * Pick today's entry out of a `consumptionx` history.
 *
 * Meross returns one entry per day as `{ date: 'YYYY-MM-DD', time, value }`
 * where `value` is in watt-hours; Gladys wants kWh.
 */
export function readTodayConsumption(history, now = new Date()) {
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const entry = history.find((item) => item?.date === today) ?? history[history.length - 1];

  const wattHours = Number(entry?.value);
  if (!Number.isFinite(wattHours)) {
    return null;
  }
  return Math.round(wattHours) / 1000;
}

/**
 * Add up today's hourly buckets from a `consumptionH` entry.
 *
 * `{ channel, total, data: [{ timestamp, value }] }` — `value` is watt-hours
 * per hour-long bucket, `timestamp` a Unix epoch, and the window covers roughly
 * the last day. Summing the buckets that fall on the current local day is what
 * makes this comparable to the per-day figure the older namespace gives.
 *
 * `total` is deliberately ignored: nothing confirms whether it counts the
 * window, the day or the month, and a wrong energy figure is worse than none.
 */
export function readTodayConsumptionH(entry, now = new Date()) {
  const data = entry?.data;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  let wattHours = 0;
  let counted = 0;

  for (const bucket of data) {
    const timestamp = Number(bucket?.timestamp);
    const value = Number(bucket?.value);
    if (!Number.isFinite(timestamp) || !Number.isFinite(value) || timestamp < start) {
      continue;
    }
    wattHours += value;
    counted += 1;
  }

  return counted === 0 ? null : Math.round(wattHours) / 1000;
}

function pad(value) {
  return String(value).padStart(2, '0');
}
