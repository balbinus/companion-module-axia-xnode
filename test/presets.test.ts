import { describe, expect, it } from 'vitest'
import { UpdateActions } from '../src/actions.js'
import { UpdateFeedbacks } from '../src/feedbacks.js'
import { MAX_DISCOVERED_ROUTES, UpdatePresets } from '../src/presets.js'
import { computeVariableDefinitions } from '../src/model/derived.js'
import type ModuleInstance from '../src/main.js'
import { loadedState, type FixtureName } from './fixtures/load.js'
import { networkDirectory } from './helpers/directory.js'
import { LivewireDirectory } from '../src/model/directory.js'

type Any = any

interface Fake {
	self: ModuleInstance
	state: ReturnType<typeof loadedState>
	config: Any
	actions: Record<string, Any>
	feedbacks: Record<string, Any>
	sections: Any[]
	presets: Record<string, Any>
}

function build(fixture: FixtureName, cfg: Any = {}, directory?: LivewireDirectory): Fake {
	const state = loadedState(fixture)
	const config = {
		knownSources: '22301=Studio Mic 1\n239.192.87.29=Other',
		levelAlerts: true,
		meterMode: 'off',
		exposeXpointVariables: true,
		...cfg,
	}
	const fake: Any = { state, config, actions: {}, feedbacks: {}, sections: [], presets: {} }
	fake.self = {
		label: 'xn',
		controller: { state, levelsReady: true },
		config,
		directory,
		log() {},
		setActionDefinitions(d: Any) {
			fake.actions = d
		},
		setFeedbackDefinitions(d: Any) {
			fake.feedbacks = d
		},
		setPresetDefinitions(sections: Any, presets: Any) {
			fake.sections = sections
			fake.presets = presets
		},
	}
	UpdateActions(fake.self)
	UpdateFeedbacks(fake.self)
	UpdatePresets(fake.self)
	return fake
}

/** Every declared option present with a valid value, and no undeclared one. */
function checkOptions(kind: string, def: Any, id: string, options: Any, errs: string[], where: string): void {
	if (!def) {
		errs.push(`${where}: unknown ${kind} ${id}`)
		return
	}
	const fields: Any[] = def.options ?? []
	for (const f of fields) {
		if (!(f.id in options)) {
			errs.push(`${where}: ${id} is missing option ${f.id}`)
			continue
		}
		const v = options[f.id]
		if (f.type === 'dropdown') {
			if (!f.choices.some((c: Any) => c.id === v))
				errs.push(`${where}: ${id}.${f.id}=${JSON.stringify(v)} not in choices`)
		} else if (f.type === 'multidropdown') {
			for (const x of v)
				if (!f.choices.some((c: Any) => c.id === x)) errs.push(`${where}: ${id}.${f.id} has bad choice ${x}`)
		} else if (f.type === 'number') {
			if (typeof v !== 'number' || v < f.min || v > f.max)
				errs.push(`${where}: ${id}.${f.id}=${v} outside [${f.min},${f.max}]`)
			else if (f.asInteger && !Number.isInteger(v)) errs.push(`${where}: ${id}.${f.id}=${v} is not an integer`)
		}
	}
	for (const k of Object.keys(options)) {
		if (!fields.some((f) => f.id === k)) errs.push(`${where}: ${id} has undeclared option ${k}`)
	}
}

function problems(f: Fake): string[] {
	const errs: string[] = []
	const vars = computeVariableDefinitions(f.state, f.config)
	const grouped = new Set<string>()
	const groupIds = new Set<string>()
	for (const s of f.sections) {
		for (const g of s.definitions) {
			if (groupIds.has(g.id)) errs.push(`duplicate group id ${g.id}`)
			groupIds.add(g.id)
			for (const p of g.presets) {
				grouped.add(p)
				if (!f.presets[p]) errs.push(`group ${g.id} references missing preset ${p}`)
			}
		}
	}
	for (const id of Object.keys(f.presets)) if (!grouped.has(id)) errs.push(`preset ${id} is in no group`)
	for (const [id, p] of Object.entries<Any>(f.presets)) {
		for (const m of String(p.style.text).matchAll(/\$\(xn:([a-z0-9_]+)\)/g)) {
			if (!vars[m[1]]) errs.push(`${id}: variable ${m[1]} is not defined`)
		}
		for (const step of p.steps) {
			for (const list of Object.values<Any>(step)) {
				if (!Array.isArray(list)) continue
				for (const a of list) checkOptions('action', f.actions[a.actionId], a.actionId, a.options, errs, id)
			}
		}
		for (const fb of p.feedbacks)
			checkOptions('feedback', f.feedbacks[fb.feedbackId], fb.feedbackId, fb.options, errs, id)
	}
	return errs
}

