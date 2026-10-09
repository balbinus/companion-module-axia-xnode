import {
	combineRgb,
	type CompanionButtonStyleProps,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetSection,
	type CompanionSimplePresetDefinition,
	type SomePresetActionEntry,
	type SomePresetSimpleFeedbackEntry,
	type CompanionFeedbackButtonStyleResult,
} from '@companion-module/base'
import { micChoices, type XpointPickerOptions } from './choices.js'
import { parseKnownSources } from './lwrp/livewire.js'
import { physPorts } from './model/derived.js'
import { pairLabel, type MixPair } from './model/iomap.js'
import type { XNodeState } from './model/state.js'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'

type Presets = CompanionPresetDefinitions<ModuleSchema>
type Preset = CompanionSimplePresetDefinition<ModuleSchema>
type Action = SomePresetActionEntry<ModuleSchema>
type Feedback = SomePresetSimpleFeedbackEntry<ModuleSchema>

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const GREY = combineRgb(40, 40, 40)
const GREEN = combineRgb(0, 140, 0)
const RED = combineRgb(200, 0, 0)
const AMBER = combineRgb(220, 140, 0)
const DIM_AMBER = combineRgb(90, 60, 0)

const onGreen: CompanionFeedbackButtonStyleResult = { bgcolor: GREEN, color: WHITE }
const onRed: CompanionFeedbackButtonStyleResult = { bgcolor: RED, color: WHITE }
const onAmber: CompanionFeedbackButtonStyleResult = { bgcolor: AMBER, color: WHITE }

const style = (
	text: string,
	size: CompanionButtonStyleProps['size'] = 14,
	bgcolor = BLACK,
): CompanionButtonStyleProps => ({
	text,
	size,
	color: WHITE,
	bgcolor,
})

/** Collects presets, groups and sections so the generators below only describe buttons. */
class PresetBuilder {
	readonly presets: Presets = {}
	readonly sections: CompanionPresetSection<ModuleSchema>[] = []

	add(id: string, preset: Preset): string {
		this.presets[id] = preset
		return id
	}

	/** Add a section made of groups; sections or groups without presets are dropped. */
	section(id: string, name: string, description: string, groups: CompanionPresetGroup<ModuleSchema>[]): void {
		const filled = groups.filter((g) => g.type !== 'simple' || g.presets.length > 0)
		if (filled.length > 0) this.sections.push({ id, name, description, definitions: filled })
	}
}

function group(id: string, name: string, presets: string[], description?: string): CompanionPresetGroup<ModuleSchema> {
	return { id, type: 'simple', name, description, presets }
}

/** Picker options for a stereo pair (or a mono channel, which feeds both sides) crosspoint */
function picker(out: MixPair, inp: MixPair): XpointPickerOptions {
	return { mode: 'stereo', out_pair: out.id, in_pair: inp.id, out_ch: out.left.number, in_ch: inp.left.number }
}

/** Label with a line break instead of " · " so that both parts fit on a button */
const stacked = (label: string): string => label.replace(' · ', '\\n')

/** Button text for an input pair: DST pairs follow the live name variable, physical ones the detected label */
function inputText(self: ModuleInstance, pair: MixPair, state: XNodeState): string {
	if (pair.left.kind === 'dst') return `DST ${pair.left.owner}\\n$(${self.label}:dst_${pair.left.owner}_name)`
	return stacked(pairLabel(pair, true, state))
}

function outputText(pair: MixPair, state: XNodeState): string {
	return stacked(pairLabel(pair, false, state))
}

const noSteps = { down: [], up: [] }

/** Single-press button */
function pressButton(name: string, st: CompanionButtonStyleProps, down: Action[], feedbacks: Feedback[] = []): Preset {
	return { type: 'simple', name, style: st, steps: [{ down, up: [] }], feedbacks }
}

/** Display-only button (no action) */
function indicator(name: string, st: CompanionButtonStyleProps, feedbacks: Feedback[]): Preset {
	return { type: 'simple', name, style: st, steps: [noSteps], feedbacks }
}

