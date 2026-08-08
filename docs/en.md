# Meross

Control your Meross plugs, switches, lights and garage doors from Gladys, and see their
consumption on your dashboard.

## What you get

Sign in once with your Meross account and every compatible device of the account appears in
the **Discovery** tab, ready to be added. No re-pairing, no extra hardware.

| Your device                                         | What you can do in Gladys                               |
| --------------------------------------------------- | ------------------------------------------------------- |
| Smart plug or wall switch (MSS110, MSS210, MSS510…) | Turn it on and off                                      |
| Plug with metering (MSS310)                         | On/off, plus power, voltage, current and today's energy |
| Power strip (MSS425…)                               | Each outlet on and off separately                       |
| Bulb or light strip (MSL120, MSL320, MSL430…)       | On/off, brightness, colour and white temperature        |
| Garage door opener (MSG100, MSG200)                 | Open and close it, and see whether it is really open    |

Sensors connected to a Meross **hub** (MSH300 with MS100 thermometers or MTS100 valves) are
not supported yet: they are simply ignored.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Enter the **email** and **password** of your Meross account — the same ones you use in
   the Meross mobile app.
3. Choose the **region** where your account was created (Europe, America, Asia/Pacific).
   This is the most common cause of a refused login: if you are unsure, try Europe first,
   then Global.
4. Save. Click **Test the connection** to check everything works: it tells you how many
   devices were found.
5. Your devices appear in the **Discovery** tab.

Your password is stored encrypted by Gladys. It is never sent in clear text: only a hashed
form leaves the integration, and only to the Meross authentication server.

### Local or cloud?

The **Prefer the local connection** toggle (on by default) asks the integration to talk to
your devices directly over your Wi-Fi network instead of going through Meross' servers.
Local control is faster and keeps working when your internet connection is down.

Each device shows a badge telling you the channel it _really_ uses:

- **local** — commands never leave your home network;
- **cloud** — commands go through Meross;
- **cloud with an orange dot** — local was preferred, but this device did not answer on the
  network; hover the badge to see why.

Some Meross firmware versions refuse local control. That is a device-side limitation: the
integration falls back to the cloud so the device keeps working.

Note that even in local mode, the integration signs in to Meross once at startup: your
devices only accept commands signed with your account key, and only Meross can hand it out.

### Refresh interval

Only plugs that measure consumption are polled, at this interval (60 seconds by default).
Everything else — on/off, colours, the garage door position — arrives **instantly**, pushed
by the device, including when someone presses a physical button or uses the Meross app.

## Actions

- **Test the connection** — signs in with the credentials in the form and reports how many
  devices your account holds, and how many are online.
- **Refresh the device list** — re-reads your account. Use it after adding or renaming a
  device in the Meross app.

## Troubleshooting

**"Meross refused the credentials"** — check the three fields together: email, password and
above all the **region**. An account created in Europe cannot sign in on the American
endpoint.

**A device stays offline** — check it is reachable in the Meross app first. Gladys reports
what Meross tells it, and a device that is offline for Meross is offline here too.

**The Meross app logs me out** — Meross limits the number of simultaneous sessions per
account. Simply sign in again in the app: both sessions can coexist. The integration caches
its session and releases it on shutdown to limit this.

**A device is missing from the Discovery tab** — its type is probably not supported yet
(hub sub-devices in particular). The integration logs a line for every device it skips.

**Nothing works, and I want to know why** — the integration logs everything it does. Open
the integration logs from the Gladys UI (or `docker logs` on the host); set `LOG_LEVEL` to
`debug` for the full detail, including every message exchanged with your devices.
