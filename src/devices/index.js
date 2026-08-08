// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike a fixed-hardware integration, the device list here is DISCOVERED: it
// is whatever the Meross account holds. So instead of one module per physical
// device, this registry holds one module per KIND of device, and every module
// answers the same four questions:
//
//   matches(device)              -> is this mine?
//   buildFeatures(device, ids)   -> which Gladys features does it expose?
//   buildStates(device)          -> which values can I read from the digest?
//   onSetValue(client, {...})    -> run a command
//
// Kinds are matched on the ABILITIES the firmware advertises
// (`Appliance.System.Ability`), never on a model name. A Meross reference
// released tomorrow that toggles a relay is recognised as a plug on day one.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import * as plug from './plug.js';
import * as light from './light.js';
import * as garageDoor from './garageDoor.js';
import { deviceIds, parseFeatureExternalId } from './featureIds.js';

const logger = createLogger({ name: 'devices' });

/**
 * Order matters: a light also advertises `ToggleX`, so it must be tested
 * before the plug kind, which deliberately claims everything else that toggles.
 */
export const DEVICE_KINDS = [light, garageDoor, plug];

/** Find the kind that owns a Meross device, or null when unsupported. */
export function findKind(device) {
  return DEVICE_KINDS.find((kind) => kind.matches(device)) ?? null;
}

/**
 * Build the Gladys discovery payload for every supported device of the account.
 *
 * A device the integration cannot model yet is skipped with a log line rather
 * than published as an empty shell: an empty device in the UI is worse than no
 * device at all.
 */
export function buildDiscoveredDevices(gladys, merossDevices, config) {
  const devices = [];

  for (const device of merossDevices) {
    const kind = findKind(device);
    if (!kind) {
      logger.info(
        `Skipping unsupported Meross device "${device.name}" (${device.type}): ` +
          `no matching device kind for its abilities`,
      );
      continue;
    }

    const ids = deviceIds(gladys, device.uuid);
    const features = kind.buildFeatures(device, ids);
    if (features.length === 0) {
      logger.info(`Skipping "${device.name}" (${device.type}): no usable feature`);
      continue;
    }

    devices.push({
      name: device.name,
      external_id: ids.device,
      // Only devices with something to poll get a frequency: an on/off-only
      // plug is entirely push-driven and does not need to be woken up.
      ...(shouldPoll(device, kind) ? { poll_frequency: config.poll_frequency } : {}),
      features,
      params: buildParams(device),
    });
  }

  return devices;
}

/** True when the device has values that only a poll can bring back. */
export function shouldPoll(device, kind = findKind(device)) {
  return kind === plug && (plug.hasElectricity(device) || plug.hasConsumption(device));
}

/** Free-form metadata, shown in the device page in Gladys. */
function buildParams(device) {
  const params = [
    { name: 'MEROSS_UUID', value: String(device.uuid) },
    { name: 'MEROSS_MODEL', value: String(device.type ?? 'unknown') },
  ];
  if (device.firmwareVersion) {
    params.push({ name: 'MEROSS_FIRMWARE', value: String(device.firmwareVersion) });
  }
  if (device.ip) {
    params.push({ name: 'MEROSS_LAN_IP', value: String(device.ip) });
  }
  return params;
}

/**
 * Turn the states a kind read from the digest into the batch payload of
 * `gladys.publishStates()`.
 */
export function toGladysStates(gladys, device, states) {
  const ids = deviceIds(gladys, device.uuid);
  return states.map(({ featureKey, state }) => ({
    device_feature_external_id: ids.feature(featureKey),
    state,
  }));
}

/**
 * Publish everything currently known about a device (from the cached digest).
 * Used right after discovery and on every real-time push.
 */
export async function publishDeviceStates(gladys, device) {
  const kind = findKind(device);
  if (!kind) {
    return;
  }

  const states = toGladysStates(gladys, device, kind.buildStates(device));
  if (states.length > 0) {
    await gladys.publishStates(states);
  }
}

/**
 * Route a Gladys command to the right kind.
 *
 * Throwing here is meaningful: the SDK turns it into a `success: false`
 * acknowledgement and Gladys shows the failure to the user, instead of
 * pretending the light changed.
 */
export async function handleSetValue(gladys, client, { device: gladysDevice, feature, value }) {
  const merossDevice = findMerossDevice(gladys, client, gladysDevice.external_id);
  const parsed = parseFeatureExternalId(feature.external_id);
  if (!parsed) {
    throw new Error(`Unreadable feature external_id ${feature.external_id}`);
  }

  const kind = findKind(merossDevice);
  if (!kind || typeof kind.onSetValue !== 'function') {
    throw new Error(`No command handler for ${gladysDevice.external_id}`);
  }

  const applied = await kind.onSetValue(client, {
    device: merossDevice,
    kind: parsed.kind,
    channel: parsed.channel,
    value,
  });

  // `has_feedback` is true on every controllable feature: publish the state the
  // device actually settled on. A push may confirm it again a moment later,
  // which is harmless and keeps Gladys right even if the command was clamped.
  if (applied !== undefined) {
    await gladys.publishState(feature.external_id, applied);
  }
}

/** Refresh one device on Gladys' schedule. */
export async function handlePoll(gladys, client, gladysDevice) {
  const merossDevice = findMerossDevice(gladys, client, gladysDevice.external_id);
  const kind = findKind(merossDevice);
  if (!kind) {
    return;
  }

  // The digest carries on/off, brightness, door position...
  await client.fetchState(merossDevice.uuid);
  const states = kind.buildStates(merossDevice);

  // ...but electricity and energy have to be asked for separately.
  if (typeof kind.poll === 'function') {
    states.push(...(await kind.poll(client, merossDevice)));
  }

  const payload = toGladysStates(gladys, merossDevice, states);
  if (payload.length > 0) {
    await gladys.publishStates(payload);
  }
}

/**
 * Resolve a Gladys device external_id back to the Meross device it describes.
 * The uuid is the last segment, which is why the id scheme is worth keeping
 * boring (see featureIds.js).
 */
export function findMerossDevice(gladys, client, deviceExternalId) {
  const uuid = deviceExternalId.slice(deviceExternalId.lastIndexOf(':') + 1);
  const device = client.getDevice(uuid);
  if (!device) {
    throw new Error(`Unknown Meross device for ${deviceExternalId}`);
  }
  return device;
}
