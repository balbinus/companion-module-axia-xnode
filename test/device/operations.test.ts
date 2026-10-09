import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModuleConfig } from '../../src/config.js'
import { LwrpError } from '../../src/device/connection.js'
import type { WriteTarget, XNodeController } from '../../src/device/controller.js'
import {
	COALESCE_MS,
	DESTROY_RESTORE_TIMEOUT_MS,
	MIC_GAIN_MAX_TENTHS,
	PULSE_RESTORE_MAX_ATTEMPTS,
	PULSE_RESTORE_RETRY_MS,
	MIC_GAIN_MIN_TENTHS,
	XNodeOperations,
	normaliseMicGain,
} from '../../src/device/operations.js'
import { parseLine, type LwrpLine } from '../../src/lwrp/parser.js'
import type { XNodeState } from '../../src/model/state.js'
import { apply, loadedState, type FixtureName } from '../fixtures/load.js'

// ------------------------------------------------------------------ fake controller

class FakeController {
	isConnected = true
	isSynced = true
	levelsReady = true
	readonly commands: string[] = []
	/** When set, writeAndVerify rejects with it (after recording the command) */
	failWith: Error | undefined
	/** When false the node accepts the command but changes nothing */
	applyEcho = true

	constructor(readonly state: XNodeState) {}

	async writeAndVerify(cmd: string, target: WriteTarget): Promise<LwrpLine | null> {
		await Promise.resolve()
		this.commands.push(cmd)
		if (this.failWith) throw this.failWith
		const line = parseLine(cmd)
		if (!line) return null
		if (!this.applyEcho) return parseLine(`${target.verb} ${target.index}`)
		if (line.verb === 'MIX') {
			// the node changes the listed crosspoints; the re-query answers with the whole row
			const out = Number(line.args[0])
			const row = new Map(this.state.mix.get(out))
			for (const [k, v] of Object.entries(line.attrs)) {
				if (v === '-') row.delete(Number(k))
				else row.set(Number(k), Number(v))
			}
			const text = `MIX ${out} ${[...row].map(([i, g]) => `${i}:${g}`).join(' ')}`
			this.state.applyLine(parseLine(text) as LwrpLine)
			return parseLine(text)
		}
		this.state.applyLine(line)
		return line
	}
}

const baseConfig: ModuleConfig = {
	host: 'node.example',
	port: 93,
	password: '',
	allowMixerWrites: true,
	allowSourceWrites: true,
	allowLeaveFactoryMode: false,
	allowGpoWrites: true,
	meterMode: 'off',
	meterInterval: 500,
	levelAlerts: true,
	xpointMinDb: -80,
	xpointMaxDb: 24,
	exposeXpointVariables: false,
	knownSources: '',
}

interface Rig {
	ops: XNodeOperations
	ctl: FakeController
	state: XNodeState
	cfg: ModuleConfig
	logs: Array<[string, string]>
}

function rig(fixture: FixtureName = 'legacy-analog4x4-a', over: Partial<ModuleConfig> = {}): Rig {
	const state = loadedState(fixture)
	const ctl = new FakeController(state)
	const cfg: ModuleConfig = { ...baseConfig, ...over }
	const logs: Array<[string, string]> = []
	const ops = new XNodeOperations(
		ctl as unknown as XNodeController,
		() => cfg,
		(level, msg) => logs.push([level, msg]),
	)
	return { ops, ctl, state, cfg, logs }
}