const CASES: Array<[string, FixtureName, Any, LivewireDirectory?]> = [
	['xNode2 combo', 'xnode2-combo', {}],
	['legacy analog 4x4 (a)', 'legacy-analog4x4-a', {}],
	['legacy analog 4x4 (b)', 'legacy-analog4x4-b', {}],
	[
		'xNode2 without level alerts, xpoint variables or known sources',
		'xnode2-combo',
		{
			levelAlerts: false,
			exposeXpointVariables: false,
			knownSources: '',
		},
	],
	['xNode2 with discovered sources', 'xnode2-combo', {}, networkDirectory()],
]

describe('presets reference real actions, feedbacks and variables', () => {
	for (const [name, fixture, cfg, directory] of CASES) {
		it(name, () => {
			const f = build(fixture, cfg, directory)
			expect(Object.keys(f.presets).length).toBeGreaterThan(0)
			expect(problems(f)).toEqual([])
		})
	}

	it('before the node has been read only the device info is offered', () => {
		const f = build('xnode2-combo')
		f.state.reset()
		UpdatePresets(f.self)
		expect(problems(f)).toEqual([])
		expect(f.sections.map((s) => s.id)).toEqual(['status'])
	})
})

describe('nothing is generated for missing features', () => {
	it('no mic or physical-signal presets on legacy nodes', () => {
		const f = build('legacy-analog4x4-a')
		const ids = Object.keys(f.presets)
		expect(ids.some((id) => /^(sig_hw|mic)/.test(id))).toBe(false)
		expect(f.sections.some((s) => s.id === 'mic')).toBe(false)
	})

	it('no signal presets when level alerts are off', () => {
		const f = build('xnode2-combo', { levelAlerts: false })
		expect(Object.keys(f.presets).some((id) => id.startsWith('sig_'))).toBe(false)
	})

	it('preset ids are unique across sections (an id cannot be reused by another preset)', () => {
		const f = build('xnode2-combo')
		const all = f.sections.flatMap((s) => s.definitions.flatMap((g: Any) => g.presets as string[]))
		expect(new Set(all).size).toBe(all.length)
	})
})

describe('DST routing presets', () => {
	const routes = (f: Fake, n: number): Any[] =>
		f.sections
			.find((s) => s.id === 'dst_routing')
			.definitions.find((g: Any) => g.id === `route_${n}`)
			.presets.map((id: string) => ({ id, ...f.presets[id] }))

	it('lists the known sources, then the discovered ones not already known, by channel', () => {
		// 239.192.87.29 is both known ("Other") and discovered (MIC 1 on .223): it is offered once, as known
		const f = build('xnode2-combo', {}, networkDirectory())
		const ids = routes(f, 1).map((p) => p.id)
		expect(ids.slice(0, 2)).toEqual(['route_1_0', 'route_1_1'])
		expect(ids).not.toContain('route_1_lw_239_192_87_29')
		expect(ids).toContain('route_1_lw_239_192_87_30')
		expect(ids).toContain('route_1_lw_239_193_87_29')
		expect(ids.at(-1)).toBe('route_1_off')
		const src2 = routes(f, 1).find((p) => p.id === 'route_1_lw_239_192_87_30')
		expect(src2.name).toBe('DST 1 ← SRC 2 (Node-223-0)')
		expect(src2.steps[0].down[0]).toEqual({
			actionId: 'dst_connect_channel',
			options: { dst: 1, source: '239.192.87.30', channel: 22302, kind: 'from' },
		})
		expect(src2.feedbacks[0].options).toMatchObject({ dst: 1, target: 'known', known: '239.192.87.30' })
	})

	it('keeps the known-source preset ids, so existing presets keep their identity', () => {
		const without = build('xnode2-combo')
		const withDir = build('xnode2-combo', {}, networkDirectory())
		const known = (f: Fake): string[] =>
			routes(f, 1)
				.map((p) => p.id)
				.filter((id: string) => /^route_1_\d+$/.test(id))
		expect(known(withDir)).toEqual(known(without))
	})

	it(`offers at most ${MAX_DISCOVERED_ROUTES} discovered sources per destination`, () => {
		const directory = new LivewireDirectory({ now: () => 0 })
		const sources = Array.from({ length: MAX_DISCOVERED_ROUTES + 10 }, (_, i) => ({
			slot: `S${String(i + 1).padStart(3, '0')}`,
			channel: 1000 + i,
			name: `Src ${i}`,
			streamAddress: `239.192.3.${i}`,
			backfeedAddress: `239.193.3.${i}`,
		}))
		directory.ingest({
			kind: 'full',
			deviceIp: '10.0.0.1',
			configVersion: 1,
			sourceCount: sources.length,
			deviceName: 'Big',
			sources,
			usage: [],
		})
		const f = build('xnode2-combo', { knownSources: '' }, directory)
		const ids = routes(f, 1).map((p) => p.id)
		expect(ids).toHaveLength(MAX_DISCOVERED_ROUTES + 1)
		expect(ids[0]).toBe('route_1_lw_239_192_3_0')
		expect(problems(f)).toEqual([])
	})
})

