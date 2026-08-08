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
| Hub                      | MSH300, MSH400         | Its sub-devices, published individually (see below)             |

### Hubs and their sub-devices

A hub owns nothing the user can act on — it is a gateway. So the hub itself is never
published: each sub-device paired to it becomes its own Gladys device, with the name chosen
in the Meross app.

| Sub-device         | Typical models | Features in Gladys                                    |
| ------------------ | -------------- | ----------------------------------------------------- |
| Thermometer        | MS100          | Temperature, humidity, battery                        |
| Thermostatic valve | MTS100, MTS150 | Target temperature, room temperature, on/off, battery |
| Water leak sensor  | MS400, MS405   | Leak detected, battery                                |
| Door/window sensor | MS200          | Opening, battery                                      |

Sub-device features are derived from the **data a sub-device actually reports**, with its
type only as a fallback hint: hub generations name their types inconsistently, but they all
report a `tempHum` block for a thermometer and a `temperature` block for a valve. A
sub-device that reports nothing usable is skipped with a log line naming its raw payload.

**Known gap:** the valve _mode_ (comfort / economy / schedule) is not exposed yet, only the
target temperature. The numeric mode scale Gladys expects could not be confirmed, and a
wrong mapping would mislabel the modes in the UI.

#### Watering timers (MST100 on an MSH400 sprinkler hub)

Battery and on/off state are read correctly, and the on/off command is accepted and adopted
by the device. **But it does not start a watering** — on a sprinkler timer, on/off is not a
watering trigger.

Everything below was established against real hardware (MSH400 + MST100), and it is where
the investigation stopped:

| What was tried                         | Result                                          |
| -------------------------------------- | ----------------------------------------------- |
| `Appliance.Hub.ToggleX` SET            | Accepted, adopted, no watering                  |
| `Appliance.Control.Water` GET          | `error 5000` on every plausible payload shape   |
| `Appliance.Digest.WaterPlan` GET       | `error 5000` on every shape                     |
| `Appliance.Config.WaterPlan` GET       | `error 5000` on every shape                     |
| `Appliance.Control.WaterEvent` GET     | No answer at all                                |
| `Appliance.Control.Sensor.LatestX` GET | Answers — `{"latest":[]}`, empty even by sub-id |

Shapes tried per namespace: a bare `{}`, then the namespace key as an object, as an array,
and as an array targeting the sub-device by `id` (the convention every other hub namespace
follows), in both the camelCase and flat spellings.

So the hub advertises the watering family but does not serve it over the MQTT channel this
integration uses, and the one namespace that does answer holds no watering data. Starting a
watering needs a namespace and payload that are not publicly documented — `meross_iot` does
not know them either.

**To go further**, the reliable route is to capture the Meross mobile app's traffic
(mitmproxy) during a manual watering and read the request it sends. The **Diagnose my
devices** action re-runs all of the probes above, so a firmware update that opens these
namespaces would show up there.

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
power-metering devices and hub sub-devices declare a `poll_frequency`, because electricity
readings and hub sensor values are only available on request.

`poll_frequency` is in MILLISECONDS and Gladys accepts only its own
`DEVICE_POLL_FREQUENCIES` values — 1 s, 2 s, 10 s, 15 s, 30 s or 1 minute, which is the
slowest it supports. Anything else is refused with `400 invalid poll frequency`, and the
refusal takes the whole publish batch with it. Hence the select in the manifest rather than
a free number, and `normalizePollFrequency()` guarding every device payload.

A hub is read **once** per cycle no matter how many sub-devices it carries: each sub-device
is its own Gladys device with its own schedule, so their polls arrive as a burst and are
coalesced into a single hub read.

## Configuration

| Field            | Notes                                                                   |
| ---------------- | ----------------------------------------------------------------------- |
| Meross email     | Same account as the mobile app                                          |
| Meross password  | `secret` field: stored encrypted by Gladys, sent hashed (MD5) to Meross |
| Meross region    | Europe, America, Asia/Pacific or Global — a wrong region refuses login  |
| Refresh interval | One of the intervals Gladys accepts, 1 minute at the slowest (default)  |

Three buttons are available in the Configuration screen:

- **Test the connection** — signs in with the credentials currently in the form and reports
  how many devices the account holds;
- **Refresh the device list** — re-reads the account after you add or rename a device in
  the Meross app;
- **Diagnose my devices** — lists every device, its abilities, its sub-devices and the kind
  the integration matched it to. This is the fastest way to find out why a device did not
  show up.

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
| `src/devices/hub.js`        | Hub sub-devices: one Meross device -> many Gladys ones   |

### Tests

`npm test` runs 106 unit tests with no network and no hardware: message signing, the cloud
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
