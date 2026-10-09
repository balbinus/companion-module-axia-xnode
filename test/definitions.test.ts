import { describe, expect, it, vi } from 'vitest'
import { CheckFeedbacksForChanges, UpdateFeedbacks } from '../src/feedbacks.js'
import { UpdateActions } from '../src/actions.js'
import type ModuleInstance from '../src/main.js'
import { apply, loadedState, type FixtureName } from './fixtures/load.js'

const ACTION_IDS = [
	'mix_set',
	'mix_clear',
	'mix_toggle',
	'mix_adjust',
	'mix_exclusive',
	'mix_clear_output',
	'mix_snapshot_store',
	'mix_snapshot_recall',
	'gpo_set',
	'gpo_pulse',
	'gpo_toggle',
	'mic_gain_set',
	'mic_gain_adjust',
	'dst_connect_channel',
	'dst_connect_address',
	'dst_disconnect',
	'dst_gain_set',
	'dst_gain_adjust',
	'src_gain_set',
	'src_gain_adjust',
	'src_enable',
	'src_address',
	'src_mode',
	'src_rename',
]
const FEEDBACK_IDS = [
	'mix_xpoint_active',
	'mix_output_exclusive',
	'dst_connected_to',
	'dst_connected',
	'src_enabled',
	'level_state',
	'mixer_factory_mode',
	'xpoint_budget',
	'gpi_active',
	'gpo_active',
	'mic_phantom',
]

type Any = any

function fakeSelf(fixture: FixtureName | null, levelsReady = true) {
	const state = loadedState(fixture ?? 'legacy-analog4x4-a')
	if (fixture === null) state.reset()
	const ops = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
		get(target, prop: string) {
			return (target[prop] ??= vi.fn(async () => (prop === 'mixSnapshotStore' ? '{"v":1}' : undefined)))
		},
	})
	const self = {
		controller: { state, levelsReady },
		config: { knownSources: '22301=Studio Mic 1\n239.192.87.29=Other' },
		ops,
		log: vi.fn(),
		actions: {} as Any,
		feedbacks: {} as Any,
		setActionDefinitions(d: unknown) {
			self.actions = d
		},
		setFeedbackDefinitions(d: unknown) {
			self.feedbacks = d
		},
		checkFeedbacks: vi.fn(),
	}
	return { self, state, ops }
}

const asSelf = (s: unknown): ModuleInstance => s as ModuleInstance

