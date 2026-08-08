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

| Sub-device         | Typical models | Features in Gladys                                       |
| ------------------ | -------------- | -------------------------------------------------------- |
| Thermometer        | MS100          | Temperature, humidity, battery                           |
| Thermostatic valve | MTS100, MTS150 | Target temperature, room temperature, on/off, battery    |
| Water leak sensor  | MS400, MS405   | Leak detected, battery                                   |
| Door/window sensor | MS200          | Opening, battery                                         |
| Watering timer     | MST100         | Watering (start/stop + duration), timer enabled, battery |

Sub-device features are derived from the **data a sub-device actually reports**, with its
type only as a fallback hint: hub generations name their types inconsistently, but they all
report a `tempHum` block for a thermometer and a `temperature` block for a valve. A
sub-device that reports nothing usable is skipped with a log line naming its raw payload.

**Known gap:** the valve _mode_ (comfort / economy / schedule) is not exposed yet, only the
target temperature. The numeric mode scale Gladys expects could not be confirmed, and a
wrong mapping would mislabel the modes in the UI.

#### Watering timers (MST100 on an MSH400 sprinkler hub)

A sprinkler timer is not a relay: its `Appliance.Hub.ToggleX` is accepted and adopted by the
device but waters nothing. Watering runs through `Appliance.Control.Water`, whose payload
defeats every reasonable guess — which is why it had to come from a capture of the Meross
Android app rather than from probing:

```json
{ "control": [{ "channel": 0, "dura": 900, "onoff": 1, "subId": "1B0091AFC74E" }] }
```

- the payload key is **`control`**, not `water` after the namespace;
- the sub-device is addressed by **`subId`**, not by `id` like every hub namespace;
- **stopping uses `onoff: 2`**, not `0`. Sending `0` is not "stop";
- `dura` is the duration in **seconds**, and is omitted when stopping.

The same shape reads back, so the namespace is polled as well as pushed:

```json
{ "control": [{ "subId": "1B0091AFC74E", "channel": 0, "dura": 900, "onoff": 2, "lmTime": 0 }] }
```

A timer therefore exposes a **Watering** switch that reflects what the hardware is really
doing — a cycle started from the Meross app or by the timer's own schedule shows up in
Gladys too — and a **Watering duration** in minutes. The duration is read from the timer's
own `dura`, which it remembers between cycles; setting it in Gladys overrides that for the
next watering, and the device then keeps it.

The switch is also cleared by a local timer when the duration elapses. That is not the
authority — the next poll is — it just spares the user a switch left visibly on for up to a
minute after the water stopped.

**On the MSH400 firmware, a watering SET only works over the LAN** — and the cloud does not
say so. Measured, not assumed:

| over the cloud                     | answer         |
| ---------------------------------- | -------------- |
| `GET {"control":[]}`               | the full state |
| `SET {"control":{…}}` (object)     | `error 5000`   |
| `SET {"control":[{…}]}` (list, ×5) | nothing at all |
| the same list over the LAN         | acted on       |

The refusal of the object form is the informative one: the hub parsed the message, rejected
the shape and replied, so SET on this namespace **is** dispatched over MQTT. A well-formed
list is then swallowed in silence. There is no payload to fix — five shapes, including the
one the Meross app sends and the one meross_lan sends, all met the same silence.

So the command tries the normal routing first (a hub that honours the cloud needs nothing
else), and on silence falls back to a direct POST to the hub — even when the start-up
reachability probe said the address was unreachable, since that probe is one packet and a
command the user is waiting on deserves a real attempt. When both refuse, the error names
both failures and the address to fix. **Gladys must be able to reach the hub on the LAN for
watering to work on this hardware.**

**A reply is identified by its `messageId`, never by its method.** Meross devices answer some
commands with a PUSH of the resulting state rather than a `SETACK`, so a client that requires
an ack waits out its full timeout on an answer already in hand, then reports a failure for a
command that worked. Here a reply is whatever carries the `messageId` we sent and either our
namespace or an error namespace — `krahabb/meross_lan` matches the same way. A PUSH that
resolves a command then continues through the push path as well, because it is genuinely both
an answer and a state announcement.

`Appliance.Control.WaterEvent` really is unreadable — it is push-only by design, and every
GET goes unanswered. Schedules are readable through `Appliance.Digest.WaterPlan` (keyed
`digest`, targeted by `subId`) but `Appliance.Config.WaterPlan` refuses every shape with
`error 5000`, so schedules are not exposed.

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
