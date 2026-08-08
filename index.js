// -----------------------------------------------------------------------------
// Entry point of the Meross integration.
//
// This file wires the SDK to the two halves of the integration and holds no
// protocol logic of its own:
//   - src/meross/  talks to Meross (cloud login, MQTT broker, LAN HTTP);
//   - src/devices/ turns Meross devices into Gladys devices and back.
//
// Environment variables provided by the Gladys supervisor:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them itself: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './src/config.js';
import { MerossClient } from './src/meross/client.js';
import { deviceIds } from './src/devices/featureIds.js';
import {
  buildDiscoveredDevices,
  findKind,
  handlePoll,
  handleSetValue,
  publishDeviceStates,
} from './src/devices/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// The Meross session. Recreated whenever the credentials change.
let client = null;

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> refreshing the Meross account');
  if (!client) {
    throw new Error('Not connected to Meross: check the integration configuration');
  }
  await client.refreshDevices();
  await publishEverything();
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  if (!client) {
    throw new Error('Not connected to Meross');
  }
  await handleSetValue(gladys, client, { device, feature, value });
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Only the power-monitoring devices declare a poll_frequency: everything else
// is push-driven and never lands here.
gladys.onPoll(async (device) => {
  if (!client) {
    return;
  }
  await handlePoll(gladys, client, device);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  if (!isConfigured(config)) {
    return {
      en: 'Enter your Meross email and password first.',
      fr: "Renseignez d'abord votre e-mail et mot de passe Meross.",
    };
  }

  // Deliberately a FRESH client: the point of the button is to prove the
  // credentials currently in the form work, not that an old session survives.
  const probe = new MerossClient();
  try {
    await probe.authenticate(config);
    const devices = await probe.refreshDevices();
    const online = devices.filter((device) => device.online).length;
    return {
      en: `Connection successful: ${devices.length} device(s) on the account, ${online} online.`,
      fr: `Connexion réussie : ${devices.length} appareil(s) sur le compte, ${online} en ligne.`,
    };
  } finally {
    await probe.disconnectMqtt();
  }
});

gladys.onAction('refresh_devices', async () => {
  if (!client) {
    throw new Error('Not connected to Meross: check the configuration and the logs.');
  }
  const devices = await client.refreshDevices();
  await publishEverything();
  return {
    en: `${devices.length} device(s) refreshed from the Meross account.`,
    fr: `${devices.length} appareil(s) rafraîchi(s) depuis le compte Meross.`,
  };
});

// Diagnostic: report what each device of the account advertises, and what the
// integration made of it. This is the fastest way to find out why a given
// device did not show up — and the information needed to add support for it.
gladys.onAction('diagnose', async () => {
  if (!client) {
    throw new Error('Not connected to Meross: check the configuration and the logs.');
  }

  const lines = client.getDevices().map((device) => {
    const kind = findKind(device);
    const abilities = Object.keys(device.ability ?? {});
    const parts = [
      `${device.name} (${device.type})`,
      device.online ? 'online' : 'offline',
      kind ? `handled as ${kind.KIND}` : 'NOT HANDLED',
    ];

    if (device.subDevices?.size > 0) {
      parts.push(
        `sub-devices: ${[...device.subDevices.values()]
          .map((sub) => `${sub.name}/${sub.type || '?'}`)
          .join(', ')}`,
      );
    }
    parts.push(`abilities: ${abilities.join(' ') || 'none'}`);

    return parts.join(' — ');
  });

  const report = lines.join('\n') || 'No device on this Meross account.';
  logger.info(`Diagnostic report:\n${report}`);
  return report;
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  const previous = config;
  config = normalizeConfig(newConfig);

  // Credentials or region changed: the whole session is stale, start over.
  if (
    config.email !== previous.email ||
    config.password !== previous.password ||
    config.region !== previous.region
  ) {
    await startMeross();
    return;
  }

  // Caching the Meross session writes to the config, which brings us straight
  // back here mid-startup: ignore that echo until the client is fully up.
  if (!client?.ready) {
    return;
  }

  // The reserved GLADYS_PREFER_LOCAL key arrives here like any other key:
  // re-route every device, then report the ACTUAL outcome.
  await publishTransports(await client.refreshTransports(config));
  // poll_frequency lives in the discovery payload, so republish it.
  await gladys.publishDiscoveredDevices(
    buildDiscoveredDevices(gladys, client.getDevices(), config),
  );
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself; these handlers only run the
// integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await startMeross();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await reportFailure(err);
  }
});