describe('action definitions', () => {
	it('follow the naming contract on a full xNode2', () => {
		const { self } = fakeSelf('xnode2-combo')
		UpdateActions(asSelf(self))
		expect(Object.keys(self.actions).sort()).toEqual([...ACTION_IDS].sort())
	})

	it('legacy analog node: no GPO and no mic actions', () => {
		const { self } = fakeSelf('legacy-analog4x4-a')
		UpdateActions(asSelf(self))
		const ids = Object.keys(self.actions)
		expect(ids).toEqual(expect.arrayContaining(['mix_set', 'dst_connect_channel', 'src_rename']))
		expect(ids.some((i) => i.startsWith('gpo_') || i.startsWith('mic_'))).toBe(false)
	})

	it('before the first sync everything is defined', () => {
		const { self } = fakeSelf(null)
		UpdateActions(asSelf(self))
		expect(Object.keys(self.actions).sort()).toEqual([...ACTION_IDS].sort())
	})

	it('a node without mixer has no mix actions', () => {
		const { self, state } = fakeSelf(null)
		apply(state, 'VER LWRP:1.2 DEVN:"axiaxnode.analog4x4" NSRC:2 NDST:2 NGPI:0 NGPO:0')
		UpdateActions(asSelf(self))
		expect(Object.keys(self.actions).some((i) => i.startsWith('mix_'))).toBe(false)
	})

	it('hasResult only on the snapshot store', () => {
		const { self } = fakeSelf('xnode2-combo')
		UpdateActions(asSelf(self))
		for (const [id, def] of Object.entries<Any>(self.actions)) {
			expect(Boolean(def.hasResult)).toBe(id === 'mix_snapshot_store')
		}
	})

	it('every option id is unique per action and dropdown defaults are valid choices', () => {
		const { self } = fakeSelf('xnode2-combo')
		UpdateActions(asSelf(self))
		for (const def of Object.values<Any>(self.actions)) {
			const ids = def.options.map((o: Any) => o.id)
			expect(new Set(ids).size).toBe(ids.length)
			for (const o of def.options) {
				if (o.type === 'dropdown' && o.choices.length > 0) {
					expect(o.choices.map((c: Any) => c.id)).toContain(o.default)
				}
			}
		}
	})

	describe('callbacks route to the operations, gains converted to tenths', () => {
		const run = async (
			fixture: FixtureName,
			id: string,
			options: Record<string, unknown>,
		): Promise<ReturnType<typeof fakeSelf>> => {
			const f = fakeSelf(fixture)
			UpdateActions(asSelf(f.self))
			await f.self.actions[id].callback({ options })
			return f
		}
		const pick = { mode: 'stereo', out_pair: 9, in_pair: 3, out_ch: 1, in_ch: 1 }

		it('mix_set (stereo pair expands to L-L and R-R)', async () => {
			const { ops } = await run('legacy-analog4x4-a', 'mix_set', { ...pick, gain: -6 })
			expect(ops.mixSet).toHaveBeenCalledWith(
				[
					[9, 3],
					[10, 4],
				],
				-60,
			)
		})
		it('mix_set mono', async () => {
			const { ops } = await run('legacy-analog4x4-a', 'mix_set', {
				...pick,
				mode: 'mono',
				out_ch: 9,
				in_ch: 3,
				gain: 0.25,
			})
			expect(ops.mixSet).toHaveBeenCalledWith([[9, 3]], 3) // 0.25 dB rounds to whole tenths
		})
		it('mix_clear, mix_toggle, mix_adjust, mix_exclusive', async () => {
			expect((await run('legacy-analog4x4-a', 'mix_clear', pick)).ops.mixClear).toHaveBeenCalledWith([
				[9, 3],
				[10, 4],
			])
			expect((await run('legacy-analog4x4-a', 'mix_toggle', { ...pick, gain: -3 })).ops.mixToggle).toHaveBeenCalledWith(
				expect.any(Array),
				-30,
			)
			expect(
				(await run('legacy-analog4x4-a', 'mix_adjust', { ...pick, step: -1.5 })).ops.mixAdjust,
			).toHaveBeenCalledWith(expect.any(Array), -15)
			expect(
				(await run('legacy-analog4x4-a', 'mix_exclusive', { ...pick, gain: 0 })).ops.mixExclusive,
			).toHaveBeenCalledWith(expect.any(Array), 0)
		})
		it('an input pair that does not exist is refused without calling ops', async () => {
			const f = await run('legacy-analog4x4-a', 'mix_set', { ...pick, in_pair: 25, gain: 0 })
			expect(f.ops.mixSet).not.toHaveBeenCalled()
			expect(f.self.log).toHaveBeenCalledWith('warn', expect.stringContaining('does not exist'))
		})
		it('mix_clear_output expands a stereo pair to both rows', async () => {
			const { ops } = await run('legacy-analog4x4-a', 'mix_clear_output', { mode: 'stereo', out_pair: 1, out_ch: 1 })
			expect(ops.mixClearOutput).toHaveBeenCalledWith([1, 2])
		})
		it('mix_snapshot_store returns the snapshot, mix_snapshot_recall passes the text', async () => {
			const f = fakeSelf('legacy-analog4x4-a')
			UpdateActions(asSelf(f.self))
			expect(await f.self.actions.mix_snapshot_store.callback({ options: {} })).toBe('{"v":1}')
			await f.self.actions.mix_snapshot_recall.callback({ options: { snapshot: '{"a":1}' } })
			expect(f.ops.mixSnapshotRecall).toHaveBeenCalledWith('{"a":1}')
		})
		it('a refused operation is logged, not thrown', async () => {
			const f = fakeSelf('legacy-analog4x4-a')
			f.ops.mixSet.mockRejectedValueOnce(new Error('nope'))
			UpdateActions(asSelf(f.self))
			await expect(f.self.actions.mix_set.callback({ options: { ...pick, gain: 0 } })).resolves.toBeUndefined()
			expect(f.self.log).toHaveBeenCalledWith('warn', 'mix_set: nope')
		})
		it('snapshot store failure returns an empty string', async () => {
			const f = fakeSelf('legacy-analog4x4-a')
			f.ops.mixSnapshotStore.mockRejectedValueOnce(new Error('nope'))
			UpdateActions(asSelf(f.self))
			expect(await f.self.actions.mix_snapshot_store.callback({ options: {} })).toBe('')
		})
		it('GPO actions', async () => {
			const set = await run('xnode2-combo', 'gpo_set', { port: 1, pins: [1, 2], active: 'active' })
			expect(set.ops.gpoSet).toHaveBeenCalledWith(1, [1, 2], true)
			const off = await run('xnode2-combo', 'gpo_set', { port: 2, pins: [3], active: 'inactive' })
			expect(off.ops.gpoSet).toHaveBeenCalledWith(2, [3], false)
			const pulse = await run('xnode2-combo', 'gpo_pulse', { port: 1, pins: [1], ms: 250.4, level: 'active' })
			expect(pulse.ops.gpoPulse).toHaveBeenCalledWith(1, [1], 250, true)
			const toggle = await run('xnode2-combo', 'gpo_toggle', { port: 1, pins: [5] })
			expect(toggle.ops.gpoToggle).toHaveBeenCalledWith(1, [5])
		})
		it('pins are filtered to integers', async () => {
			const { ops } = await run('xnode2-combo', 'gpo_set', { port: 1, pins: ['2', 'x', 1.5, 3], active: 'active' })
			expect(ops.gpoSet).toHaveBeenCalledWith(1, [2, 3], true)
		})
		it('mic gain', async () => {
			expect((await run('xnode2-combo', 'mic_gain_set', { inp: 5, gain: 35 })).ops.micGainSet).toHaveBeenCalledWith(
				5,
				350,
			)
			expect(
				(await run('xnode2-combo', 'mic_gain_adjust', { inp: 5, step: -1 })).ops.micGainAdjust,
			).toHaveBeenCalledWith(5, -10)
		})
		it('DST actions', async () => {
			expect(
				(
					await run('legacy-analog4x4-a', 'dst_connect_channel', {
						dst: 1,
						source: 'custom',
						channel: 22302,
						kind: 'to',
					})
				).ops.dstConnectChannel,
			).toHaveBeenCalledWith(1, 22302, 'to')
			expect(
				(
					await run('legacy-analog4x4-a', 'dst_connect_channel', {
						dst: 1,
						source: 'custom',
						channel: 5,
						kind: 'bogus',
					})
				).ops.dstConnectChannel,
			).toHaveBeenCalledWith(1, 5, 'from')
			expect(
				(await run('legacy-analog4x4-a', 'dst_connect_channel', { dst: 2, source: '239.192.87.29' })).ops
					.dstConnectAddress,
			).toHaveBeenCalledWith(2, '239.192.87.29')
			expect(
				(await run('legacy-analog4x4-a', 'dst_connect_address', { dst: 3, address: '239.1.1.1' })).ops
					.dstConnectAddress,
			).toHaveBeenCalledWith(3, '239.1.1.1')
			expect((await run('legacy-analog4x4-a', 'dst_disconnect', { dst: 4 })).ops.dstDisconnect).toHaveBeenCalledWith(4)
			expect(
				(await run('legacy-analog4x4-a', 'dst_gain_set', { dst: 4, gain: -3 })).ops.dstGainSet,
			).toHaveBeenCalledWith(4, -30)
			expect(
				(await run('legacy-analog4x4-a', 'dst_gain_adjust', { dst: 4, step: 2 })).ops.dstGainAdjust,
			).toHaveBeenCalledWith(4, 20)
		})
		it('SRC actions', async () => {
			const a = 'legacy-analog4x4-a'
			expect((await run(a, 'src_gain_set', { src: 1, gain: 3 })).ops.srcGainSet).toHaveBeenCalledWith(1, 30)
			expect((await run(a, 'src_gain_adjust', { src: 1, step: -1 })).ops.srcGainAdjust).toHaveBeenCalledWith(1, -10)
			expect((await run(a, 'src_enable', { src: 2, mode: 'toggle' })).ops.srcEnable).toHaveBeenCalledWith(2, 'toggle')
			expect((await run(a, 'src_enable', { src: 2, mode: 'weird' })).ops.srcEnable).toHaveBeenCalledWith(2, 'on')
			expect((await run(a, 'src_address', { src: 2, address: '22301' })).ops.srcSetAddress).toHaveBeenCalledWith(
				2,
				'22301',
			)
			expect((await run(a, 'src_mode', { src: 2, mode: 240 })).ops.srcSetMode).toHaveBeenCalledWith(2, 240)
			expect((await run(a, 'src_rename', { src: 2, name: 'Hello' })).ops.srcRename).toHaveBeenCalledWith(2, 'Hello')
		})
	})
})

