import { describe, expect, it } from 'vitest'
import {
	PIN_CHOICES,
	dropdown,
	dstChoices,
	gpiChoices,
	gpoChoices,
	inputChannelChoices,
	inputPairChoices,
	micChoices,
	outputChannelChoices,
	outputPairChoices,
	resolveXpoints,
	srcChoices,
	xpointPickerFields,
} from '../src/choices.js'
import { buildIoMap } from '../src/model/iomap.js'
import { XNodeState } from '../src/model/state.js'
import { apply, loadedState } from './fixtures/load.js'

const combo = loadedState('xnode2-combo')
const analog = loadedState('legacy-analog4x4-a')
const named = loadedState('legacy-analog4x4-b')

describe('resolveXpoints', () => {
	it('stereo: pair to pair maps L->L and R->R', () => {
		// SRC 5 (outputs 9/10) <- DST 2 (inputs 3/4)
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: 9, in_pair: 3 })).toEqual([
			[9, 3],
			[10, 4],
		])
		// physical Line 1 output (17/18) <- DST 8 (15/16)
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: 17, in_pair: 15 })).toEqual([
			[17, 15],
			[18, 16],
		])
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: 1, in_pair: 17 })).toEqual([
			[1, 17],
			[2, 18],
		])
	})

	it('defaults to stereo when mode is missing', () => {
		expect(resolveXpoints(analog.ioMap, { out_pair: 1, in_pair: 1 })).toEqual([
			[1, 1],
			[2, 2],
		])
	})

	it('accepts numeric strings (expression results)', () => {
		expect(resolveXpoints(analog.ioMap, { out_pair: '9', in_pair: '3' } as never)).toEqual([
			[9, 3],
			[10, 4],
		])
	})

	it('a mono input feeds both output channels', () => {
		// combo Mic is input 25 (mono)
		expect(resolveXpoints(combo.ioMap, { mode: 'stereo', out_pair: 9, in_pair: 25 })).toEqual([
			[9, 25],
			[10, 25],
		])
		expect(resolveXpoints(combo.ioMap, { mode: 'stereo', out_pair: 17, in_pair: 25 })).toEqual([
			[17, 25],
			[18, 25],
		])
	})

	it('mono mode resolves single channels', () => {
		expect(resolveXpoints(combo.ioMap, { mode: 'mono', out_ch: 10, in_ch: 25 })).toEqual([[10, 25]])
		expect(resolveXpoints(combo.ioMap, { mode: 'mono', out_ch: 2, in_ch: 3 })).toEqual([[2, 3]])
		expect(resolveXpoints(combo.ioMap, { mode: 'mono', out_ch: 24, in_ch: 1 })).toEqual([[24, 1]])
	})

	it('mono mode ignores the stereo options', () => {
		expect(resolveXpoints(combo.ioMap, { mode: 'mono', out_pair: 1, in_pair: 1, out_ch: 4, in_ch: 6 })).toEqual([
			[4, 6],
		])
		expect(resolveXpoints(combo.ioMap, { mode: 'stereo', out_ch: 4, in_ch: 6, out_pair: 3, in_pair: 5 })).toEqual([
			[3, 5],
			[4, 6],
		])
	})

	it('returns [] for channels outside the map', () => {
		expect(resolveXpoints(analog.ioMap, { mode: 'mono', out_ch: 1, in_ch: 25 })).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'mono', out_ch: 25, in_ch: 1 })).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'mono', out_ch: 0, in_ch: 1 })).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: 1, in_pair: 25 })).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: 99, in_pair: 1 })).toEqual([])
	})

	it('returns [] for stale values that are not pair ids', () => {
		// 2 is the R channel of pair 1, not a pair id
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: 2, in_pair: 1 })).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: 1, in_pair: 2 })).toEqual([])
	})

	it('returns [] for missing, NaN or garbage options', () => {
		expect(resolveXpoints(analog.ioMap, {})).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'mono' })).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: 'x', in_pair: 1 } as never)).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: Number.NaN, in_pair: 1 })).toEqual([])
		expect(resolveXpoints(analog.ioMap, { mode: 'stereo', out_pair: undefined, in_pair: undefined })).toEqual([])
	})

	it('returns [] without a mixer', () => {
		const none = buildIoMap({})
		expect(resolveXpoints(none, { mode: 'stereo', out_pair: 1, in_pair: 1 })).toEqual([])
		expect(resolveXpoints(none, { mode: 'mono', out_ch: 1, in_ch: 1 })).toEqual([])
		expect(resolveXpoints(new XNodeState().ioMap, { out_pair: 1, in_pair: 1 })).toEqual([])
	})

	it('a mono output pair gets only one crosspoint (unknown model)', () => {
		const unknown = buildIoMap({ MIX: '24', NSRC: '8', NDST: '8', DEVN: 'axiaxnode.xselector' })
		expect(resolveXpoints(unknown, { mode: 'stereo', out_pair: 17, in_pair: 1 })).toEqual([[17, 1]])
		expect(resolveXpoints(unknown, { mode: 'stereo', out_pair: 1, in_pair: 17 })).toEqual([
			[1, 17],
			[2, 17],
		])
	})

	it('every resolved crosspoint is inside the I/O map for every pair combination', () => {
		const io = combo.ioMap
		for (const o of io.outputPairs) {
			for (const i of io.inputPairs) {
				const r = resolveXpoints(io, { mode: 'stereo', out_pair: o.id, in_pair: i.id })
				expect(r.length).toBe(o.right ? 2 : 1)
				for (const [out, inp] of r) {
					expect(io.outputs.some((c) => c.number === out)).toBe(true)
					expect(io.inputs.some((c) => c.number === inp)).toBe(true)
				}
			}
		}
	})
})

