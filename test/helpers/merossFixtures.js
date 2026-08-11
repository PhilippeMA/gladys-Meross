// -----------------------------------------------------------------------------
// Meross device fixtures, in the shape src/meross/client.js produces them
// (cloud device list + `Appliance.System.Ability` + `Appliance.System.All`).
//
// Keeping the abilities realistic matters: the whole device layer decides what
// a device IS from them, so a fixture that lies would make the tests pass while
// the integration misreads real hardware.
// -----------------------------------------------------------------------------

import { NAMESPACE } from '../../src/meross/protocol.js';

/** MSS310: single smart plug with power monitoring. */
/**
 * An MOP320: the newer metering generation. It advertises ElectricityX and
 * ConsumptionH where an MSS310 advertises Electricity and ConsumptionX — which
 * is why matching only the older pair left it a bare on/off switch.
 * (Abilities copied from a real device's diagnostic.)
 */
export function newGenerationPowerPlug(overrides = {}) {
  return {
    uuid: '4411223344556677889900aabbccddee',
    name: 'Prise x',
    type: 'mop320',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: '192.168.68.57',
    firmwareVersion: '4.1.0',
    ability: {
      [NAMESPACE.SYSTEM_ALL]: {},
      [NAMESPACE.SYSTEM_ABILITY]: {},
      [NAMESPACE.CONTROL_TOGGLEX]: {},
      [NAMESPACE.CONTROL_ELECTRICITYX]: {},
      [NAMESPACE.CONTROL_CONSUMPTIONH]: {},
      'Appliance.Config.ElectricParam': {},
      'Appliance.Control.OverTemp': {},
    },
    digest: {
      togglex: [{ channel: 0, onoff: 1, lmTime: 1700000000 }],
    },
    ...overrides,
  };
}

export function powerPlug(overrides = {}) {
  return {
    uuid: '1806239851916890865148e1e9aa11f1',
    name: 'Office plug',
    type: 'mss310',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: '192.168.1.50',
    firmwareVersion: '2.1.12',
    ability: {
      [NAMESPACE.SYSTEM_ALL]: {},
      [NAMESPACE.SYSTEM_ABILITY]: {},
      [NAMESPACE.CONTROL_TOGGLEX]: {},
      [NAMESPACE.CONTROL_ELECTRICITY]: {},
      [NAMESPACE.CONTROL_CONSUMPTIONX]: {},
    },
    digest: {
      togglex: [{ channel: 0, onoff: 1, lmTime: 1700000000 }],
    },
    ...overrides,
  };
}

/** MSS110: the simplest plug — a relay, nothing else. */
export function simplePlug(overrides = {}) {
  return {
    uuid: '2806239851916890865148e1e9aa22f2',
    name: 'Lamp plug',
    type: 'mss110',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: null,
    ability: {
      [NAMESPACE.CONTROL_TOGGLEX]: {},
    },
    digest: {
      togglex: [{ channel: 0, onoff: 0 }],
    },
    ...overrides,
  };
}

/** MSS425: power strip — a master channel plus four outlets. */
export function powerStrip(overrides = {}) {
  return {
    uuid: '3806239851916890865148e1e9aa33f3',
    name: 'Desk strip',
    type: 'mss425e',
    channelCount: 5,
    channelNames: ['', 'Screen', 'Dock', '', ''],
    online: true,
    ip: '192.168.1.51',
    ability: {
      [NAMESPACE.CONTROL_TOGGLEX]: {},
    },
    digest: {
      togglex: [
        { channel: 0, onoff: 1 },
        { channel: 1, onoff: 1 },
        { channel: 2, onoff: 0 },
        { channel: 3, onoff: 0 },
        { channel: 4, onoff: 1 },
      ],
    },
    ...overrides,
  };
}

/** Very old firmware: a single `toggle`, no `togglex`. */
export function legacyTogglePlug(overrides = {}) {
  return {
    uuid: '4806239851916890865148e1e9aa44f4',
    name: 'Old plug',
    type: 'mss110',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: null,
    ability: {
      [NAMESPACE.CONTROL_TOGGLE]: {},
    },
    digest: {
      toggle: { onoff: 1 },
    },
    ...overrides,
  };
}

