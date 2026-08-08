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
 * The ONLY polling intervals Gladys accepts, in MILLISECONDS
 * (`DEVICE_POLL_FREQUENCIES` in the core). Publishing a device with anything
 * else is rejected with `400 invalid poll frequency`, so this list — not a free
 * number — is what the Configuration screen offers.
 *
 * Note the ceiling: one minute is the slowest polling Gladys supports.
 */
export const POLL_FREQUENCIES = [1000, 2000, 10000, 15000, 30000, 60000];

/** Slowest allowed interval: the friendliest default for a cloud API. */
export const DEFAULT_POLL_FREQUENCY = 60000;

/**
 * Defaults. They MUST stay consistent with the `default` values declared in the
 * manifest `config_schema` (a unit test enforces it).
 */
export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  region: 'eu',
  // Milliseconds. Only used by the devices that cannot push: power monitoring
  // and hub sub-devices.
  poll_frequency: DEFAULT_POLL_FREQUENCY,
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
    // The select stores a string; the device payload needs the number, and it
    // must be one Gladys knows.
    poll_frequency: normalizePollFrequency(raw.poll_frequency),
    // A boolean: anything but an explicit false means true.
    GLADYS_PREFER_LOCAL: raw.GLADYS_PREFER_LOCAL !== false,
  };
}

/**
 * Coerce whatever the form sends into an interval Gladys accepts.
 *
 * Anything unknown snaps to the CLOSEST allowed value rather than falling back
 * to the default: a stale config asking for 300 s means "poll slowly", and the
 * slowest Gladys offers (60 s) honours that far better than an arbitrary reset.
 */
export function normalizePollFrequency(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_POLL_FREQUENCY;
  }
  if (POLL_FREQUENCIES.includes(requested)) {
    return requested;
  }
  return POLL_FREQUENCIES.reduce((closest, candidate) =>
    Math.abs(candidate - requested) < Math.abs(closest - requested) ? candidate : closest,
  );
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
