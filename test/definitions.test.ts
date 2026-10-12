import { describe, expect, it, vi } from 'vitest'
import { CheckFeedbacksForChanges, UpdateFeedbacks } from '../src/feedbacks.js'
import { UpdateActions } from '../src/actions.js'
import type ModuleInstance from '../src/main.js'
import type { LivewireDirectory } from '../src/model/directory.js'
import { apply, loadedState, type FixtureName } from './fixtures/load.js'
import { networkDirectory } from './helpers/directory.js'

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
	'src_in_use',
	'level_state',
	'mixer_factory_mode',
	'xpoint_budget',
	'gpi_active',
	'gpo_active',
	'mic_phantom',
]

type Any = any

function fakeSelf(fixture: FixtureName | null, levelsReady = true, directory?: LivewireDirectory) {
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
		directory,
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
			const f = fakeSelf('legacy-analog4x4-a')
			UpdateActions(asSelf(f.self))
			await expect(f.self.actions.mix_set.callback({ options: { ...pick, in_pair: 25, gain: 0 } })).rejects.toThrow(
				/does not exist/,
			)
			expect(f.ops.mixSet).not.toHaveBeenCalled()
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
		it('a refused operation is logged and rethrown so Companion reports the failure', async () => {
			const f = fakeSelf('legacy-analog4x4-a')
			f.ops.mixSet.mockRejectedValueOnce(new Error('nope'))
			UpdateActions(asSelf(f.self))
			await expect(f.self.actions.mix_set.callback({ options: { ...pick, gain: 0 } })).rejects.toThrow('nope')
			expect(f.self.log).toHaveBeenCalledWith('warn', 'mix_set: nope')
		})
		it('snapshot store failure is logged and rethrown', async () => {
			const f = fakeSelf('legacy-analog4x4-a')
			f.ops.mixSnapshotStore.mockRejectedValueOnce(new Error('nope'))
			UpdateActions(asSelf(f.self))
			await expect(f.self.actions.mix_snapshot_store.callback({ options: {} })).rejects.toThrow('nope')
			expect(f.self.log).toHaveBeenCalledWith('warn', 'mix_snapshot_store: nope')
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
			new Set(['mix_xpoint_active', 'mix_output_exclusive', 'xpoint_budget', 'src_enabled', 'src_in_use']),
		)
	})
})