describe('feedback definitions', () => {
	it('follow the naming contract', () => {
		const { self } = fakeSelf('xnode2-combo')
		UpdateFeedbacks(asSelf(self))
		expect(Object.keys(self.feedbacks).sort()).toEqual([...FEEDBACK_IDS].sort())
		for (const def of Object.values<Any>(self.feedbacks)) expect(def.type).toBe('boolean')
	})

	it('level_state offers hardware groups on xNode2 only', () => {
		const groups = (fx: FixtureName): string[] => {
			const { self } = fakeSelf(fx)
			UpdateFeedbacks(asSelf(self))
			return self.feedbacks.level_state.options.find((o: Any) => o.id === 'group').choices.map((c: Any) => c.id)
		}
		expect(groups('legacy-analog4x4-a')).toEqual(['ICH', 'OCH'])
		expect(groups('xnode2-combo')).toEqual(['ICH', 'OCH', 'HWI', 'HWO'])
	})

	it('callbacks evaluate against the live state', () => {
		const { self, state } = fakeSelf('legacy-analog4x4-a')
		UpdateFeedbacks(asSelf(self))
		const fb = (id: string, options: Record<string, unknown>): boolean => self.feedbacks[id].callback({ options })
		const pick = { mode: 'stereo', out_pair: 1, in_pair: 17, out_ch: 1, in_ch: 17 }
		expect(fb('mix_xpoint_active', { ...pick, condition: 'any', gain: 0 })).toBe(true)
		expect(fb('mix_xpoint_active', { ...pick, condition: 'eq', gain: -6 })).toBe(false)
		expect(fb('mix_output_exclusive', pick)).toBe(true)
		expect(fb('mix_xpoint_active', { ...pick, in_pair: 99, condition: 'any' })).toBe(false)
		apply(state, 'MIX 1 17:-')
		expect(fb('mix_xpoint_active', { ...pick, condition: 'any', gain: 0 })).toBe(false)

		expect(fb('dst_connected', { dst: 1 })).toBe(true)
		expect(fb('dst_connected_to', { dst: 1, target: 'channel', channel: 22301, kind: 'to' })).toBe(true)
		expect(fb('dst_connected_to', { dst: 1, target: 'address', address: '239.193.87.29' })).toBe(true)
		expect(fb('dst_connected_to', { dst: 1, target: 'known', known: '239.193.87.29' })).toBe(true)
		expect(fb('dst_connected_to', { dst: 1, target: 'channel', channel: 22301, kind: 'from' })).toBe(false)
		expect(fb('src_enabled', { src: 1 })).toBe(true)
		expect(fb('mixer_factory_mode', {})).toBe(false)
		expect(fb('xpoint_budget', { threshold: 16 })).toBe(true)
		expect(fb('xpoint_budget', { threshold: 17 })).toBe(false) // 16 left after the clear above
		apply(state, 'MIXCFG MODE:2')
		expect(fb('mixer_factory_mode', {})).toBe(true)
	})

	it('level_state picks the index of the chosen group and uses levelsReady', () => {
		const f = fakeSelf('xnode2-combo', false)
		apply(f.state, 'LVL ICH 2.L CLIP')
		apply(f.state, 'LVL HWI 5.1 LOW')
		UpdateFeedbacks(asSelf(f.self))
		const fb = (options: Record<string, unknown>): boolean => f.self.feedbacks.level_state.callback({ options })
		const base = { src: 2, dst: 1, hwi: 5, hwo: 1, side: 'either' }
		expect(fb({ ...base, group: 'ICH', condition: 'clip' })).toBe(false) // not ready
		f.self.controller.levelsReady = true
		expect(fb({ ...base, group: 'ICH', condition: 'clip' })).toBe(true)
		expect(fb({ ...base, group: 'ICH', src: 1, condition: 'clip' })).toBe(false)
		expect(fb({ ...base, group: 'HWI', condition: 'silence' })).toBe(true)
		expect(fb({ ...base, group: 'OCH', condition: 'silence' })).toBe(false)
	})

	it('gpio and phantom callbacks', () => {
		const { self, state } = fakeSelf('xnode2-combo')
		apply(state, 'GPO 2 hhlhh')
		apply(state, 'GPI 1 lhhhh')
		apply(state, 'INP 5 PHPW:1')
		UpdateFeedbacks(asSelf(self))
		const fb = (id: string, options: Record<string, unknown>): boolean => self.feedbacks[id].callback({ options })
		expect(fb('gpo_active', { port: 2, pin: 3 })).toBe(true)
		expect(fb('gpo_active', { port: 2, pin: 1 })).toBe(false)
		expect(fb('gpi_active', { port: 1, pin: 1 })).toBe(true)
		expect(fb('mic_phantom', { input: 5 })).toBe(true)
		expect(fb('mic_phantom', { input: 1 })).toBe(false)
	})

	it('CheckFeedbacksForChanges only re-checks the affected feedbacks', () => {
		const { self } = fakeSelf('xnode2-combo')
		CheckFeedbacksForChanges(asSelf(self), [{ kind: 'gpo', index: 1, rebuild: false }])
		expect(self.checkFeedbacks).toHaveBeenCalledWith('gpo_active')
		self.checkFeedbacks.mockClear()
		CheckFeedbacksForChanges(asSelf(self), [{ kind: 'mtr', index: 1, rebuild: false }])
		expect(self.checkFeedbacks).not.toHaveBeenCalled()
		CheckFeedbacksForChanges(asSelf(self), [
			{ kind: 'mix', index: 1, rebuild: false },
			{ kind: 'src', index: 1, rebuild: false },
		])
		expect(new Set(self.checkFeedbacks.mock.calls[0])).toEqual(
			new Set(['mix_xpoint_active', 'mix_output_exclusive', 'xpoint_budget', 'src_enabled']),
		)
	})
})