const levelOptions = (
	level: { group: 'ICH' | 'OCH' | 'HWI' | 'HWO'; n: number },
	condition: 'present' | 'silence' | 'clip',
	physical: boolean,
): Extract<Feedback, { feedbackId: 'level_state' }>['options'] =>
	({
		group: level.group,
		src: level.group === 'ICH' ? level.n : 1,
		dst: level.group === 'OCH' ? level.n : 1,
		// hwi / hwo are only declared by the feedback on xNode2
		...(physical ? { hwi: level.group === 'HWI' ? level.n : 1, hwo: level.group === 'HWO' ? level.n : 1 } : {}),
		side: 'either',
		condition,
	}) as Extract<Feedback, { feedbackId: 'level_state' }>['options']

/** Signal indicator: green when audio is present, dim amber on silence, red on clipping */
function signalButton(
	name: string,
	text: string,
	level: { group: 'ICH' | 'OCH' | 'HWI' | 'HWO'; n: number },
	physical: boolean,
): Preset {
	return indicator(name, style(text), [
		{
			feedbackId: 'level_state',
			options: levelOptions(level, 'silence', physical),
			style: { bgcolor: DIM_AMBER, color: WHITE },
		},
		{ feedbackId: 'level_state', options: levelOptions(level, 'present', physical), style: onGreen },
		{ feedbackId: 'level_state', options: levelOptions(level, 'clip', physical), style: onRed },
	])
}

// ------------------------------------------------------------------ mixer

function addMixer(b: PresetBuilder, self: ModuleInstance, state: XNodeState): void {
	const { outputPairs, inputPairs } = state.ioMap
	const xpoint = (opts: XpointPickerOptions): Extract<Feedback, { feedbackId: 'mix_xpoint_active' }>['options'] => ({
		...opts,
		condition: 'any',
		gain: 0,
	})
	const physOut = outputPairs.filter((p) => p.left.kind === 'phys')
	const srcOut = outputPairs.filter((p) => p.left.kind === 'src')

	const toggleGroup = (prefix: string, out: MixPair): CompanionPresetGroup<ModuleSchema> => {
		const ids = inputPairs.map((inp) => {
			const opts = picker(out, inp)
			return b.add(
				`${prefix}_${out.id}_${inp.id}`,
				pressButton(
					`${outputText(out, state).replace('\\n', ' ')} <- ${pairLabel(inp, true, state)}`,
					style(inputText(self, inp, state)),
					[{ actionId: 'mix_toggle', options: { ...opts, gain: 0 } }],
					[{ feedbackId: 'mix_xpoint_active', options: xpoint(opts), style: onGreen }],
				),
			)
		})
		return group(
			`${prefix}_${out.id}`,
			`Mixer → ${pairLabel(out, false, state)}`,
			ids,
			'Each button switches the stereo crosspoint at 0 dB; green while it is on. Needs "Allow mixer & routing changes".',
		)
	}

	b.section(
		'mixer_outputs',
		'Mixer → physical outputs',
		'One page per physical output: toggle which inputs feed it.',
		physOut.map((out) => toggleGroup('mix', out)),
	)
	b.section(
		'mixer_streams',
		'Mixer → SRC streams',
		'One page per Livewire sender (SRC): toggle which inputs feed the stream.',
		srcOut.map((out) => toggleGroup('mixsrc', out)),
	)

	b.section(
		'mixer_exclusive',
		'Mixer → exclusive select',
		'Radio-button rows: choosing an input clears every other input of that output.',
		physOut.map((out) => {
			const ids = inputPairs.map((inp) => {
				const opts = picker(out, inp)
				return b.add(
					`excl_${out.id}_${inp.id}`,
					pressButton(
						`Only ${pairLabel(inp, true, state)} → ${pairLabel(out, false, state)}`,
						style(inputText(self, inp, state)),
						[{ actionId: 'mix_exclusive', options: { ...opts, gain: 0 } }],
						[{ feedbackId: 'mix_output_exclusive', options: opts, style: onGreen }],
					),
				)
			})
			ids.push(
				b.add(
					`excl_${out.id}_off`,
					pressButton(
						`Clear ${pairLabel(out, false, state)}`,
						style('CLEAR', 14, GREY),
						[
							{
								actionId: 'mix_clear_output',
								options: { mode: 'stereo', out_pair: out.id, out_ch: out.left.number },
							},
						],
						[],
					),
				),
			)
			return group(
				`excl_${out.id}`,
				`Exclusive → ${pairLabel(out, false, state)}`,
				ids,
				'Green: this input is the only one feeding the output. The last button silences the output.',
			)
		}),
	)

	// Rotary: turn = crosspoint gain in 1 dB steps, press = 0 dB. Start at the configured minimum on the first turn up.
	b.section(
		'mixer_rotary',
		'Mixer → rotary (Stream Deck+ / Loupedeck)',
		'Encoder presets: turn to change the crosspoint gain (1 dB per click, an off crosspoint turns on when turned up), press to set 0 dB.',
		physOut.map((out) => {
			const ids = inputPairs.map((inp) => {
				const opts = picker(out, inp)
				const gainVar = self.config.exposeXpointVariables
					? `\\n$(${self.label}:xp_${out.left.number}_${inp.left.number})`
					: ''
				return b.add(`rot_${out.id}_${inp.id}`, {
					type: 'simple',
					name: `Rotary ${pairLabel(inp, true, state)} → ${pairLabel(out, false, state)}`,
					style: style(`${inputText(self, inp, state)}${gainVar}`),
					steps: [
						{
							down: [{ actionId: 'mix_set', options: { ...opts, gain: 0 } }],
							up: [],
							rotate_left: [{ actionId: 'mix_adjust', options: { ...opts, step: -1 } }],
							rotate_right: [{ actionId: 'mix_adjust', options: { ...opts, step: 1 } }],
						},
					],
					feedbacks: [{ feedbackId: 'mix_xpoint_active', options: xpoint(opts), style: onGreen }],
				} satisfies Preset)
			})
			return group(`rot_${out.id}`, `Rotary → ${pairLabel(out, false, state)}`, ids)
		}),
	)
}

