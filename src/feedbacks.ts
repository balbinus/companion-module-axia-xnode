import {
	combineRgb,
	type CompanionFeedbackButtonStyleResult,
	type CompanionInputFieldDropdown,
	type DropdownChoice,
} from '@companion-module/base'
import type ModuleInstance from './main.js'
import {
	dropdown,
	dstChoices,
	gpiChoices,
	gpoChoices,
	micChoices,
	PIN_CHOICES,
	resolveXpoints,
	sourceChoices,
	srcChoices,
	xpointPickerFields,
	type XpointPickerOptions,
} from './choices.js'
import { parseKnownSources } from './lwrp/livewire.js'
import {
	evaluateDstConnected,
	evaluateDstConnectedTo,
	evaluateFactoryMode,
	evaluateGpioActive,
	evaluateLevelState,
	evaluateOutputExclusive,
	evaluatePhantom,
	evaluateSrcEnabled,
	evaluateSrcInUse,
	evaluateXpointActive,
	evaluateXpointBudget,
	feedbackIdsForChanges,
	physPorts,
	type LevelCondition,
	type LevelSideOption,
	type XpointCondition,
} from './model/derived.js'
import type { MeterKind, StateChange } from './model/state.js'

const GREEN = combineRgb(0, 140, 0)
const RED = combineRgb(200, 0, 0)
const AMBER = combineRgb(220, 140, 0)
const WHITE = combineRgb(255, 255, 255)

const green: CompanionFeedbackButtonStyleResult = { bgcolor: GREEN, color: WHITE }
const red: CompanionFeedbackButtonStyleResult = { bgcolor: RED, color: WHITE }
const amber: CompanionFeedbackButtonStyleResult = { bgcolor: AMBER, color: WHITE }

export type FeedbacksSchema = {
	mix_xpoint_active: {
		type: 'boolean'
		options: XpointPickerOptions & { condition: XpointCondition; gain: number }
	}
	mix_output_exclusive: { type: 'boolean'; options: XpointPickerOptions }
	dst_connected_to: {
		type: 'boolean'
		options: {
			dst: number
			target: 'known' | 'channel' | 'address'
			known: string
			channel: number
			kind: 'from' | 'to' | 'surround'
			address: string
		}
	}
	dst_connected: { type: 'boolean'; options: { dst: number } }
	src_enabled: { type: 'boolean'; options: { src: number } }
	src_in_use: { type: 'boolean'; options: { src: number; engine: string } }
	level_state: {
		type: 'boolean'
		options: {
			group: MeterKind
			src: number
			dst: number
			hwi: number
			hwo: number
			side: LevelSideOption
			condition: LevelCondition
		}
	}
	mixer_factory_mode: { type: 'boolean'; options: Record<string, never> }
	xpoint_budget: { type: 'boolean'; options: { threshold: number } }
	gpi_active: { type: 'boolean'; options: { port: number; pin: number } }
	gpo_active: { type: 'boolean'; options: { port: number; pin: number } }
	mic_phantom: { type: 'boolean'; options: { input: number } }
}

