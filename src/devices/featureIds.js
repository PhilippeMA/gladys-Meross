// -----------------------------------------------------------------------------
// External id conventions.
//
// Gladys matches states to devices by external_id, so these strings must be
// unique and — above all — STABLE across restarts. Meross gives us the perfect
// anchor: the device `uuid`, which never changes.
//
//   device  : ext:<selector>:meross:<uuid>
//   feature : ext:<selector>:meross:<uuid>:<kind>-<channel>
//
// Encoding the channel in the feature key is what lets a 4-outlet power strip
// live as ONE Gladys device with one on/off feature per outlet, and still route
// a command back to the right relay.
// -----------------------------------------------------------------------------

/** The `type` segment of every external id built by this integration. */
export const EXTERNAL_ID_TYPE = 'meross';

/** Feature kinds, i.e. the `<kind>` part of a feature key. */
export const FEATURE_KIND = {
  ON_OFF: 'on-off',
  BRIGHTNESS: 'brightness',
  COLOR: 'color',
  COLOR_TEMPERATURE: 'color-temperature',
  POWER: 'power',
  VOLTAGE: 'voltage',
  CURRENT: 'current',
  ENERGY_TODAY: 'energy-today',
  DOOR: 'door',
  // Hub sub-devices
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  TARGET_TEMPERATURE: 'target-temperature',
  BATTERY: 'battery',
  LEAK: 'leak',
  OPENING: 'opening',
  WATERING: 'watering',
  // Three durations, three sources, one owner each: the default configured on
  // the timer, the one-off Gladys uses for the next watering it starts, and
  // what the last cycle actually ran for.
  WATERING_DURATION: 'watering-duration',
  WATERING_RUN_DURATION: 'watering-run-duration',
  WATERING_LAST_DURATION: 'watering-last-duration',
};

/**
 * Platform id of a hub sub-device: `<hubUuid>-<subDeviceId>`.
 *
 * Meross uuids and sub-device ids are both dash-free hex strings, so the single
 * dash stays an unambiguous separator on the way back.
 */
export function subDevicePlatformId(hubUuid, subDeviceId) {
  return `${hubUuid}-${subDeviceId}`;
}

/**
 * External ids of one Gladys device — a plain Meross device, or one
 * sub-device behind a hub.
 */
export function deviceIds(gladys, platformId) {
  return gladys.externalIds(EXTERNAL_ID_TYPE, platformId);
}

/**
 * Resolve a device external_id back to the Meross device it addresses.
 * @returns {{ uuid: string, subDeviceId: string | null }}
 */
export function parseDeviceExternalId(deviceExternalId) {
  const platformId = deviceExternalId.slice(deviceExternalId.lastIndexOf(':') + 1);
  const dash = platformId.indexOf('-');
  if (dash < 0) {
    return { uuid: platformId, subDeviceId: null };
  }
  return {
    uuid: platformId.slice(0, dash),
    subDeviceId: platformId.slice(dash + 1),
  };
}

/** `on-off` + channel 2 -> `on-off-2`. */
export function buildFeatureKey(kind, channel = 0) {
  return `${kind}-${channel}`;
}

/**
 * Reverse of `buildFeatureKey`, applied to a FULL feature external_id.
 * Splits on the last dash so that multi-word kinds survive the round trip.
 *
 * @param {string} featureExternalId
 * @returns {{ kind: string, channel: number } | null}
 */
export function parseFeatureExternalId(featureExternalId) {
  if (typeof featureExternalId !== 'string') {
    return null;
  }
  const featureKey = featureExternalId.slice(featureExternalId.lastIndexOf(':') + 1);
  const lastDash = featureKey.lastIndexOf('-');
  if (lastDash <= 0) {
    return null;
  }
  const kind = featureKey.slice(0, lastDash);
  const channel = Number(featureKey.slice(lastDash + 1));
  if (!Number.isInteger(channel)) {
    return null;
  }
  return { kind, channel };
}
