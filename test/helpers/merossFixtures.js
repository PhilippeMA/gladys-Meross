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

/** A device whose abilities this integration does not model (hub). */
export function unsupportedHub(overrides = {}) {
  return {
    uuid: '8806239851916890865148e1e9aa88f8',
    name: 'Sensor hub',
    type: 'msh300',
    channelCount: 1,
    channelNames: [''],
    online: true,
    ip: null,
    ability: {
      'Appliance.Hub.ToggleX': {},
      'Appliance.Hub.Sensor.All': {},
    },
    digest: { hub: { hubId: 1, mode: 0 } },
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

    async fetchElectricity(uuid, channel = 0) {
      requests.push({ uuid, namespace: NAMESPACE.CONTROL_ELECTRICITY, method: 'GET', channel });
      // 123.456 W, 234.5 V, 0.543 A in Meross sub-units.
      return { channel, power: 123456, voltage: 2345, current: 543 };
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
