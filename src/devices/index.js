// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike a fixed-hardware integration, the device list here is DISCOVERED: it
// is whatever the Meross account holds. So instead of one module per physical
// device, this registry holds one module per KIND of device, and every module
// answers the same questions:
//
//   matches(device)              -> is this mine?
//   buildFeatures(device, ids)   -> which Gladys features does it expose?
//   buildStates(device)          -> which values can I read from what I know?
//   onSetValue(client, {...})    -> run a command
//   poll(client, device)         -> refresh what a read cannot give (optional)
//
// Kinds are matched on the ABILITIES the firmware advertises
// (`Appliance.System.Ability`), never on a model name. A Meross reference
// released tomorrow that toggles a relay is recognised as a plug on day one.
//
// A hub is the exception that shapes the interfaces below: it maps ONE Meross
// device to MANY Gladys devices (its sub-devices). Such a kind implements
// `buildGladysDevices()` and `buildStateEntries()` instead, and the two helpers
// `gladysDevicesOf` / `stateEntriesOf` hide the difference from the callers.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import * as plug from './plug.js';
import * as light from './light.js';
import * as garageDoor from './garageDoor.js';
import * as hub from './hub.js';
import { normalizePollFrequency } from '../config.js';
import { deviceIds, parseDeviceExternalId, parseFeatureExternalId } from './featureIds.js';

const logger = createLogger({ name: 'devices' });

/**
 * Order matters: a light also advertises `ToggleX`, and so does a hub, so both
 * must be tested before the plug kind — which deliberately claims everything
 * else that toggles.
 */
export const DEVICE_KINDS = [hub, light, garageDoor, plug];

/** Find the kind that owns a Meross device, or null when unsupported. */
export function findKind(device) {
  return DEVICE_KINDS.find((kind) => kind.matches(device)) ?? null;
}

/**
 * The Gladys devices one Meross device produces — usually exactly one, but a
 * hub produces one per sub-device.
 */
export function gladysDevicesOf(kind, gladys, device, config) {
  // Both branches funnel through `withRequiredBounds`: it is the single place
  // that guarantees a published feature can actually be saved by Gladys.
  return buildRawDevices(kind, gladys, device, config).map((built) => ({
    ...built,
    features: built.features.map(withRequiredBounds),
  }));
}

/**
 * Gladys stores `min` and `max` as NOT NULL columns with no default, so a
 * feature missing either is refused at ADD time with
 * `422 t_device_feature.min cannot be null` — the device is discovered, then
 * impossible to add, which is the most confusing failure of all.
 *
 * Binary features are the easy trap: their range is so obvious that it feels
 * redundant to declare it. It is not. Fill it in rather than let the user hit
 * a 422.
 */
export function withRequiredBounds(feature) {
  if (Number.isFinite(feature.min) && Number.isFinite(feature.max)) {
    return feature;
  }

  if (!isBinaryFeature(feature)) {
    // Not a bug we can fix by guessing: a sensor needs a meaningful range.
    // Publish it anyway so the rest of the device works, but say so loudly.
    logger.error(
      `Feature "${feature.name}" (${feature.category}/${feature.type}) declares no min/max. ` +
        `Falling back to 0..1 so Gladys accepts it, but that range is almost certainly wrong.`,
    );
  }

  return { ...feature, min: feature.min ?? 0, max: feature.max ?? 1 };
}

/** Binary features have exactly two states, whatever their category. */
function isBinaryFeature(feature) {
  return feature.type === 'binary';
}

function buildRawDevices(kind, gladys, device, config) {
  if (typeof kind.buildGladysDevices === 'function') {
    return kind.buildGladysDevices(gladys, device, config);
  }

  const ids = deviceIds(gladys, device.uuid);
  const features = kind.buildFeatures(device, ids);
  if (features.length === 0) {
    return [];
  }

  return [
    {
      name: device.name,
      external_id: ids.device,
      // Only devices with something to poll get a frequency: an on/off-only
      // plug is entirely push-driven and does not need to be woken up.
      // Normalized here too: Gladys rejects the WHOLE publish batch when a
      // single device carries a frequency outside its allowed list.
      ...(shouldPoll(device, kind)
        ? { poll_frequency: normalizePollFrequency(config.poll_frequency) }
        : {}),
      features,
      params: buildParams(device),
    },
  ];
}