/** MSL120: RGBWW bulb (color + white temperature + brightness). */
export function colorBulb(overrides = {}) {
  return {
    uuid: '5806239851916890865148e1e9aa55f5',
    name: 'Bedroom bulb',
    type: 'msl120',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: '192.168.1.52',
    ability: {
      [NAMESPACE.CONTROL_TOGGLEX]: {},
      [NAMESPACE.CONTROL_LIGHT]: { capacity: 7 },
    },
    digest: {
      togglex: [{ channel: 0, onoff: 1 }],
      light: { channel: 0, capacity: 5, rgb: 0xff8800, luminance: 70, temperature: 50 },
    },
    ...overrides,
  };
}

/** MSL320: RGB strip — no white-temperature channel. */
export function colorStrip(overrides = {}) {
  return {
    uuid: '6806239851916890865148e1e9aa66f6',
    name: 'TV strip',
    type: 'msl320',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: null,
    ability: {
      [NAMESPACE.CONTROL_TOGGLEX]: {},
      [NAMESPACE.CONTROL_LIGHT]: { capacity: 5 },
    },
    digest: {
      togglex: [{ channel: 0, onoff: 1 }],
      light: { channel: 0, capacity: 5, rgb: 0x00ff00, luminance: 100 },
    },
    ...overrides,
  };
}

/** MSG100: garage door opener. */
export function garageOpener(overrides = {}) {
  return {
    uuid: '7806239851916890865148e1e9aa77f7',
    name: 'Garage',
    type: 'msg100',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: '192.168.1.53',
    ability: {
      [NAMESPACE.GARAGE_DOOR_STATE]: {},
      [NAMESPACE.CONTROL_TOGGLEX]: {},
    },
    digest: {
      garageDoor: [{ channel: 0, open: 0, lmTime: 1700000000 }],
    },
    ...overrides,
  };
}

/** A device whose abilities this integration does not model yet. */
export function unsupportedDevice(overrides = {}) {
  return {
    uuid: '8806239851916890865148e1e9aa88f8',
    name: 'Diffuser',
    type: 'msxh0',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: null,
    ability: {
      'Appliance.Control.Spray': {},
      'Appliance.Control.Diffuser.Light': {},
    },
    digest: { spray: [{ channel: 0, mode: 0 }] },
    ...overrides,
  };
}

/**
 * MSH400 smart hub, with the three sub-device families the integration models:
 * a thermometer, a thermostatic valve and a water leak sensor.
 *
 * The shapes below are the ones the hub namespaces really return: values in
 * tenths of a unit, and one block per family under each sub-device.
 */
export function smartHub(overrides = {}) {
  const hub = {
    uuid: '8806239851916890865148e1e9aa88f8',
    name: 'Smart Hub',
    type: 'msh400',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: '192.168.1.60',
    ability: {
      [NAMESPACE.SYSTEM_ALL]: {},
      [NAMESPACE.HUB_ONLINE]: {},
      [NAMESPACE.HUB_TOGGLEX]: {},
      [NAMESPACE.HUB_BATTERY]: {},
      [NAMESPACE.HUB_SENSOR_ALL]: {},
      [NAMESPACE.HUB_MTS100_ALL]: {},
      [NAMESPACE.HUB_MTS100_TEMPERATURE]: {},
    },
    digest: { hub: { hubId: 1234, mode: 0 } },
    subDevices: new Map(),
    ...overrides,
  };

  // Only seed the default sub-devices when the caller did not supply its own
  // set — an explicitly empty map means "a hub with nothing paired".
  if (!('subDevices' in overrides)) {
    hub.subDevices.set('0000A1B2', {
      id: '0000A1B2',
      name: 'Living room thermometer',
      type: 'ms100',
      state: {
        online: { status: 1 },
        tempHum: { latestTime: 1700000000, latestTemperature: 231, latestHumidity: 546 },
        battery: { value: 87 },
      },
    });
    hub.subDevices.set('0000C3D4', {
      id: '0000C3D4',
      name: 'Bedroom valve',
      type: 'mts100v3',
      state: {
        online: { status: 1 },
        togglex: { onoff: 1 },
        mode: { state: 0 },
        temperature: { room: 210, currentSet: 200, min: 50, max: 350, openWindow: 0 },
        battery: { value: 64 },
      },
    });
    hub.subDevices.set('0000E5F6', {
      id: '0000E5F6',
      name: 'Cellar leak sensor',
      type: 'ms400',
      state: {
        online: { status: 1 },
        waterLeak: { latestWaterLeak: 0 },
        battery: { value: 92 },
      },
    });
  }

  return hub;
}

