// -----------------------------------------------------------------------------
// Device kind: GARAGE DOOR OPENER  (MSG100, MSG200...)
//
// Driven through `Appliance.GarageDoor.State`:
//   SET { "state": { "channel": 0, "open": 1, "uuid": "<device uuid>" } }
//
// The `uuid` inside the payload is NOT redundant with the topic: the MSG200
// drives three doors and identifies them that way, and the firmware rejects a
// state message without it.
//
// One controllable feature models the door: 1 = open, 0 = closed. The opener
// reports the real position back (it has a reed sensor), so `has_feedback` is
// true and the value the user sees is the door's actual state, not the command
// that was sent.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { METHOD, NAMESPACE } from '../meross/protocol.js';
import { buildFeatureKey, FEATURE_KIND } from './featureIds.js';

export const KIND = 'garage-door';

export function matches(device) {
  return NAMESPACE.GARAGE_DOOR_STATE in device.ability;
}

/** A multi-door opener exposes one entry per door in its digest. */
export function doorCount(device) {
  const doors = device.digest?.garageDoor;
  if (Array.isArray(doors) && doors.length > 0) {
    return doors.length;
  }
  return Math.max(1, device.channelCount);
}

export function buildFeatures(device, ids) {
  const features = [];
  const count = doorCount(device);

  for (let channel = 0; channel < count; channel += 1) {
    features.push({
      name: count > 1 ? `Door ${channel + 1}` : 'Garage door',
      external_id: ids.feature(buildFeatureKey(FEATURE_KIND.DOOR, channel)),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }

  return features;
}

export function buildStates(device) {
  const doors = device.digest?.garageDoor;
  if (!Array.isArray(doors)) {
    return [];
  }

  return doors
    .filter((door) => door && typeof door === 'object')
    .map((door) => ({
      featureKey: buildFeatureKey(FEATURE_KIND.DOOR, Number(door.channel ?? 0)),
      state: Number(door.open) === 1 ? 1 : 0,
    }));
}

export async function onSetValue(client, { device, kind, channel, value }) {
  if (kind !== FEATURE_KIND.DOOR) {
    throw new Error(`Unsupported garage door feature ${kind} on ${device.name}`);
  }

  const open = Number(value) === 1 ? 1 : 0;

  await client.request(device.uuid, NAMESPACE.GARAGE_DOOR_STATE, METHOD.SET, {
    state: { channel, open, uuid: device.uuid },
  });

  // The door takes several seconds to travel; the opener pushes its real
  // position when it gets there, which is what finally reaches Gladys.
  return open;
}