/** Switch on crosspoints (outside rows 1-2) until `target` are in use */
function fillBudget(state: XNodeState, target: number): void {
	for (let out = 24; out >= 3 && state.xpointsUsed() < target; out--) {
		const row = state.mix.get(out) ?? new Map<number, number>()
		for (let inp = 1; inp <= 24 && state.xpointsUsed() < target; inp++) if (!row.has(inp)) row.set(inp, 0)
		state.mix.set(out, row)
	}
	expect(state.xpointsUsed()).toBe(target)
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

// ------------------------------------------------------------------ gating

describe('connection and permission gating', () => {
	type Call = (ops: XNodeOperations) => Promise<unknown>
	const mixerCalls: Array<[string, Call]> = [
		['mixSet', async (o) => o.mixSet([[9, 1]], -60)],
		['mixClear', async (o) => o.mixClear([[1, 17]])],
		['mixToggle', async (o) => o.mixToggle([[9, 1]], 0)],
		['mixAdjust', async (o) => o.mixAdjust([[1, 17]], 10)],
		['mixExclusive', async (o) => o.mixExclusive([[9, 1]], 0)],
		['mixClearOutput', async (o) => o.mixClearOutput([1])],
		['mixSnapshotRecall', async (o) => o.mixSnapshotRecall('{"v":1,"devn":"axiaxnode.analog4x4","mix":{}}')],
		['dstConnectChannel', async (o) => o.dstConnectChannel(1, 100)],
		['dstConnectAddress', async (o) => o.dstConnectAddress(1, '239.192.0.100')],
		['dstDisconnect', async (o) => o.dstDisconnect(1)],
		['dstGainSet', async (o) => o.dstGainSet(1, -60)],
		['dstGainAdjust', async (o) => o.dstGainAdjust(1, 10)],
	]
	const sourceCalls: Array<[string, Call]> = [
		['srcGainSet', async (o) => o.srcGainSet(2, -60)],
		['srcGainAdjust', async (o) => o.srcGainAdjust(2, 10)],
		['srcEnable', async (o) => o.srcEnable(2, 'off')],
		['srcSetAddress', async (o) => o.srcSetAddress(2, 100)],
		['srcSetMode', async (o) => o.srcSetMode(2, 240)],
		['srcRename', async (o) => o.srcRename(2, 'Other')],
	]
	const gpoCalls: Array<[string, Call]> = [
		['gpoSet', async (o) => o.gpoSet(1, [1], true)],
		['gpoToggle', async (o) => o.gpoToggle(1, [1])],
		['gpoPulse', async (o) => o.gpoPulse(1, [1], 100)],
	]
	const micCalls: Array<[string, Call]> = [
		['micGainSet', async (o) => o.micGainSet(5, 300)],
		['micGainAdjust', async (o) => o.micGainAdjust(5, 10)],
	]

	const none = {
		allowMixerWrites: false,
		allowSourceWrites: false,
		allowGpoWrites: false,
		allowLeaveFactoryMode: false,
	}

	it.each(mixerCalls)('%s needs allowMixerWrites (and nothing else unlocks it)', async (_n, call) => {
		const r = rig('legacy-analog4x4-a', {
			...none,
			allowSourceWrites: true,
			allowGpoWrites: true,
			allowLeaveFactoryMode: true,
		})
		await expect(call(r.ops)).rejects.toThrow(/Mixer & routing changes are disabled/)
		expect(r.ctl.commands).toEqual([])
	})

	it.each(sourceCalls)('%s needs allowSourceWrites', async (_n, call) => {
		const r = rig('legacy-analog4x4-a', { ...none, allowMixerWrites: true, allowGpoWrites: true })
		await expect(call(r.ops)).rejects.toThrow(/Source \(stream\) changes are disabled/)
		expect(r.ctl.commands).toEqual([])
	})

	it.each(micCalls)('%s needs allowSourceWrites', async (_n, call) => {
		const r = rig('xnode2-combo', { ...none, allowMixerWrites: true, allowGpoWrites: true })
		await expect(call(r.ops)).rejects.toThrow(/Source \(stream\) changes are disabled/)
		expect(r.ctl.commands).toEqual([])
	})

	it.each(gpoCalls)('%s needs allowGpoWrites', async (_n, call) => {
		const r = rig('xnode2-combo', { ...none, allowMixerWrites: true, allowSourceWrites: true })
		await expect(call(r.ops)).rejects.toThrow(/GPO control is disabled/)
		expect(r.ctl.commands).toEqual([])
	})

	it('writes are enabled with the right toggle only', async () => {
		const r = rig('legacy-analog4x4-a', { ...none, allowMixerWrites: true })
		await r.ops.mixSet([[9, 1]], -60)
		await expect(r.ops.srcRename(1, 'x')).rejects.toThrow(/disabled/)
		expect(r.ctl.commands).toEqual(['MIX 9 1:-60'])
	})

	it('the permission is read at call time (config can change)', async () => {
		const r = rig('legacy-analog4x4-a')
		await r.ops.mixSet([[9, 1]], -60)
		r.cfg.allowMixerWrites = false
		await expect(r.ops.mixSet([[9, 2]], -60)).rejects.toThrow(/disabled/)
		expect(r.ctl.commands).toHaveLength(1)
	})

	it('the permission is re-checked when a coalesced adjust finally runs', async () => {
		vi.useFakeTimers()
		try {
			const r = rig('legacy-analog4x4-a')
			const p = r.ops.mixAdjust([[12, 10]], 10)
			const settled = p.then(
				() => 'ok',
				(e: Error) => e.message,
			)
			r.cfg.allowMixerWrites = false
			await vi.advanceTimersByTimeAsync(COALESCE_MS + 10)
			expect(await settled).toMatch(/disabled/)
			expect(r.ctl.commands).toEqual([])
		} finally {
			vi.useRealTimers()
		}
	})

	it('read-only snapshot store works without any permission', async () => {
		const r = rig('legacy-analog4x4-a', none)
		const json = await r.ops.mixSnapshotStore()
		expect(JSON.parse(json).v).toBe(1)
	})

	const everything: Array<[string, (o: XNodeOperations) => Promise<unknown>]> = [
		...mixerCalls,
		...sourceCalls,
		...gpoCalls,
		...micCalls,
		['mixSnapshotStore', async (o) => o.mixSnapshotStore()],
	]

	it.each(everything)('%s refuses when not connected', async (_n, call) => {
		const r = rig('xnode2-combo')
		r.ctl.isConnected = false
		r.ctl.isSynced = false
		await expect(call(r.ops)).rejects.toThrow(/Not connected/)
		expect(r.ctl.commands).toEqual([])
	})

	it.each(everything)('%s refuses while the node is still being read', async (_n, call) => {
		const r = rig('xnode2-combo')
		r.ctl.isSynced = false
		await expect(call(r.ops)).rejects.toThrow(/still being read/)
		expect(r.ctl.commands).toEqual([])
	})

	it('refuses after destroy', async () => {
		const r = rig()
		await r.ops.destroy()
		await expect(r.ops.mixSet([[9, 1]], 0)).rejects.toThrow(/shutting down/)
	})
})

// ------------------------------------------------------------------ mixer

describe('mixer: wire format and index validation', () => {
	it('mixSet on a stereo pair writes one line per output row', async () => {
		const r = rig()
		await r.ops.mixSet(
			[
				[9, 1],
				[10, 2],
			],
			-60,
		)
		expect(r.ctl.commands).toEqual(['MIX 9 1:-60', 'MIX 10 2:-60'])
		expect(r.state.getXpoint(9, 1)).toBe(-60)
	})

	it('several inputs of one output are merged into one line, sorted', async () => {
		const r = rig()
		await r.ops.mixSet(
			[
				[9, 3],
				[9, 1],
			],
			0,
		)
		expect(r.ctl.commands).toEqual(['MIX 9 1:0 3:0'])
	})

	it('gains are integers (decimals refused, NaN refused)', async () => {
		const r = rig()
		await expect(r.ops.mixSet([[9, 1]], 1.5)).rejects.toThrow(/integer/)
		await expect(r.ops.mixSet([[9, 1]], Number.NaN)).rejects.toThrow(/integer/)
		await expect(r.ops.mixSet([[9, 1]], Infinity)).rejects.toThrow(/integer/)
		await expect(r.ops.mixAdjust([[9, 1]], 0.5)).rejects.toThrow(/integer/)
		expect(r.ctl.commands).toEqual([])
	})

	it('clamps to the configured crosspoint limits', async () => {
		const r = rig()
		await r.ops.mixSet([[9, 1]], 300)
		await r.ops.mixSet([[9, 2]], -900)
		expect(r.ctl.commands).toEqual(['MIX 9 1:240', 'MIX 9 2:-800'])
	})

	it('custom limits', async () => {
		const r = rig('legacy-analog4x4-a', { xpointMinDb: -40, xpointMaxDb: 6 })
		await r.ops.mixSet([[9, 1]], 240)
		await r.ops.mixSet([[9, 2]], -600)
		expect(r.ctl.commands).toEqual(['MIX 9 1:60', 'MIX 9 2:-400'])
	})

	it('a minimum of -100 dB turns the lowest gain into a clear', async () => {
		const r = rig('legacy-analog4x4-a', { xpointMinDb: -100 })
		await r.ops.mixSet([[1, 17]], -1000)
		expect(r.ctl.commands).toEqual(['MIX 1 17:-'])
	})

	describe('xpointLimits with nonsense config', () => {
		const limits = (min: unknown, max: unknown): { min: number; max: number } =>
			rig('legacy-analog4x4-a', { xpointMinDb: min as number, xpointMaxDb: max as number }).ops.xpointLimits()
		it('defaults', () => expect(limits(-80, 24)).toEqual({ min: -800, max: 240 }))
		it('NaN, undefined, strings fall back to defaults', () => {
			expect(limits(Number.NaN, undefined)).toEqual({ min: -800, max: 240 })
			expect(limits('abc', null)).toEqual({ min: -800, max: 240 })
			expect(limits(Infinity, -Infinity)).toEqual({ min: -800, max: 240 })
		})
		it('out of range values are clamped to -100...+24 dB', () => {
			expect(limits(-500, 500)).toEqual({ min: -1000, max: 240 })
		})
		it('min >= max falls back to defaults', () => {
			expect(limits(10, 5)).toEqual({ min: -800, max: 240 })
			expect(limits(0, 0)).toEqual({ min: -800, max: 240 })
		})
		it('rounds to integer tenths', () => {
			expect(limits(-12.34, 3.06)).toEqual({ min: -123, max: 31 })
		})
		it('writes use the sanitised limits', async () => {
			const r = rig('legacy-analog4x4-a', { xpointMinDb: 'x' as unknown as number, xpointMaxDb: 99999 })
			await r.ops.mixSet([[9, 1]], 5000)
			expect(r.ctl.commands).toEqual(['MIX 9 1:240'])
		})
	})

	describe('out-of-map indices', () => {
		it('input 25 is refused on analog4x4, 26 and MIX output 25 never', async () => {
			const r = rig('legacy-analog4x4-a')
			await expect(r.ops.mixSet([[1, 25]], 0)).rejects.toThrow(/input 25/)
			await expect(r.ops.mixSet([[1, 26]], 0)).rejects.toThrow(/input 26/)
			await expect(r.ops.mixSet([[25, 1]], 0)).rejects.toThrow(/output 25/)
			await expect(r.ops.mixSet([[0, 1]], 0)).rejects.toThrow(/output 0/)
			await expect(r.ops.mixSet([[1, 0]], 0)).rejects.toThrow(/input 0/)
			await expect(r.ops.mixSet([[1.5, 1]], 0)).rejects.toThrow()
			expect(r.ctl.commands).toEqual([])
		})
		it('input 25 is fine on the combo (mic), 26 and output 25 are not', async () => {
			const r = rig('xnode2-combo')
			await r.ops.mixSet([[11, 25]], -60)
			expect(r.ctl.commands).toEqual(['MIX 11 25:-60'])
			await expect(r.ops.mixSet([[1, 26]], 0)).rejects.toThrow(/input 26/)
			await expect(r.ops.mixSet([[25, 1]], 0)).rejects.toThrow(/output 25/)
		})
		it('one bad entry refuses the whole batch before anything is written', async () => {
			const r = rig('legacy-analog4x4-a')
			await expect(
				r.ops.mixSet(
					[
						[9, 1],
						[10, 25],
					],
					0,
				),
			).rejects.toThrow()
			expect(r.ctl.commands).toEqual([])
		})
		it('clearing a crosspoint outside the map that is off is a silent no-op, an active one is cleared', async () => {
			const r = rig('legacy-analog4x4-a')
			await r.ops.mixClear([[1, 25]])
			expect(r.ctl.commands).toEqual([])
			// a stray crosspoint on input 25 (stored by the node) can still be removed
			apply(r.state, 'MIX 1 17:0 25:0')
			await r.ops.mixClear([[1, 25]])
			expect(r.ctl.commands).toEqual(['MIX 1 25:-'])
			// but never an output outside the map
			await expect(r.ops.mixClear([[25, 1]])).rejects.toThrow(/output 25/)
		})
		it('a node without mixer refuses everything', async () => {
			const r = rig()
			r.state.reset()
			apply(r.state, 'VER LWRP:1.2 DEVN:"axiaxnode.analog4x4" NSRC:2 NDST:2')
			await expect(r.ops.mixSet([[1, 1]], 0)).rejects.toThrow(/no mixer/)
			await expect(r.ops.mixSnapshotStore()).rejects.toThrow(/no mixer/)
		})
		it('an unknown model only allows its generic map', async () => {
			const r = rig()
			r.state.reset()
			apply(r.state, 'VER LWRP:1.2 DEVN:"axiaxnode.future" NSRC:8 NDST:8 MIX:24')
			apply(r.state, 'MIXCFG MODE:0')
			await r.ops.mixSet([[24, 24]], 0)
			await expect(r.ops.mixSet([[24, 25]], 0)).rejects.toThrow(/input 25/)
		})
	})

	describe('factory mixer mode', () => {
		it('refuses when MODE is not 0', async () => {
			const r = rig()
			apply(r.state, 'MIXCFG MODE:2')
			await expect(r.ops.mixSet([[9, 1]], 0)).rejects.toThrow(/factory mode 2/)
			await expect(r.ops.mixClear([[1, 17]])).rejects.toThrow(/factory mode/)
			await expect(r.ops.mixToggle([[9, 1]], 0)).rejects.toThrow(/factory mode/)
			await expect(r.ops.mixExclusive([[9, 1]], 0)).rejects.toThrow(/factory mode/)
			await expect(r.ops.mixClearOutput([1])).rejects.toThrow(/factory mode/)
			expect(r.ctl.commands).toEqual([])
		})
		it('refuses when the mode is unknown, even with the permission', async () => {
			const r = rig('legacy-analog4x4-a', { allowLeaveFactoryMode: true })
			r.state.mixcfgMode = undefined
			await expect(r.ops.mixSet([[9, 1]], 0)).rejects.toThrow(/not known/)
			expect(r.ctl.commands).toEqual([])
		})
		it('allowLeaveFactoryMode lets it through, with a warning', async () => {
			const r = rig('legacy-analog4x4-a', { allowLeaveFactoryMode: true })
			apply(r.state, 'MIXCFG MODE:1')
			await r.ops.mixSet([[9, 1]], -60)
			expect(r.ctl.commands).toEqual(['MIX 9 1:-60'])
			expect(r.logs.some(([l]) => l === 'warn')).toBe(true)
		})
		it('allowLeaveFactoryMode alone does not unlock mixer writes', async () => {
			const r = rig('legacy-analog4x4-a', { allowMixerWrites: false, allowLeaveFactoryMode: true })
			apply(r.state, 'MIXCFG MODE:1')
			await expect(r.ops.mixSet([[9, 1]], 0)).rejects.toThrow(/disabled/)
		})
		it('an adjust that changes nothing does not trip the check', async () => {
			vi.useFakeTimers()
			try {
				const r = rig()
				apply(r.state, 'MIXCFG MODE:1')
				const p = r.ops.mixAdjust([[9, 1]], -10) // off crosspoint, negative step: nothing to do
				await vi.advanceTimersByTimeAsync(100)
				await expect(p).resolves.toBeUndefined()
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe('crosspoint budget (220)', () => {
		it('allows reaching exactly 220, refuses the 221st', async () => {
			const r = rig()
			fillBudget(r.state, 219)
			await r.ops.mixSet([[1, 1]], 0)
			expect(r.state.xpointsUsed()).toBe(220)
			await expect(r.ops.mixSet([[1, 2]], 0)).rejects.toThrow(/budget/)
			expect(r.ctl.commands).toEqual(['MIX 1 1:0'])
		})
		it('refuses a batch that would exceed it, without writing anything', async () => {
			const r = rig()
			fillBudget(r.state, 219)
			await expect(
				r.ops.mixSet(
					[
						[1, 1],
						[2, 2],
					],
					0,
				),
			).rejects.toThrow(/budget/)
			expect(r.ctl.commands).toEqual([])
		})
		it('refuses increases only: re-gain, clear and exclusive replace stay possible at 220', async () => {
			const r = rig()
			fillBudget(r.state, 220)
			await r.ops.mixSet([[1, 17]], -100) // existing crosspoint
			await r.ops.mixClear([[1, 17]])
			expect(r.state.xpointsUsed()).toBe(219)
			await r.ops.mixSet([[1, 17]], 0)
			expect(r.state.xpointsUsed()).toBe(220)
			// exclusive: clears row 1 (17) and sets another input: net zero
			await r.ops.mixExclusive([[1, 3]], 0)
			expect(r.state.xpointsUsed()).toBe(220)
			await expect(r.ops.mixSet([[2, 5]], 0)).rejects.toThrow(/budget/)
		})
		it('a toggle on at the limit is refused, a toggle off works', async () => {
			const r = rig()
			fillBudget(r.state, 220)
			await expect(r.ops.mixToggle([[1, 5]], 0)).rejects.toThrow(/budget/)
			await r.ops.mixToggle([[1, 17]], 0)
			expect(r.state.getXpoint(1, 17)).toBeUndefined()
		})
	})

	describe('toggle', () => {
		it('turns an off crosspoint on at the given gain, and an on one off', async () => {
			const r = rig()
			await r.ops.mixToggle([[9, 1]], -30)
			expect(r.state.getXpoint(9, 1)).toBe(-30)
			await r.ops.mixToggle([[9, 1]], -30)
			expect(r.state.getXpoint(9, 1)).toBeUndefined()
			expect(r.ctl.commands).toEqual(['MIX 9 1:-30', 'MIX 9 1:-'])
		})
		it('stereo: all on clears both, partially on sets both', async () => {
			const r = rig()
			const pair: Array<[number, number]> = [
				[1, 17],
				[2, 18],
			]
			await r.ops.mixToggle(pair, 0)
			expect(r.ctl.commands).toEqual(['MIX 1 17:-', 'MIX 2 18:-'])
			r.ctl.commands.length = 0
			apply(r.state, 'MIX 1 17:0')
			await r.ops.mixToggle(pair, -20)
			expect(r.ctl.commands).toEqual(['MIX 1 17:-20', 'MIX 2 18:-20'])
		})
		it('empty selection writes nothing', async () => {
			const r = rig()
			await r.ops.mixToggle([], 0)
			expect(r.ctl.commands).toEqual([])
		})
	})

	describe('exclusive select and clear output', () => {
		it('exclusive writes one MIX line per output row, clearing every other in-map input', async () => {
			const r = rig() // analog4x4: inputs 1..24
			await r.ops.mixExclusive(
				[
					[1, 3],
					[2, 4],
				],
				0,
			)
			const expectRow = (out: number, keep: number): string =>
				`MIX ${out} ${range(24)
					.map((i) => `${i}:${i === keep ? 0 : '-'}`)
					.join(' ')}`
			expect(r.ctl.commands).toEqual([expectRow(1, 3), expectRow(2, 4)])
			expect(r.ctl.commands.join(' ')).not.toMatch(/\b2[56]:/)
			expect(r.state.mix.get(1)).toEqual(new Map([[3, 0]]))
		})
		it('on the combo the mic input 25 is part of the row, 26 is not', async () => {
			const r = rig('xnode2-combo')
			await r.ops.mixExclusive([[1, 1]], -60)
			const cmd = r.ctl.commands[0]
			expect(cmd.startsWith('MIX 1 1:-60 2:-')).toBe(true)
			expect(cmd.endsWith('24:- 25:-')).toBe(true)
			expect(cmd).not.toContain('26:')
		})
		it('a stray active crosspoint outside the map is cleared too', async () => {
			const r = rig()
			apply(r.state, 'MIX 1 17:0 26:0')
			await r.ops.mixExclusive([[1, 3]], 0)
			expect(r.ctl.commands[0]).toMatch(/ 26:-$/)
			expect(r.state.mix.get(1)).toEqual(new Map([[3, 0]]))
		})
		it('refuses an out-of-map input without writing', async () => {
			const r = rig()
			await expect(r.ops.mixExclusive([[1, 25]], 0)).rejects.toThrow(/input 25/)
			expect(r.ctl.commands).toEqual([])
		})
		it('clear output writes the active crosspoints of each row, nothing for empty rows', async () => {
			const r = rig()
			await r.ops.mixClearOutput([1, 2, 9])
			expect(r.ctl.commands).toEqual(['MIX 1 17:-', 'MIX 2 18:-'])
			expect(r.state.mix.get(1)?.size).toBe(0)
		})
		it('clear output refuses an output outside the map', async () => {
			const r = rig()
			await expect(r.ops.mixClearOutput([1, 25])).rejects.toThrow(/output 25/)
			expect(r.ctl.commands).toEqual([])
		})
	})

	describe('device errors and echo problems', () => {
		it('a device ERROR is propagated and the queue keeps working', async () => {
			const r = rig()
			r.ctl.failWith = new LwrpError(1001, 'syntax error', 'MIX 9 1:0')
			await expect(r.ops.mixSet([[9, 1]], 0)).rejects.toThrow(/1001/)
			r.ctl.failWith = undefined
			await r.ops.mixSet([[9, 2]], 0)
			expect(r.state.getXpoint(9, 2)).toBe(0)
		})
		it('a command the node accepted but did not apply is reported', async () => {
			const r = rig()
			r.ctl.applyEcho = false
			await expect(r.ops.mixSet([[9, 1]], 0)).rejects.toThrow(/did not apply/)
		})
	})
})

describe('mixer: adjust (coalesced)', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})
	const settle = async (...ps: Array<Promise<unknown>>): Promise<void> => {
		await vi.advanceTimersByTimeAsync(COALESCE_MS + 10)
		await Promise.all(ps)
	}

	it('10 rapid +1 dB steps become one write of +10 dB', async () => {
		const r = rig() // MIX 12 10:-100
		const ps = range(10).map(async () => r.ops.mixAdjust([[12, 10]], 10))
		expect(r.ctl.commands).toEqual([])
		await settle(...ps)
		expect(r.ctl.commands).toEqual(['MIX 12 10:0'])
	})

	it('nothing is written before the window ends', async () => {
		const r = rig()
		const p = r.ops.mixAdjust([[12, 10]], 10)
		await vi.advanceTimersByTimeAsync(COALESCE_MS - 1)
		expect(r.ctl.commands).toEqual([])
		await settle(p)
		expect(r.ctl.commands).toHaveLength(1)
	})

	it('clamps to the configured maximum', async () => {
		const r = rig()
		const ps = range(40).map(async () => r.ops.mixAdjust([[12, 10]], 10))
		await settle(...ps)
		expect(r.ctl.commands).toEqual(['MIX 12 10:240'])
		// already at the maximum: nothing more to write
		const p = r.ops.mixAdjust([[12, 10]], 10)
		await settle(p)
		expect(r.ctl.commands).toHaveLength(1)
	})

	it('an ON crosspoint is never turned off by lowering, it stops at the minimum', async () => {
		const r = rig()
		const p = r.ops.mixAdjust([[12, 10]], -5000)
		await settle(p)
		expect(r.ctl.commands).toEqual(['MIX 12 10:-800'])
		expect(r.state.getXpoint(12, 10)).toBe(-800)
	})

	it('an OFF crosspoint: a positive total switches it on at min + total', async () => {
		const r = rig()
		const ps = range(3).map(async () => r.ops.mixAdjust([[9, 1]], 10))
		await settle(...ps)
		expect(r.ctl.commands).toEqual(['MIX 9 1:-770'])
	})

	it('an OFF crosspoint: zero or negative totals leave it off', async () => {
		const r = rig()
		const neg = r.ops.mixAdjust([[9, 1]], -10)
		await settle(neg)
		const a = r.ops.mixAdjust([[9, 2]], 10)
		const b = r.ops.mixAdjust([[9, 2]], -10)
		await settle(a, b)
		expect(r.ctl.commands).toEqual([])
	})

	it('opposite steps cancel out on an ON crosspoint', async () => {
		const r = rig()
		const a = r.ops.mixAdjust([[12, 10]], 30)
		const b = r.ops.mixAdjust([[12, 10]], -30)
		await settle(a, b)
		expect(r.ctl.commands).toEqual([])
	})

	it('a call after the window starts a new write relative to the new state', async () => {
		const r = rig()
		const a = r.ops.mixAdjust([[12, 10]], 10)
		await settle(a)
		const b = r.ops.mixAdjust([[12, 10]], 10)
		await settle(b)
		expect(r.ctl.commands).toEqual(['MIX 12 10:-90', 'MIX 12 10:-80'])
	})

	it('different crosspoints are coalesced independently; a stereo pair makes two writes', async () => {
		const r = rig()
		const p = r.ops.mixAdjust(
			[
				[1, 17],
				[2, 18],
			],
			-10,
		)
		const q = r.ops.mixAdjust([[12, 10]], 10)
		await settle(p, q)
		expect(r.ctl.commands.sort()).toEqual(['MIX 1 17:-10', 'MIX 12 10:-90', 'MIX 2 18:-10'].sort())
	})

	it('refuses out-of-map crosspoints up front', async () => {
		const r = rig()
		await expect(r.ops.mixAdjust([[1, 25]], 10)).rejects.toThrow(/does not exist/)
		await expect(r.ops.mixAdjust([[30, 1]], 10)).rejects.toThrow(/does not exist/)
	})

	it('device failure rejects every waiter of the window', async () => {
		const r = rig()
		r.ctl.failWith = new LwrpError(1001, 'syntax error')
		const ps = range(3).map(async () => r.ops.mixAdjust([[12, 10]], 10).catch((e: Error) => e.message))
		await vi.advanceTimersByTimeAsync(100)
		const res = await Promise.all(ps)
		expect(res.every((m) => /1001/.test(String(m)))).toBe(true)
		expect(r.ctl.commands).toHaveLength(1)
	})

	it('destroy drops pending adjusts without writing and resolves the waiters', async () => {
		const r = rig()
		const p = r.ops.mixAdjust([[12, 10]], 10)
		await r.ops.destroy()
		await expect(p).resolves.toBeUndefined()
		await vi.advanceTimersByTimeAsync(200)
		expect(r.ctl.commands).toEqual([])
	})
})

// ------------------------------------------------------------------ snapshots

describe('mixer snapshots', () => {
	it('store: compact JSON with the in-map crosspoints that are on', async () => {
		const r = rig()
		apply(r.state, 'MIX 12 10:-100 25:0') // 25 is outside the analog4x4 map
		const snap = JSON.parse(await r.ops.mixSnapshotStore())
		expect(snap.v).toBe(1)
		expect(snap.devn).toBe('axiaxnode.analog4x4')
		expect(Object.keys(snap.mix)).toEqual(range(24).map(String))
		expect(snap.mix['1']).toEqual({ '17': 0 })
		expect(snap.mix['12']).toEqual({ '10': -100 })
		expect(snap.mix['9']).toEqual({})
		expect(await r.ops.mixSnapshotStore()).not.toMatch(/\s/)
	})

	it('round trip: change the mixer, recall, get the original back with minimal writes', async () => {
		const r = rig()
		const original = [...r.state.mix].map(([o, row]) => [o, [...row]])
		const json = await r.ops.mixSnapshotStore()

		await r.ops.mixSet([[9, 1]], -60)
		await r.ops.mixClear([[1, 17]])
		await r.ops.mixSet([[12, 10]], 0)
		r.ctl.commands.length = 0

		const changed = await r.ops.mixSnapshotRecall(json)
		expect(changed).toBe(3)
		expect(r.ctl.commands.sort()).toEqual(['MIX 1 17:0', 'MIX 12 10:-100', 'MIX 9 1:-'].sort())
		expect([...r.state.mix].map(([o, row]) => [o, [...row]])).toEqual(original)
	})

	it('recalling an identical snapshot writes nothing, even in factory mode', async () => {
		const r = rig()
		const json = await r.ops.mixSnapshotStore()
		apply(r.state, 'MIXCFG MODE:1')
		expect(await r.ops.mixSnapshotRecall(json)).toBe(0)
		expect(r.ctl.commands).toEqual([])
	})

	it('rows missing from the snapshot are left alone', async () => {
		const r = rig()
		const n = await r.ops.mixSnapshotRecall(
			JSON.stringify({ v: 1, devn: 'axiaxnode.analog4x4', mix: { '9': { '1': -60 } } }),
		)
		expect(n).toBe(1)
		expect(r.ctl.commands).toEqual(['MIX 9 1:-60'])
		expect(r.state.getXpoint(1, 17)).toBe(0)
	})

	it('gains of a snapshot are clamped to the configured limits', async () => {
		const r = rig()
		await r.ops.mixSnapshotRecall(
			JSON.stringify({ v: 1, devn: 'axiaxnode.analog4x4', mix: { '9': { '1': -950, '2': 240 } } }),
		)
		expect(r.ctl.commands).toEqual(['MIX 9 1:-800 2:240'])
	})

	it('a gain of -1000 in a snapshot means off, not -80 dB', async () => {
		const r = rig()
		await r.ops.mixSnapshotRecall(JSON.stringify({ v: 1, devn: 'axiaxnode.analog4x4', mix: { '9': { '1': -1000 } } }))
		expect(r.ctl.commands).toEqual([])
	})

	it('refuses a snapshot of another device model', async () => {
		const r = rig()
		const json = JSON.stringify({ v: 1, devn: 'axiaxnode2.combo', mix: {} })
		await expect(r.ops.mixSnapshotRecall(json)).rejects.toThrow(/another device model/)
		expect(r.ctl.commands).toEqual([])
	})

	it('the DEVN comparison ignores case', async () => {
		const r = rig()
		expect(await r.ops.mixSnapshotRecall(JSON.stringify({ v: 1, devn: 'AxiaXNode.Analog4x4', mix: {} }))).toBe(0)
	})

	const dev = 'axiaxnode.analog4x4'
	const bad: Array<[string, string, RegExp]> = [
		['not JSON', 'this is not json', /not valid JSON/],
		['empty string', '', /not valid JSON/],
		['truncated JSON', '{"v":1,"devn":"axiaxnode.analog4x4","mix":{"1":{"17":', /not valid JSON/],
		['null', 'null', /unknown format/],
		['array', '[]', /unknown format/],
		['number', '42', /unknown format/],
		['empty object', '{}', /unknown format/],
		['wrong version', JSON.stringify({ v: 2, devn: dev, mix: {} }), /unknown format/],
		['no mix', JSON.stringify({ v: 1, devn: dev }), /unknown format/],
		['mix null', JSON.stringify({ v: 1, devn: dev, mix: null }), /unknown format/],
		['output outside the map', JSON.stringify({ v: 1, devn: dev, mix: { '25': {} } }), /output that does not exist/],
		['output not numeric', JSON.stringify({ v: 1, devn: dev, mix: { x: {} } }), /output that does not exist/],
		[
			'input outside the map',
			JSON.stringify({ v: 1, devn: dev, mix: { '1': { '25': 0 } } }),
			/input that does not exist/,
		],
		['input not numeric', JSON.stringify({ v: 1, devn: dev, mix: { '1': { a: 0 } } }), /input that does not exist/],
		['row is not an object', JSON.stringify({ v: 1, devn: dev, mix: { '1': 5 } }), /malformed/],
		['row null', JSON.stringify({ v: 1, devn: dev, mix: { '1': null } }), /malformed/],
		['gain above max', JSON.stringify({ v: 1, devn: dev, mix: { '1': { '1': 241 } } }), /invalid gain/],
		['gain below min', JSON.stringify({ v: 1, devn: dev, mix: { '1': { '1': -1001 } } }), /invalid gain/],
		['gain not integer', JSON.stringify({ v: 1, devn: dev, mix: { '1': { '1': 1.5 } } }), /invalid gain/],
		['gain a string', JSON.stringify({ v: 1, devn: dev, mix: { '1': { '1': '0' } } }), /invalid gain/],
		['gain null', JSON.stringify({ v: 1, devn: dev, mix: { '1': { '1': null } } }), /invalid gain/],
	]
	it.each(bad)('refuses a malformed snapshot: %s', async (_n, json, re) => {
		const r = rig()
		await expect(r.ops.mixSnapshotRecall(json)).rejects.toThrow(re)
		expect(r.ctl.commands).toEqual([])
	})

	it('a bad row anywhere refuses the whole snapshot before any write', async () => {
		const r = rig()
		const json = JSON.stringify({ v: 1, devn: dev, mix: { '9': { '1': -60 }, '10': { '99': 0 } } })
		await expect(r.ops.mixSnapshotRecall(json)).rejects.toThrow()
		expect(r.ctl.commands).toEqual([])
	})

	it('respects the crosspoint budget', async () => {
		const r = rig()
		fillBudget(r.state, 219) // row 1 holds 17:0
		const json = JSON.stringify({ v: 1, devn: dev, mix: { '1': { '1': 0, '2': 0, '17': 0 } } })
		await expect(r.ops.mixSnapshotRecall(json)).rejects.toThrow(/budget/)
		expect(r.ctl.commands).toEqual([])
		const r2 = rig()
		fillBudget(r2.state, 218)
		expect(await r2.ops.mixSnapshotRecall(json)).toBe(2)
	})

	it('respects the factory mode check when something has to change', async () => {
		const r = rig()
		apply(r.state, 'MIXCFG MODE:1')
		const json = JSON.stringify({ v: 1, devn: dev, mix: { '9': { '1': 0 } } })
		await expect(r.ops.mixSnapshotRecall(json)).rejects.toThrow(/factory mode/)
	})

	it('works on the xNode2 with input 25', async () => {
		const r = rig('xnode2-combo')
		const json = await r.ops.mixSnapshotStore()
		expect(JSON.parse(json).mix['10']).toEqual({ '25': 0 })
		await r.ops.mixClear([[10, 25]])
		expect(await r.ops.mixSnapshotRecall(json)).toBe(1)
		expect(r.state.getXpoint(10, 25)).toBe(0)
	})
})

// ------------------------------------------------------------------ GPO

describe('GPO', () => {
	it('set builds the line from the current pins', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoSet(1, [1, 3], true)
		expect(r.ctl.commands).toEqual(['GPO 1 lhlhh'])
		await r.ops.gpoSet(1, [4], true)
		expect(r.ctl.commands[1]).toBe('GPO 1 lhllh') // pins 1 and 3 untouched
		await r.ops.gpoSet(1, [1], false)
		expect(r.ctl.commands[2]).toBe('GPO 1 hhllh')
		expect(r.state.gpo.get(2)).toBe('hhhhh') // another port untouched
	})
	it('set to the level already present writes nothing', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoSet(1, [2], false)
		expect(r.ctl.commands).toEqual([])
	})
	it('toggle flips from the current state; duplicate pins are collapsed', async () => {
		const r = rig('xnode2-combo')
		apply(r.state, 'GPO 2 hlhhh')
		await r.ops.gpoToggle(2, [1, 2, 2])
		expect(r.ctl.commands).toEqual(['GPO 2 lhhhh'])
	})
	it('validates port and pins', async () => {
		const r = rig('xnode2-combo')
		await expect(r.ops.gpoSet(3, [1], true)).rejects.toThrow(/GPO 3 does not exist \(1-2\)/)
		await expect(r.ops.gpoSet(0, [1], true)).rejects.toThrow(/does not exist/)
		await expect(r.ops.gpoSet(1.5, [1], true)).rejects.toThrow(/does not exist/)
		await expect(r.ops.gpoSet(1, [6], true)).rejects.toThrow(/pin 6/)
		await expect(r.ops.gpoSet(1, [0], true)).rejects.toThrow(/pin 0/)
		await expect(r.ops.gpoSet(1, [1.5], true)).rejects.toThrow(/pin/)
		await expect(r.ops.gpoSet(1, [], true)).rejects.toThrow(/No GPO pin/)
		await expect(r.ops.gpoSet(1, [1, 9], true)).rejects.toThrow(/pin 9/)
		expect(r.ctl.commands).toEqual([])
		for (const pin of [1, 2, 3, 4, 5]) await r.ops.gpoSet(2, [pin], true)
		expect(r.ctl.commands).toHaveLength(5)
	})
	it('legacy nodes have no GPO', async () => {
		const r = rig('legacy-analog4x4-a')
		await expect(r.ops.gpoSet(1, [1], true)).rejects.toThrow(/no GPO objects/)
	})
	it('refuses when the pin state is unknown', async () => {
		const r = rig('xnode2-combo')
		r.state.gpo.delete(1)
		await expect(r.ops.gpoSet(1, [1], true)).rejects.toThrow(/not known/)
	})
	it('reports a GPO that did not change', async () => {
		const r = rig('xnode2-combo')
		r.ctl.applyEcho = false
		await expect(r.ops.gpoSet(1, [1], true)).rejects.toThrow(/did not change/)
	})
	it('propagates a device error', async () => {
		const r = rig('xnode2-combo')
		r.ctl.failWith = new LwrpError(1002, 'bad port number')
		await expect(r.ops.gpoSet(1, [1], true)).rejects.toThrow(/1002/)
	})
})

describe('GPO pulse', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('drives the pin and restores it after the duration', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1], 500)
		expect(r.ctl.commands).toEqual(['GPO 1 lhhhh'])
		await vi.advanceTimersByTimeAsync(499)
		expect(r.ctl.commands).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(2)
		expect(r.ctl.commands).toEqual(['GPO 1 lhhhh', 'GPO 1 hhhhh'])
		expect(r.state.gpo.get(1)).toBe('hhhhh')
	})

	it('a pulse to the inactive level restores the active one', async () => {
		const r = rig('xnode2-combo')
		apply(r.state, 'GPO 1 lhhhh')
		await r.ops.gpoPulse(1, [1], 100, false)
		expect(r.ctl.commands).toEqual(['GPO 1 hhhhh'])
		await vi.advanceTimersByTimeAsync(101)
		expect(r.ctl.commands).toEqual(['GPO 1 hhhhh', 'GPO 1 lhhhh'])
	})

	it('only restores the pulsed pins', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1, 2], 100)
		apply(r.state, 'GPO 1 llLhh') // pin 3 turned on meanwhile
		await vi.advanceTimersByTimeAsync(101)
		expect(r.ctl.commands.at(-1)).toBe('GPO 1 hhlhh')
	})

	it('re-triggering restarts the timer and still restores the original level', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1], 500)
		await vi.advanceTimersByTimeAsync(300)
		await r.ops.gpoPulse(1, [1], 500) // pin is already active: no new write
		expect(r.ctl.commands).toEqual(['GPO 1 lhhhh'])
		await vi.advanceTimersByTimeAsync(300) // 600 ms after the first trigger: must not have been restored
		expect(r.ctl.commands).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(250) // 800+ ms
		expect(r.ctl.commands).toEqual(['GPO 1 lhhhh', 'GPO 1 hhhhh'])
		await vi.advanceTimersByTimeAsync(2000)
		expect(r.ctl.commands).toHaveLength(2) // restored once
	})

	it('validates the duration', async () => {
		const r = rig('xnode2-combo')
		await expect(r.ops.gpoPulse(1, [1], 19)).rejects.toThrow(/Pulse length/)
		await expect(r.ops.gpoPulse(1, [1], 600_001)).rejects.toThrow(/Pulse length/)
		await expect(r.ops.gpoPulse(1, [1], 10.5)).rejects.toThrow(/Pulse length/)
		await expect(r.ops.gpoPulse(1, [1], Number.NaN)).rejects.toThrow(/Pulse length/)
		await expect(r.ops.gpoPulse(1, [1], -5)).rejects.toThrow(/Pulse length/)
		expect(r.ctl.commands).toEqual([])
		await r.ops.gpoPulse(1, [1], 20)
		await r.ops.gpoPulse(2, [1], 600_000)
		expect(r.ctl.commands).toHaveLength(2)
	})

	it('the restore still happens when the GPO permission was switched off meanwhile', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1], 100)
		r.cfg.allowGpoWrites = false
		await vi.advanceTimersByTimeAsync(101)
		expect(r.ctl.commands.at(-1)).toBe('GPO 1 hhhhh')
	})

	it('a failing restore is logged, not thrown', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1], 100)
		r.ctl.failWith = new LwrpError(1000, 'oops')
		await vi.advanceTimersByTimeAsync(101)
		expect(r.logs.some(([l, m]) => l === 'warn' && /could not restore/.test(m))).toBe(true)
	})

	it('destroy during a pulse restores the pins', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1], 5000)
		await r.ops.destroy()
		expect(r.ctl.commands.at(-1)).toBe('GPO 1 hhhhh')
		await vi.advanceTimersByTimeAsync(10_000)
		expect(r.ctl.commands).toHaveLength(2) // the timer was cancelled, restored once
	})

	it('destroy restores several pins of a port with one write, and logs when it cannot', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1, 2], 5000)
		r.ctl.failWith = new Error('link down')
		await r.ops.destroy()
		expect(r.logs.some(([l, m]) => l === 'error' && /could not restore.*shutdown/.test(m))).toBe(true)
		r.ctl.failWith = undefined
		r.ctl.commands.length = 0
		const r2 = rig('xnode2-combo')
		await r2.ops.gpoPulse(1, [1, 2], 5000)
		await r2.ops.destroy()
		expect(r2.ctl.commands).toEqual(['GPO 1 lhhhh'.replace('lhhhh', 'llhhh'), 'GPO 1 hhhhh'])
	})

	it('destroy is bounded when the restore hangs', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1], 5000)
		r.ctl.writeAndVerify = async () => new Promise(() => undefined)
		const p = r.ops.destroy()
		await vi.advanceTimersByTimeAsync(DESTROY_RESTORE_TIMEOUT_MS + 10)
		await p
		expect(r.logs.some(([l, m]) => l === 'error' && /timed out/.test(m))).toBe(true)
	})

	it('the restore is armed even when the verification of the pulse write fails', async () => {
		const r = rig('xnode2-combo')
		const orig = r.ctl.writeAndVerify.bind(r.ctl)
		let first = true
		r.ctl.writeAndVerify = async (cmd, target) => {
			const line = await orig(cmd, target)
			if (first) {
				first = false
				throw new Error('query timed out')
			}
			return line
		}
		await expect(r.ops.gpoPulse(1, [1], 200)).rejects.toThrow(/timed out/)
		expect(r.state.gpo.get(1)).toBe('lhhhh') // the pin did change
		await vi.advanceTimersByTimeAsync(201)
		expect(r.ctl.commands.at(-1)).toBe('GPO 1 hhhhh')
		expect(r.state.gpo.get(1)).toBe('hhhhh')
	})

	it('a restore that fails while the link is down is retried once it is back', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1], 100)
		r.ctl.isSynced = false
		await vi.advanceTimersByTimeAsync(101)
		expect(r.ctl.commands).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(PULSE_RESTORE_RETRY_MS * 3)
		expect(r.ctl.commands).toHaveLength(1)
		expect(r.logs.some(([l, m]) => l === 'warn' && /retrying/.test(m))).toBe(true)
		r.ctl.isSynced = true
		await vi.advanceTimersByTimeAsync(PULSE_RESTORE_RETRY_MS)
		expect(r.ctl.commands).toEqual(['GPO 1 lhhhh', 'GPO 1 hhhhh'])
		await vi.advanceTimersByTimeAsync(PULSE_RESTORE_RETRY_MS * 5)
		expect(r.ctl.commands).toHaveLength(2)
	})

	it('gives up after the bounded number of attempts and says so', async () => {
		const r = rig('xnode2-combo')
		await r.ops.gpoPulse(1, [1], 100)
		r.ctl.isSynced = false
		await vi.advanceTimersByTimeAsync(101 + PULSE_RESTORE_RETRY_MS * (PULSE_RESTORE_MAX_ATTEMPTS + 2))
		expect(r.logs.some(([l, m]) => l === 'error' && /giving up/.test(m))).toBe(true)
		r.ctl.isSynced = true
		await vi.advanceTimersByTimeAsync(PULSE_RESTORE_RETRY_MS * 3)
		expect(r.ctl.commands).toHaveLength(1)
	})

	it('a pulse on an already active pin with no running pulse changes nothing', async () => {
		const r = rig('xnode2-combo')
		apply(r.state, 'GPO 1 lhhhh')
		await r.ops.gpoPulse(1, [1], 100)
		await vi.advanceTimersByTimeAsync(200)
		expect(r.ctl.commands).toEqual([])
	})
})

