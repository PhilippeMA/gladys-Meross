// -----------------------------------------------------------------------------
// Device kind: LIGHT  (MSL120 bulbs, MSL320 strips, MSL430 ambient lights...)
//
// A Meross light is driven through `Appliance.Control.Light`, whose payload
// carries a `capacity` bitmask telling WHICH channel of the light the message
// is about: color (RGB), white temperature, or brightness (luminance).
//
//   { "light": { "channel": 0, "capacity": 4, "luminance": 70 } }
//
// Setting the color switches the bulb to color mode, setting the temperature
// switches it to white mode — that is the hardware behaviour, not a choice
// made here.
//
// Value ranges:
//   - luminance  : Meross 1-100  -> Gladys brightness 0-100 %   (direct)
//   - rgb        : Meross 24-bit -> Gladys color 24-bit integer (direct)
//   - temperature: Meross 1-100, exposed as-is (0 = warmest, 100 = coolest)
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { LIGHT_CAPACITY, METHOD, NAMESPACE, toRgbInt } from '../meross/protocol.js';
import { buildFeatureKey, FEATURE_KIND } from './featureIds.js';

export const KIND = 'light';

/** Assumed capabilities when the firmware does not advertise any. */
const DEFAULT_CAPACITY = LIGHT_CAPACITY.RGB | LIGHT_CAPACITY.TEMPERATURE | LIGHT_CAPACITY.LUMINANCE;

export function matches(device) {
  return NAMESPACE.CONTROL_LIGHT in device.ability;
}

/**
 * Which light channels this device really has.
 *
 * The `capacity` found in the DIGEST reflects the mode the bulb is in right
 * now (color vs white), so relying on it would make features appear and
 * disappear between two polls. The ability declaration is stable, so it wins;
 * the digest is only a fallback, and brightness is always assumed — every
 * Meross light dims.
 */
export function readCapacity(device) {
  const declared = device.ability?.[NAMESPACE.CONTROL_LIGHT]?.capacity;
  const capacity = Number.isInteger(declared) ? declared : DEFAULT_CAPACITY;
  return capacity | LIGHT_CAPACITY.LUMINANCE;
}

export function buildFeatures(device, ids) {
  const capacity = readCapacity(device);
  const features = [
    {
      name: 'On/Off',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.ON_OFF, 0)),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
  ];

  if (capacity & LIGHT_CAPACITY.LUMINANCE) {
    features.push({
      name: 'Brightness',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.BRIGHTNESS, 0)),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BRIGHTNESS,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }

  if (capacity & LIGHT_CAPACITY.RGB) {
    features.push({
      name: 'Color',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.COLOR, 0)),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.COLOR,
      min: 0,
      max: 16777215,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }

  if (capacity & LIGHT_CAPACITY.TEMPERATURE) {
    features.push({
      name: 'Color temperature',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.COLOR_TEMPERATURE, 0)),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.TEMPERATURE,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }

  return features;
}

export function buildStates(device) {
  const states = [];
  const light = device.digest?.light ?? {};
  const capacity = readCapacity(device);

  // On/off lives in `togglex` on every current firmware, and inside the light
  // payload on the oldest ones.
  const togglex = Array.isArray(device.digest?.togglex)
    ? device.digest.togglex.find((entry) => Number(entry?.channel ?? 0) === 0)
    : null;
  const onoff = togglex ? togglex.onoff : light.onoff;
  if (onoff !== undefined) {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.ON_OFF, 0),
      state: Number(onoff) === 1 ? 1 : 0,
    });
  }

  if (capacity & LIGHT_CAPACITY.LUMINANCE && Number.isFinite(Number(light.luminance))) {
    states.push({
      featureKey: buildFeatureKey(FEATURE_KIND.BRIGHTNESS, 0),
      state: clamp(Number(light.luminance), 0, 100),
    });
  }

  // Only report the channel the bulb is currently using: a white bulb has no
  // meaningful `rgb`, and a color bulb has no meaningful `temperature`.
  const currentCapacity = Number(light.capacity);
  if (capacity & LIGHT_CAPACITY.RGB && Number.isFinite(Number(light.rgb))) {
    if (!Number.isFinite(currentCapacity) || currentCapacity & LIGHT_CAPACITY.RGB) {
      states.push({
        featureKey: buildFeatureKey(FEATURE_KIND.COLOR, 0),
        state: toRgbInt(light.rgb),
      });
    }
  }

  if (capacity & LIGHT_CAPACITY.TEMPERATURE && Number.isFinite(Number(light.temperature))) {
    if (!Number.isFinite(currentCapacity) || currentCapacity & LIGHT_CAPACITY.TEMPERATURE) {
      states.push({
        featureKey: buildFeatureKey(FEATURE_KIND.COLOR_TEMPERATURE, 0),
        state: clamp(Number(light.temperature), 0, 100),
      });
    }
  }

  return states;
}

export async function onSetValue(client, { device, kind, channel, value }) {
  switch (kind) {
    case FEATURE_KIND.ON_OFF:
      return setPower(client, device, channel, Number(value) === 1 ? 1 : 0);

    case FEATURE_KIND.BRIGHTNESS: {
      const luminance = clamp(Math.round(Number(value)), 0, 100);
      // Meross rejects luminance 0: dragging the slider to zero means "off".
      if (luminance === 0) {
        return setPower(client, device, channel, 0);
      }
      await setLight(client, device, channel, LIGHT_CAPACITY.LUMINANCE, { luminance });
      return luminance;
    }

    case FEATURE_KIND.COLOR: {
      const rgb = toRgbInt(value);
      await setLight(client, device, channel, LIGHT_CAPACITY.RGB, { rgb });
      return rgb;
    }

    case FEATURE_KIND.COLOR_TEMPERATURE: {
      const temperature = clamp(Math.round(Number(value)), 1, 100);
      await setLight(client, device, channel, LIGHT_CAPACITY.TEMPERATURE, { temperature });
      return temperature;
    }

    default:
      throw new Error(`Unsupported light feature ${kind} on ${device.name}`);
  }
}

async function setPower(client, device, channel, onoff) {
  if (NAMESPACE.CONTROL_TOGGLEX in device.ability) {
    await client.request(device.uuid, NAMESPACE.CONTROL_TOGGLEX, METHOD.SET, {
      togglex: { channel, onoff },
    });
  } else {
    await client.request(device.uuid, NAMESPACE.CONTROL_LIGHT, METHOD.SET, {
      light: { channel, onoff },
    });
  }
  return onoff;
}

/**
 * Send one light channel. `capacity` tells the bulb which field of the payload
 * it must actually apply.
 */
async function setLight(client, device, channel, capacity, fields) {
  await client.request(device.uuid, NAMESPACE.CONTROL_LIGHT, METHOD.SET, {
    light: { channel, capacity, ...fields },
  });
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
