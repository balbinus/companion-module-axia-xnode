import type { CompanionInputFieldDropdown, DropdownChoice } from '@companion-module/base'
import { channelLabel, findChannel, pairLabel, type MixIoMap } from './model/iomap.js'
import type { XNodeState } from './model/state.js'

/** Mixer crosspoint picker options shared by actions and feedbacks */
export type XpointPickerOptions = {
	mode: 'stereo' | 'mono'
	out_pair: number
	in_pair: number
	out_ch: number
	in_ch: number
}

const STEREO_ONLY = '$(options:mode) == "stereo"'
const MONO_ONLY = '$(options:mode) == "mono"'

function range(n: number, label: (i: number) => string): DropdownChoice<number>[] {
	return Array.from({ length: n }, (_, i) => ({ id: i + 1, label: label(i + 1) }))
}

function nameSuffix(name: string | undefined, fallback: string): string {
	return name && name !== fallback ? ` · ${name}` : ''
}

export function outputPairChoices(state: XNodeState): DropdownChoice<number>[] {
	return state.ioMap.outputPairs.map((p) => ({
		id: p.id,
		label: `${p.id}${p.right ? `/${p.right.number}` : ''} · ${pairLabel(p, false, state)}`,
	}))
}

export function inputPairChoices(state: XNodeState): DropdownChoice<number>[] {
	return state.ioMap.inputPairs.map((p) => ({
		id: p.id,
		label: `${p.id}${p.right ? `/${p.right.number}` : ''} · ${pairLabel(p, true, state)}`,
	}))
}

export function outputChannelChoices(state: XNodeState): DropdownChoice<number>[] {
	return state.ioMap.outputs.map((c) => ({ id: c.number, label: `${c.number} · ${channelLabel(c, false, state)}` }))
}

export function inputChannelChoices(state: XNodeState): DropdownChoice<number>[] {
	return state.ioMap.inputs.map((c) => ({ id: c.number, label: `${c.number} · ${channelLabel(c, true, state)}` }))
}

/** "SRC 3 · TEL 1" */
export function srcChoices(state: XNodeState): DropdownChoice<number>[] {
	return range(state.nsrc, (n) => `SRC ${n}${nameSuffix(state.srcName(n), `SRC ${n}`)}`)
}

/** "DST 2 · Program 3" */
export function dstChoices(state: XNodeState): DropdownChoice<number>[] {
	return range(state.ndst, (n) => `DST ${n}${nameSuffix(state.dstName(n), `DST ${n}`)}`)
}

export function gpiChoices(state: XNodeState): DropdownChoice<number>[] {
	return range(state.ngpi, (n) => `GPI ${n}`)
}

export function gpoChoices(state: XNodeState): DropdownChoice<number>[] {
	return range(state.ngpo, (n) => `GPO ${n}${nameSuffix(state.cfgGpo.get(n)?.NAME, `GPO ${n}`)}`)
}

/** Physical inputs of type MIC (xNode2 INP) */
export function micChoices(state: XNodeState): DropdownChoice<number>[] {
	return [...state.inp.entries()]
		.filter(([, a]) => (a.TYPE ?? '').toUpperCase() === 'MIC')
		.sort(([a], [b]) => a - b)
		.map(([n, a]) => ({ id: n, label: `INP ${n}${nameSuffix(a.NAME, `INP ${n}`)}` }))
}

/** Pins 1..5 of a GPIO port */
export const PIN_CHOICES: DropdownChoice<number>[] = range(5, (n) => `Pin ${n}`)

/** Dropdown with the first choice as default (1 when the model is not known yet) */
export function dropdown<K extends string>(
	id: K,
	label: string,
	choices: DropdownChoice<number>[],
	extra: Partial<CompanionInputFieldDropdown<K, number>> = {},
): CompanionInputFieldDropdown<K, number> {
	return { type: 'dropdown', id, label, choices, default: choices[0]?.id ?? 1, ...extra }
}

/** The five fields of a crosspoint picker: stereo pairs (L→L, R→R) or single mono channels */
export function xpointPickerFields(
	state: XNodeState,
): CompanionInputFieldDropdown<keyof XpointPickerOptions, string | number>[] {
	return [
		{
			type: 'dropdown',
			id: 'mode',
			label: 'Channels',
			choices: [
				{ id: 'stereo', label: 'Stereo pair (L→L, R→R)' },
				{ id: 'mono', label: 'Single mono channel' },
			],
			default: 'stereo',
			disableAutoExpression: true,
		},
		dropdown('out_pair', 'Output (mixer row)', outputPairChoices(state), { isVisibleExpression: STEREO_ONLY }),
		dropdown('in_pair', 'Input', inputPairChoices(state), { isVisibleExpression: STEREO_ONLY }),
		dropdown('out_ch', 'Output channel (mixer row)', outputChannelChoices(state), { isVisibleExpression: MONO_ONLY }),
		dropdown('in_ch', 'Input channel', inputChannelChoices(state), { isVisibleExpression: MONO_ONLY }),
	]
}

/**
 * Resolve picker options into wire crosspoints `[output, input]`, restricted to the detected I/O map.
 * Stereo: output pair (o, o+1) × input pair (i, i+1) → [o,i], [o+1,i+1]; a mono input feeds both output channels.
 * Returns [] when a channel is not part of the map (unknown model, stale option).
 */
export function resolveXpoints(ioMap: MixIoMap, options: Partial<XpointPickerOptions>): Array<[number, number]> {
	if (!ioMap.hasMixer) return []
	if (options.mode === 'mono') {
		const out = findChannel(ioMap.outputs, Number(options.out_ch))
		const inp = findChannel(ioMap.inputs, Number(options.in_ch))
		return out && inp ? [[out.number, inp.number]] : []
	}
	const outPair = ioMap.outputPairs.find((p) => p.id === Number(options.out_pair))
	const inPair = ioMap.inputPairs.find((p) => p.id === Number(options.in_pair))
	if (!outPair || !inPair) return []
	const result: Array<[number, number]> = [[outPair.left.number, inPair.left.number]]
	if (outPair.right) result.push([outPair.right.number, (inPair.right ?? inPair.left).number])
	return result
}
