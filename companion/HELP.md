# Axia xNode

Monitor and control Axia **xNode** and **xNode2** audio nodes over LWRP (Livewire Routing Protocol, TCP port 93): the 24x24 mixer, destination routing, gains, signal alerts and GPIO.

**The module is read-only by default.** It never writes anything to the node until you tick a permission in the module configuration.

## Supported devices

| Device                                             | LWRP | Notes                                                                                                         |
| -------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| xNode (legacy), Analog 4x4 / AES 4x4 / Mixed / Mic | 1.2  | Full mixer, SRC/DST, level alerts. Meters for the physical inputs/outputs only through the HTTP meter stream. |
| xNode2 (Analog, AES, Mixed, Mic)                   | 1.4  | Same, plus physical input/output level alerts and meters, microphone input gain.                              |
| GPIO and xSelector nodes                           | -    | Read-only / limited: whatever the node reports (SRC, DST, GPIO) is shown, mixer features are not offered.     |

The model is detected when the module connects (from the `VER` answer). Actions, feedbacks, variables and presets are generated from what the node actually has.

## Configuration

| Field                             | Meaning                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node IP or hostname, LWRP port    | Where the node listens (port 93).                                                                                                                                                                                                    |
| LWRP password                     | Stored as a Companion secret. Sent (`LOGIN`) only when a write permission below is on. Also used as the HTTP Basic auth password of the HTTP meter stream. Empty if the node has none.                                               |
| Allow mixer & routing changes     | Unlocks crosspoint changes (MIX) and destination changes (connect, disconnect, DST gain).                                                                                                                                            |
| Allow source (stream) changes     | Unlocks SRC changes (enable, address, mode, input gain, rename) and the microphone input gain. These change what goes on the network.                                                                                                |
| Allow leaving factory mixer mode  | A crosspoint write on a node in a factory mixer mode silently switches it to custom mode. Without this option such writes are refused (the "Mixer: factory mode" feedback shows the state).                                          |
| Allow GPO control                 | Unlocks GPO actions. GPOs often drive on-air lights, tally or machine starts.                                                                                                                                                        |
| Meters                            | Off, LWRP poll (snapshot every interval) or HTTP stream (also gives the legacy xNode physical input/output meters).                                                                                                                  |
| Meter interval                    | Milliseconds, minimum 100.                                                                                                                                                                                                           |
| Level alerts                      | Subscribes to the node's silence/clip alerts (default thresholds, never modified).                                                                                                                                                   |
| Expose crosspoint variables       | One variable per crosspoint (up to 600). Off by default.                                                                                                                                                                             |
| Crosspoint gain minimum / maximum | The node does not limit crosspoint gains, so the module does (default -80 to +24 dB).                                                                                                                                                |
| Known Livewire sources            | Optional, one per line: `22301=Studio Mic 1` (channel number) or `239.192.87.29=Name` (multicast address). `#` starts a comment. Used by the destination connect dropdowns, the "connected to" feedback and the DST routing presets. |

## Actions

Crosspoint pickers choose either a **stereo pair** (left to left, right to right) or a **single mono channel**.

- **Mixer**: set, clear, toggle, adjust (rotary friendly), exclusive select (only this input feeds the output), clear output, store/recall snapshot (the store action returns the snapshot as text, put it in a custom variable).
- **Destinations**: connect to a known source or Livewire channel, connect to a multicast address, disconnect, set/adjust output gain.
- **Sources**: set/adjust input gain, enable/disable/toggle stream, set address, set mode (Live / Standard / AES67), rename (16 characters max).
- **GPO**: set pins, pulse pins, toggle pins. A pulse drives the pins, then restores the level they had before it. The restore is always scheduled once the pulse was sent, retried for about 3 minutes if the link is down, and done immediately when the module is disabled or its configuration is saved. Pulsing a pin that already has the pulse level (and no pulse running) changes nothing; pulsing a pin whose pulse is running restarts the timer.
- Repeated set actions on the same target (set, toggle, exclusive, gain set) that are still waiting in the queue are merged into the latest one. A failed action is reported as failed in Companion and logged.
- **Microphone** (xNode2): set/adjust gain.

Action ids: `mix_set`, `mix_clear`, `mix_toggle`, `mix_adjust`, `mix_exclusive`, `mix_clear_output`, `mix_snapshot_store`, `mix_snapshot_recall`, `gpo_set`, `gpo_pulse`, `gpo_toggle`, `mic_gain_set`, `mic_gain_adjust`, `dst_connect_channel`, `dst_connect_address`, `dst_disconnect`, `dst_gain_set`, `dst_gain_adjust`, `src_gain_set`, `src_gain_adjust`, `src_enable`, `src_address`, `src_mode`, `src_rename`.

