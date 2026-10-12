import { describe, expect, it } from 'vitest'
import {
	computeVariableDefinitions,
	computeVariableValues,
	evaluateDstConnected,
	evaluateDstConnectedTo,
	evaluateFactoryMode,
	evaluateGpioActive,
	evaluateLevelState,
	evaluateOutputExclusive,
	evaluatePhantom,
	evaluateSrcEnabled,
	evaluateXpointActive,
	evaluateXpointBudget,
	feedbackIdsForChanges,
	ALL_FEEDBACK_IDS,
	inpTypeLabel,
	mixOutputSummary,
	signalState,
	srcModeLabel,
	type DerivedConfig,
} from '../../src/model/derived.js'
import type { XNodeState } from '../../src/model/state.js'
import { apply, loadedState } from '../fixtures/load.js'

const cfg = (over: Partial<DerivedConfig> = {}): DerivedConfig => ({
	meterMode: 'off',
	exposeXpointVariables: false,
	levelAlerts: true,
	...over,
})

const legacyA = (): XNodeState => loadedState('legacy-analog4x4-a')
const legacyB = (): XNodeState => loadedState('legacy-analog4x4-b')
const combo = (): XNodeState => loadedState('xnode2-combo')

const ids = (s: XNodeState, c: DerivedConfig): string[] => Object.keys(computeVariableDefinitions(s, c))
const vals = (s: XNodeState, c: DerivedConfig = cfg(), ready = true): Record<string, string | number> =>
	computeVariableValues(s, c, ready)