// ------------------------------------------------------------------ mic gain

describe('mic gain', () => {
	it('normaliseMicGain snaps to 0 or 140...690', () => {
		expect(normaliseMicGain(0)).toBe(0)
		expect(normaliseMicGain(69)).toBe(0)
		expect(normaliseMicGain(70)).toBe(MIC_GAIN_MIN_TENTHS)
		expect(normaliseMicGain(139)).toBe(MIC_GAIN_MIN_TENTHS)
		expect(normaliseMicGain(140)).toBe(140)
		expect(normaliseMicGain(350)).toBe(350)
		expect(normaliseMicGain(690)).toBe(690)
		expect(normaliseMicGain(691)).toBe(MIC_GAIN_MAX_TENTHS)
		expect(normaliseMicGain(5000)).toBe(690)
		expect(normaliseMicGain(-300)).toBe(0)
	})
	it('set writes integer tenths on the xNode2 MIC input', async () => {
		const r = rig('xnode2-combo')
		await r.ops.micGainSet(5, 350)
		expect(r.ctl.commands).toEqual(['INP 5 GAIN:350'])
		expect(r.state.inp.get(5)?.GAIN).toBe('350')
	})
	it('set applies the 0 / 140...690 rule', async () => {
		const r = rig('xnode2-combo')
		await r.ops.micGainSet(5, 100)
		await r.ops.micGainSet(5, 900)
		await r.ops.micGainSet(5, 20)
		expect(r.ctl.commands).toEqual(['INP 5 GAIN:140', 'INP 5 GAIN:690', 'INP 5 GAIN:0'])
	})
	it('set to the current value writes nothing', async () => {
		const r = rig('xnode2-combo')
		await r.ops.micGainSet(5, 0)
		expect(r.ctl.commands).toEqual([])
	})
	it('refuses non-integers, non-mic inputs, unknown inputs and legacy nodes', async () => {
		const r = rig('xnode2-combo')
		await expect(r.ops.micGainSet(5, 35.5)).rejects.toThrow(/integer/)
		await expect(r.ops.micGainSet(1, 300)).rejects.toThrow(/not a microphone/)
		await expect(r.ops.micGainSet(4, 300)).rejects.toThrow(/not a microphone/)
		await expect(r.ops.micGainSet(6, 300)).rejects.toThrow(/not a microphone/)
		await expect(r.ops.micGainAdjust(1, 10)).rejects.toThrow(/not a microphone/)
		const legacy = rig('legacy-analog4x4-a')
		await expect(legacy.ops.micGainSet(1, 300)).rejects.toThrow(/not a microphone/)
		expect(r.ctl.commands).toEqual([])
		expect(legacy.ctl.commands).toEqual([])
	})
	it('never touches phantom power or the source selection', async () => {
		const r = rig('xnode2-combo')
		await r.ops.micGainSet(5, 300)
		expect(r.ctl.commands.join('\n')).not.toMatch(/PHPW|SRCE/)
	})

	describe('adjust', () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})
		afterEach(() => {
			vi.useRealTimers()
		})
		const settle = async (...ps: Array<Promise<unknown>>): Promise<void> => {
			await vi.advanceTimersByTimeAsync(COALESCE_MS + 10)
			await Promise.all(ps)
		}
		it('coalesces rapid steps', async () => {
			const r = rig('xnode2-combo')
			apply(r.state, 'INP 5 GAIN:350')
			const ps = range(10).map(async () => r.ops.micGainAdjust(5, 10))
			await settle(...ps)
			expect(r.ctl.commands).toEqual(['INP 5 GAIN:450'])
		})
		it('from 0, a positive step jumps to the minimum 140', async () => {
			const r = rig('xnode2-combo')
			await settle(r.ops.micGainAdjust(5, 10))
			expect(r.ctl.commands).toEqual(['INP 5 GAIN:140'])
		})
		it('from 0 a negative step does nothing', async () => {
			const r = rig('xnode2-combo')
			await settle(r.ops.micGainAdjust(5, -10))
			expect(r.ctl.commands).toEqual([])
		})
		it('stepping down from 140 reaches 0, however small the step', async () => {
			const r = rig('xnode2-combo')
			apply(r.state, 'INP 5 GAIN:140')
			await settle(r.ops.micGainAdjust(5, -10))
			expect(r.ctl.commands).toEqual(['INP 5 GAIN:0'])
			apply(r.state, 'INP 5 GAIN:200')
			await settle(r.ops.micGainAdjust(5, -10))
			expect(r.ctl.commands.at(-1)).toBe('INP 5 GAIN:190')
		})
		it('going below 140 drops to 0, clamps at 690', async () => {
			const r = rig('xnode2-combo')
			apply(r.state, 'INP 5 GAIN:150')
			await settle(r.ops.micGainAdjust(5, -100))
			expect(r.ctl.commands).toEqual(['INP 5 GAIN:0'])
			apply(r.state, 'INP 5 GAIN:680')
			await settle(r.ops.micGainAdjust(5, 100))
			expect(r.ctl.commands.at(-1)).toBe('INP 5 GAIN:690')
		})
		it('fails when the gain is unknown', async () => {
			const r = rig('xnode2-combo')
			delete r.state.inp.get(5)!.GAIN
			const p = r.ops.micGainAdjust(5, 10).catch((e: Error) => e.message)
			await vi.advanceTimersByTimeAsync(100)
			expect(await p).toMatch(/not known/)
		})
	})
})

