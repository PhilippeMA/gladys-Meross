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
};

/** External ids of one Meross device. */
export function deviceIds(gladys, uuid) {
  return gladys.externalIds(EXTERNAL_ID_TYPE, uuid);
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
