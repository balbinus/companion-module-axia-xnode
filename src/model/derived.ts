/** Pure value computations for variables and feedbacks. No dependency on Companion's InstanceBase. */
import type { ModuleConfig } from '../config.js'
import { channelToMulticast, normaliseAddr, parseDstAddr, type ChannelKind } from '../lwrp/livewire.js'
import { dbToTenths, formatDb, isXpointOn } from '../lwrp/units.js'
import { channelLabel, pairLabel, type MixChannel } from './iomap.js'
import type { LevelSide, LevelState, MeterKind, StateChange, StateKind, XNodeState } from './state.js'

export type VarValue = string | number
export type VarValues = Record<string, VarValue>
export type VarDefinitions = Record<string, { name: string }>

export type DerivedConfig = Pick<ModuleConfig, 'meterMode' | 'exposeXpointVariables' | 'levelAlerts'>

export type SignalState = 'clip' | 'low' | 'ok' | ''

export interface PhysPort {
	n: number
	stereo: boolean
	label: string
}

const RTPP_MODES: Record<string, string> = { '12': 'Live', '240': 'Standard', '48': 'AES67' }
const INP_TYPES: Record<string, string> = { ANALAOG: 'Analog', ANALOG: 'Analog', AES: 'AES', MIC: 'Mic' }

export function srcModeLabel(rtpp: string | undefined): string {
	return rtpp === undefined ? '' : (RTPP_MODES[rtpp] ?? rtpp)
}

/** Firmware says `ANALAOG` (sic) */
export function inpTypeLabel(type: string | undefined): string {
	if (!type) return ''
	return INP_TYPES[type.toUpperCase()] ?? type
}

export function isMicInput(attrs: Record<string, string> | undefined): boolean {
	return (attrs?.TYPE ?? '').toUpperCase() === 'MIC'
}