## Feedbacks

Crosspoint active (optionally by gain), output fed only by an input, destination connected to a source, destination connected (any), source stream enabled, level state (signal present / silence / clipping for SRC, DST and, on xNode2, physical inputs and outputs), mixer in factory mode, crosspoint budget nearly full, GPI pin active, GPO pin active, microphone phantom power on.

## Variables

Replace `N` by the number; only what exists on the detected model is defined.

- Device: `model`, `devn`, `product`, `firmware`, `lwrp_version`, `hostname`, `ip`, `link`, `node_id`, `mixer_mode`, `xpoints_used`, and on legacy nodes `set_nid`, `set_lwclk_prio`, `set_ptp_dom`, `set_enable_sap`, `set_adip`.
- Sources: `src_N_name`, `src_N_enabled`, `src_N_address`, `src_N_channel`, `src_N_mode`, `src_N_gain`, `src_N_signal`.
- Destinations: `dst_N_name`, `dst_N_address`, `dst_N_channel`, `dst_N_source_label`, `dst_N_gain`, `dst_N_signal`.
- Mixer: `mix_out_K_inputs` (what feeds output K), `xp_O_I` (crosspoint gain, optional).
- Physical I/O (xNode2): `hwi_N_signal`, `hwo_N_signal`. Inputs (xNode2): `inp_N_name` and `inp_N_type` exist for every INP, `inp_N_gain` and `inp_N_phantom` only for microphone inputs.
- Meters (when enabled): `src_N_peak_l|r`, `dst_N_peak_l|r`, `hwi_N_peak_l|r`, `hwo_N_peak_l|r`.
- GPIO: `gpi_N`, `gpo_N` (pin string, `l` = active), `gpo_N_name`.

## Presets

Generated from the detected model (nothing but the device info before the first read).

- **Status**: device info, mixer factory mode, crosspoint budget, signal present / silence / clip per SRC and DST (and physical I/O on xNode2).
- **Sources → stream on/off**: one toggle button per SRC (green when the stream is enabled). It writes, so it needs "Allow source (stream) changes".
- **Mixer**: one page per physical output and per SRC stream with one button per input pair (toggle at 0 dB, green when active); exclusive-select rows (radio buttons); rotary presets for Stream Deck+ / Loupedeck (turn: gain, press: 0 dB). Turning up an off crosspoint turns it on starting from the configured minimum gain; pressing the encoder sets 0 dB.
- **Gain**: -1 dB / value / +1 dB buttons and rotary presets per DST and SRC. The centre button only displays the value; the rotary press sets 0 dB.
- **DST routing**: one button per known source plus a disconnect button, per destination.
- **GPIO** (nodes with GPIO): GPI indicators, GPO toggle and 500 ms pulse buttons (require "Allow GPO control").
- **Microphone** (xNode2): gain buttons, red value while phantom power is on.

Buttons that write need the matching permission in the configuration, otherwise the action is refused and logged.

## Safety

- Everything is validated and clamped before it is sent. Gains are sent as integer tenths of a dB.
- Source input gain and destination output gain: -100 to +24 dB. Below -72 dB the nodes behave differently: legacy nodes store any lower value as -100 dB (mute), and xNode2 refuses it, so the module sends -72 dB there. Adjusting up from -72 dB or below (including the legacy mute) starts from -72 dB. An absent gain on a legacy node means 0 dB.
- Crosspoints: the node has a budget of **220** crosspoints; the module refuses writes beyond it. While the mixer has not been fully read (some rows missing), writes that add crosspoints are refused; clearing is still allowed. Crosspoint gain stays within the configured limits.
- Microphone gain: the node accepts **0 dB or 14 to 69 dB**; other values are snapped (stepping down from 14 dB goes to 0).
- **Phantom power is deliberately not controllable** (risk of damaging equipment); it is only shown as a variable and a feedback.
- System settings, IP, mixer configuration and input sources are never written.
- Do not point several controllers at the same crosspoint at the same time: the last write wins.

## Limitations

- Meters and level alerts have not been verified with real audio. The first level state after connecting is provisional (about 3 seconds) and is ignored.
- On legacy xNodes, physical input/output (HWI/HWO) meters are only available with the "HTTP stream" meter mode.
- GPIO and xSelector nodes are only partially supported (read-only / limited).
- Livewire sources cannot be discovered on the network; list the ones you need in "Known Livewire sources".
