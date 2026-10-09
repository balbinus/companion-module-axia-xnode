import { describe, expect, it } from 'vitest'
import { UpdateActions } from '../src/actions.js'
import { UpdateFeedbacks } from '../src/feedbacks.js'
import { UpdatePresets } from '../src/presets.js'
import { computeVariableDefinitions } from '../src/model/derived.js'
import type ModuleInstance from '../src/main.js'
import { loadedState, type FixtureName } from './fixtures/load.js'

interface Fake {
	self: ModuleInstance
	state: ReturnType<typeof loadedState>
	config: Any
	actions: Record<string, Any>
	feedbacks: Record<string, Any>
	sections: Any[]
	presets: Record<string, Any>
}

function build(fixture: FixtureName, cfg: Any = {}): Fake {
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

const CASES: Array<[string, FixtureName, Any]> = [
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
]

describe('presets reference real actions, feedbacks and variables', () => {
	for (const [name, fixture, cfg] of CASES) {
		it(name, () => {
			const f = build(fixture, cfg)
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

describe('gain and stream presets', () => {
	it('the gain value button (centre of the trio) is display-only', () => {
		const f = build('xnode2-combo')
		const centre = Object.entries<Any>(f.presets).filter(([id]) => /^gain_(dst|src)_\d+_value$/.test(id))
		expect(centre.length).toBeGreaterThan(0)
		for (const [, p] of centre) expect(p.steps.every((s: Any) => s.down.length === 0 && s.up.length === 0)).toBe(true)
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

	it('rotary press still sets 0 dB', () => {
		const f = build('legacy-analog4x4-a')
		expect(f.presets.rotgain_dst_1.steps[0].down[0]).toMatchObject({ actionId: 'dst_gain_set', options: { gain: 0 } })
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