gladys.on('disconnected', () => {
  // Keep the Meross session: the SDK reconnects on its own, and tearing the
  // broker down on every hiccup would burn a login each time.
  logger.info('Disconnected from Gladys, keeping the Meross session open');
});

/**
 * (Re)build the whole Meross session, then publish everything Gladys needs.
 */
async function startMeross() {
  await stopMeross();

  if (!isConfigured(config)) {
    logger.warn('Meross credentials are missing: waiting for the configuration');
    await gladys.setConnectionStatus(false, {
      en: 'Enter your Meross email and password to connect.',
      fr: 'Renseignez votre e-mail et mot de passe Meross pour vous connecter.',
    });
    return;
  }

  try {
    client = new MerossClient({
      // Real-time: a device changed, tell Gladys immediately.
      onPush: (uuid) => {
        const device = client?.getDevice(uuid);
        if (device) {
          publishDeviceStates(gladys, device).catch((err) =>
            logger.error(`Could not publish the pushed state of ${device.name}`, err),
          );
        }
      },
      // Cache the session so a restart does not consume a new Meross token.
      saveSession: (partialConfig) => gladys.setConfig(partialConfig),
    });

    await client.start(config);
    await publishEverything();
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Could not connect to Meross', err);
    client = null;
    await reportFailure(err);
  }
}

async function stopMeross() {
  if (client) {
    // Full stop, not just a disconnect: this runs when the credentials change,
    // so the previous token must be released rather than left dangling.
    await client.stop().catch((err) => logger.error('Meross disconnection failed', err));
    client = null;
  }
}

/** Publish the devices, their transports and their current states. */
async function publishEverything() {
  const devices = client.getDevices();

  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, devices, config));
  await publishTransports(client.getTransportEntries());

  // Seed Gladys with what we already know, so the dashboard is right from the
  // first second instead of waiting for the first push or poll.
  for (const device of devices) {
    await publishDeviceStates(gladys, device).catch((err) =>
      logger.error(`Could not publish the initial state of ${device.name}`, err),
    );
  }
}

/**
 * Publish the per-device transport badge (local / cloud / unreachable). The
 * client reports uuids; Gladys wants external ids.
 */
async function publishTransports(entries) {
  if (!entries || entries.length === 0) {
    return;
  }
  await gladys.publishTransports(
    entries.map(({ platformId, ...entry }) => ({
      external_id: deviceIds(gladys, platformId).device,
      ...entry,
    })),
  );
}

/** Surface a failure in the Configuration screen, in the user's language. */
async function reportFailure(err) {
  const message = String(err?.message ?? '');
  const isAuth = /password|email|account|token|1001|1004|1008/i.test(message);

  await gladys
    .setConnectionStatus(
      false,
      isAuth
        ? {
            en: 'Meross refused the credentials: check your email, password and region.',
            fr: 'Meross a refusé les identifiants : vérifiez e-mail, mot de passe et région.',
          }
        : {
            en: 'Could not reach Meross, check the integration logs.',
            fr: 'Impossible de joindre Meross, consultez les logs de l’intégration.',
          },
    )
    .catch(() => {});
}

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  // Release the Meross token: the account caps concurrent sessions.
  if (client) {
    await client.stop().catch((err) => logger.error('Meross shutdown failed', err));
    client = null;
  }
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Meross integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