describe('choice builders', () => {
	it('output and input pair choices follow the I/O map', () => {
		const out = outputPairChoices(analog)
		expect(out).toHaveLength(12)
		expect(out[0]).toEqual({ id: 1, label: '1/2 · SRC 1' })
		expect(out[8]).toEqual({ id: 17, label: '17/18 · Line 1' })
		const inp = inputPairChoices(combo)
		expect(inp).toHaveLength(13)
		expect(inp.at(-1)).toEqual({ id: 25, label: '25 · Mic · Microphone 5' })
		expect(inp[8]).toEqual({ id: 17, label: '17/18 · Line 1 · Analog 1' })
	})

	it('channel choices cover every mono channel', () => {
		expect(outputChannelChoices(analog)).toHaveLength(24)
		expect(inputChannelChoices(combo)).toHaveLength(25)
		expect(outputChannelChoices(analog)[1]).toEqual({ id: 2, label: '2 · SRC 1 R' })
		expect(inputChannelChoices(combo)[24]).toEqual({ id: 25, label: '25 · Mic · Microphone 5' })
	})

	it('labels include user names', () => {
		expect(outputPairChoices(named)[0].label).toBe('1/2 · SRC 1 · MIX ANIM')
		expect(outputChannelChoices(named)[4].label).toBe('5 · SRC 3 L · TEL 1')
	})

	it('are empty without VER', () => {
		const s = new XNodeState()
		for (const f of [
			outputPairChoices,
			inputPairChoices,
			outputChannelChoices,
			inputChannelChoices,
			srcChoices,
			dstChoices,
			gpiChoices,
			gpoChoices,
			micChoices,
		]) {
			expect(f(s)).toEqual([])
		}
	})

	it('SRC and DST choices use counts and user names', () => {
		expect(srcChoices(analog)).toHaveLength(8)
		expect(srcChoices(analog)[0]).toEqual({ id: 1, label: 'SRC 1' })
		expect(srcChoices(named)[2]).toEqual({ id: 3, label: 'SRC 3 · TEL 1' })
		expect(dstChoices(named)[7]).toEqual({ id: 8, label: 'DST 8 · TEST AUDIO' })
		expect(dstChoices(combo)[0]).toEqual({ id: 1, label: 'DST 1 · Receiver1' })
	})

	it('GPIO choices follow NGPI/NGPO and CFG GPO names', () => {
		expect(gpiChoices(combo)).toEqual([
			{ id: 1, label: 'GPI 1' },
			{ id: 2, label: 'GPI 2' },
		])
		expect(gpoChoices(combo)).toEqual([
			{ id: 1, label: 'GPO 1 · GPIO_1' },
			{ id: 2, label: 'GPO 2 · GPIO_2' },
		])
		expect(gpiChoices(analog)).toEqual([])
		expect(gpoChoices(analog)).toEqual([])
		expect(PIN_CHOICES.map((c) => c.id)).toEqual([1, 2, 3, 4, 5])
	})

	it('mic choices list MIC inputs only, sorted', () => {
		expect(micChoices(combo)).toEqual([{ id: 5, label: 'INP 5 · Microphone 5' }])
		const s = new XNodeState()
		apply(s, 'INP 7 NAME:"M7" TYPE:MIC')
		apply(s, 'INP 3 NAME:"M3" TYPE:mic')
		apply(s, 'INP 4 NAME:"AES" TYPE:AES')
		apply(s, 'INP 2 TYPE:MIC')
		expect(micChoices(s).map((c) => c.id)).toEqual([2, 3, 7])
		expect(micChoices(s)[0].label).toBe('INP 2')
		expect(micChoices(analog)).toEqual([])
	})
})

describe('dropdown', () => {
	it('uses the first choice as default and 1 when empty', () => {
		expect(dropdown('x', 'X', [{ id: 7, label: 'seven' }]).default).toBe(7)
		expect(dropdown('x', 'X', []).default).toBe(1)
		expect(dropdown('x', 'X', [], { tooltip: 't' })).toMatchObject({
			type: 'dropdown',
			id: 'x',
			label: 'X',
			tooltip: 't',
		})
	})
})

describe('xpointPickerFields', () => {
	it('has the five fields with sensible defaults and visibility', () => {
		const fields = xpointPickerFields(combo)
		expect(fields.map((f) => f.id)).toEqual(['mode', 'out_pair', 'in_pair', 'out_ch', 'in_ch'])
		expect(fields[0].default).toBe('stereo')
		expect(fields[1].default).toBe(1)
		expect(fields[2].choices).toHaveLength(13)
		expect(fields[3].choices).toHaveLength(24)
		expect(fields[1].isVisibleExpression).toContain('stereo')
		expect(fields[3].isVisibleExpression).toContain('mono')
	})

	it('still builds when no mixer is detected', () => {
		const fields = xpointPickerFields(new XNodeState())
		expect(fields).toHaveLength(5)
		expect(fields[1].choices).toEqual([])
		expect(fields[1].default).toBe(1)
	})
})