describe('variable definitions', () => {
	it('device variables exist on every model', () => {
		for (const s of [legacyA(), combo()]) {
			const d = ids(s, cfg())
			for (const id of ['model', 'devn', 'product', 'firmware', 'lwrp_version', 'hostname', 'ip', 'link']) {
				expect(d).toContain(id)
			}
			expect(d).toContain('mixer_mode')
			expect(d).toContain('xpoints_used')
		}
	})

	it('node_id and SET snapshot variables exist on legacy only', () => {
		expect(ids(legacyA(), cfg())).toEqual(expect.arrayContaining(['node_id', 'set_nid', 'set_adip']))
		const d = ids(combo(), cfg())
		for (const id of ['node_id', 'set_nid', 'set_lwclk_prio', 'set_ptp_dom', 'set_enable_sap', 'set_adip']) {
			expect(d).not.toContain(id)
		}
	})

	it('defines per SRC / DST variables for the counts in VER', () => {
		const d = ids(legacyA(), cfg())
		for (const n of [1, 8]) {
			for (const k of ['name', 'enabled', 'address', 'channel', 'used_by', 'mode', 'gain', 'signal']) {
				expect(d).toContain(`src_${n}_${k}`)
			}
			for (const k of ['name', 'address', 'channel', 'source_label', 'source_name', 'gain', 'signal']) {
				expect(d).toContain(`dst_${n}_${k}`)
			}
		}
		expect(d).not.toContain('src_9_name')
		expect(d).not.toContain('dst_9_name')
	})

	it('has no HWI/HWO variables on legacy nodes by default, nor INP, GPI, GPO', () => {
		for (const s of [legacyA(), legacyB()]) {
			const d = ids(s, cfg())
			expect(d.filter((i) => /^(hwi|hwo|inp|gpi|gpo)_/.test(i))).toEqual([])
			// even with polled meters: no HWI/HWO over TCP on legacy
			expect(ids(s, cfg({ meterMode: 'poll' })).filter((i) => /^(hwi|hwo)_/.test(i))).toEqual([])
		}
	})

	it('legacy HWI/HWO peaks only appear with the HTTP meter stream, and never as signal variables', () => {
		const d = ids(legacyA(), cfg({ meterMode: 'http' }))
		expect(d).toContain('hwi_1_peak_l')
		expect(d).toContain('hwi_1_peak_r')
		expect(d).toContain('hwo_4_peak_r')
		expect(d.filter((i) => /^hw[io]_\d+_signal$/.test(i))).toEqual([])
	})

	it('INP variables exist on xNode2 only; gain and phantom only for MIC inputs', () => {
		expect(ids(legacyA(), cfg()).some((i) => i.startsWith('inp_'))).toBe(false)
		const d = ids(combo(), cfg())
		for (let n = 1; n <= 5; n++) {
			expect(d).toContain(`inp_${n}_name`)
			expect(d).toContain(`inp_${n}_type`)
		}
		expect(d).toContain('inp_5_gain')
		expect(d).toContain('inp_5_phantom')
		for (let n = 1; n <= 4; n++) {
			expect(d).not.toContain(`inp_${n}_gain`)
			expect(d).not.toContain(`inp_${n}_phantom`)
		}
		expect(d).not.toContain('inp_6_name')
	})

	it('xNode2 has HWI/HWO signal variables (levelAlerts) and GPIO variables', () => {
		const d = ids(combo(), cfg())
		expect(d).toEqual(expect.arrayContaining(['hwi_1_signal', 'hwi_5_signal', 'hwo_1_signal', 'hwo_4_signal']))
		expect(d.filter((i) => /_peak_/.test(i))).toEqual([])
		expect(d).toEqual(expect.arrayContaining(['gpi_1', 'gpi_2', 'gpo_1', 'gpo_2', 'gpo_1_name', 'gpo_2_name']))
		expect(d).not.toContain('gpi_3')
		expect(d).not.toContain('gpo_3')
	})

	it('signal variables follow levelAlerts', () => {
		const d = ids(combo(), cfg({ levelAlerts: false }))
		expect(d.filter((i) => i.endsWith('_signal'))).toEqual([])
	})

	it('meter variables only when meters are enabled', () => {
		expect(ids(legacyA(), cfg()).filter((i) => i.includes('_peak_'))).toEqual([])
		const d = ids(legacyA(), cfg({ meterMode: 'poll' }))
		expect(d).toEqual(expect.arrayContaining(['src_1_peak_l', 'src_1_peak_r', 'dst_8_peak_l', 'dst_8_peak_r']))
		const x = ids(combo(), cfg({ meterMode: 'poll' }))
		expect(x).toEqual(expect.arrayContaining(['hwi_1_peak_l', 'hwi_1_peak_r', 'hwo_1_peak_l', 'hwo_1_peak_r']))
	})

	it('a mono physical input has only a left peak variable', () => {
		const d = ids(combo(), cfg({ meterMode: 'poll' }))
		expect(d).toContain('hwi_5_peak_l')
		expect(d).not.toContain('hwi_5_peak_r')
	})

	it('mix_out_K_inputs for every mixer output', () => {
		const d = ids(legacyA(), cfg())
		for (let k = 1; k <= 24; k++) expect(d).toContain(`mix_out_${k}_inputs`)
		expect(d).not.toContain('mix_out_25_inputs')
	})

	it('xp_O_I only when exposed and only for the I/O map', () => {
		expect(ids(legacyA(), cfg()).some((i) => i.startsWith('xp_'))).toBe(false)
		const a = ids(legacyA(), cfg({ exposeXpointVariables: true })).filter((i) => i.startsWith('xp_'))
		expect(a).toHaveLength(24 * 24)
		expect(a).toContain('xp_1_17')
		expect(a).toContain('xp_24_24')
		expect(a).not.toContain('xp_1_25')
		expect(a).not.toContain('xp_25_1')
		const c = ids(combo(), cfg({ exposeXpointVariables: true })).filter((i) => i.startsWith('xp_'))
		expect(c).toHaveLength(24 * 25)
		expect(c).toContain('xp_9_25')
		expect(c.some((i) => i.endsWith('_26'))).toBe(false)
	})

	it('a node without mixer has no mixer variables', () => {
		const s = loadedState('legacy-analog4x4-a')
		s.reset()
		apply(s, 'VER LWRP:1.2 DEVN:"axiaxnode.analog4x4" NSRC:2 NDST:2 NGPI:0 NGPO:0')
		const d = ids(s, cfg({ exposeXpointVariables: true }))
		expect(d.filter((i) => /^(mix_|xp_|mixer_mode|xpoints_used)/.test(i))).toEqual([])
		expect(d).toContain('src_2_name')
	})

	it('an empty (not yet synced) state defines only the device variables', () => {
		const s = loadedState('legacy-analog4x4-a')
		s.reset()
		expect(ids(s, cfg())).toEqual([
			'model',
			'devn',
			'product',
			'firmware',
			'lwrp_version',
			'hostname',
			'ip',
			'link',
			'node_id',
			'set_nid',
			'set_lwclk_prio',
			'set_ptp_dom',
			'set_enable_sap',
			'set_adip',
		])
	})
})

describe('every value has a definition (and the reverse)', () => {
	const configs: DerivedConfig[] = [
		cfg(),
		cfg({ meterMode: 'poll' }),
		cfg({ meterMode: 'http', exposeXpointVariables: true }),
		cfg({ levelAlerts: false, exposeXpointVariables: true }),
	]
	for (const [name, make] of [
		['legacy a', legacyA],
		['legacy b', legacyB],
		['xnode2', combo],
	] as const) {
		it(`${name}`, () => {
			for (const c of configs) {
				const s = make()
				const defs = Object.keys(computeVariableDefinitions(s, c)).sort()
				const values = Object.keys(computeVariableValues(s, c, true)).sort()
				expect(values).toEqual(defs)
			}
		})
	}
})