/**
 * MST100 watering timer behind an MSH400 sprinkler hub: it reports nothing but
 * its relay and its battery, exactly as the real hardware does.
 */
export function wateringTimer(overrides = {}) {
  return {
    id: '1B0091AFC74E',
    name: 'Programmateur arrosage',
    type: 'mst100',
    state: {
      battery: { value: 98 },
      togglex: { onoff: 0 },
      online: { status: 1, lastActiveTime: 1786189193 },
    },
    ...overrides,
  };
}

/**
 * Minimal stand-in for MerossClient, recording the requests the device layer
 * makes so the tests can assert the exact namespace/payload sent to hardware.
 */
export function createFakeClient(devices = []) {
  const requests = [];
  const byUuid = new Map(devices.map((device) => [device.uuid, device]));

  return {
    requests,
    getDevice: (uuid) => byUuid.get(uuid),
    getDevices: () => [...byUuid.values()],

    async request(uuid, namespace, method, payload) {
      requests.push({ uuid, namespace, method, payload });
      return {};
    },

    async fetchState(uuid) {
      requests.push({ uuid, namespace: NAMESPACE.SYSTEM_ALL, method: 'GET' });
      return byUuid.get(uuid)?.digest ?? {};
    },

    async refreshSubDeviceStates(device) {
      requests.push({ uuid: device.uuid, namespace: 'refreshSubDeviceStates', method: 'GET' });
      return device.subDevices;
    },

    async fetchElectricity(uuid, channel = 0) {
      const device = byUuid.get(uuid);
      // Mirrors the real client: which generation answered decides the scaling,
      // so it comes back with the reading.
      if (NAMESPACE.CONTROL_ELECTRICITYX in (device?.ability ?? {})) {
        requests.push({
          uuid,
          namespace: NAMESPACE.CONTROL_ELECTRICITYX,
          method: 'GET',
          channel,
        });
        // 123.456 W, 234.5 V, 0.543 A — voltage in MILLIvolts here.
        return {
          namespace: NAMESPACE.CONTROL_ELECTRICITYX,
          reading: { channel, power: 123456, voltage: 234500, current: 543 },
        };
      }

      requests.push({ uuid, namespace: NAMESPACE.CONTROL_ELECTRICITY, method: 'GET', channel });
      // The same values, with voltage in DECIvolts.
      return {
        namespace: NAMESPACE.CONTROL_ELECTRICITY,
        reading: { channel, power: 123456, voltage: 2345, current: 543 },
      };
    },

    async fetchConsumptionH(uuid, channel = 0) {
      requests.push({ uuid, namespace: NAMESPACE.CONTROL_CONSUMPTIONH, method: 'GET', channel });
      const now = Math.floor(Date.now() / 1000);
      return {
        channel,
        total: 4321,
        data: [
          { timestamp: now - 90000, value: 999 }, // yesterday: must not count
          { timestamp: now - 3600, value: 1000 },
          { timestamp: now, value: 234 },
        ],
      };
    },

    async fetchConsumption(uuid) {
      requests.push({ uuid, namespace: NAMESPACE.CONTROL_CONSUMPTIONX, method: 'GET' });
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate(),
      ).padStart(2, '0')}`;
      return [
        { date: '2024-01-01', time: 1704067200, value: 500 },
        { date, time: Math.floor(now.getTime() / 1000), value: 1234 },
      ];
    },
  };
}