/**
 * The states one Meross device can report, each tagged with the platform id of
 * the Gladys device it belongs to.
 */
export function stateEntriesOf(kind, device) {
  if (typeof kind.buildStateEntries === 'function') {
    return kind.buildStateEntries(device);
  }
  return kind.buildStates(device).map((state) => ({ platformId: device.uuid, ...state }));
}

/**
 * Build the Gladys discovery payload for every supported device of the account.
 *
 * A device the integration cannot model yet is skipped with a log line rather
 * than published as an empty shell: an empty device in the UI is worse than no
 * device at all. The log carries the abilities the firmware advertised, which
 * is exactly what is needed to add support for it.
 */
export function buildDiscoveredDevices(gladys, merossDevices, config) {
  const devices = [];

  for (const device of merossDevices) {
    const kind = findKind(device);
    if (!kind) {
      logger.info(
        `Skipping unsupported Meross device "${device.name}" (${device.type}): ` +
          `no matching device kind for its abilities [${Object.keys(device.ability ?? {}).join(', ')}]`,
      );
      continue;
    }

    const built = gladysDevicesOf(kind, gladys, device, config);
    if (built.length === 0) {
      logger.info(`Skipping "${device.name}" (${device.type}): no usable feature`);
      continue;
    }

    devices.push(...built);
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

/** Turn state entries into the batch payload of `gladys.publishStates()`. */
export function toGladysStates(gladys, entries) {
  return entries.map(({ platformId, featureKey, state }) => ({
    device_feature_external_id: deviceIds(gladys, platformId).feature(featureKey),
    state,
  }));
}

/**
 * Publish everything currently known about a Meross device (from the cached
 * state). Used right after discovery and on every real-time push.
 */
export async function publishDeviceStates(gladys, device) {
  const kind = findKind(device);
  if (!kind) {
    return;
  }

  const states = toGladysStates(gladys, stateEntriesOf(kind, device));
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
  const { merossDevice, subDeviceId } = findMerossDevice(client, gladysDevice.external_id);
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
    subDeviceId,
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
export async function handlePoll(gladys, client, gladysDevice, config) {
  const { merossDevice } = findMerossDevice(client, gladysDevice.external_id);
  const kind = findKind(merossDevice);
  if (!kind) {
    return;
  }

  // The digest carries on/off, brightness, door position — but a hub keeps
  // nothing there (its sub-devices live in their own namespaces), so reading it
  // would be a wasted round trip per sub-device.
  if (kind.readsDigest !== false) {
    await client.fetchState(merossDevice.uuid);
  }

  // ...but electricity, energy and hub sub-devices have to be asked for
  // separately. `poll` refreshes them, and may return entries of its own.
  const extra =
    typeof kind.poll === 'function'
      ? (await kind.poll(client, merossDevice, config)).map((entry) => ({
          platformId: merossDevice.uuid,
          ...entry,
        }))
      : [];

  const payload = toGladysStates(gladys, [...stateEntriesOf(kind, merossDevice), ...extra]);
  if (payload.length > 0) {
    await gladys.publishStates(payload);
  }
}

/**
 * Resolve a Gladys device external_id back to the Meross device it addresses,
 * plus the sub-device when it points behind a hub.
 */
export function findMerossDevice(client, deviceExternalId) {
  const { uuid, subDeviceId } = parseDeviceExternalId(deviceExternalId);
  const merossDevice = client.getDevice(uuid);
  if (!merossDevice) {
    throw new Error(`Unknown Meross device for ${deviceExternalId}`);
  }
  return { merossDevice, subDeviceId };
}