describe('variable values: device', () => {
	it('legacy', () => {
		const v = vals(legacyA())
		expect(v.model).toBe('Analog 4x4 I/O')
		expect(v.devn).toBe('axiaxnode.analog4x4')
		expect(v.product).toBe('Axia xNode')
		expect(v.firmware).toBe('2.4.7-1')
		expect(v.lwrp_version).toBe('1.2')
		expect(v.hostname).toBe('node-a-0')
		expect(v.ip).toBe('192.0.2.223')
		expect(v.link).toBe('up')
		expect(v.node_id).toBe('223/0')
		expect(v.set_nid).toBe('223/0')
		expect(v.mixer_mode).toBe('Custom')
		expect(v.xpoints_used).toBe(17)
	})

	it('link down, unknown link, factory mode', () => {
		const s = legacyA()
		apply(s, 'IP ADDR:"192.0.2.223" LINK:0')
		expect(vals(s).link).toBe('down')
		apply(s, 'MIXCFG MODE:3')
		expect(vals(s).mixer_mode).toBe('Factory (mode 3)')
		const empty = legacyA()
		empty.reset()
		expect(vals(empty).link).toBe('')
		expect(vals(empty).model).toBe('')
	})

	it('mixer_mode is empty until MIXCFG is known', () => {
		const s = legacyA()
		s.mixcfgMode = undefined
		expect(vals(s).mixer_mode).toBe('')
	})

	it('xNode2 has no node_id value', () => {
		const v = vals(combo())
		expect(v).not.toHaveProperty('node_id')
		expect(v.firmware).toBe('1.3.1')
		expect(v.lwrp_version).toBe('1.4.2')
	})
})

describe('variable values: SRC and DST', () => {
	it('SRC basics', () => {
		const v = vals(legacyB())
		expect(v.src_3_name).toBe('TEL 1')
		expect(v.src_3_enabled).toBe('on')
		expect(v.src_3_address).toBe('239.192.87.131')
		expect(v.src_3_channel).toBe(87 * 256 + 131)
		expect(v.src_3_mode).toBe('Live')
		expect(v.src_3_gain).toBe('0.0')
	})

	it('SRC enabled off, empty when unknown', () => {
		const v = vals(combo())
		expect(v.src_1_enabled).toBe('off')
		expect(v.src_1_mode).toBe('AES67')
		const s = legacyA()
		s.src.get(1)!.RTPE = '0'
		delete s.src.get(2)!.RTPE
		expect(vals(s).src_1_enabled).toBe('off')
		expect(vals(s).src_2_enabled).toBe('')
	})

	it('SRC mode labels', () => {
		expect(srcModeLabel('12')).toBe('Live')
		expect(srcModeLabel('240')).toBe('Standard')
		expect(srcModeLabel('48')).toBe('AES67')
		expect(srcModeLabel('99')).toBe('99')
		expect(srcModeLabel(undefined)).toBe('')
	})

	it('SRC with a non-Livewire address has no channel', () => {
		const s = legacyA()
		apply(s, 'SRC 1 RTPA:"239.10.0.1"')
		expect(vals(s).src_1_channel).toBe('')
		apply(s, 'SRC 2 RTPA:"239.196.0.9"') // surround range is still a channel
		expect(vals(s).src_2_channel).toBe(9)
	})

	it('gains are formatted with formatDb', () => {
		const s = legacyA()
		apply(s, 'SRC 1 INGN:35')
		apply(s, 'SRC 2 INGN:-60')
		apply(s, 'SRC 3 INGN:-1000')
		apply(s, 'DST 1 OUGN:240')
		const v = vals(s)
		expect(v.src_1_gain).toBe('+3.5')
		expect(v.src_2_gain).toBe('-6.0')
		expect(v.src_3_gain).toBe('-100.0')
		expect(v.dst_1_gain).toBe('+24.0')
		expect(v.dst_2_gain).toBe('0.0')
	})

	it('an absent gain attribute on an existing SRC/DST means 0 dB; garbage is empty', () => {
		const s = legacyA()
		delete s.src.get(1)!.INGN
		delete s.dst.get(1)!.OUGN
		s.src.get(2)!.INGN = 'abc'
		s.dst.get(2)!.OUGN = ''
		const v = vals(s)
		expect(v.src_1_gain).toBe('0.0')
		expect(v.dst_1_gain).toBe('0.0')
		expect(v.src_2_gain).toBe('')
		expect(v.dst_2_gain).toBe('')
	})

	it('DST source_label and channel for every address form', () => {
		const s = legacyA()
		const set = (addr: string): Record<string, string | number> => {
			apply(s, `DST 1 ADDR:"${addr}"`)
			return vals(s)
		}
		let v = set('')
		expect([v.dst_1_address, v.dst_1_channel, v.dst_1_source_label]).toEqual(['', '', ''])
		v = set('239.192.87.30')
		expect([v.dst_1_channel, v.dst_1_source_label]).toEqual([22302, 22302])
		v = set('22302')
		expect([v.dst_1_address, v.dst_1_channel, v.dst_1_source_label]).toEqual(['22302', 22302, 22302])
		v = set('239.193.87.29')
		expect([v.dst_1_channel, v.dst_1_source_label]).toEqual([22301, 22301])
		v = set('239.192.91.205 <Program 1@STD3>')
		expect([v.dst_1_channel, v.dst_1_source_label]).toEqual([23501, 'Program 1@STD3'])
		expect(v.dst_1_address).toBe('239.192.91.205 <Program 1@STD3>')
		v = set('239.192.91.205 Program 1')
		expect(v.dst_1_source_label).toBe('Program 1')
		v = set('10.1.2.3')
		expect([v.dst_1_channel, v.dst_1_source_label]).toEqual(['', '10.1.2.3'])
		v = set('garbage')
		expect([v.dst_1_channel, v.dst_1_source_label]).toEqual(['', ''])
	})

	it('DST fixture values', () => {
		const v = vals(legacyB())
		expect(v.dst_2_source_label).toBe('Program 3@STD3-Engine')
		expect(v.dst_2_channel).toBe(91 * 256 + 207)
		expect(v.dst_8_name).toBe('TEST AUDIO')
	})
})