// ------------------------------------------------------------------ gains

type GainTarget = { kind: 'dst' | 'src'; n: number }

function gainPresets(b: PresetBuilder, self: ModuleInstance, t: GainTarget): string[] {
	const title = `${t.kind.toUpperCase()} ${t.n}`
	const gainVar = `$(${self.label}:${t.kind}_${t.n}_gain)`
	const adjust = (step: number): Action =>
		t.kind === 'dst'
			? { actionId: 'dst_gain_adjust', options: { dst: t.n, step } }
			: { actionId: 'src_gain_adjust', options: { src: t.n, step } }
	const id = `gain_${t.kind}_${t.n}`
	return [
		b.add(`${id}_down`, pressButton(`${title} gain -1 dB`, style('-1 dB', 18), [adjust(-1)])),
		b.add(`${id}_value`, indicator(`${title} gain`, style(`${title}\\n${gainVar} dB`), [])),
		b.add(`${id}_up`, pressButton(`${title} gain +1 dB`, style('+1 dB', 18), [adjust(1)])),
	]
}

function addGains(b: PresetBuilder, self: ModuleInstance, state: XNodeState): void {
	const targets = (kind: 'dst' | 'src', count: number): GainTarget[] =>
		Array.from({ length: count }, (_, i) => ({ kind, n: i + 1 }))
	const groups = (list: GainTarget[]): CompanionPresetGroup<ModuleSchema>[] =>
		list.map((t) => group(`gain_${t.kind}_${t.n}`, `${t.kind.toUpperCase()} ${t.n} gain`, gainPresets(b, self, t)))
	b.section(
		'gain_dst',
		'Gain → destinations (DST output gain)',
		'-1 dB / current value (display only) / +1 dB. Needs "Allow mixer & routing changes". xNode2 floor: -72 dB.',
		groups(targets('dst', state.ndst)),
	)
	b.section(
		'gain_src',
		'Gain → sources (SRC input gain)',
		'-1 dB / current value (display only) / +1 dB. Needs "Allow source (stream) changes".',
		groups(targets('src', state.nsrc)),
	)

	const rotary = (t: GainTarget): CompanionPresetGroup<ModuleSchema> => {
		const title = `${t.kind.toUpperCase()} ${t.n}`
		const rotate = (step: number): Action[] => [
			t.kind === 'dst'
				? { actionId: 'dst_gain_adjust', options: { dst: t.n, step } }
				: { actionId: 'src_gain_adjust', options: { src: t.n, step } },
		]
		const reset: Action =
			t.kind === 'dst'
				? { actionId: 'dst_gain_set', options: { dst: t.n, gain: 0 } }
				: { actionId: 'src_gain_set', options: { src: t.n, gain: 0 } }
		const text =
			t.kind === 'dst'
				? `${title}\\n$(${self.label}:dst_${t.n}_name)\\n$(${self.label}:dst_${t.n}_gain) dB`
				: `${title}\\n$(${self.label}:src_${t.n}_name)\\n$(${self.label}:src_${t.n}_gain) dB`
		const pid = b.add(`rotgain_${t.kind}_${t.n}`, {
			type: 'simple',
			name: `Rotary ${title} gain`,
			style: style(text),
			steps: [{ down: [reset], up: [], rotate_left: rotate(-0.5), rotate_right: rotate(0.5) }],
			feedbacks: [],
		})
		return group(`rotgain_${t.kind}_${t.n}`, `${title} rotary`, [pid])
	}
	b.section(
		'gain_rotary',
		'Gain → rotary (Stream Deck+ / Loupedeck)',
		'Turn: gain in 0.5 dB steps. Press: back to 0 dB. DST gains need mixer & routing changes, SRC gains need source changes.',
		[...targets('dst', state.ndst), ...targets('src', state.nsrc)].map(rotary),
	)
}

