# Local D-Bus control API (Linux)

The application exposes Teams control and observed state on the **user session bus**. MQTT is not required. The API exports no D-Bus properties: installed `dbus-native` 0.7.9 makes exported properties read/write, so state is provided by a JSON `GetState` snapshot and typed signals instead. Calendar and caller data are private; use only from trusted processes in the same user session.

| Item | Value |
| --- | --- |
| Bus | User session bus |
| Service | `$FLATPAK_ID`, otherwise `com.github.IsmaelMartinez.teams_for_linux` |
| Object path | `/com/github/IsmaelMartinez/teams_for_linux` |
| Interface | `com.github.IsmaelMartinez.teams_for_linux.Control` |

## Methods

| Method | Signature | Meaning |
| --- | --- | --- |
| `AcceptAudio`, `AcceptVideo`, `DeclineCall` | `() -> b` | Dispatch the corresponding action for the known incoming call |
| `SendShortcut` | `(s accelerator) -> b` | Send an Electron keyDown/keyUp pair to the active profile |
| `ToggleMute`, `ToggleVideo`, `ToggleHandRaise`, `LeaveCall` | `() -> b` | Toggle Teams mute/video/hand, or leave the call, using Teams shortcuts |
| `Mute`, `Unmute` | `(b force) -> b` | Set desired mute state; if already desired, return false without dispatch. Unknown state requires `force=true`. The argument must be a Boolean. |
| `GetCalendar` | `(s startDate, s endDate) -> s` | Async Graph calendar query; returns JSON `{ "success": true, "data": ... }` or `{ "success": false, "error": ... }`. Dates accept ISO dates (`YYYY-MM-DD`) or ISO-8601 timestamps with timezone. |
| `GetState` | `() -> s` | Current JSON state snapshot |

`true` means dispatch, not acknowledgement from Teams. Incoming-call actions target the ringing renderer, with root-window fallback if that renderer is unavailable; shortcuts target the active profile. A toggle changes state only if Teams processes its shortcut. `Mute`/`Unmute` avoid dispatch if the observed normalized control state is already the requested state. With `force=true`, an unknown state is toggled; the desired final state cannot be guaranteed.

## Signals and state

Signals: `StateChanged(s stateJson)`, `PresenceChanged(s status, i statusCode)`, `InCallChanged(b)`, `IncomingCallChanged(b)`, `IncomingCallCallerChanged(s callerJson)`, `CameraChanged(b)`, `MicrophoneChanged(s)`, `MicrophoneControlChanged(s)`, `ScreenSharingChanged(b)`, `MeetingStartedChanged(b)`, and `CalendarReceived(s resultJson)`. `StateChanged` contains the full snapshot; typed signals follow when individual values change. Call `GetState` after connecting for an immediate snapshot. No properties are exported.

The snapshot has exactly ten keys: `presenceStatus`, `presenceStatusCode`, `inCall`, `incomingCall`, `incomingCallCaller`, `cameraEnabled`, `microphoneState`, `microphoneControlState`, `screenSharing`, `meetingStarted` (no timestamp, client ID, or MQTT metadata). Initial presence is `unknown`/`-1`, microphone states are `unknown`, booleans initialize to false and caller to null. These are initial observations, not server-confirmed Teams state; initial camera `false` is not a separately validated camera observation. Boolean values are observed application state, not a multi-account aggregate. Snapshot microphone fields refer to the active profile, and remain `unknown` if it has no observation; state events otherwise reflect events observed by the application. `microphoneState` preserves the raw Teams status; `microphoneControlState` normalizes it to `muted`, `unmuted`, `off`, or `unknown`.

Caller information is opt-in through `config.mqtt.incomingCallCaller.enabled`, independently of whether MQTT is enabled. It is null by default and can contain private name/number/queue details. Meeting-start detection can be enabled with `config.mqtt.meetingStartDetection.enabled` even when MQTT is disabled; `resetSeconds` configures the pulse duration (default 10 seconds). `config.graphApi.enabled` controls Graph API availability. Calendar results can disclose private appointments.

The former MQTT functional data is represented by presence/status code, call and incoming-call state, optional caller, camera, raw microphone and normalized microphone-control state, screen sharing, meeting-start pulse, and on-demand calendar results. Broker credentials, QoS, retain flags, custom topic names, and Home Assistant MQTT auto-discovery are transport settings, not callable Teams functions. D-Bus instead offers introspection, typed signals, and service-owner availability; this API does not provide Home Assistant auto-discovery over D-Bus.

MQTT remains an independent, unchanged control and publishing path. Its existing command handlers, microphone-control app event, calendar input handling, root-window shortcut routing, and Home Assistant discovery are retained; they are not redirected through the D-Bus control service. The D-Bus state observer does not emit MQTT's `teams-microphone-control-changed` event. A legacy MQTT calendar request keeps its original MQTT response topic; `CalendarReceived` describes requests through the new control service.

## Copy/paste examples

Run these from a terminal in the same logged-in user session (no `sudo`). For the installed `.Devel` build:

```bash
BUS=com.github.IsmaelMartinez.teams_for_linux.Devel
OBJ_PATH=/com/github/IsmaelMartinez/teams_for_linux
IFACE=com.github.IsmaelMartinez.teams_for_linux.Control
busctl --user introspect "$BUS" "$OBJ_PATH" "$IFACE"
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" GetState
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" AcceptAudio
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" AcceptVideo
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" DeclineCall
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" SendShortcut s 'Control+Shift+M'
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" ToggleMute
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" Mute b false
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" Unmute b false
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" ToggleVideo
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" ToggleHandRaise
busctl --user call "$BUS" "$OBJ_PATH" "$IFACE" LeaveCall
busctl --user call --timeout=45s "$BUS" "$OBJ_PATH" "$IFACE" GetCalendar ss '2026-10-05T00:00:00Z' '2026-10-12T00:00:00Z'
busctl --user monitor "$BUS"
```

Observe name-owner changes without an MQTT broker:

```bash
busctl --user monitor org.freedesktop.DBus
```

Look for `NameOwnerChanged` for `$BUS`. Native builds use `com.github.IsmaelMartinez.teams_for_linux`; Flatpak uses its app ID (`FLATPAK_ID`). Interface and path are unchanged. Teams shortcut mapping: mute `Ctrl+Shift+M`, video `Ctrl+Shift+O`, hand raise/lower `Ctrl+Shift+K`, leave `Ctrl+Shift+H`. For `SendShortcut`, one primary key and optional unique Electron-style modifiers are supported.

For detailed `busctl` output decoding, all exact accelerator aliases/accepted key names, signal emission and initial-state caveats, caller privacy, calendar errors and Graph response shape, MQTT correspondence, config file paths, and diagnosis, see the [full German reference](../knowledge.md).

After changing application files, rebuild and reinstall the `.Devel` bundle to use the updated version; this document does not claim that an installed bundle has already been updated.