describe('signalState', () => {
	const t = { updatedAt: 0 }
	it('is empty until levels are ready or when nothing is known', () => {
		expect(signalState({ L: { low: true, updatedAt: 0 } }, false)).toBe('')
		expect(signalState(undefined, true)).toBe('')
		expect(signalState({}, true)).toBe('')
	})
	it('clip wins over low, low needs all sides low, otherwise ok', () => {
		expect(signalState({ L: { clip: true, low: true, ...t }, R: { low: true, ...t } }, true)).toBe('clip')
		expect(signalState({ L: { clip: false, low: true, ...t }, R: { clip: true, low: false, ...t } }, true)).toBe('clip')
		expect(signalState({ L: { low: true, ...t }, R: { low: true, ...t } }, true)).toBe('low')
		expect(signalState({ L: { low: true, ...t }, R: { low: false, ...t } }, true)).toBe('ok')
		expect(signalState({ L: { low: false, clip: false, ...t }, R: { low: false, ...t } }, true)).toBe('ok')
		expect(signalState({ mono: { low: true, ...t } }, true)).toBe('low')
		expect(signalState({ mono: { clip: false, ...t } }, true)).toBe('ok')
	})
	it('is exposed as variables from LVL lines', () => {
		const s = legacyA()
		apply(s, 'LVL ICH 1.L LOW')
		apply(s, 'LVL ICH 1.R LOW')
		apply(s, 'LVL ICH 2.L CLIP')
		apply(s, 'LVL OCH 3.L NO-LOW')
		const v = vals(s)
		expect(v.src_1_signal).toBe('low')
		expect(v.src_2_signal).toBe('clip')
		expect(v.dst_3_signal).toBe('ok')
		expect(v.src_4_signal).toBe('')
		expect(vals(s, cfg(), false).src_1_signal).toBe('')
	})
	it('xNode2 hardware signal variables use the physical port numbers', () => {
		const s = combo()
		apply(s, 'LVL HWI 5.1 CLIP')
		apply(s, 'LVL HWO 2.L LOW')
		apply(s, 'LVL HWO 2.R LOW')
		const v = vals(s)
		expect(v.hwi_5_signal).toBe('clip')
		expect(v.hwo_2_signal).toBe('low')
		expect(v.hwi_1_signal).toBe('')
	})
})