// ------------------------------------------------------------------ DST routing

function addRouting(b: PresetBuilder, self: ModuleInstance, state: XNodeState): void {
	const known = parseKnownSources(self.config.knownSources ?? '')
	const groups = Array.from({ length: state.ndst }, (_, i) => i + 1).map((n) => {
		const ids = known.map((k, idx) =>
			b.add(
				`route_${n}_${idx}`,
				pressButton(
					`DST ${n} ← ${k.label}`,
					style(`${k.label}\\n→ DST ${n}`),
					[
						{
							actionId: 'dst_connect_channel',
							options: { dst: n, source: k.ip, channel: k.channel ?? 1, kind: 'from' },
						},
					],
					[
						{
							feedbackId: 'dst_connected_to',
							options: { dst: n, target: 'known', known: k.ip, channel: 1, kind: 'from', address: '' },
							style: onGreen,
						},
					],
				),
			),
		)
		ids.push(
			b.add(
				`route_${n}_off`,
				pressButton(
					`Disconnect DST ${n}`,
					style(`DST ${n}\\nDISCONNECT`, 14, GREY),
					[{ actionId: 'dst_disconnect', options: { dst: n } }],
					[{ feedbackId: 'dst_connected', options: { dst: n }, style: onGreen, isInverted: true }],
				),
			),
		)
		return group(
			`route_${n}`,
			`DST ${n} routing`,
			ids,
			'Green: connected to this source (from the "Known Livewire sources" list). The last button disconnects; green while disconnected.',
		)
	})
	b.section(
		'dst_routing',
		'DST routing',
		'Connect each destination to a known source. Needs "Allow mixer & routing changes" and entries in "Known Livewire sources".',
		groups,
	)
}

// ------------------------------------------------------------------ status