// ------------------------------------------------------------------ DST

describe('DST', () => {
	it('connect to a channel computes the multicast address', async () => {
		const r = rig()
		await r.ops.dstConnectChannel(1, 22302)
		await r.ops.dstConnectChannel(2, 22302, 'to')
		await r.ops.dstConnectChannel(3, 1)
		await r.ops.dstConnectChannel(4, 32767)
		expect(r.ctl.commands).toEqual([
			'DST 1 ADDR:"239.192.87.30"',
			'DST 2 ADDR:"239.193.87.30"',
			'DST 3 ADDR:"239.192.0.1"',
			'DST 4 ADDR:"239.192.127.255"',
		])
	})
	it('rejects channels outside 1...32767', async () => {
		const r = rig()
		for (const ch of [0, -1, 32768, 1.5, Number.NaN, Infinity]) {
			await expect(r.ops.dstConnectChannel(1, ch)).rejects.toThrow(/Invalid Livewire channel/)
		}
		expect(r.ctl.commands).toEqual([])
	})
	it('connect to an address: IPv4 multicast only', async () => {
		const r = rig()
		await r.ops.dstConnectAddress(1, '239.192.5.6')
		await r.ops.dstConnectAddress(2, ' 224.0.0.1 ')
		expect(r.ctl.commands).toEqual(['DST 1 ADDR:"239.192.5.6"', 'DST 2 ADDR:"224.0.0.1"'])
		for (const bad of [
			'10.0.0.1',
			'192.168.1.1',
			'240.0.0.1',
			'223.255.255.255',
			'239.192.5',
			'239.192.5.256',
			'abc',
			'',
			'22301',
			'239.192.5.6 <label>',
			'239.192.5.6/24',
		]) {
			await expect(r.ops.dstConnectAddress(1, bad)).rejects.toThrow(/not an IPv4 multicast/)
		}
		expect(r.ctl.commands).toHaveLength(2)
	})
	it('disconnect writes an empty address', async () => {
		const r = rig()
		await r.ops.dstDisconnect(1)
		expect(r.ctl.commands).toEqual(['DST 1 ADDR:""'])
		expect(r.state.dst.get(1)?.ADDR).toBe('')
	})
	it('validates the DST index', async () => {
		const r = rig()
		for (const n of [0, 9, -1, 1.5, Number.NaN]) {
			await expect(r.ops.dstDisconnect(n)).rejects.toThrow(/does not exist/)
			await expect(r.ops.dstConnectChannel(n, 5)).rejects.toThrow(/does not exist/)
			await expect(r.ops.dstGainSet(n, 0)).rejects.toThrow(/does not exist/)
			await expect(r.ops.dstGainAdjust(n, 1)).rejects.toThrow(/does not exist/)
		}
		expect(r.ctl.commands).toEqual([])
	})
	it('legacy keeps the address as typed and the verification accepts it', async () => {
		const r = rig()
		const orig = r.ctl.writeAndVerify.bind(r.ctl)
		r.ctl.writeAndVerify = async (cmd, target) => {
			await orig(cmd, target)
			apply(r.state, 'DST 1 ADDR:"22302"')
			return null
		}
		await expect(r.ops.dstConnectChannel(1, 22302)).resolves.toBeUndefined()
	})
	it('a different address read back is an error', async () => {
		const r = rig()
		r.ctl.applyEcho = false
		await expect(r.ops.dstConnectAddress(1, '239.192.5.6')).rejects.toThrow(/did not apply/)
	})

	describe('gain', () => {
		it('set clamps to -100...+24 dB on legacy', async () => {
			const r = rig()
			await r.ops.dstGainSet(1, 500)
			await r.ops.dstGainSet(2, -5000)
			await r.ops.dstGainSet(3, -60)
			expect(r.ctl.commands).toEqual(['DST 1 OUGN:240', 'DST 2 OUGN:-1000', 'DST 3 OUGN:-60'])
		})
		it('xNode2 has a -72 dB floor', async () => {
			const r = rig('xnode2-combo')
			await r.ops.dstGainSet(1, -1000)
			await r.ops.dstGainSet(2, -720)
			await r.ops.dstGainSet(3, -719)
			await r.ops.dstGainSet(4, 999)
			expect(r.ctl.commands).toEqual(['DST 1 OUGN:-720', 'DST 2 OUGN:-720', 'DST 3 OUGN:-719', 'DST 4 OUGN:240'])
		})
		it('refuses non-integers and writes nothing when already at the value', async () => {
			const r = rig()
			await expect(r.ops.dstGainSet(1, 0.5)).rejects.toThrow(/integer/)
			await r.ops.dstGainSet(1, 0)
			expect(r.ctl.commands).toEqual([])
		})
		describe('adjust', () => {
			beforeEach(() => {
				vi.useFakeTimers()
			})
			afterEach(() => {
				vi.useRealTimers()
			})
			it('coalesces and clamps', async () => {
				const r = rig()
				const ps = range(10).map(async () => r.ops.dstGainAdjust(1, 5))
				await vi.advanceTimersByTimeAsync(100)
				await Promise.all(ps)
				expect(r.ctl.commands).toEqual(['DST 1 OUGN:50'])
				const qs = range(100).map(async () => r.ops.dstGainAdjust(1, 10))
				await vi.advanceTimersByTimeAsync(100)
				await Promise.all(qs)
				expect(r.ctl.commands.at(-1)).toBe('DST 1 OUGN:240')
			})
			it('an absent OUGN (legacy node) counts as 0 dB', async () => {
				const r = rig()
				delete r.state.dst.get(1)!.OUGN
				const p = r.ops.dstGainAdjust(1, 5)
				await vi.advanceTimersByTimeAsync(100)
				await p
				expect(r.ctl.commands).toEqual(['DST 1 OUGN:5'])
			})
		})
	})
})