describe('peaks', () => {
	it('are dBFS numbers, empty when unknown', () => {
		const s = legacyA()
		apply(s, 'MTR ICH 1 PEEK:-120:-135')
		apply(s, 'MTR OCH 2 PEEK:-1000:-1000')
		const v = vals(s, cfg({ meterMode: 'poll' }))
		expect(v.src_1_peak_l).toBe(-12)
		expect(v.src_1_peak_r).toBe(-13.5)
		expect(v.dst_2_peak_l).toBe(-100)
		expect(v.src_3_peak_l).toBe('')
		expect(v.src_3_peak_r).toBe('')
	})
	it('mono hardware inputs only have _l', () => {
		const s = combo()
		apply(s, 'MTR HWI 5 PEEK:-300')
		apply(s, 'MTR HWI 1 PEEK:-100:-110')
		const v = vals(s, cfg({ meterMode: 'poll' }))
		expect(v.hwi_5_peak_l).toBe(-30)
		expect(v).not.toHaveProperty('hwi_5_peak_r')
		expect(v.hwi_1_peak_r).toBe(-11)
	})
	it('are absent when meters are off', () => {
		const s = legacyA()
		apply(s, 'MTR ICH 1 PEEK:-120:-135')
		expect(Object.keys(vals(s)).some((k) => k.includes('_peak_'))).toBe(false)
	})
})

describe('mixer variables', () => {
	it('mix_out_K_inputs summarises with names and gains', () => {
		const s = legacyA()
		apply(s, 'MIX 1 17:0 3:-60')
		const v = vals(s)
		expect(v.mix_out_1_inputs).toBe('DST 2 L (-6.0) + Line 1 L (0.0)')
		expect(v.mix_out_9_inputs).toBe('')
		expect(mixOutputSummary(s, 1)).toBe(v.mix_out_1_inputs)
		expect(mixOutputSummary(s, 99)).toBe('')
	})
	it('uses user names and skips off crosspoints', () => {
		const s = legacyB()
		apply(s, 'MIX 5 1:-1000 15:35')
		expect(mixOutputSummary(s, 5)).toBe('DST 8 L · TEST AUDIO (+3.5)')
	})
	it('xp_O_I values: gain when on, empty when off', () => {
		const s = legacyA()
		apply(s, 'MIX 12 10:-100')
		const v = vals(s, cfg({ exposeXpointVariables: true }))
		expect(v.xp_1_17).toBe('0.0')
		expect(v.xp_12_10).toBe('-10.0')
		expect(v.xp_1_18).toBe('')
	})
	it('xpoints_used follows the state', () => {
		const s = legacyA()
		apply(s, 'MIX 9 1:0 2:0')
		expect(vals(s).xpoints_used).toBe(19)
	})
})

describe('inp, gpio variables', () => {
	it('xNode2 INP values', () => {
		const v = vals(combo())
		expect(v.inp_1_name).toBe('Analog 1')
		expect(v.inp_1_type).toBe('Analog')
		expect(v.inp_4_type).toBe('AES')
		expect(v.inp_5_type).toBe('Mic')
		expect(v.inp_5_gain).toBe('0.0')
		expect(v.inp_5_phantom).toBe('off')
		expect(inpTypeLabel(undefined)).toBe('')
		expect(inpTypeLabel('WEIRD')).toBe('WEIRD')
	})
	it('mic gain and phantom values', () => {
		const s = combo()
		apply(s, 'INP 5 GAIN:350 PHPW:1')
		const v = vals(s)
		expect(v.inp_5_gain).toBe('+35.0')
		expect(v.inp_5_phantom).toBe('on')
	})
	it('GPIO pins and names', () => {
		const s = combo()
		apply(s, 'GPO 2 hhlhh')
		apply(s, 'GPI 1 LHHHH')
		const v = vals(s)
		expect(v.gpo_1).toBe('hhhhh')
		expect(v.gpo_2).toBe('hhlhh')
		expect(v.gpi_1).toBe('lhhhh')
		expect(v.gpo_1_name).toBe('GPIO_1')
	})
})

// ------------------------------------------------------------------ feedbacks