/** Physical inputs (`in`: HWI) or outputs (`out`: HWO) from the I/O map, numbered like the xNode2 INP / HWI / HWO objects. */
export function physPorts(state: XNodeState, dir: 'in' | 'out'): PhysPort[] {
	const isInput = dir === 'in'
	const pairs = isInput ? state.ioMap.inputPairs : state.ioMap.outputPairs
	const ports: PhysPort[] = []
	for (const p of pairs) {
		if (p.left.kind !== 'phys') continue
		ports.push({ n: p.left.owner, stereo: p.right !== undefined, label: pairLabel(p, isInput, state) })
	}
	if (ports.length === 0 && isInput && state.isXNode2) {
		for (let n = 1; n <= state.ninp; n++) ports.push({ n, stereo: false, label: state.inpName(n) ?? `Input ${n}` })
	}
	return ports
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

function hasHwMeters(state: XNodeState, config: Pick<DerivedConfig, 'meterMode'>): boolean {
	return config.meterMode !== 'off' && (state.isXNode2 || config.meterMode === 'http')
}

// ------------------------------------------------------------------ definitions

export function computeVariableDefinitions(state: XNodeState, config: DerivedConfig): VarDefinitions {
	const defs: VarDefinitions = {}
	const add = (id: string, name: string): void => {
		defs[id] = { name }
	}

	for (const [id, name] of [
		['model', 'Model'],
		['devn', 'Device type (DEVN)'],
		['product', 'Product'],
		['firmware', 'Firmware version'],
		['lwrp_version', 'LWRP version'],
		['hostname', 'Hostname'],
		['ip', 'IP address'],
		['link', 'Network link (up/down)'],
	] as const)
		add(id, name)
	if (!state.isXNode2) add('node_id', 'Node ID (SET NID)')
	if (state.hasMixer) {
		add('mixer_mode', 'Mixer mode (Custom / Factory)')
		add('xpoints_used', 'Crosspoints in use')
	}
	if (!state.isXNode2) {
		add('set_nid', 'System: NID')
		add('set_lwclk_prio', 'System: Livewire clock priority')
		add('set_ptp_dom', 'System: PTP domain')
		add('set_enable_sap', 'System: SAP enabled')
		add('set_adip', 'System: Livewire advertisement address')
	}

	const signals = config.levelAlerts !== false
	const meters = config.meterMode !== 'off'
	for (const n of range(state.nsrc)) {
		const t = `SRC ${n}`
		add(`src_${n}_name`, `${t}: name`)
		add(`src_${n}_enabled`, `${t}: stream enabled (on/off)`)
		add(`src_${n}_address`, `${t}: stream address`)
		add(`src_${n}_channel`, `${t}: Livewire channel`)
		add(`src_${n}_mode`, `${t}: stream mode`)
		add(`src_${n}_gain`, `${t}: input gain (dB)`)
		if (signals) add(`src_${n}_signal`, `${t}: signal state (ok/low/clip)`)
		if (meters) {
			add(`src_${n}_peak_l`, `${t}: peak L (dBFS)`)
			add(`src_${n}_peak_r`, `${t}: peak R (dBFS)`)
		}
	}
	for (const n of range(state.ndst)) {
		const t = `DST ${n}`
		add(`dst_${n}_name`, `${t}: name`)
		add(`dst_${n}_address`, `${t}: connected address`)
		add(`dst_${n}_channel`, `${t}: Livewire channel`)
		add(`dst_${n}_source_label`, `${t}: source label`)
		add(`dst_${n}_gain`, `${t}: output gain (dB)`)
		if (signals) add(`dst_${n}_signal`, `${t}: signal state (ok/low/clip)`)
		if (meters) {
			add(`dst_${n}_peak_l`, `${t}: peak L (dBFS)`)
			add(`dst_${n}_peak_r`, `${t}: peak R (dBFS)`)
		}
	}

	const hwMeters = hasHwMeters(state, config)
	const hwSignals = signals && state.isXNode2
	if (hwSignals || hwMeters) {
		for (const [dir, prefix, word] of [
			['in', 'hwi', 'Input'],
			['out', 'hwo', 'Output'],
		] as const) {
			for (const p of physPorts(state, dir)) {
				const t = `${word} ${p.label}`
				if (hwSignals) add(`${prefix}_${p.n}_signal`, `${t}: signal state (ok/low/clip)`)
				if (hwMeters) {
					add(`${prefix}_${p.n}_peak_l`, `${t}: peak${p.stereo ? ' L' : ''} (dBFS)`)
					if (p.stereo) add(`${prefix}_${p.n}_peak_r`, `${t}: peak R (dBFS)`)
				}
			}
		}
	}

	if (state.hasMixer) {
		for (const out of state.ioMap.outputs)
			add(`mix_out_${out.number}_inputs`, `Mixer output ${out.number} (${channelLabel(out, false, state)}): inputs`)
		if (config.exposeXpointVariables) {
			for (const out of state.ioMap.outputs)
				for (const inp of state.ioMap.inputs)
					add(`xp_${out.number}_${inp.number}`, `Crosspoint out ${out.number} / in ${inp.number} gain (dB)`)
		}
	}

	for (const n of range(state.ninp)) {
		const attrs = state.inp.get(n)
		add(`inp_${n}_name`, `INP ${n}: name`)
		add(`inp_${n}_type`, `INP ${n}: type`)
		if (isMicInput(attrs)) {
			add(`inp_${n}_gain`, `INP ${n}: mic gain (dB)`)
			add(`inp_${n}_phantom`, `INP ${n}: phantom power (on/off)`)
		}
	}
	for (const n of range(state.ngpi)) add(`gpi_${n}`, `GPI ${n}: pins (l = active)`)
	for (const n of range(state.ngpo)) {
		add(`gpo_${n}`, `GPO ${n}: pins (l = active)`)
		add(`gpo_${n}_name`, `GPO ${n}: name`)
	}
	return defs
}

// ------------------------------------------------------------------ values

/** One-way signal summary from the LVL flags of a channel's sides. '' = unknown. */
export function signalState(
	sides: Partial<Record<LevelSide, LevelState>> | undefined,
	levelsReady: boolean,
): SignalState {
	if (!levelsReady || !sides) return ''
	const known = Object.values(sides).filter((s): s is LevelState => s !== undefined)
	if (known.length === 0) return ''
	if (known.some((s) => s.clip === true)) return 'clip'
	const withLow = known.filter((s) => s.low !== undefined)
	if (withLow.length > 0 && withLow.every((s) => s.low === true)) return 'low'
	return 'ok'
}

const peakDb = (tenths: number | undefined): VarValue => (tenths === undefined ? '' : Math.round(tenths) / 10)

function setPeaks(out: VarValues, id: string, state: XNodeState, group: MeterKind, n: number, stereo: boolean): void {
	const m = state.mtr[group].get(n)
	out[`${id}_peak_l`] = peakDb(m?.l)
	if (stereo) out[`${id}_peak_r`] = peakDb(m?.r)
}

function gainText(raw: string | undefined): string {
	if (raw === undefined || raw === '' || !Number.isFinite(Number(raw))) return ''
	return formatDb(Number(raw))
}

/** Short summary of what feeds a mixer row: `Line 1 L (0.0) + DST 3 L · Name (-6.0)` */
export function mixOutputSummary(state: XNodeState, output: number): string {
	const row = state.mix.get(output)
	if (!row) return ''
	const parts: string[] = []
	for (const [input, gain] of [...row].sort(([a], [b]) => a - b)) {
		if (!isXpointOn(gain)) continue
		const ch: MixChannel | undefined = state.ioMap.inputs.find((c) => c.number === input)
		parts.push(`${ch ? channelLabel(ch, true, state) : `In ${input}`} (${formatDb(gain)})`)
	}
	return parts.join(' + ')
}

export function computeVariableValues(state: XNodeState, config: DerivedConfig, levelsReady: boolean): VarValues {
	const v: VarValues = {}
	v.model = state.ver.MODEL ?? ''
	v.devn = state.ver.DEVN ?? ''
	v.product = state.ver.PRODUCT ?? ''
	v.firmware = state.ver.SVER ?? ''
	v.lwrp_version = state.ver.LWRP ?? ''
	v.hostname = state.ip.hostname ?? ''
	v.ip = state.ip.addr ?? ''
	v.link = state.ip.link === undefined ? '' : state.ip.link ? 'up' : 'down'
	if (!state.isXNode2) {
		v.node_id = state.set.NID ?? ''
		v.set_nid = state.set.NID ?? ''
		v.set_lwclk_prio = state.set.LWCLK_PRIO ?? ''
		v.set_ptp_dom = state.set.PTP_DOM ?? ''
		v.set_enable_sap = state.set.ENABLE_SAP ?? ''
		v.set_adip = state.set.ADIP ?? ''
	}
	if (state.hasMixer) {
		v.mixer_mode =
			state.mixcfgMode === undefined ? '' : state.mixcfgMode === 0 ? 'Custom' : `Factory (mode ${state.mixcfgMode})`
		v.xpoints_used = state.xpointsUsed()
	}

	const signals = config.levelAlerts !== false
	const meters = config.meterMode !== 'off'
	for (const n of range(state.nsrc)) {
		const a = state.src.get(n) ?? {}
		const addr = (a.RTPA ?? '').split(';')[0].trim()
		v[`src_${n}_name`] = a.PSNM ?? ''
		v[`src_${n}_enabled`] = a.RTPE === undefined ? '' : a.RTPE === '1' ? 'on' : 'off'
		v[`src_${n}_address`] = a.RTPA ?? ''
		v[`src_${n}_channel`] = parseDstAddr(addr).channel ?? ''
		v[`src_${n}_mode`] = srcModeLabel(a.RTPP)
		v[`src_${n}_gain`] = gainText(a.INGN)
		if (signals) v[`src_${n}_signal`] = signalState(state.lvl.ICH.get(n), levelsReady)
		if (meters) setPeaks(v, `src_${n}`, state, 'ICH', n, true)
	}
	for (const n of range(state.ndst)) {
		const a = state.dst.get(n) ?? {}
		const addr = a.ADDR ?? ''
		const p = parseDstAddr(addr)
		v[`dst_${n}_name`] = a.NAME ?? ''
		v[`dst_${n}_address`] = addr
		v[`dst_${n}_channel`] = p.channel ?? ''
		v[`dst_${n}_source_label`] = p.label ?? p.channel ?? p.ip ?? ''
		v[`dst_${n}_gain`] = gainText(a.OUGN)
		if (signals) v[`dst_${n}_signal`] = signalState(state.lvl.OCH.get(n), levelsReady)
		if (meters) setPeaks(v, `dst_${n}`, state, 'OCH', n, true)
	}

	const hwMeters = hasHwMeters(state, config)
	const hwSignals = signals && state.isXNode2
	if (hwSignals || hwMeters) {
		for (const [dir, prefix, group] of [
			['in', 'hwi', 'HWI'],
			['out', 'hwo', 'HWO'],
		] as const) {
			for (const p of physPorts(state, dir)) {
				if (hwSignals) v[`${prefix}_${p.n}_signal`] = signalState(state.lvl[group].get(p.n), levelsReady)
				if (hwMeters) setPeaks(v, `${prefix}_${p.n}`, state, group, p.n, p.stereo)
			}
		}
	}

	if (state.hasMixer) {
		for (const out of state.ioMap.outputs) v[`mix_out_${out.number}_inputs`] = mixOutputSummary(state, out.number)
		if (config.exposeXpointVariables) {
			for (const out of state.ioMap.outputs)
				for (const inp of state.ioMap.inputs) {
					const g = state.getXpoint(out.number, inp.number)
					v[`xp_${out.number}_${inp.number}`] = isXpointOn(g) ? formatDb(g as number) : ''
				}
		}
	}

	for (const n of range(state.ninp)) {
		const a = state.inp.get(n)
		v[`inp_${n}_name`] = a?.NAME ?? ''
		v[`inp_${n}_type`] = inpTypeLabel(a?.TYPE)
		if (isMicInput(a)) {
			v[`inp_${n}_gain`] = gainText(a?.GAIN)
			v[`inp_${n}_phantom`] = a?.PHPW === undefined ? '' : a.PHPW === '1' ? 'on' : 'off'
		}
	}
	for (const n of range(state.ngpi)) v[`gpi_${n}`] = state.gpi.get(n) ?? ''
	for (const n of range(state.ngpo)) {
		v[`gpo_${n}`] = state.gpo.get(n) ?? ''
		v[`gpo_${n}_name`] = state.cfgGpo.get(n)?.NAME ?? ''
	}
	return v
}

// ------------------------------------------------------------------ feedback evaluation

export type XpointCondition = 'any' | 'gte' | 'eq'

/** Crosspoint(s) on; for several crosspoints (stereo pair) all must match. `xpoints` come from resolveXpoints. */
export function evaluateXpointActive(
	state: XNodeState,
	xpoints: ReadonlyArray<readonly [number, number]>,
	condition: XpointCondition,
	gainDb: number,
): boolean {
	if (xpoints.length === 0) return false
	const limit = condition === 'any' || !Number.isFinite(gainDb) ? 0 : dbToTenths(gainDb)
	return xpoints.every(([o, i]) => {
		const g = state.getXpoint(o, i)
		if (g === undefined || !isXpointOn(g)) return false
		if (condition === 'gte') return g >= limit
		if (condition === 'eq') return g === limit
		return true
	})
}

/** Every resolved output row has exactly the given input on, and nothing else. */
export function evaluateOutputExclusive(state: XNodeState, xpoints: ReadonlyArray<readonly [number, number]>): boolean {
	if (xpoints.length === 0) return false
	return xpoints.every(([o, i]) => {
		const row = state.mix.get(o)
		if (!row || !isXpointOn(row.get(i))) return false
		for (const [input, g] of row) if (input !== i && isXpointOn(g)) return false
		return true
	})
}

export type DstTarget =
	| { target: 'known'; known: string }
	| { target: 'channel'; channel: number; kind: ChannelKind }
	| { target: 'address'; address: string }

/** Normalised IP/address the target stands for, or '' when invalid */
export function dstTargetAddr(t: DstTarget): string {
	try {
		if (t.target === 'known') return normaliseAddr(t.known)
		if (t.target === 'channel') return channelToMulticast(Number(t.channel), t.kind)
		return normaliseAddr(t.address)
	} catch {
		return ''
	}
}

export function evaluateDstConnectedTo(state: XNodeState, dst: number, t: DstTarget): boolean {
	const want = dstTargetAddr(t)
	if (want === '') return false
	const cur = normaliseAddr(state.dst.get(dst)?.ADDR ?? '')
	return cur !== '' && cur === want
}

export function evaluateDstConnected(state: XNodeState, dst: number): boolean {
	return (state.dst.get(dst)?.ADDR ?? '').trim() !== ''
}

export function evaluateSrcEnabled(state: XNodeState, src: number): boolean {
	return state.src.get(src)?.RTPE === '1'
}

export type LevelSideOption = 'L' | 'R' | 'either' | 'both'
export type LevelCondition = 'present' | 'silence' | 'clip'

export function evaluateLevelState(
	state: XNodeState,
	levelsReady: boolean,
	group: MeterKind,
	index: number,
	side: LevelSideOption,
	condition: LevelCondition,
): boolean {
	if (!levelsReady) return false
	const sides = state.lvl[group].get(index)
	if (!sides) return false
	const test = (s: LevelState | undefined): boolean => {
		if (!s) return false
		if (condition === 'clip') return s.clip === true
		if (condition === 'silence') return s.low === true
		return s.low === false
	}
	if (sides.mono) return test(sides.mono)
	if (side === 'L') return test(sides.L)
	if (side === 'R') return test(sides.R)
	return side === 'both' ? test(sides.L) && test(sides.R) : test(sides.L) || test(sides.R)
}

export function evaluateFactoryMode(state: XNodeState): boolean {
	return state.mixcfgMode !== undefined && state.mixcfgMode !== 0
}

export function evaluateXpointBudget(state: XNodeState, threshold: number): boolean {
	return state.xpointsUsed() >= threshold
}

export function evaluateGpioActive(pins: string | undefined, pin: number): boolean {
	return pins?.[pin - 1] === 'l'
}

export function evaluatePhantom(state: XNodeState, input: number): boolean {
	const a = state.inp.get(input)
	return isMicInput(a) && a?.PHPW === '1'
}

// ------------------------------------------------------------------ change mapping

export type FeedbackId =
	| 'mix_xpoint_active'
	| 'mix_output_exclusive'
	| 'dst_connected_to'
	| 'dst_connected'
	| 'src_enabled'
	| 'level_state'
	| 'mixer_factory_mode'
	| 'xpoint_budget'
	| 'gpi_active'
	| 'gpo_active'
	| 'mic_phantom'

export const ALL_FEEDBACK_IDS: readonly FeedbackId[] = [
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

const FEEDBACKS_BY_KIND: Partial<Record<StateKind, readonly FeedbackId[]>> = {
	ver: ALL_FEEDBACK_IDS,
	mix: ['mix_xpoint_active', 'mix_output_exclusive', 'xpoint_budget'],
	mixcfg: ['mixer_factory_mode'],
	dst: ['dst_connected_to', 'dst_connected'],
	src: ['src_enabled'],
	lvl: ['level_state'],
	gpi: ['gpi_active'],
	gpo: ['gpo_active'],
	inp: ['mic_phantom'],
}

/** Feedback ids to re-check for a batch of state changes (deduplicated). */
export function feedbackIdsForChanges(changes: readonly Pick<StateChange, 'kind'>[]): FeedbackId[] {
	const ids = new Set<FeedbackId>()
	for (const c of changes) for (const id of FEEDBACKS_BY_KIND[c.kind] ?? []) ids.add(id)
	return [...ids]
}
