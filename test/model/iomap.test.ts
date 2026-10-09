import { describe, expect, it } from 'vitest'
import { parseLine } from '../../src/lwrp/parser.js'
import {
	buildIoMap,
	channelLabel,
	devnSuffix,
	findChannel,
	pairLabel,
	type MixIoMap,
	type NameLookup,
} from '../../src/model/iomap.js'

function ver(line: string): Record<string, string> {
	return parseLine(line)!.attrs
}

const LEGACY = 'VER LWRP:1.2 NSRC:8 NDST:8 NGPI:0 NGPO:0 MIXCFG:1 MIX:24'
const map = (devn: string, extra = ''): MixIoMap => buildIoMap(ver(`${LEGACY} DEVN:"${devn}" ${extra}`))

const nums = (list: Array<{ number: number }>) => list.map((c) => c.number)

function names(
	src: Record<number, string> = {},
	dst: Record<number, string> = {},
	inp: Record<number, string> = {},
): NameLookup {
	return {
		srcName: (n) => src[n],
		dstName: (n) => dst[n],
		inpName: (n) => inp[n],
	}
}

describe('devnSuffix', () => {
	it('takes the part after the last dot, lowercase', () => {
		expect(devnSuffix('axiaxnode.analog4x4')).toBe('analog4x4')
		expect(devnSuffix('axiaxnode2.combo')).toBe('combo')
		expect(devnSuffix('AxiaXNode2.COMBO')).toBe('combo')
		expect(devnSuffix('combo')).toBe('combo')
		expect(devnSuffix('')).toBe('')
		expect(devnSuffix(undefined)).toBe('')
	})
})

describe('buildIoMap without mixer', () => {
	it('has no mixer when VER lacks MIX', () => {
		const m = buildIoMap(ver('VER LWRP:1.2 DEVN:"axiaxnode.gpio" NSRC:0 NDST:0 NGPI:4 NGPO:4'))
		expect(m).toEqual({ hasMixer: false, model: null, outputs: [], inputs: [], outputPairs: [], inputPairs: [] })
	})

	it('has no mixer for an empty or zero MIX and for an empty VER', () => {
		expect(buildIoMap({}).hasMixer).toBe(false)
		expect(buildIoMap(ver('VER DEVN:"axiaxnode.analog4x4" MIX:0')).hasMixer).toBe(false)
		expect(buildIoMap(ver('VER DEVN:"axiaxnode.analog4x4" MIX:abc')).hasMixer).toBe(false)
	})
})