describe('evaluateXpointActive', () => {
	it('single crosspoint on/off', () => {
		const s = legacyA()
		expect(evaluateXpointActive(s, [[1, 17]], 'any', 0)).toBe(true)
		expect(evaluateXpointActive(s, [[1, 18]], 'any', 0)).toBe(false)
		expect(evaluateXpointActive(s, [[9, 1]], 'any', 0)).toBe(false)
		expect(evaluateXpointActive(s, [], 'any', 0)).toBe(false)
	})
	it('a stereo pair needs both crosspoints', () => {
		const s = legacyA()
		expect(
			evaluateXpointActive(
				s,
				[
					[1, 17],
					[2, 18],
				],
				'any',
				0,
			),
		).toBe(true)
		apply(s, 'MIX 2 18:-')
		expect(
			evaluateXpointActive(
				s,
				[
					[1, 17],
					[2, 18],
				],
				'any',
				0,
			),
		).toBe(false)
		expect(evaluateXpointActive(s, [[1, 17]], 'any', 0)).toBe(true)
	})
	it('gte and eq conditions', () => {
		const s = legacyA() // MIX 12 10:-100 (-10 dB)
		expect(evaluateXpointActive(s, [[12, 10]], 'gte', -10)).toBe(true)
		expect(evaluateXpointActive(s, [[12, 10]], 'gte', -20)).toBe(true)
		expect(evaluateXpointActive(s, [[12, 10]], 'gte', -9.9)).toBe(false)
		expect(evaluateXpointActive(s, [[12, 10]], 'eq', -10)).toBe(true)
		expect(evaluateXpointActive(s, [[12, 10]], 'eq', -10.1)).toBe(false)
		expect(evaluateXpointActive(s, [[12, 10]], 'eq', 0)).toBe(false)
		// an off crosspoint never matches, even gte -100
		expect(evaluateXpointActive(s, [[9, 1]], 'gte', -100)).toBe(false)
		expect(evaluateXpointActive(s, [[9, 1]], 'eq', -100)).toBe(false)
	})
	it('gte/eq with a stereo pair needs both to match', () => {
		const s = legacyA()
		apply(s, 'MIX 1 17:-60')
		apply(s, 'MIX 2 18:0')
		expect(
			evaluateXpointActive(
				s,
				[
					[1, 17],
					[2, 18],
				],
				'gte',
				-6,
			),
		).toBe(true)
		expect(
			evaluateXpointActive(
				s,
				[
					[1, 17],
					[2, 18],
				],
				'gte',
				-5,
			),
		).toBe(false)
		expect(
			evaluateXpointActive(
				s,
				[
					[1, 17],
					[2, 18],
				],
				'eq',
				0,
			),
		).toBe(false)
	})
	it('a non-finite gain with gte does not throw', () => {
		const s = legacyA()
		expect(() => evaluateXpointActive(s, [[1, 17]], 'gte', Number.NaN)).not.toThrow()
	})
})

describe('evaluateOutputExclusive', () => {
	it('true only when that input alone feeds the output', () => {
		const s = legacyA()
		expect(evaluateOutputExclusive(s, [[1, 17]])).toBe(true)
		expect(evaluateOutputExclusive(s, [[1, 18]])).toBe(false)
		apply(s, 'MIX 1 17:0 3:-200')
		expect(evaluateOutputExclusive(s, [[1, 17]])).toBe(false)
		apply(s, 'MIX 1 17:0 3:-')
		expect(evaluateOutputExclusive(s, [[1, 17]])).toBe(true)
	})
	it('stereo: every row must be exclusive', () => {
		const s = legacyA()
		expect(
			evaluateOutputExclusive(s, [
				[1, 17],
				[2, 18],
			]),
		).toBe(true)
		apply(s, 'MIX 2 18:0 5:0')
		expect(
			evaluateOutputExclusive(s, [
				[1, 17],
				[2, 18],
			]),
		).toBe(false)
	})
	it('empty or empty row is false', () => {
		const s = legacyA()
		expect(evaluateOutputExclusive(s, [])).toBe(false)
		expect(evaluateOutputExclusive(s, [[9, 1]])).toBe(false)
	})
	it('an input at -100 dB counts as off, so it does not break exclusivity', () => {
		const s = legacyA()
		apply(s, 'MIX 1 17:0 3:-1000')
		expect(evaluateOutputExclusive(s, [[1, 17]])).toBe(true)
	})
})