// ------------------------------------------------------------------ SRC

describe('SRC', () => {
	const rigWithGain = (fixture: FixtureName = 'legacy-analog4x4-a'): Rig => {
		const r = rig(fixture)
		apply(r.state, 'SRC 1 INGN:0')
		return r
	}

	it('gain clamps: legacy -100...+24, xNode2 floor -72', async () => {
		const l = rigWithGain()
		await l.ops.srcGainSet(1, -5000)
		await l.ops.srcGainSet(2, 5000)
		expect(l.ctl.commands).toEqual(['SRC 1 INGN:-1000', 'SRC 2 INGN:240'])
		const x = rigWithGain('xnode2-combo')
		await x.ops.srcGainSet(1, -1000)
		expect(x.ctl.commands).toEqual(['SRC 1 INGN:-720'])
	})

	it('gain adjust coalesces', async () => {
		vi.useFakeTimers()
		try {
			const r = rigWithGain()
			const ps = range(10).map(async () => r.ops.srcGainAdjust(1, -10))
			await vi.advanceTimersByTimeAsync(100)
			await Promise.all(ps)
			expect(r.ctl.commands).toEqual(['SRC 1 INGN:-100'])
		} finally {
			vi.useRealTimers()
		}
	})

	it('validates the SRC index everywhere', async () => {
		const r = rigWithGain()
		for (const n of [0, 9, 1.5, Number.NaN, -1]) {
			await expect(r.ops.srcGainSet(n, 0)).rejects.toThrow(/does not exist/)
			await expect(r.ops.srcGainAdjust(n, 1)).rejects.toThrow(/does not exist/)
			await expect(r.ops.srcEnable(n, 'on')).rejects.toThrow(/does not exist/)
			await expect(r.ops.srcSetAddress(n, 5)).rejects.toThrow(/does not exist/)
			await expect(r.ops.srcSetMode(n, 12)).rejects.toThrow(/does not exist/)
			await expect(r.ops.srcRename(n, 'x')).rejects.toThrow(/does not exist/)
		}
		expect(r.ctl.commands).toEqual([])
	})

	it('enable / disable / toggle', async () => {
		const r = rigWithGain()
		await r.ops.srcEnable(1, 'off')
		expect(r.state.src.get(1)?.RTPE).toBe('0')
		await r.ops.srcEnable(1, 'toggle')
		expect(r.state.src.get(1)?.RTPE).toBe('1')
		await r.ops.srcEnable(1, 'toggle')
		await r.ops.srcEnable(1, 'on')
		expect(r.ctl.commands).toEqual(['SRC 1 RTPE:0', 'SRC 1 RTPE:1', 'SRC 1 RTPE:0', 'SRC 1 RTPE:1'])
	})

	it('toggle needs a known state', async () => {
		const r = rigWithGain()
		delete r.state.src.get(1)!.RTPE
		await expect(r.ops.srcEnable(1, 'toggle')).rejects.toThrow(/not known/)
	})

	it('address from a channel number or a multicast IP, always sent as an IP', async () => {
		const r = rigWithGain()
		await r.ops.srcSetAddress(1, 22301)
		await r.ops.srcSetAddress(2, '22302')
		await r.ops.srcSetAddress(3, '22303', 'to')
		await r.ops.srcSetAddress(4, '239.192.9.9')
		expect(r.ctl.commands).toEqual([
			'SRC 1 RTPA:"239.192.87.29"',
			'SRC 2 RTPA:"239.192.87.30"',
			'SRC 3 RTPA:"239.193.87.31"',
			'SRC 4 RTPA:"239.192.9.9"',
		])
	})

	it('address validation', async () => {
		const r = rigWithGain()
		for (const bad of [0, 32768, 99999999, '', 'abc', '10.0.0.1', '239.192.1', '239.192.1.1 <x>', '-5', '1.5']) {
			await expect(r.ops.srcSetAddress(1, bad)).rejects.toThrow()
		}
		expect(r.ctl.commands).toEqual([])
	})

	it('mode accepts only 12, 240, 48', async () => {
		const r = rigWithGain()
		await r.ops.srcSetMode(1, 12)
		await r.ops.srcSetMode(1, 240)
		await r.ops.srcSetMode(1, 48)
		expect(r.ctl.commands).toEqual(['SRC 1 RTPP:12', 'SRC 1 RTPP:240', 'SRC 1 RTPP:48'])
		for (const bad of [0, 13, 1.5, Number.NaN, -12, 120]) {
			await expect(r.ops.srcSetMode(1, bad)).rejects.toThrow(/Unknown stream mode/)
		}
		expect(r.ctl.commands).toHaveLength(3)
	})

	describe('rename', () => {
		it('writes a quoted name', async () => {
			const r = rigWithGain()
			await r.ops.srcRename(1, 'Studio A')
			expect(r.ctl.commands).toEqual(['SRC 1 PSNM:"Studio A"'])
			expect(r.state.src.get(1)?.PSNM).toBe('Studio A')
		})
		it('strips quotes, backslashes and control characters', async () => {
			const r = rigWithGain()
			await r.ops.srcRename(1, 'A"B\\C\r\nD\tE\0F\x7f')
			expect(r.ctl.commands).toEqual(['SRC 1 PSNM:"ABCDEF"'])
		})
		it('trims, enforces 1...16 characters', async () => {
			const r = rigWithGain()
			await r.ops.srcRename(1, '  1234567890123456  ')
			expect(r.ctl.commands).toEqual(['SRC 1 PSNM:"1234567890123456"'])
			await expect(r.ops.srcRename(1, '12345678901234567')).rejects.toThrow(/too long/)
			await expect(r.ops.srcRename(1, '')).rejects.toThrow(/empty/)
			await expect(r.ops.srcRename(1, '   ')).rejects.toThrow(/empty/)
			await expect(r.ops.srcRename(1, '"\r\n"')).rejects.toThrow(/empty/)
			expect(r.ctl.commands).toHaveLength(1)
		})
		it('a name of 17 characters that is 16 after sanitising is accepted', async () => {
			const r = rigWithGain()
			await r.ops.srcRename(1, '1234567890"123456')
			expect(r.ctl.commands).toEqual(['SRC 1 PSNM:"1234567890123456"'])
		})
		it('tolerates non-string input', async () => {
			const r = rigWithGain()
			await r.ops.srcRename(1, 42 as unknown as string)
			expect(r.ctl.commands).toEqual(['SRC 1 PSNM:"42"'])
		})
	})
})

