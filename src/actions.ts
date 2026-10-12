import type {
	CompanionActionDefinitions,
	CompanionInputFieldDropdown,
	CompanionInputFieldMultiDropdown,
	SomeCompanionActionInputField,
} from '@companion-module/base'
import {
	dropdown,
	dstChoices,
	gpoChoices,
	micChoices,
	PIN_CHOICES,
	resolveXpoints,
	sourceChoices,
	srcChoices,
	xpointPickerFields,
	type XpointPickerOptions,
} from './choices.js'
import { PULSE_MAX_MS, PULSE_MIN_MS, SRC_MODES } from './device/operations.js'
import { parseKnownSources } from './lwrp/livewire.js'
import { dbToTenths } from './lwrp/units.js'
import type ModuleInstance from './main.js'
import { findChannel } from './model/iomap.js'

type Gain = { gain: number }
type Step = { step: number }
type Pins = { port: number; pins: number[] }

export type ActionsSchema = {
	mix_set: { options: XpointPickerOptions & Gain }
	mix_clear: { options: XpointPickerOptions }
	mix_toggle: { options: XpointPickerOptions & Gain }
	mix_adjust: { options: XpointPickerOptions & Step }
	mix_exclusive: { options: XpointPickerOptions & Gain }
	mix_clear_output: { options: Pick<XpointPickerOptions, 'mode' | 'out_pair' | 'out_ch'> }
	mix_snapshot_store: { options: Record<string, never>; result: string }
	mix_snapshot_recall: { options: { snapshot: string } }
	gpo_set: { options: Pins & { active: 'active' | 'inactive' } }
	gpo_pulse: { options: Pins & { ms: number; level: 'active' | 'inactive' } }
	gpo_toggle: { options: Pins }
	mic_gain_set: { options: { inp: number } & Gain }
	mic_gain_adjust: { options: { inp: number } & Step }
	dst_connect_channel: { options: { dst: number; source: string; channel: number; kind: 'from' | 'to' } }
	dst_connect_address: { options: { dst: number; address: string } }
	dst_disconnect: { options: { dst: number } }
	dst_gain_set: { options: { dst: number } & Gain }
	dst_gain_adjust: { options: { dst: number } & Step }
	src_gain_set: { options: { src: number } & Gain }
	src_gain_adjust: { options: { src: number } & Step }
	src_enable: { options: { src: number; mode: 'on' | 'off' | 'toggle' } }
	src_address: { options: { src: number; address: string } }
	src_mode: { options: { src: number; mode: number } }
	src_rename: { options: { src: number; name: string } }
}

type Defs = Partial<CompanionActionDefinitions<ActionsSchema>>

const CUSTOM_SOURCE = 'custom'

const gainField = (label = 'Gain (dB)', min = -100, max = 24, def = 0): SomeCompanionActionInputField<'gain'> => ({
	type: 'number',
	id: 'gain',
	label,
	min,
	max,
	step: 0.5,
	default: def,
})

const stepField = (range: number, def: number): SomeCompanionActionInputField<'step'> => ({
	type: 'number',
	id: 'step',
	label: 'Change (dB, negative = down)',
	min: -range,
	max: range,
	step: 0.5,
	default: def,
})

const pinFields = (state: ModuleInstance['controller']['state']): SomeCompanionActionInputField<'port' | 'pins'>[] => {
	const pins: CompanionInputFieldMultiDropdown<'pins', number> = {
		type: 'multidropdown',
		id: 'pins',
		label: 'Pins',
		choices: PIN_CHOICES,
		default: [1],
		minSelection: 1,
	}
	return [dropdown('port', 'GPO port', gpoChoices(state)), pins]
}

const activeChoices = [
	{ id: 'active', label: 'Active (low)' },
	{ id: 'inactive', label: 'Inactive (high)' },
]

function levelDropdown<K extends string>(id: K, label: string): CompanionInputFieldDropdown<K, string> {
	return { type: 'dropdown', id, label, choices: activeChoices, default: 'active', disableAutoExpression: true }
}

function toInts(values: unknown): number[] {
	const list = Array.isArray(values) ? values : [values]
	return list.map(Number).filter((n) => Number.isInteger(n))
}