function addStatus(b: PresetBuilder, self: ModuleInstance, state: XNodeState, known: boolean): void {
	const l = self.label
	const groups: CompanionPresetGroup<ModuleSchema>[] = []

	const info = [
		b.add('status_device', indicator('Device info', style(`$(${l}:model)\\nFW $(${l}:firmware)\\n$(${l}:ip)`, 14), [])),
	]
	if (state.hasMixer) {
		info.push(
			b.add(
				'status_factory_mode',
				indicator('Mixer mode', style(`Mixer\\n$(${l}:mixer_mode)`), [
					{ feedbackId: 'mixer_factory_mode', options: {}, style: onAmber },
				]),
			),
			b.add(
				'status_budget',
				indicator('Crosspoint budget', style(`XP\\n$(${l}:xpoints_used)/220`), [
					{ feedbackId: 'xpoint_budget', options: { threshold: 200 }, style: onAmber },
				]),
			),
		)
	}
	groups.push(group('status_device', 'Device', info, 'Amber: factory mixer mode / 200+ of 220 crosspoints used.'))
	if (!known) {
		b.section('status', 'Status', 'Model-specific presets appear once the node has been read.', groups)
		return
	}

	if (self.config.levelAlerts !== false) {
		const signal = (kind: 'src' | 'dst', group_: 'ICH' | 'OCH', count: number): string[] =>
			Array.from({ length: count }, (_, i) => i + 1).map((n) =>
				b.add(
					`sig_${kind}_${n}`,
					signalButton(
						`${kind.toUpperCase()} ${n} signal`,
						`${kind.toUpperCase()} ${n}\\n$(${l}:${kind}_${n}_name)\\n$(${l}:${kind}_${n}_signal)`,
						{ group: group_, n },
						state.isXNode2,
					),
				),
			)
		groups.push(
			group(
				'status_src',
				'Signal → SRC',
				signal('src', 'ICH', state.nsrc),
				'Green: signal present, dim amber: silence, red: clipping (node level alerts, default thresholds).',
			),
			group('status_dst', 'Signal → DST', signal('dst', 'OCH', state.ndst)),
		)
		if (state.isXNode2) {
			for (const [dir, prefix, g, word] of [
				['in', 'hwi', 'HWI', 'Input'],
				['out', 'hwo', 'HWO', 'Output'],
			] as const) {
				const ids = physPorts(state, dir).map((p) =>
					b.add(
						`sig_${prefix}_${p.n}`,
						signalButton(
							`${word} ${p.label} signal`,
							`${stacked(p.label)}\\n$(${l}:${prefix}_${p.n}_signal)`,
							{
								group: g,
								n: p.n,
							},
							true,
						),
					),
				)
				groups.push(group(`status_${prefix}`, `Signal → physical ${word.toLowerCase()}s`, ids))
			}
		}
	}
	b.section('status', 'Status', 'Read-only indicators: device, mixer and signal state.', groups)

	// SRC stream on/off buttons (they write, so they are not part of the read-only Status section)
	if (state.nsrc > 0) {
		const ids = Array.from({ length: state.nsrc }, (_, i) => i + 1).map((n) =>
			b.add(
				`srcon_${n}`,
				pressButton(
					`SRC ${n} stream (press: toggle)`,
					style(`SRC ${n}\\n$(${l}:src_${n}_name)\\n$(${l}:src_${n}_enabled)`),
					[{ actionId: 'src_enable', options: { src: n, mode: 'toggle' } }],
					[{ feedbackId: 'src_enabled', options: { src: n }, style: onGreen }],
				),
			),
		)
		b.section(
			'src_streams',
			'Sources → stream on/off',
			'Green: stream enabled. Pressing toggles the stream and needs "Allow source (stream) changes".',
			[group('src_streams', 'SRC streams', ids)],
		)
	}
}

// ------------------------------------------------------------------ GPIO and mic

