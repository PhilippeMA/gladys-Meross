# Gladys Meross integration

External integration to read and control [Meross](https://www.meross.com/) devices from
[Gladys Assistant](https://gladysassistant.com), built on the official
[JavaScript SDK](https://github.com/GladysAssistant/integration-sdk-js) and the
[integration template](https://github.com/GladysAssistant/integration-template-js).

Sign in with your Meross account and your devices show up in Gladys — no re-pairing, no
bridge, no soldering. Once discovered, they are driven **directly over your LAN** whenever
possible, so a light reacts in milliseconds and keeps working when the internet is down.

## Supported devices

Devices are recognised from the abilities their firmware advertises
(`Appliance.System.Ability`), never from a hard-coded model list — a new Meross reference
that toggles a relay is understood on day one.

| Type                     | Typical models         | Features in Gladys                                              |
| ------------------------ | ---------------------- | --------------------------------------------------------------- |
| Smart plug / wall switch | MSS110, MSS210, MSS510 | On/off                                                          |
| Smart plug with metering | MSS310                 | On/off, power (W), voltage (V), current (A), energy today (kWh) |
| Power strip              | MSS425, MSS425E        | One on/off feature per outlet, plus a master                    |
| Bulb / light strip       | MSL120, MSL320, MSL430 | On/off, brightness, colour, white temperature                   |
| Garage door opener       | MSG100, MSG200         | Open/close, with the real door position fed back                |

**Not supported yet:** the MSH300 hub and its sub-devices (MS100 temperature sensors,
MTS100 thermostatic valves). They speak a different, hub-scoped namespace family; the
integration skips them with a log line rather than publishing empty devices.

## How it works

```
                     ┌──────────────────────────────┐
   Gladys  ◄───ws───►│         index.js             │
                     │  SDK handlers, no protocol   │
                     └───────────────┬──────────────┘
                                     │
              ┌──────────────────────┴────────────────────┐
              │                                           │
      ┌───────▼────────┐                        ┌─────────▼────────┐
      │  src/devices/  │                        │   src/meross/    │
      │ Meross ↔ Gladys│                        │  the protocol    │
      └────────────────┘                        └─────────┬────────┘
                                                          │
                                    ┌─────────────────────┼───────────────────┐
                                    │                     │                   │
                             cloudApi.js           mqttClient.js       localClient.js
                            login + devices      cloud + real-time      direct on LAN
```

The same signed JSON envelope travels over MQTT and over LAN HTTP — only the pipe changes.
That is what makes the dual-channel design possible (`src/meross/protocol.js`).

### Local vs cloud

The manifest declares both transports, so Gladys shows its standard **Prefer the local
connection** toggle. The integration treats it as a wish, not an order, and reports the
channel it _actually_ uses as a badge on each device:

- **local** — the device answers on the LAN, commands never leave your network;
- **cloud** — commands go through the Meross broker;
- **cloud + orange dot** — local was preferred but the device did not answer; the tooltip
  says why.

A one-time cloud login is always required, even in local mode: devices only accept messages
signed with the account key, and that key is only handed out by the Meross login endpoint.
The device's LAN address is read from `Appliance.System.All` → `system.firmware.innerIp`,
the one place Meross discloses it.

### Real time, not polling

On/off states, colours and door positions arrive **pushed** over MQTT the moment they
change — including when someone presses a physical button or uses the Meross app. Only the
power-metering devices declare a `poll_frequency`, because electricity readings are
available on request only.

## Configuration

| Field                | Notes                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| Meross email         | Same account as the mobile app                                          |
| Meross password      | `secret` field: stored encrypted by Gladys, sent hashed (MD5) to Meross |
| Meross region        | Europe, America, Asia/Pacific or Global — a wrong region refuses login  |
| Refresh interval (s) | Power-metering devices only (default 60)                                |

Two buttons are available in the Configuration screen:

- **Test the connection** — signs in with the credentials currently in the form and reports
  how many devices the account holds;
- **Refresh the device list** — re-reads the account after you add or rename a device in
  the Meross app.

The session token is cached in the integration config and released on shutdown: Meross caps
the number of concurrent sessions per account, so the integration does not burn a new one on
every restart.

## Development

```bash
npm install
npm test           # node --test, no extra runner
npm run lint       # eslint
npm run format     # prettier
```

Run it against a local Gladys:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<integration jwt>" \
GLADYS_INTEGRATION_SELECTOR="meross" \
LOG_LEVEL=debug \
npm start
```

### Layout

| Path                        | Role                                                     |
| --------------------------- | -------------------------------------------------------- |
| `index.js`                  | SDK wiring only — no protocol logic                      |
| `src/config.js`             | Defaults and normalization of the user configuration     |
| `src/meross/protocol.js`    | Envelope, signature, namespaces, unit conversions (pure) |
| `src/meross/cloudApi.js`    | Login and device list over HTTPS                         |
| `src/meross/mqttClient.js`  | Cloud commands and the real-time push stream             |
| `src/meross/localClient.js` | Direct LAN control                                       |
| `src/meross/client.js`      | Session, inventory, transport routing                    |
| `src/devices/`              | One module per device _kind_, matched on abilities       |

### Tests

`npm test` runs 79 unit tests with no network and no hardware: message signing, the cloud
error contract, digest merging, and every device mapping (discovery payloads, state reading,
command routing) against realistic Meross fixtures.

The Meross protocol is not publicly documented — it is the one the mobile app uses, pinned
down here by the tests. Meross can change it without notice.

## Releasing

Use the **Release** workflow from the GitHub Actions tab and pick `patch`, `minor` or
`major`. It bumps `package.json` and the manifest, tags the commit, and publishes the
multi-arch image (amd64 + arm64) to `ghcr.io`.

## License

Apache-2.0