describe('source discovery in the definitions', () => {
	const option = (def: Any, id: string): Any => def.options.find((o: Any) => o.id === id)
	const ids = (choices: Any[]): string[] => choices.map((c) => c.id)

	describe('dst_connect_channel', () => {
		it('offers the known sources, then the discovered ones, then the custom entry', () => {
			const { self } = fakeSelf('legacy-analog4x4-a', true, networkDirectory())
			UpdateActions(asSelf(self))
			const choices = option(self.actions.dst_connect_channel, 'source').choices
			expect(choices).toHaveLength(2 + 25 + 1) // known (two entries, one address), 26 discovered minus 1 listed
			expect(ids(choices).slice(0, 2)).toEqual(['239.192.87.29', '239.192.87.29'])
			expect(choices[2]).toEqual({ id: '239.192.0.141', label: '141 · Program 1 (Engine402F59)' })
			expect(choices.at(-1)).toEqual({ id: 'custom', label: 'Custom channel number' })
			expect(self.actions.dst_connect_channel.description).toMatch(/known or discovered source/)
		})

		it('keeps its definition stable: the default does not depend on what was discovered', () => {
			const without = fakeSelf('legacy-analog4x4-a')
			const withDiscovery = fakeSelf('legacy-analog4x4-a', true, networkDirectory())
			UpdateActions(asSelf(without.self))
			UpdateActions(asSelf(withDiscovery.self))
			expect(option(withDiscovery.self.actions.dst_connect_channel, 'source').default).toBe(
				option(without.self.actions.dst_connect_channel, 'source').default,
			)

			// no known source at all: the default is still the custom entry, whatever is on the network
			for (const f of [without, withDiscovery]) {
				f.self.config.knownSources = ''
				UpdateActions(asSelf(f.self))
				expect(option(f.self.actions.dst_connect_channel, 'source').default).toBe('custom')
			}
		})

		it('every dropdown default is one of its choices, with discovery too', () => {
			const { self } = fakeSelf('legacy-analog4x4-a', true, networkDirectory())
			self.config.knownSources = ''
			UpdateActions(asSelf(self))
			for (const def of Object.values<Any>(self.actions)) {
				for (const o of def.options) {
					if (o.type === 'dropdown' && o.choices.length > 0) expect(ids(o.choices)).toContain(o.default)
				}
			}
		})

		it('connects to a discovered source by its address', async () => {
			const { self, ops } = fakeSelf('legacy-analog4x4-a', true, networkDirectory())
			UpdateActions(asSelf(self))
			await self.actions.dst_connect_channel.callback({ options: { dst: 2, source: '239.192.87.129' } })
			expect(ops.dstConnectAddress).toHaveBeenCalledWith(2, '239.192.87.129')
		})

		it('follows the directory when the definitions are built again', () => {
			const directory = networkDirectory(['full-xnode-224'])
			const { self } = fakeSelf('legacy-analog4x4-a', true, directory)
			UpdateActions(asSelf(self))
			expect(option(self.actions.dst_connect_channel, 'source').choices).toHaveLength(2 + 8 + 1)
			directory.clear()
			UpdateActions(asSelf(self))
			expect(option(self.actions.dst_connect_channel, 'source').choices).toHaveLength(2 + 1)
		})
	})

	describe('dst_connected_to', () => {
		it('lists the known and the discovered sources in the "known" target', () => {
			const { self } = fakeSelf('legacy-analog4x4-a', true, networkDirectory())
			UpdateFeedbacks(asSelf(self))
			const def = self.feedbacks.dst_connected_to
			expect(option(def, 'target').choices[0]).toEqual({ id: 'known', label: 'Known or discovered source' })
			const known = option(def, 'known')
			expect(known.label).toBe('Known or discovered source')
			expect(known.choices).toHaveLength(2 + 25)
			expect(known.choices[2]).toEqual({ id: '239.192.0.141', label: '141 · Program 1 (Engine402F59)' })
		})

		it('keeps its defaults independent of discovery', () => {
			const defaults = (directory?: LivewireDirectory, known = '22301=Studio Mic 1'): [unknown, unknown] => {
				const { self } = fakeSelf('legacy-analog4x4-a', true, directory)
				self.config.knownSources = known
				UpdateFeedbacks(asSelf(self))
				const def = self.feedbacks.dst_connected_to
				return [option(def, 'target').default, option(def, 'known').default]
			}
			expect(defaults(undefined)).toEqual(['known', '239.192.87.29'])
			expect(defaults(networkDirectory())).toEqual(['known', '239.192.87.29'])
			expect(defaults(undefined, '')).toEqual(['channel', ''])
			expect(defaults(networkDirectory(), '')).toEqual(['channel', ''])
		})

		it('evaluates a discovered address like any other', () => {
			const { self, state } = fakeSelf('legacy-analog4x4-a', true, networkDirectory())
			apply(state, 'DST 3 ADDR:"239.192.87.129"')
			UpdateFeedbacks(asSelf(self))
			const fb = (options: Record<string, unknown>): boolean => self.feedbacks.dst_connected_to.callback({ options })
			expect(fb({ dst: 3, target: 'known', known: '239.192.87.129' })).toBe(true)
			expect(fb({ dst: 2, target: 'known', known: '239.192.87.129' })).toBe(false)
		})
	})

	describe('src_in_use', () => {
		it('is a boolean feedback on a SRC and an optional engine IP, amber by default', () => {
			const { self } = fakeSelf('legacy-analog4x4-a')
			UpdateFeedbacks(asSelf(self))
			const def = self.feedbacks.src_in_use
			expect(def).toMatchObject({ type: 'boolean', name: 'Source: in use by a console' })
			expect(def.options.map((o: Any) => o.id)).toEqual(['src', 'engine'])
			expect(option(def, 'src').choices).toHaveLength(8)
			expect(option(def, 'engine')).toMatchObject({
				type: 'textinput',
				default: '',
				label: 'Console engine IP (empty = any)',
			})
			expect(def.defaultStyle.bgcolor).toBe(self.feedbacks.mixer_factory_mode.defaultStyle.bgcolor)
			expect(def.description).toMatch(/console engine owns this SRC/)
		})

		it('is true while a console engine uses the SRC channel', () => {
			const { self } = fakeSelf('legacy-analog4x4-a', true, networkDirectory())
			UpdateFeedbacks(asSelf(self))
			const fb = (options: Record<string, unknown>): boolean => self.feedbacks.src_in_use.callback({ options })
			expect(fb({ src: 1, engine: '' })).toBe(true)
			expect(fb({ src: 1, engine: '10.96.30.235' })).toBe(true)
			expect(fb({ src: 1, engine: '10.96.30.236' })).toBe(false)
			expect(fb({ src: 2, engine: '' })).toBe(false)
			expect(fb({ src: 1 })).toBe(true) // the engine option may be missing in a saved button
		})

		it('is false when discovery is off', () => {
			const { self } = fakeSelf('legacy-analog4x4-a')
			UpdateFeedbacks(asSelf(self))
			expect(self.feedbacks.src_in_use.callback({ options: { src: 1, engine: '' } })).toBe(false)
		})

		it('reads the directory when it is evaluated, not when it is defined', () => {
			const directory = networkDirectory()
			const { self } = fakeSelf('legacy-analog4x4-a', true, directory)
			UpdateFeedbacks(asSelf(self))
			const fb = (): boolean => self.feedbacks.src_in_use.callback({ options: { src: 1, engine: '' } })
			expect(fb()).toBe(true)
			directory.clear()
			expect(fb()).toBe(false)
		})

		it('is re-checked when a SRC changes (its address may move)', () => {
			const { self } = fakeSelf('legacy-analog4x4-a')
			CheckFeedbacksForChanges(asSelf(self), [{ kind: 'src', index: 1, rebuild: false }])
			expect(self.checkFeedbacks.mock.calls[0]).toContain('src_in_use')
		})
	})
})