function addGpio(b: PresetBuilder, self: ModuleInstance, state: XNodeState): void {
	const l = self.label
	const pins = [1, 2, 3, 4, 5]
	const gpi = Array.from({ length: state.ngpi }, (_, i) => i + 1).map((port) =>
		group(
			`gpi_${port}`,
			`GPI ${port}`,
			pins.map((pin) =>
				b.add(
					`gpi_${port}_${pin}`,
					indicator(`GPI ${port} pin ${pin}`, style(`GPI ${port}.${pin}\\n$(${l}:gpi_${port})`, 14), [
						{ feedbackId: 'gpi_active', options: { port, pin }, style: onGreen },
					]),
				),
			),
			'Green: pin active (low).',
		),
	)
	b.section('gpi', 'GPI', 'Input pin indicators (read-only).', gpi)

	const gpo = Array.from({ length: state.ngpo }, (_, i) => i + 1).map((port) => {
		const ids = pins.flatMap((pin) => [
			b.add(
				`gpo_${port}_${pin}_toggle`,
				pressButton(
					`GPO ${port} pin ${pin} toggle`,
					style(`GPO ${port}.${pin}\\nTOGGLE`),
					[{ actionId: 'gpo_toggle', options: { port, pins: [pin] } }],
					[{ feedbackId: 'gpo_active', options: { port, pin }, style: onGreen }],
				),
			),
			b.add(
				`gpo_${port}_${pin}_pulse`,
				pressButton(
					`GPO ${port} pin ${pin} pulse 500 ms`,
					style(`GPO ${port}.${pin}\\nPULSE`),
					[{ actionId: 'gpo_pulse', options: { port, pins: [pin], ms: 500, level: 'active' } }],
					[{ feedbackId: 'gpo_active', options: { port, pin }, style: onGreen }],
				),
			),
		])
		return group(
			`gpo_${port}`,
			`GPO ${port}`,
			ids,
			'Toggle or pulse (500 ms) one pin. Only works with "Allow GPO control" enabled; GPOs often drive on-air lights.',
		)
	})
	b.section(
		'gpo',
		'GPO',
		'Output pin control. Requires "Allow GPO control": GPOs often drive on-air lights and machine starts.',
		gpo,
	)
}

function addMic(b: PresetBuilder, self: ModuleInstance, state: XNodeState): void {
	const groups = micChoices(state).map(({ id: inp }) => {
		const n = Number(inp)
		const id = `mic_${n}`
		const down = b.add(
			`${id}_down`,
			pressButton(`Mic INP ${n} gain -1 dB`, style('-1 dB', 18), [
				{ actionId: 'mic_gain_adjust', options: { inp: n, step: -1 } },
			]),
		)
		const value = b.add(
			`${id}_value`,
			indicator(`Mic INP ${n} gain`, style(`MIC ${n}\\n$(${self.label}:inp_${n}_gain) dB`), [
				{ feedbackId: 'mic_phantom', options: { input: n }, style: onRed },
			]),
		)
		const up = b.add(
			`${id}_up`,
			pressButton(`Mic INP ${n} gain +1 dB`, style('+1 dB', 18), [
				{ actionId: 'mic_gain_adjust', options: { inp: n, step: 1 } },
			]),
		)
		return group(
			id,
			`Mic ${n} gain`,
			[down, value, up],
			'Needs "Allow source (stream) changes". The node accepts 0 dB or 14-69 dB only. The value turns red while phantom power is on (phantom power cannot be controlled from here).',
		)
	})
	b.section('mic', 'Microphone input', 'Mic preamp gain (xNode2 nodes with a MIC input).', groups)
}

// ------------------------------------------------------------------ entry point

export function UpdatePresets(self: ModuleInstance): void {
	const state = self.controller.state
	const known = Object.keys(state.ver).length > 0
	const b = new PresetBuilder()

	if (known) {
		if (state.hasMixer) addMixer(b, self, state)
		addGains(b, self, state)
		if (state.ndst > 0) addRouting(b, self, state)
		if (state.ngpi > 0 || state.ngpo > 0) addGpio(b, self, state)
		if (state.isXNode2) addMic(b, self, state)
	}
	addStatus(b, self, state, known)

	// Keep the device / status section first
	const status = b.sections.filter((s) => s.id === 'status')
	const rest = b.sections.filter((s) => !status.includes(s))
	self.setPresetDefinitions([...status, ...rest], b.presets)
}