describe('dst_connected_to', () => {
	it('legacy IP forms, by channel kind', () => {
		const s = legacyA() // DST 1 -> 239.193.87.29
		expect(evaluateDstConnectedTo(s, 1, { target: 'channel', channel: 22301, kind: 'to' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 1, { target: 'channel', channel: 22301, kind: 'from' })).toBe(false)
		expect(evaluateDstConnectedTo(s, 1, { target: 'address', address: '239.193.87.29' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 1, { target: 'known', known: '239.193.87.29' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 2, { target: 'address', address: '239.193.87.29' })).toBe(false)
	})
	it('legacy channel string stored as typed', () => {
		const s = legacyA()
		apply(s, 'DST 1 ADDR:"22301"')
		expect(evaluateDstConnectedTo(s, 1, { target: 'channel', channel: 22301, kind: 'from' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 1, { target: 'address', address: '239.192.87.29' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 1, { target: 'channel', channel: 22301, kind: 'to' })).toBe(false)
	})
	it('address with a label suffix', () => {
		const s = legacyB() // DST 2 "239.192.91.207 <Program 3@STD3-Engine>"
		expect(evaluateDstConnectedTo(s, 2, { target: 'address', address: '239.192.91.207' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 2, { target: 'channel', channel: 91 * 256 + 207, kind: 'from' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 2, { target: 'known', known: '239.192.91.207' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 2, { target: 'address', address: '239.192.91.208' })).toBe(false)
	})
	it('xNode2 normalised IP; surround kind', () => {
		const s = combo()
		expect(evaluateDstConnectedTo(s, 1, { target: 'channel', channel: 2 * 256, kind: 'from' })).toBe(true)
		apply(s, 'DST 1 ADDR:"239.196.0.7"')
		expect(evaluateDstConnectedTo(s, 1, { target: 'channel', channel: 7, kind: 'surround' })).toBe(true)
		expect(evaluateDstConnectedTo(s, 1, { target: 'channel', channel: 7, kind: 'from' })).toBe(false)
	})
	it('disconnected, invalid targets, unknown DST are false', () => {
		const s = legacyA()
		apply(s, 'DST 1 ADDR:""')
		expect(evaluateDstConnectedTo(s, 1, { target: 'address', address: '' })).toBe(false)
		expect(evaluateDstConnectedTo(s, 1, { target: 'channel', channel: 22301, kind: 'to' })).toBe(false)
		expect(evaluateDstConnectedTo(s, 2, { target: 'channel', channel: 0, kind: 'from' })).toBe(false)
		expect(evaluateDstConnectedTo(s, 2, { target: 'channel', channel: 40000, kind: 'from' })).toBe(false)
		expect(evaluateDstConnectedTo(s, 2, { target: 'known', known: '' })).toBe(false)
		expect(evaluateDstConnectedTo(s, 99, { target: 'channel', channel: 1, kind: 'from' })).toBe(false)
	})
	it('dst_connected', () => {
		const s = legacyA()
		expect(evaluateDstConnected(s, 1)).toBe(true)
		apply(s, 'DST 1 ADDR:""')
		expect(evaluateDstConnected(s, 1)).toBe(false)
		apply(s, 'DST 1 ADDR:" "')
		expect(evaluateDstConnected(s, 1)).toBe(false)
		expect(evaluateDstConnected(s, 42)).toBe(false)
	})
})

describe('simple evaluators', () => {
	it('src_enabled', () => {
		const s = legacyA()
		expect(evaluateSrcEnabled(s, 1)).toBe(true)
		apply(s, 'SRC 1 RTPE:0')
		expect(evaluateSrcEnabled(s, 1)).toBe(false)
		expect(evaluateSrcEnabled(s, 77)).toBe(false)
	})
	it('factory mode', () => {
		const s = legacyA()
		expect(evaluateFactoryMode(s)).toBe(false)
		apply(s, 'MIXCFG MODE:1')
		expect(evaluateFactoryMode(s)).toBe(true)
		s.mixcfgMode = undefined
		expect(evaluateFactoryMode(s)).toBe(false)
	})
	it('budget threshold', () => {
		const s = legacyA()
		expect(evaluateXpointBudget(s, 17)).toBe(true)
		expect(evaluateXpointBudget(s, 18)).toBe(false)
		expect(evaluateXpointBudget(s, 1)).toBe(true)
	})
	it('GPIO active is l', () => {
		expect(evaluateGpioActive('hhlhh', 3)).toBe(true)
		expect(evaluateGpioActive('hhlhh', 1)).toBe(false)
		expect(evaluateGpioActive(undefined, 1)).toBe(false)
		expect(evaluateGpioActive('hhlhh', 0)).toBe(false)
		expect(evaluateGpioActive('hhlhh', 6)).toBe(false)
		const s = combo()
		apply(s, 'GPO 1 LHHHH')
		expect(evaluateGpioActive(s.gpo.get(1), 1)).toBe(true)
	})
	it('phantom: only MIC inputs', () => {
		const s = combo()
		expect(evaluatePhantom(s, 5)).toBe(false)
		apply(s, 'INP 5 PHPW:1')
		expect(evaluatePhantom(s, 5)).toBe(true)
		apply(s, 'INP 1 PHPW:1')
		expect(evaluatePhantom(s, 1)).toBe(false)
		expect(evaluatePhantom(s, 9)).toBe(false)
		expect(evaluatePhantom(legacyA(), 1)).toBe(false)
	})
})

describe('evaluateLevelState', () => {
	const mk = (...lines: string[]): XNodeState => {
		const s = legacyA()
		for (const l of lines) apply(s, l)
		return s
	}
	it('is false before levelsReady', () => {
		const s = mk('LVL ICH 1.L CLIP')
		expect(evaluateLevelState(s, false, 'ICH', 1, 'either', 'clip')).toBe(false)
		expect(evaluateLevelState(s, true, 'ICH', 1, 'either', 'clip')).toBe(true)
	})
	it('is false for unknown channels', () => {
		expect(evaluateLevelState(mk(), true, 'ICH', 1, 'either', 'silence')).toBe(false)
	})
	it('sides: either / both / L / R', () => {
		const s = mk('LVL ICH 1.L LOW', 'LVL ICH 1.R NO-LOW')
		expect(evaluateLevelState(s, true, 'ICH', 1, 'either', 'silence')).toBe(true)
		expect(evaluateLevelState(s, true, 'ICH', 1, 'both', 'silence')).toBe(false)
		expect(evaluateLevelState(s, true, 'ICH', 1, 'L', 'silence')).toBe(true)
		expect(evaluateLevelState(s, true, 'ICH', 1, 'R', 'silence')).toBe(false)
		expect(evaluateLevelState(s, true, 'ICH', 1, 'either', 'present')).toBe(true)
		expect(evaluateLevelState(s, true, 'ICH', 1, 'both', 'present')).toBe(false)
		apply(s, 'LVL ICH 1.R LOW')
		expect(evaluateLevelState(s, true, 'ICH', 1, 'both', 'silence')).toBe(true)
		expect(evaluateLevelState(s, true, 'ICH', 1, 'either', 'present')).toBe(false)
	})
	it('clip', () => {
		const s = mk('LVL OCH 2.L NO-CLIP', 'LVL OCH 2.R CLIP')
		expect(evaluateLevelState(s, true, 'OCH', 2, 'R', 'clip')).toBe(true)
		expect(evaluateLevelState(s, true, 'OCH', 2, 'L', 'clip')).toBe(false)
		expect(evaluateLevelState(s, true, 'OCH', 2, 'both', 'clip')).toBe(false)
		expect(evaluateLevelState(s, true, 'OCH', 2, 'either', 'clip')).toBe(true)
	})
	it('mono channels answer for any side', () => {
		const s = combo()
		apply(s, 'LVL HWI 5.1 LOW')
		for (const side of ['L', 'R', 'either', 'both'] as const) {
			expect(evaluateLevelState(s, true, 'HWI', 5, side, 'silence')).toBe(true)
			expect(evaluateLevelState(s, true, 'HWI', 5, side, 'present')).toBe(false)
		}
	})
})

describe('feedbackIdsForChanges', () => {
	it('maps kinds to feedbacks, deduplicated', () => {
		expect(feedbackIdsForChanges([])).toEqual([])
		expect(feedbackIdsForChanges([{ kind: 'mix' }, { kind: 'mix' }]).sort()).toEqual(
			['mix_output_exclusive', 'mix_xpoint_active', 'xpoint_budget'].sort(),
		)
		expect(feedbackIdsForChanges([{ kind: 'mixcfg' }])).toEqual(['mixer_factory_mode'])
		expect(feedbackIdsForChanges([{ kind: 'dst' }]).sort()).toEqual(['dst_connected', 'dst_connected_to'])
		expect(feedbackIdsForChanges([{ kind: 'src' }]).sort()).toEqual(['src_enabled', 'src_in_use'])
		expect(feedbackIdsForChanges([{ kind: 'lvl' }])).toEqual(['level_state'])
		expect(feedbackIdsForChanges([{ kind: 'gpi' }])).toEqual(['gpi_active'])
		expect(feedbackIdsForChanges([{ kind: 'gpo' }])).toEqual(['gpo_active'])
		expect(feedbackIdsForChanges([{ kind: 'inp' }])).toEqual(['mic_phantom'])
	})
	it('ver rechecks everything; ip, set, mtr, cfgGpo nothing', () => {
		expect(feedbackIdsForChanges([{ kind: 'ver' }]).sort()).toEqual([...ALL_FEEDBACK_IDS].sort())
		expect(feedbackIdsForChanges([{ kind: 'ip' }, { kind: 'set' }, { kind: 'mtr' }, { kind: 'cfgGpo' }])).toEqual([])
	})
	it('combines kinds', () => {
		const r = feedbackIdsForChanges([{ kind: 'src' }, { kind: 'gpo' }, { kind: 'src' }])
		expect(r.sort()).toEqual(['gpo_active', 'src_enabled', 'src_in_use'])
	})
})
