// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills this in from the `config_schema` declared in
// `gladys-assistant-integration.json`; the SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// This module holds the defaults and normalizes what comes back, so the rest of
// the code never deals with `undefined` or with a number that arrived as a
// string from an HTML form.
// -----------------------------------------------------------------------------

/**
 * Defaults. They MUST stay consistent with the `default` values declared in the
 * manifest `config_schema` (a unit test enforces it).
 */
export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  region: 'eu',
  poll_frequency: 60, // seconds, only used by the power-monitoring devices
  // Reserved key (NOT in config_schema): the manifest declares both 'local' and
  // 'cloud' in `transports`, so Gladys shows a "Prefer the local connection"
  // toggle and sends the choice here. Read-only for the integration.
  GLADYS_PREFER_LOCAL: true,
};

/**
 * Merge the user config with the defaults and force the types.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    email: String(raw.email ?? DEFAULT_CONFIG.email).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    region: normalizeRegion(raw.region),
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    // A boolean: anything but an explicit false means true.
    GLADYS_PREFER_LOCAL: raw.GLADYS_PREFER_LOCAL !== false,
  };
}

/** Accepted regions, matching the manifest select options. */
export const REGIONS = ['eu', 'us', 'ap', 'global'];

function normalizeRegion(region) {
  const value = String(region ?? DEFAULT_CONFIG.region).toLowerCase();
  return REGIONS.includes(value) ? value : DEFAULT_CONFIG.region;
}

/** True when the user has entered enough to attempt a connection. */
export function isConfigured(config) {
  return Boolean(config.email && config.password);
}