function visibleWhen(field: string, value: string): string {
	return `$(options:${field}) == "${value}"`
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const { state } = self.controller
	const known = parseKnownSources(self.config.knownSources ?? '')
	// The defaults only look at the known sources, so that the definitions do not change as sources are discovered
	const hasKnown = known.length > 0
	const knownChoices = sourceChoices(known, self.directory)
	const physChoices = (dir: 'in' | 'out'): DropdownChoice<number>[] =>
		physPorts(state, dir).map((p) => ({ id: p.n, label: `${p.n} · ${p.label}` }))

	const groupChoices: DropdownChoice<MeterKind>[] = [
		{ id: 'ICH', label: 'Source (SRC)' },
		{ id: 'OCH', label: 'Destination (DST)' },
		...(state.isXNode2
			? ([
					{ id: 'HWI', label: 'Physical input' },
					{ id: 'HWO', label: 'Physical output' },
				] as DropdownChoice<MeterKind>[])
			: []),
	]
	const levelIndex = (
		id: 'src' | 'dst' | 'hwi' | 'hwo',
		label: string,
		choices: DropdownChoice<number>[],
		group: MeterKind,
	): CompanionInputFieldDropdown<typeof id, number> =>
		dropdown(id, label, choices, { isVisibleExpression: visibleWhen('group', group) })

	self.setFeedbackDefinitions({
		mix_xpoint_active: {
			type: 'boolean',
			name: 'Mixer: crosspoint active',
			description: 'True when the crosspoint is on (for a stereo pair, both crosspoints must match).',
			options: [
				...xpointPickerFields(state),
				{
					type: 'dropdown',
					id: 'condition',
					label: 'Condition',
					choices: [
						{ id: 'any', label: 'On (any gain)' },
						{ id: 'gte', label: 'Gain at least' },
						{ id: 'eq', label: 'Gain exactly' },
					],
					default: 'any',
					disableAutoExpression: true,
				},
				{
					type: 'number',
					id: 'gain',
					label: 'Gain (dB)',
					default: 0,
					min: -100,
					max: 24,
					step: 0.1,
					isVisibleExpression: '$(options:condition) != "any"',
				},
			],
			defaultStyle: green,
			callback: (fb) =>
				evaluateXpointActive(
					self.controller.state,
					resolveXpoints(self.controller.state.ioMap, fb.options),
					fb.options.condition ?? 'any',
					Number(fb.options.gain ?? 0),
				),
		},
		mix_output_exclusive: {
			type: 'boolean',
			name: 'Mixer: output fed only by input',
			description: 'True when the output is fed by the chosen input and by nothing else.',
			options: xpointPickerFields(state),
			defaultStyle: green,
			callback: (fb) =>
				evaluateOutputExclusive(self.controller.state, resolveXpoints(self.controller.state.ioMap, fb.options)),
		},
		dst_connected_to: {
			type: 'boolean',
			name: 'Destination: connected to source',
			description: 'True when the destination listens to the chosen source (legacy channel and IP forms both match).',
			options: [
				dropdown('dst', 'Destination', dstChoices(state)),
				{
					type: 'dropdown',
					id: 'target',
					label: 'Source given as',
					choices: [
						{ id: 'known', label: 'Known or discovered source' },
						{ id: 'channel', label: 'Livewire channel number' },
						{ id: 'address', label: 'Multicast address' },
					],
					default: hasKnown ? 'known' : 'channel',
					disableAutoExpression: true,
				},
				{
					type: 'dropdown',
					id: 'known',
					label: 'Known or discovered source',
					choices: knownChoices,
					default: known[0]?.ip ?? '',
					isVisibleExpression: visibleWhen('target', 'known'),
				},
				{
					type: 'number',
					id: 'channel',
					label: 'Livewire channel',
					default: 1,
					min: 1,
					max: 32767,
					asInteger: true,
					isVisibleExpression: visibleWhen('target', 'channel'),
				},
				{
					type: 'dropdown',
					id: 'kind',
					label: 'Channel kind',
					choices: [
						{ id: 'from', label: 'From source (239.192.x.y)' },
						{ id: 'to', label: 'To source (239.193.x.y)' },
						{ id: 'surround', label: 'Surround (239.196.x.y)' },
					],
					default: 'from',
					disableAutoExpression: true,
					isVisibleExpression: visibleWhen('target', 'channel'),
				},
				{
					type: 'textinput',
					id: 'address',
					label: 'Multicast address',
					default: '',
					useVariables: true,
					isVisibleExpression: visibleWhen('target', 'address'),
				},
			],
			defaultStyle: green,
			callback: (fb) => {
				const o = fb.options
				const dst = Number(o.dst)
				if (o.target === 'known')
					return evaluateDstConnectedTo(self.controller.state, dst, { target: 'known', known: o.known ?? '' })
				if (o.target === 'address')
					return evaluateDstConnectedTo(self.controller.state, dst, { target: 'address', address: o.address ?? '' })
				return evaluateDstConnectedTo(self.controller.state, dst, {
					target: 'channel',
					channel: Number(o.channel),
					kind: o.kind ?? 'from',
				})
			},
		},
		dst_connected: {
			type: 'boolean',
			name: 'Destination: connected (any source)',
			options: [dropdown('dst', 'Destination', dstChoices(state))],
			defaultStyle: green,
			callback: (fb) => evaluateDstConnected(self.controller.state, Number(fb.options.dst)),
		},
		src_enabled: {
			type: 'boolean',
			name: 'Source: stream enabled',
			options: [dropdown('src', 'Source', srcChoices(state))],
			defaultStyle: green,
			callback: (fb) => evaluateSrcEnabled(self.controller.state, Number(fb.options.src)),
		},
		src_in_use: {
			type: 'boolean',
			name: 'Source: in use by a console',
			description:
				'True when a console engine owns this SRC (from the Livewire adverts: it generates the backfeed and the source GPIO). Needs "Discover Livewire sources" in the module config.',
			options: [
				dropdown('src', 'Source', srcChoices(state)),
				{
					type: 'textinput',
					id: 'engine',
					label: 'Console engine IP (empty = any)',
					default: '',
					useVariables: true,
				},
			],
			defaultStyle: amber,
			callback: (fb) =>
				evaluateSrcInUse(self.controller.state, self.directory, Number(fb.options.src), fb.options.engine ?? ''),
		},
		level_state: {
			type: 'boolean',
			name: 'Level: signal present / silence / clipping',
			description: 'Needs level alerts enabled in the module config. False until the first states are reliable.',
			options: [
				{
					type: 'dropdown',
					id: 'group',
					label: 'Channel group',
					choices: groupChoices,
					default: 'ICH',
					disableAutoExpression: true,
				},
				levelIndex('src', 'Source', srcChoices(state), 'ICH'),
				levelIndex('dst', 'Destination', dstChoices(state), 'OCH'),
				...(state.isXNode2
					? [
							levelIndex('hwi', 'Physical input', physChoices('in'), 'HWI'),
							levelIndex('hwo', 'Physical output', physChoices('out'), 'HWO'),
						]
					: []),
				{
					type: 'dropdown',
					id: 'side',
					label: 'Side',
					choices: [
						{ id: 'either', label: 'Either side' },
						{ id: 'both', label: 'Both sides' },
						{ id: 'L', label: 'Left' },
						{ id: 'R', label: 'Right' },
					],
					default: 'either',
					disableAutoExpression: true,
				},
				{
					type: 'dropdown',
					id: 'condition',
					label: 'Condition',
					choices: [
						{ id: 'present', label: 'Signal present' },
						{ id: 'silence', label: 'Silence' },
						{ id: 'clip', label: 'Clipping' },
					],
					default: 'present',
					disableAutoExpression: true,
				},
			],
			defaultStyle: green,
			callback: (fb) => {
				const o = fb.options
				const group = o.group ?? 'ICH'
				const index = Number(group === 'ICH' ? o.src : group === 'OCH' ? o.dst : group === 'HWI' ? o.hwi : o.hwo)
				return evaluateLevelState(
					self.controller.state,
					self.controller.levelsReady,
					group,
					index,
					o.side ?? 'either',
					o.condition ?? 'present',
				)
			},
		},
		mixer_factory_mode: {
			type: 'boolean',
			name: 'Mixer: factory mode active',
			description: 'True when the mixer is not in custom mode (MIXCFG MODE is not 0).',
			options: [],
			defaultStyle: amber,
			callback: () => evaluateFactoryMode(self.controller.state),
		},
		xpoint_budget: {
			type: 'boolean',
			name: 'Mixer: crosspoint budget nearly full',
			description: 'True when the number of crosspoints in use reaches the threshold (device limit: 220).',
			options: [
				{
					type: 'number',
					id: 'threshold',
					label: 'Threshold (crosspoints in use)',
					default: 200,
					min: 1,
					max: 220,
					asInteger: true,
				},
			],
			defaultStyle: amber,
			callback: (fb) => evaluateXpointBudget(self.controller.state, Number(fb.options.threshold ?? 200)),
		},
		gpi_active: {
			type: 'boolean',
			name: 'GPI: pin active',
			description: 'Active = low (l).',
			options: [dropdown('port', 'GPI port', gpiChoices(state)), dropdown('pin', 'Pin', PIN_CHOICES)],
			defaultStyle: green,
			callback: (fb) =>
				evaluateGpioActive(self.controller.state.gpi.get(Number(fb.options.port)), Number(fb.options.pin)),
		},
		gpo_active: {
			type: 'boolean',
			name: 'GPO: pin active',
			description: 'Active = low (l).',
			options: [dropdown('port', 'GPO port', gpoChoices(state)), dropdown('pin', 'Pin', PIN_CHOICES)],
			defaultStyle: green,
			callback: (fb) =>
				evaluateGpioActive(self.controller.state.gpo.get(Number(fb.options.port)), Number(fb.options.pin)),
		},
		mic_phantom: {
			type: 'boolean',
			name: 'Microphone: phantom power on',
			options: [dropdown('input', 'Microphone input', micChoices(state))],
			defaultStyle: red,
			callback: (fb) => evaluatePhantom(self.controller.state, Number(fb.options.input)),
		},
	})
}

/** Re-check the feedbacks affected by these state changes (called batched from main.ts). */
export function CheckFeedbacksForChanges(self: ModuleInstance, changes: StateChange[]): void {
	const [first, ...rest] = feedbackIdsForChanges(changes)
	if (first) self.checkFeedbacks(first, ...rest)
}