// ------------------------------------------------------------------ injection

describe('no command injection from user-supplied strings', () => {
	const payloads = [
		'x"\r\nSET NID:"666"\r\n',
		'\r\nSET NID:"1"',
		'abc\nMIXCFG MODE:1',
		'" PSNM:"evil',
		'name" ADDR:"239.1.1.1',
		'\\"\r\nIP ADDR:"1.2.3.4"',
		'\0\0SET x',
		'a\u2028b\u2029SET y',
		'239.192.1.1\r\nSET NID:"1"',
		'239.192.1.1" ADDR:"x',
		'22301\r\nSET NID:"1"',
		'22301 SET',
		'1\n2',
	]
	const FORBIDDEN_VERBS = ['SET', 'IP', 'MIXCFG', 'CFG', 'LOGIN']
	const ALLOWED_VERBS = ['SRC', 'DST', 'MIX', 'GPO', 'INP']

	function assertSafe(commands: string[], expectedAttrs: number): void {
		for (const c of commands) {
			expect(c).not.toMatch(/[\r\n\0]/)
			const line = parseLine(c)
			expect(line).not.toBeNull()
			expect(FORBIDDEN_VERBS).not.toContain(line?.verb)
			expect(ALLOWED_VERBS).toContain(line?.verb)
			expect(Object.keys(line?.attrs ?? {}).length).toBeLessThanOrEqual(expectedAttrs)
			// quotes only ever come in one balanced pair
			expect((c.match(/"/g) ?? []).length % 2).toBe(0)
			expect((c.match(/"/g) ?? []).length).toBeLessThanOrEqual(2)
		}
	}

	it('srcRename', async () => {
		for (const p of payloads) {
			const r = rig()
			await r.ops.srcRename(1, p.slice(0, 40)).catch(() => undefined)
			assertSafe(r.ctl.commands, 1)
			for (const c of r.ctl.commands) {
				expect(c).toMatch(/^SRC 1 PSNM:"[^"\\\r\n]{1,16}"$/)
				expect(Object.keys(parseLine(c)?.attrs ?? {})).toEqual(['PSNM'])
			}
		}
	})

	it('srcSetAddress, dstConnectAddress, dstConnectChannel', async () => {
		for (const p of payloads) {
			const r = rig()
			await r.ops.srcSetAddress(1, p).catch(() => undefined)
			await r.ops.dstConnectAddress(1, p).catch(() => undefined)
			await r.ops.dstConnectChannel(1, p as unknown as number).catch(() => undefined)
			await r.ops.dstConnectChannel(1, 1, p as unknown as 'from').catch(() => undefined)
			assertSafe(r.ctl.commands, 1)
			expect(r.ctl.commands).toEqual([])
		}
	})

	it('numeric parameters given as hostile strings are refused', async () => {
		const evil = '1\r\nSET NID:"1"' as unknown as number
		const r = rig('xnode2-combo')
		const calls: Array<Promise<unknown>> = [
			r.ops.srcGainSet(evil, 0),
			r.ops.srcGainAdjust(evil, 1),
			r.ops.srcEnable(evil, 'on'),
			r.ops.srcSetMode(evil, 12),
			r.ops.srcSetMode(1, evil),
			r.ops.srcSetAddress(evil, 5),
			r.ops.srcRename(evil, 'x'),
			r.ops.dstDisconnect(evil),
			r.ops.dstGainSet(evil, 0),
			r.ops.dstGainSet(1, evil),
			r.ops.dstGainAdjust(evil, 1),
			r.ops.gpoSet(evil, [1], true),
			r.ops.gpoSet(1, [evil], true),
			r.ops.gpoToggle(1, [evil]),
			r.ops.gpoPulse(1, [1], evil),
			r.ops.micGainSet(evil, 300),
			r.ops.micGainSet(5, evil),
			r.ops.mixSet([[evil, 1]], 0),
			r.ops.mixSet([[1, evil]], 0),
			r.ops.mixSet([[1, 1]], evil),
			r.ops.mixClear([[evil, 1]]),
			r.ops.mixClearOutput([evil]),
			r.ops.mixExclusive([[1, evil]], 0),
			r.ops.mixToggle([[1, 1]], evil),
		]
		const results = await Promise.allSettled(calls)
		expect(results.every((x) => x.status === 'rejected')).toBe(true)
		expect(r.ctl.commands).toEqual([])
	})

	it('mixSnapshotRecall with hostile JSON keys and values', async () => {
		const dev = 'axiaxnode.analog4x4'
		const docs = [
			{ v: 1, devn: dev, mix: { '1\r\nSET NID:"1"': { '1': 0 } } },
			{ v: 1, devn: dev, mix: { '1': { '1\r\nSET NID:"1"': 0 } } },
			{ v: 1, devn: dev, mix: { '1': { '1': '0\r\nSET NID:"1"' } } },
			{ v: 1, devn: dev, mix: { __proto__: { '1': 0 } } },
			{ v: 1, devn: dev + '\r\nSET', mix: {} },
		]
		for (const d of docs) {
			const r = rig()
			await r.ops.mixSnapshotRecall(JSON.stringify(d)).catch(() => undefined)
			assertSafe(r.ctl.commands, 24)
		}
		const r = rig()
		await r.ops
			.mixSnapshotRecall('{"v":1,"devn":"axiaxnode.analog4x4","mix":{"__proto__":{"1":0}}}')
			.catch(() => undefined)
		expect(r.ctl.commands).toEqual([])
	})

	it('every command ever sent is a single line using only the allowed verbs', async () => {
		const r = rig('xnode2-combo')
		await r.ops.srcRename(1, 'ok')
		await r.ops.mixSet([[9, 1]], 0)
		await r.ops.gpoSet(1, [1], true)
		await r.ops.micGainSet(5, 300)
		await r.ops.dstDisconnect(1)
		assertSafe(r.ctl.commands, 24)
	})
})

// ------------------------------------------------------------------ serialisation

describe('serialisation', () => {
	it('concurrent operations run one after the other in call order', async () => {
		const r = rig()
		const order: string[] = []
		const orig = r.ctl.writeAndVerify.bind(r.ctl)
		r.ctl.writeAndVerify = async (cmd, target) => {
			order.push(`start ${cmd}`)
			const line = await orig(cmd, target)
			await new Promise((res) => setTimeout(res, 5))
			order.push(`end ${cmd}`)
			return line
		}
		await Promise.all([r.ops.mixSet([[9, 1]], 0), r.ops.mixSet([[9, 2]], 0), r.ops.dstDisconnect(1)])
		expect(order).toEqual([
			'start MIX 9 1:0',
			'end MIX 9 1:0',
			'start MIX 9 2:0',
			'end MIX 9 2:0',
			'start DST 1 ADDR:""',
			'end DST 1 ADDR:""',
		])
	})
})

// ------------------------------------------------------------------ F3 regressions

describe('latest value wins for absolute sets', () => {
	/** Hold the first write until released, so later calls pile up in the queue. */
	function gate(r: Rig): { release: () => void } {
		const orig = r.ctl.writeAndVerify.bind(r.ctl)
		let release!: () => void
		const held = new Promise<void>((res) => (release = res))
		let first = true
		r.ctl.writeAndVerify = async (cmd, target) => {
			if (first) {
				first = false
				await held
			}
			return orig(cmd, target)
		}
		return { release }
	}

	const started = async (): Promise<void> => new Promise((res) => setTimeout(res, 5))

	it('queued gain sets on one target collapse into the last value', async () => {
		const r = rig()
		apply(r.state, 'DST 1 OUGN:0')
		const g = gate(r)
		const first = r.ops.dstGainSet(1, 10) // now blocked in the write
		await started()
		const ps = [20, 30, 40, 50].map(async (v) => r.ops.dstGainSet(1, v))
		g.release()
		await Promise.all([first, ...ps])
		expect(r.ctl.commands).toEqual(['DST 1 OUGN:10', 'DST 1 OUGN:50'])
	})

	it('same for mix_set, src and mic gain', async () => {
		const r = rig('xnode2-combo')
		apply(r.state, 'SRC 1 INGN:0')
		const g = gate(r)
		const first = r.ops.dstGainSet(1, 5)
		await started()
		const ps = [
			r.ops.mixSet([[9, 1]], -10),
			r.ops.mixSet([[9, 1]], -20),
			r.ops.mixSet([[9, 1]], -30),
			r.ops.srcGainSet(1, 10),
			r.ops.srcGainSet(1, 20),
			r.ops.micGainSet(5, 200),
			r.ops.micGainSet(5, 300),
		]
		g.release()
		await Promise.all([first, ...ps])
		expect(r.ctl.commands).toEqual(['DST 1 OUGN:5', 'MIX 9 1:-30', 'SRC 1 INGN:20', 'INP 5 GAIN:300'])
	})

	it('call order is kept: a write is never replaced across a different target', async () => {
		const r = rig()
		apply(r.state, 'DST 1 OUGN:0')
		apply(r.state, 'DST 2 OUGN:0')
		const g = gate(r)
		const first = r.ops.dstGainSet(2, 1)
		await started()
		const ps = [r.ops.dstGainSet(1, 5), r.ops.dstGainSet(1, 10), r.ops.dstGainSet(2, 20), r.ops.dstGainSet(1, 30)]
		g.release()
		await Promise.all([first, ...ps])
		expect(r.ctl.commands).toEqual(['DST 2 OUGN:1', 'DST 1 OUGN:10', 'DST 2 OUGN:20', 'DST 1 OUGN:30'])
	})

	it('toggle is decided from the state when it runs, repeated presses collapse', async () => {
		const r = rig()
		const g = gate(r)
		const first = r.ops.mixSet([[9, 1]], 0)
		await started()
		const ps = [first, r.ops.mixToggle([[9, 1]], -30), r.ops.mixToggle([[9, 1]], -30), r.ops.mixToggle([[9, 1]], -30)]
		g.release()
		await Promise.all(ps)
		// the toggle saw the crosspoint on (written by the set before it) and cleared it
		expect(r.ctl.commands).toEqual(['MIX 9 1:0', 'MIX 9 1:-'])
	})

	it('exclusive collapses and a failure reaches every waiter', async () => {
		const r = rig()
		const g = gate(r)
		const first = r.ops.mixSet([[9, 1]], 0)
		await started()
		const ps = [first, r.ops.mixExclusive([[1, 3]], 0), r.ops.mixExclusive([[1, 3]], -5)]
		g.release()
		await Promise.all(ps)
		expect(r.ctl.commands).toHaveLength(2)
		expect(r.ctl.commands[1]).toContain('3:-5')
		expect(r.state.mix.get(1)).toEqual(new Map([[3, -5]]))
		r.ctl.failWith = new LwrpError(1001, 'syntax error')
		const a = r.ops.mixSet([[9, 2]], 0)
		const b = r.ops.mixSet([[9, 2]], -5)
		await expect(a).rejects.toThrow(/1001/)
		await expect(b).rejects.toThrow(/1001/)
	})
})

describe('SRC address keeps the payload-type suffix', () => {
	it('re-sends the existing ;rtp-pt suffix and accepts the read-back', async () => {
		const r = rig('xnode2-combo')
		apply(r.state, 'SRC 1 RTPA:"239.192.87.29;rtp-pt=97"')
		await r.ops.srcSetAddress(1, 22302)
		expect(r.ctl.commands).toEqual(['SRC 1 RTPA:"239.192.87.30;rtp-pt=97"'])
		expect(r.state.src.get(1)?.RTPA).toBe('239.192.87.30;rtp-pt=97')
	})
	it('no suffix, no suffix sent', async () => {
		const r = rig('xnode2-combo')
		apply(r.state, 'SRC 1 RTPA:"239.192.87.29"')
		await r.ops.srcSetAddress(1, '239.192.87.30')
		expect(r.ctl.commands).toEqual(['SRC 1 RTPA:"239.192.87.30"'])
	})
})

describe('crosspoint budget while writing several rows', () => {
	it('snapshot recall writes the rows that free crosspoints first', async () => {
		const r = rig()
		fillBudget(r.state, 219)
		const peaks: number[] = []
		const orig = r.ctl.writeAndVerify.bind(r.ctl)
		r.ctl.writeAndVerify = async (cmd, target) => {
			const line = await orig(cmd, target)
			peaks.push(r.state.xpointsUsed())
			return line
		}
		const g1 = r.state.getXpoint(1, 17) as number
		const snap = { v: 1, devn: 'axiaxnode.analog4x4', mix: { '1': { '17': g1, '3': 0, '4': 0 }, '2': {} } }
		expect(await r.ops.mixSnapshotRecall(JSON.stringify(snap))).toBe(3)
		expect(r.ctl.commands.map((c) => c.split(' ')[1])).toEqual(['2', '1'])
		expect(Math.max(...peaks)).toBeLessThanOrEqual(220)
		expect(r.state.xpointsUsed()).toBe(220)
	})
	it('the budget of the final result is still enforced', async () => {
		const r = rig()
		fillBudget(r.state, 219)
		const snap = { v: 1, devn: 'axiaxnode.analog4x4', mix: { '1': { '17': 0, '3': 0, '4': 0 } } }
		await expect(r.ops.mixSnapshotRecall(JSON.stringify(snap))).rejects.toThrow(/budget/)
		expect(r.ctl.commands).toEqual([])
	})
})

describe('srcEnable', () => {
	it('refuses an unknown mode without writing', async () => {
		const r = rig()
		await expect(r.ops.srcEnable(1, 'maybe' as unknown as 'on')).rejects.toThrow(/Unknown stream enable mode/)
		expect(r.ctl.commands).toEqual([])
	})
})

describe('absent gain attribute', () => {
	it('src gain adjust treats a missing INGN as 0 dB', async () => {
		vi.useFakeTimers()
		try {
			const r = rig()
			delete r.state.src.get(1)!.INGN
			const p = r.ops.srcGainAdjust(1, 5)
			await vi.advanceTimersByTimeAsync(100)
			await p
			expect(r.ctl.commands).toEqual(['SRC 1 INGN:5'])
		} finally {
			vi.useRealTimers()
		}
	})
})