describe.each([
	['analog4x4', 'axiaxnode.analog4x4', ['Line 1', 'Line 2', 'Line 3', 'Line 4']],
	['analog4x4', 'axiaxnode2.analog4x4', ['Line 1', 'Line 2', 'Line 3', 'Line 4']],
	['aes4x4', 'axiaxnode.aes4x4', ['AES 1', 'AES 2', 'AES 3', 'AES 4']],
])('model %s (%s)', (model, devn, phys) => {
	const m = map(devn)

	it('is detected', () => {
		expect(m.hasMixer).toBe(true)
		expect(m.model).toBe(model)
	})

	it('has 24 outputs and 24 inputs, numbered 1..24', () => {
		expect(nums(m.outputs)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
		expect(nums(m.inputs)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
	})

	it('has SRC/DST channels 1-16 with L/R alternating', () => {
		expect(m.outputs[0]).toMatchObject({ number: 1, kind: 'src', owner: 1, side: 'L', base: 'SRC 1 L' })
		expect(m.outputs[1]).toMatchObject({ number: 2, kind: 'src', owner: 1, side: 'R', base: 'SRC 1 R' })
		expect(m.outputs[15]).toMatchObject({ number: 16, kind: 'src', owner: 8, side: 'R', base: 'SRC 8 R' })
		expect(m.inputs[0]).toMatchObject({ number: 1, kind: 'dst', owner: 1, side: 'L', base: 'DST 1 L' })
		expect(m.inputs[15]).toMatchObject({ number: 16, kind: 'dst', owner: 8, side: 'R', base: 'DST 8 R' })
	})

	it('has physical stereo pairs at 17-24', () => {
		const outBases = m.outputs.slice(16).map((c) => c.base)
		const inBases = m.inputs.slice(16).map((c) => c.base)
		const expected = phys.flatMap((p) => [`${p} L`, `${p} R`])
		expect(outBases).toEqual(expected)
		expect(inBases).toEqual(expected)
		expect(m.inputs[16]).toMatchObject({ number: 17, kind: 'phys', owner: 1, side: 'L' })
		expect(m.inputs[23]).toMatchObject({ number: 24, kind: 'phys', owner: 4, side: 'R' })
	})

	it('pairs everything as stereo with the left (odd) channel as id', () => {
		expect(m.outputPairs).toHaveLength(12)
		expect(m.inputPairs).toHaveLength(12)
		expect(m.outputPairs.map((p) => p.id)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23])
		for (const p of [...m.outputPairs, ...m.inputPairs]) {
			expect(p.id % 2).toBe(1)
			expect(p.right?.number).toBe(p.left.number + 1)
			expect(p.left.side).toBe('L')
			expect(p.right?.side).toBe('R')
		}
	})
})

describe('model combo (xNode2 Mixed Signal)', () => {
	const m = map('axiaxnode2.combo', 'INP:5')

	it('is detected from the suffix, for legacy-style and xNode2 DEVN alike', () => {
		expect(m.model).toBe('combo')
		expect(map('axiaxnode.combo').model).toBe('combo')
	})

	it('has 24 outputs: Line 1-3 and AES 4 at 17-24', () => {
		expect(m.outputs).toHaveLength(24)
		expect(m.outputs.slice(16).map((c) => c.base)).toEqual([
			'Line 1 L',
			'Line 1 R',
			'Line 2 L',
			'Line 2 R',
			'Line 3 L',
			'Line 3 R',
			'AES 4 L',
			'AES 4 R',
		])
	})

	it('has 25 inputs: Line 1-3 L/R, AES L/R, and a mono Mic at 25', () => {
		expect(m.inputs).toHaveLength(25)
		expect(m.inputs.slice(16).map((c) => c.base)).toEqual([
			'Line 1 L',
			'Line 1 R',
			'Line 2 L',
			'Line 2 R',
			'Line 3 L',
			'Line 3 R',
			'AES L',
			'AES R',
			'Mic',
		])
		expect(m.inputs[24]).toEqual({ number: 25, kind: 'phys', owner: 5, side: 'mono', base: 'Mic' })
	})

	it('numbers physical owners like the xNode2 INP objects (AES is INP 4, Mic is INP 5)', () => {
		expect(findChannel(m.inputs, 17)?.owner).toBe(1)
		expect(findChannel(m.inputs, 21)?.owner).toBe(3)
		expect(findChannel(m.inputs, 23)?.owner).toBe(4)
		expect(findChannel(m.inputs, 24)?.owner).toBe(4)
		expect(findChannel(m.inputs, 25)?.owner).toBe(5)
	})

	it('pairs the Mic as a mono entry and everything else as stereo', () => {
		expect(m.inputPairs).toHaveLength(13)
		const mic = m.inputPairs.at(-1)!
		expect(mic.id).toBe(25)
		expect(mic.right).toBeUndefined()
		expect(m.inputPairs.slice(0, -1).every((p) => p.right !== undefined)).toBe(true)
		expect(m.outputPairs).toHaveLength(12)
	})
})

describe('model mic', () => {
	const m = map('axiaxnode.mic')

	it('has Mic 1-4 as mono inputs 17-20 only', () => {
		expect(m.model).toBe('mic')
		expect(m.inputs).toHaveLength(20)
		expect(m.inputs.slice(16)).toEqual([
			{ number: 17, kind: 'phys', owner: 1, side: 'mono', base: 'Mic 1' },
			{ number: 18, kind: 'phys', owner: 2, side: 'mono', base: 'Mic 2' },
			{ number: 19, kind: 'phys', owner: 3, side: 'mono', base: 'Mic 3' },
			{ number: 20, kind: 'phys', owner: 4, side: 'mono', base: 'Mic 4' },
		])
		expect(m.inputPairs).toHaveLength(12)
		expect(m.inputPairs.slice(8).map((p) => [p.id, p.right])).toEqual([
			[17, undefined],
			[18, undefined],
			[19, undefined],
			[20, undefined],
		])
	})

	it('has Line 1-4 stereo outputs at 17-24', () => {
		expect(m.outputs).toHaveLength(24)
		expect(m.outputs.slice(16).map((c) => c.base)).toEqual(
			['Line 1', 'Line 2', 'Line 3', 'Line 4'].flatMap((n) => [`${n} L`, `${n} R`]),
		)
	})
})

describe('unknown model', () => {
	const m = map('axiaxnode.xselector')

	it('falls back to generic labels', () => {
		expect(m.hasMixer).toBe(true)
		expect(m.model).toBeNull()
		expect(m.outputs).toHaveLength(24)
		expect(m.outputs[16]).toEqual({ number: 17, kind: 'phys', owner: 1, side: 'mono', base: 'Out 17' })
		expect(m.outputs[23].base).toBe('Out 24')
		expect(m.inputs).toHaveLength(24)
		expect(m.inputs[16]).toEqual({ number: 17, kind: 'phys', owner: 1, side: 'mono', base: 'In 17' })
		expect(m.inputs[23].base).toBe('In 24')
	})

	it('keeps the SRC/DST stereo pairs and mono generic channels', () => {
		expect(m.outputPairs).toHaveLength(8 + 8)
		expect(m.outputPairs[7].right).toBeDefined()
		expect(m.outputPairs[8].right).toBeUndefined()
		expect(m.inputPairs).toHaveLength(16)
	})

	it('treats a missing DEVN as unknown', () => {
		const noDevn = buildIoMap(ver(LEGACY))
		expect(noDevn.hasMixer).toBe(true)
		expect(noDevn.model).toBeNull()
	})
})

describe('counts from VER', () => {
	it('respects smaller NSRC/NDST/MIX', () => {
		const m = buildIoMap(ver('VER DEVN:"axiaxnode.analog4x4" NSRC:4 NDST:4 MIX:16'))
		expect(m.outputs).toHaveLength(16)
		expect(m.outputs.slice(0, 8).every((c) => c.kind === 'src')).toBe(true)
		expect(m.outputs[8]).toMatchObject({ number: 9, kind: 'phys', base: 'Line 1 L' })
		expect(m.inputs[8]).toMatchObject({ number: 9, kind: 'phys', base: 'Line 1 L' })
		expect(m.inputs).toHaveLength(16)
	})

	it('does not exceed the number of mixer rows', () => {
		const m = buildIoMap(ver('VER DEVN:"axiaxnode.analog4x4" NSRC:8 NDST:8 MIX:18'))
		expect(m.outputs).toHaveLength(18)
		expect(m.outputs.at(-1)?.number).toBe(18)
	})
})

describe('findChannel', () => {
	const m = map('axiaxnode2.combo')
	it('finds by wire number', () => {
		expect(findChannel(m.inputs, 25)?.base).toBe('Mic')
		expect(findChannel(m.outputs, 1)?.base).toBe('SRC 1 L')
	})
	it('returns undefined outside the map', () => {
		expect(findChannel(m.outputs, 25)).toBeUndefined()
		expect(findChannel(m.inputs, 26)).toBeUndefined()
		expect(findChannel(m.inputs, 0)).toBeUndefined()
	})
})

describe('labels', () => {
	const m = map('axiaxnode2.combo')

	it('are plain without names', () => {
		expect(channelLabel(m.outputs[4], false)).toBe('SRC 3 L')
		expect(channelLabel(m.inputs[16], true)).toBe('Line 1 L')
		expect(pairLabel(m.outputPairs[2], false)).toBe('SRC 3')
		expect(pairLabel(m.inputPairs.at(-1)!, true)).toBe('Mic')
	})

	it('are refreshed with SRC PSNM and DST NAME', () => {
		const n = names({ 3: 'TEL 1' }, { 2: 'Program 3' })
		expect(channelLabel(m.outputs[4], false, n)).toBe('SRC 3 L · TEL 1')
		expect(channelLabel(m.outputs[5], false, n)).toBe('SRC 3 R · TEL 1')
		expect(pairLabel(m.outputPairs[2], false, n)).toBe('SRC 3 · TEL 1')
		expect(channelLabel(m.inputs[3], true, n)).toBe('DST 2 R · Program 3')
		expect(pairLabel(m.inputPairs[1], true, n)).toBe('DST 2 · Program 3')
	})

	it('omits the suffix for default names', () => {
		const n = names({ 3: 'SRC 3' }, { 2: 'DST 2' })
		expect(channelLabel(m.outputs[4], false, n)).toBe('SRC 3 L')
		expect(pairLabel(m.inputPairs[1], true, n)).toBe('DST 2')
	})

	it('ignores empty or blank names', () => {
		const n = names({ 1: '' }, { 1: '   ' })
		expect(channelLabel(m.outputs[0], false, n)).toBe('SRC 1 L')
		expect(channelLabel(m.inputs[0], true, n)).toBe('DST 1 L')
	})

	it('uses INP names for physical inputs only', () => {
		const n = names({}, {}, { 1: 'Analog 1', 5: 'Microphone 5' })
		expect(channelLabel(m.inputs[16], true, n)).toBe('Line 1 L · Analog 1')
		expect(pairLabel(m.inputPairs[8], true, n)).toBe('Line 1 · Analog 1')
		expect(channelLabel(m.inputs[24], true, n)).toBe('Mic · Microphone 5')
		expect(pairLabel(m.inputPairs.at(-1)!, true, n)).toBe('Mic · Microphone 5')
		// physical outputs never take INP names
		expect(channelLabel(m.outputs[16], false, n)).toBe('Line 1 L')
	})

	it('prefers nothing from SRC/DST names on physical channels', () => {
		const n = names({ 1: 'X' }, { 1: 'Y' })
		expect(channelLabel(m.inputs[16], true, n)).toBe('Line 1 L')
	})

	it('labels unknown-model channels generically', () => {
		const u = map('axiaxnode.xselector')
		expect(channelLabel(u.inputs[16], true)).toBe('In 17')
		expect(pairLabel(u.outputPairs[8], false)).toBe('Out 17')
	})
})