describe('level_state presets only carry declared options', () => {
	it('legacy: no hwi / hwo keys', () => {
		const f = build('legacy-analog4x4-a')
		const fbs = Object.values<Any>(f.presets).flatMap((p) =>
			p.feedbacks.filter((x: Any) => x.feedbackId === 'level_state'),
		)
		expect(fbs.length).toBeGreaterThan(0)
		for (const fb of fbs) {
			expect(fb.options).not.toHaveProperty('hwi')
			expect(fb.options).not.toHaveProperty('hwo')
		}
	})

	it('xNode2: hwi / hwo are present on every level_state feedback', () => {
		const f = build('xnode2-combo')
		const fbs = Object.values<Any>(f.presets).flatMap((p) =>
			p.feedbacks.filter((x: Any) => x.feedbackId === 'level_state'),
		)
		for (const fb of fbs) {
			expect(fb.options).toHaveProperty('hwi')
			expect(fb.options).toHaveProperty('hwo')
		}
	})
})

describe('mixer presets', () => {
	it('every crosspoint button names both its input and its output', () => {
		const f = build('xnode2-combo')
		const xp = Object.entries<Any>(f.presets).filter(([id]) => /^(mix|mixsrc|excl|rot)_/.test(id))
		expect(xp.length).toBeGreaterThan(0)
		for (const [, p] of xp) expect(p.style.text).toMatch(/\\n→ \S/)
	})
})

describe('gain and stream presets', () => {
	it('the gain value button (centre of the trio) is also the encoder preset', () => {
		const f = build('xnode2-combo')
		const centre = Object.entries<Any>(f.presets).filter(([id]) => /^gain_(dst|src)_\d+_value$/.test(id))
		expect(centre.length).toBeGreaterThan(0)
		for (const [id, p] of centre) {
			const kind = id.split('_')[1]
			const [step] = p.steps
			expect(step.down[0]).toMatchObject({ actionId: `${kind}_gain_set`, options: { gain: 0 } })
			expect(step.rotate_left[0]).toMatchObject({ actionId: `${kind}_gain_adjust`, options: { step: -0.5 } })
			expect(step.rotate_right[0]).toMatchObject({ actionId: `${kind}_gain_adjust`, options: { step: 0.5 } })
		}
		expect(f.sections.some((s) => s.id === 'gain_rotary')).toBe(false)
	})

	it('the -1 dB and +1 dB buttons adjust', () => {
		const f = build('legacy-analog4x4-a')
		expect(f.presets.gain_dst_1_down.steps[0].down[0]).toMatchObject({
			actionId: 'dst_gain_adjust',
			options: { step: -1 },
		})
		expect(f.presets.gain_src_1_up.steps[0].down[0]).toMatchObject({
			actionId: 'src_gain_adjust',
			options: { step: 1 },
		})
	})

	it('the -1 dB and +1 dB buttons name their target', () => {
		const f = build('legacy-analog4x4-a')
		expect(f.presets.gain_dst_1_down.style.text).toMatch(/^DST 1\\n/)
		expect(f.presets.gain_src_1_up.style.text).toMatch(/^SRC 1\\n/)
	})

	it('SRC stream toggles are not in the read-only Status section', () => {
		const f = build('xnode2-combo')
		const status = f.sections.find((s) => s.id === 'status')
		const statusIds = status.definitions.flatMap((g: Any) => g.presets as string[])
		expect(statusIds.some((id: string) => id.startsWith('srcon_'))).toBe(false)
		const streams = f.sections.find((s) => s.id === 'src_streams')
		expect(streams.name).toMatch(/stream on\/off/)
		expect(streams.description).toMatch(/Allow source/)
		expect(f.sections[0].id).toBe('status')
	})
})