/** Output rows selected by the mixer picker's output half. */
function resolveOutputs(
	self: ModuleInstance,
	options: Partial<Pick<XpointPickerOptions, 'mode' | 'out_pair' | 'out_ch'>>,
): number[] {
	const map = self.controller.state.ioMap
	if (options.mode === 'mono') {
		const ch = findChannel(map.outputs, Number(options.out_ch))
		return ch ? [ch.number] : []
	}
	const pair = map.outputPairs.find((p) => p.id === Number(options.out_pair))
	return pair ? [pair.left.number, ...(pair.right ? [pair.right.number] : [])] : []
}

export function UpdateActions(self: ModuleInstance): void {
	const state = self.controller.state
	// Before the first sync nothing is known: define everything so saved buttons keep their actions.
	const known = Object.keys(state.ver).length > 0
	const hasMixer = !known || state.hasMixer
	const hasGpo = !known || state.ngpo > 0
	const hasMic = !known || (state.isXNode2 && micChoices(state).length > 0)

	/** Run an operation; refusals and failures are logged as warnings and rethrown so Companion reports the action as failed. */
	const guard = async (name: string, fn: () => Promise<void>): Promise<void> => {
		try {
			await fn()
		} catch (e) {
			self.log('warn', `${name}: ${e instanceof Error ? e.message : String(e)}`)
			throw e
		}
	}
	const xpoints = (o: Partial<XpointPickerOptions>): Array<[number, number]> => {
		const list = resolveXpoints(state.ioMap, o)
		if (list.length === 0) throw new Error('The selected crosspoint does not exist on this node')
		return list
	}
	const pickerFields = xpointPickerFields(state)
	const outputPickerFields = pickerFields.filter((f) => ['mode', 'out_pair', 'out_ch'].includes(f.id))
	const knownSources = parseKnownSources(self.config.knownSources ?? '')

	const defs: Defs = {}

	if (hasMixer) {
		defs.mix_set = {
			name: 'Mixer: set crosspoint',
			description: 'Route an input to an output at the given gain (stereo pairs map L to L and R to R).',
			options: [...pickerFields, gainField('Gain (dB)', -100, 24, 0)],
			callback: async ({ options }) =>
				guard('mix_set', async () => self.ops.mixSet(xpoints(options), dbToTenths(Number(options.gain)))),
		}
		defs.mix_clear = {
			name: 'Mixer: clear crosspoint',
			options: pickerFields,
			callback: async ({ options }) => guard('mix_clear', async () => self.ops.mixClear(xpoints(options))),
		}
		defs.mix_toggle = {
			name: 'Mixer: toggle crosspoint',
			description: 'If every selected crosspoint is on, clear them; otherwise set them to the given gain.',
			options: [...pickerFields, gainField('Gain when switching on (dB)', -100, 24, 0)],
			callback: async ({ options }) =>
				guard('mix_toggle', async () => self.ops.mixToggle(xpoints(options), dbToTenths(Number(options.gain)))),
		}
		defs.mix_adjust = {
			name: 'Mixer: adjust crosspoint gain',
			description:
				'Add or subtract dB (rotary friendly: rapid steps are merged). An off crosspoint starts from the configured minimum gain on a positive step and ignores negative steps.',
			options: [...pickerFields, stepField(24, 1)],
			callback: async ({ options }) =>
				guard('mix_adjust', async () => self.ops.mixAdjust(xpoints(options), dbToTenths(Number(options.step)))),
		}
		defs.mix_exclusive = {
			name: 'Mixer: exclusive select',
			description: 'Route only this input to the output: every other input of that output is cleared.',
			options: [...pickerFields, gainField('Gain (dB)', -100, 24, 0)],
			callback: async ({ options }) =>
				guard('mix_exclusive', async () => self.ops.mixExclusive(xpoints(options), dbToTenths(Number(options.gain)))),
		}
		defs.mix_clear_output = {
			name: 'Mixer: clear output',
			description: 'Silence an output: clear every crosspoint that feeds it.',
			options: outputPickerFields as SomeCompanionActionInputField<'mode' | 'out_pair' | 'out_ch'>[],
			callback: async ({ options }) =>
				guard('mix_clear_output', async () => {
					const outputs = resolveOutputs(self, options)
					if (outputs.length === 0) throw new Error('The selected output does not exist on this node')
					await self.ops.mixClearOutput(outputs)
				}),
		}
		defs.mix_snapshot_store = {
			name: 'Mixer: store snapshot',
			description:
				'Returns the whole mixer as a JSON text. Use the action result to put it in a custom variable, for the recall action.',
			options: [],
			hasResult: true,
			callback: async () => {
				try {
					return await self.ops.mixSnapshotStore()
				} catch (e) {
					self.log('warn', `mix_snapshot_store: ${e instanceof Error ? e.message : String(e)}`)
					throw e
				}
			},
		}
		defs.mix_snapshot_recall = {
			name: 'Mixer: recall snapshot',
			description:
				'Restore a snapshot made by "Store snapshot" (usually from a custom variable). Only changed crosspoints are written.',
			options: [
				{
					type: 'textinput',
					id: 'snapshot',
					label: 'Snapshot (JSON)',
					default: '',
				},
			],
			callback: async ({ options }) =>
				guard('mix_snapshot_recall', async () => {
					await self.ops.mixSnapshotRecall(String(options.snapshot ?? ''))
				}),
		}
	}

	if (hasGpo) {
		defs.gpo_set = {
			name: 'GPO: set pins',
			options: [...pinFields(state), levelDropdown('active', 'Level')],
			callback: async ({ options }) =>
				guard('gpo_set', async () =>
					self.ops.gpoSet(Number(options.port), toInts(options.pins), options.active !== 'inactive'),
				),
		}
		defs.gpo_pulse = {
			name: 'GPO: pulse pins',
			description: 'Drive the pins for a time, then restore their previous level. Starting again restarts the timer.',
			options: [
				...pinFields(state),
				levelDropdown('level', 'Pulse level'),
				{
					type: 'number',
					id: 'ms',
					label: 'Duration (ms)',
					min: PULSE_MIN_MS,
					max: PULSE_MAX_MS,
					step: 10,
					default: 500,
					asInteger: true,
				},
			],
			callback: async ({ options }) =>
				guard('gpo_pulse', async () =>
					self.ops.gpoPulse(
						Number(options.port),
						toInts(options.pins),
						Math.round(Number(options.ms)),
						options.level !== 'inactive',
					),
				),
		}
		defs.gpo_toggle = {
			name: 'GPO: toggle pins',
			options: pinFields(state),
			callback: async ({ options }) =>
				guard('gpo_toggle', async () => self.ops.gpoToggle(Number(options.port), toInts(options.pins))),
		}
	}

	if (hasMic) {
		defs.mic_gain_set = {
			name: 'Mic input: set gain',
			options: [dropdown('inp', 'Microphone input', micChoices(state)), gainField('Gain (dB, 0 or 14-69)', 0, 69, 0)],
			callback: async ({ options }) =>
				guard('mic_gain_set', async () => self.ops.micGainSet(Number(options.inp), dbToTenths(Number(options.gain)))),
		}
		defs.mic_gain_adjust = {
			name: 'Mic input: adjust gain',
			options: [dropdown('inp', 'Microphone input', micChoices(state)), stepField(70, 1)],
			callback: async ({ options }) =>
				guard('mic_gain_adjust', async () =>
					self.ops.micGainAdjust(Number(options.inp), dbToTenths(Number(options.step))),
				),
		}
	}

	if (state.ndst > 0 || !known) {
		const dstField = (): SomeCompanionActionInputField<'dst'> => dropdown('dst', 'Destination', dstChoices(state))
		defs.dst_connect_channel = {
			name: 'Destination: connect to Livewire channel',
			description:
				'Pick a known or discovered source, or enter a channel number. "To" is the backfeed range (239.193).',
			options: [
				dstField(),
				{
					type: 'dropdown',
					id: 'source',
					label: 'Source',
					choices: [
						...sourceChoices(knownSources, self.directory),
						{ id: CUSTOM_SOURCE, label: 'Custom channel number' },
					],
					default: knownSources[0]?.ip ?? CUSTOM_SOURCE,
					disableAutoExpression: true,
				},
				{
					type: 'number',
					id: 'channel',
					label: 'Livewire channel',
					min: 1,
					max: 32767,
					default: 1,
					asInteger: true,
					isVisibleExpression: `$(options:source) == "${CUSTOM_SOURCE}"`,
				},
				{
					type: 'dropdown',
					id: 'kind',
					label: 'Channel type',
					choices: [
						{ id: 'from', label: 'From source (239.192)' },
						{ id: 'to', label: 'To source / backfeed (239.193)' },
					],
					default: 'from',
					disableAutoExpression: true,
					isVisibleExpression: `$(options:source) == "${CUSTOM_SOURCE}"`,
				},
			],
			callback: async ({ options }) =>
				guard('dst_connect_channel', async () => {
					const dst = Number(options.dst)
					if (options.source === CUSTOM_SOURCE) {
						await self.ops.dstConnectChannel(
							dst,
							Math.round(Number(options.channel)),
							options.kind === 'to' ? 'to' : 'from',
						)
					} else {
						await self.ops.dstConnectAddress(dst, String(options.source))
					}
				}),
		}
		defs.dst_connect_address = {
			name: 'Destination: connect to multicast address',
			options: [
				dstField(),
				{ type: 'textinput', id: 'address', label: 'Multicast address (IPv4)', default: '239.192.0.1' },
			],
			callback: async ({ options }) =>
				guard('dst_connect_address', async () =>
					self.ops.dstConnectAddress(Number(options.dst), String(options.address)),
				),
		}
		defs.dst_disconnect = {
			name: 'Destination: disconnect',
			options: [dstField()],
			callback: async ({ options }) => guard('dst_disconnect', async () => self.ops.dstDisconnect(Number(options.dst))),
		}
		defs.dst_gain_set = {
			name: 'Destination: set output gain',
			options: [dstField(), gainField('Gain (dB)', -100, 24, 0)],
			callback: async ({ options }) =>
				guard('dst_gain_set', async () => self.ops.dstGainSet(Number(options.dst), dbToTenths(Number(options.gain)))),
		}
		defs.dst_gain_adjust = {
			name: 'Destination: adjust output gain',
			options: [dstField(), stepField(124, 1)],
			callback: async ({ options }) =>
				guard('dst_gain_adjust', async () =>
					self.ops.dstGainAdjust(Number(options.dst), dbToTenths(Number(options.step))),
				),
		}
	}

	if (state.nsrc > 0 || !known) {
		const srcField = (): SomeCompanionActionInputField<'src'> => dropdown('src', 'Source', srcChoices(state))
		defs.src_gain_set = {
			name: 'Source: set input gain',
			options: [srcField(), gainField('Gain (dB)', -100, 24, 0)],
			callback: async ({ options }) =>
				guard('src_gain_set', async () => self.ops.srcGainSet(Number(options.src), dbToTenths(Number(options.gain)))),
		}
		defs.src_gain_adjust = {
			name: 'Source: adjust input gain',
			options: [srcField(), stepField(124, 1)],
			callback: async ({ options }) =>
				guard('src_gain_adjust', async () =>
					self.ops.srcGainAdjust(Number(options.src), dbToTenths(Number(options.step))),
				),
		}
		defs.src_enable = {
			name: 'Source: enable / disable stream',
			options: [
				srcField(),
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Stream',
					choices: [
						{ id: 'on', label: 'Enable' },
						{ id: 'off', label: 'Disable' },
						{ id: 'toggle', label: 'Toggle' },
					],
					default: 'on',
					disableAutoExpression: true,
				},
			],
			callback: async ({ options }) =>
				guard('src_enable', async () => {
					const mode = options.mode === 'off' || options.mode === 'toggle' ? options.mode : 'on'
					await self.ops.srcEnable(Number(options.src), mode)
				}),
		}
		defs.src_address = {
			name: 'Source: set stream address',
			description: 'A Livewire channel number (239.192.x.y) or an IPv4 multicast address.',
			options: [srcField(), { type: 'textinput', id: 'address', label: 'Channel or multicast address', default: '' }],
			callback: async ({ options }) =>
				guard('src_address', async () => self.ops.srcSetAddress(Number(options.src), String(options.address))),
		}
		defs.src_mode = {
			name: 'Source: set stream mode',
			options: [
				srcField(),
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					choices: [
						{ id: SRC_MODES.live, label: 'Livewire Live (low latency)' },
						{ id: SRC_MODES.standard, label: 'Livewire Standard' },
						{ id: SRC_MODES.aes67, label: 'AES67 (1 ms)' },
					],
					default: SRC_MODES.live,
				},
			],
			callback: async ({ options }) =>
				guard('src_mode', async () => self.ops.srcSetMode(Number(options.src), Number(options.mode))),
		}
		defs.src_rename = {
			name: 'Source: rename',
			description: 'Up to 16 characters; quotes and control characters are removed.',
			options: [srcField(), { type: 'textinput', id: 'name', label: 'Name', default: '', minLength: 1 }],
			callback: async ({ options }) =>
				guard('src_rename', async () => self.ops.srcRename(Number(options.src), String(options.name))),
		}
	}

	self.setActionDefinitions(defs as CompanionActionDefinitions<ActionsSchema>)
}
