import type { LwrpLine } from '../lwrp/parser.js'
import { XPOINT_OFF_TENTHS } from '../lwrp/units.js'
import { buildIoMap, type MixIoMap, type NameLookup } from './iomap.js'

export type Attrs = Record<string, string>
export type MeterKind = 'ICH' | 'OCH' | 'HWI' | 'HWO'
export type LevelSide = 'L' | 'R' | 'mono'

export interface LevelState {
	low?: boolean
	clip?: boolean
	updatedAt: number
}

export interface MeterReading {
	/** Peak in tenths of dBFS; -1000 is the floor */
	l: number
	/** Undefined for mono channels */
	r?: number
	updatedAt: number
}

export interface IpInfo {
	addr?: string
	link?: boolean
	hostname?: string
}

export type StateKind =
	'ver' | 'ip' | 'set' | 'src' | 'dst' | 'inp' | 'cfgGpo' | 'mix' | 'mixcfg' | 'gpi' | 'gpo' | 'lvl' | 'mtr'

export interface StateChange {
	kind: StateKind
	/** SRC/DST/INP/GPIO port/mixer output/meter channel number, when applicable */
	index?: number
	/** Meter group for `lvl` / `mtr` */
	group?: MeterKind
	/** A name (PSNM, DST NAME, INP NAME, CFG GPO NAME) or VER changed: definitions need rebuilding */
	rebuild: boolean
}

const METER_KINDS: readonly string[] = ['ICH', 'OCH', 'HWI', 'HWO']
const NAME_KEYS: Partial<Record<StateKind, string>> = { src: 'PSNM', dst: 'NAME', inp: 'NAME', cfgGpo: 'NAME' }

function int(v: string | undefined): number {
	const n = Number.parseInt(v ?? '', 10)
	return Number.isFinite(n) && n > 0 ? n : 0
}

function index(s: string | undefined): number | null {
	return s !== undefined && /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null
}

/** Merge `incoming` into `target`; returns the keys whose value changed. */
function mergeAttrs(target: Attrs, incoming: Attrs): string[] {
	const changed: string[] = []
	for (const [k, v] of Object.entries(incoming)) {
		if (target[k] !== v) {
			target[k] = v
			changed.push(k)
		}
	}
	return changed
}

function sameAttrs(a: Attrs, b: Attrs): boolean {
	const ka = Object.keys(a)
	return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

function parseLwrpVersion(v: string | undefined): [number, number] {
	const m = /^(\d+)\.(\d+)/.exec(v ?? '')
	return m ? [Number(m[1]), Number(m[2])] : [0, 0]
}

export class XNodeState implements NameLookup {
	ver: Attrs = {}
	isXNode2 = false
	hasMixer = false
	nsrc = 0
	ndst = 0
	/** Number of mixer rows (VER MIX) */
	nmix = 0
	ngpi = 0
	ngpo = 0
	/** Number of INP objects; always 0 on legacy nodes (their VER INP is bogus) */
	ninp = 0
	ioMap: MixIoMap = buildIoMap({})

	ip: IpInfo = {}
	set: Attrs = {}
	src = new Map<number, Attrs>()
	dst = new Map<number, Attrs>()
	/** output -> (input -> tenths); inputs that are off are absent */
	mix = new Map<number, Map<number, number>>()
	mixcfgMode: number | undefined
	inp = new Map<number, Attrs>()
	gpi = new Map<number, string>()
	gpo = new Map<number, string>()
	cfgGpo = new Map<number, Attrs>()
	lvl: Record<MeterKind, Map<number, Partial<Record<LevelSide, LevelState>>>> = {
		ICH: new Map(),
		OCH: new Map(),
		HWI: new Map(),
		HWO: new Map(),
	}
	mtr: Record<MeterKind, Map<number, MeterReading>> = {
		ICH: new Map(),
		OCH: new Map(),
		HWI: new Map(),
		HWO: new Map(),
	}

	constructor(private readonly now: () => number = Date.now) {}

	reset(): void {
		const fresh = new XNodeState(this.now)
		Object.assign(this, { ...fresh, now: this.now })
	}

	srcName(n: number): string | undefined {
		return this.src.get(n)?.PSNM || undefined
	}
	dstName(n: number): string | undefined {
		return this.dst.get(n)?.NAME || undefined
	}
	inpName(n: number): string | undefined {
		return this.inp.get(n)?.NAME || undefined
	}

	getXpoint(output: number, input: number): number | undefined {
		return this.mix.get(output)?.get(input)
	}

	/** Number of crosspoints that are on (gain > -1000) */
	xpointsUsed(): number {
		let count = 0
		for (const row of this.mix.values()) for (const g of row.values()) if (g > XPOINT_OFF_TENTHS) count++
		return count
	}

	/** The single merge path for every line, whether a query answer or a push. Null when nothing changed or the line is not state. */
	applyLine(line: LwrpLine): StateChange | null {
		const { verb, args, attrs } = line
		switch (verb) {
			case 'VER':
				return this.applyVer(attrs)
			case 'IP':
				return this.applyIp(args, attrs)
			case 'SET':
				return mergeAttrs(this.set, attrs).length ? { kind: 'set', rebuild: false } : null
			case 'SRC':
				return this.applyObject('src', this.src, args[0], attrs)
			case 'DST':
				return this.applyObject('dst', this.dst, args[0], attrs)
			case 'INP':
				return this.applyObject('inp', this.inp, args[0], attrs)
			case 'CFG':
				return args[0] === 'GPO' ? this.applyObject('cfgGpo', this.cfgGpo, args[1], attrs) : null
			case 'MIX':
				return this.applyMix(args[0], attrs)
			case 'MIXCFG': {
				const mode = attrs.MODE === undefined ? NaN : Number.parseInt(attrs.MODE, 10)
				if (!Number.isFinite(mode) || mode === this.mixcfgMode) return null
				this.mixcfgMode = mode
				return { kind: 'mixcfg', rebuild: false }
			}
			case 'GPI':
				return this.applyGpio('gpi', this.gpi, args)
			case 'GPO':
				return this.applyGpio('gpo', this.gpo, args)
			case 'LVL':
				return this.applyLvl(args)
			case 'MTR':
				return this.applyMtr(args, attrs)
			default:
				return null
		}
	}

	private applyVer(attrs: Attrs): StateChange | null {
		if (Object.keys(attrs).length === 0 || sameAttrs(this.ver, attrs)) return null
		this.ver = { ...attrs }
		const [major, minor] = parseLwrpVersion(attrs.LWRP)
		this.isXNode2 =
			(attrs.DEVN ?? '').toLowerCase().startsWith('axiaxnode2.') || major > 1 || (major === 1 && minor >= 4)
		this.nsrc = int(attrs.NSRC)
		this.ndst = int(attrs.NDST)
		this.nmix = int(attrs.MIX)
		this.hasMixer = this.nmix > 0
		this.ngpi = int(attrs.NGPI)
		this.ngpo = int(attrs.NGPO)
		this.ninp = this.isXNode2 ? int(attrs.INP) : 0
		this.ioMap = buildIoMap(attrs)
		return { kind: 'ver', rebuild: true }
	}

	private applyIp(args: string[], attrs: Attrs): StateChange | null {
		let changed = false
		const set = <K extends keyof IpInfo>(key: K, value: IpInfo[K]): void => {
			if (this.ip[key] !== value) {
				this.ip[key] = value
				changed = true
			}
		}
		if (attrs.ADDR !== undefined) set('addr', attrs.ADDR)
		if (attrs.LINK !== undefined) set('link', attrs.LINK === '1')
		if (args[0]?.toLowerCase() === 'hostname' && args[1] !== undefined) set('hostname', args[1])
		return changed ? { kind: 'ip', rebuild: false } : null
	}

	private applyObject(
		kind: 'src' | 'dst' | 'inp' | 'cfgGpo',
		map: Map<number, Attrs>,
		idx: string | undefined,
		attrs: Attrs,
	): StateChange | null {
		const n = index(idx)
		if (n === null) return null
		let target = map.get(n)
		if (!target) {
			target = {}
			map.set(n, target)
		}
		const changed = mergeAttrs(target, attrs)
		if (changed.length === 0) return null
		const nameKey = NAME_KEYS[kind]
		return { kind, index: n, rebuild: nameKey !== undefined && changed.includes(nameKey) }
	}

	private applyMix(idx: string | undefined, attrs: Attrs): StateChange | null {
		const out = index(idx)
		if (out === null) return null
		const row = new Map<number, number>()
		for (const [key, value] of Object.entries(attrs)) {
			const input = index(key)
			if (input === null || value === '-') continue
			const tenths = Number(value)
			if (!Number.isInteger(tenths) || tenths <= XPOINT_OFF_TENTHS - 1) continue
			row.set(input, tenths)
		}
		const old = this.mix.get(out)
		this.mix.set(out, row)
		const same = old ? old.size === row.size && [...row].every(([i, g]) => old.get(i) === g) : row.size === 0
		return same ? null : { kind: 'mix', index: out, rebuild: false }
	}

	private applyGpio(kind: 'gpi' | 'gpo', map: Map<number, string>, args: string[]): StateChange | null {
		const n = index(args[0])
		if (n === null || !/^[hl]+$/i.test(args[1] ?? '')) return null
		const pins = args[1].toLowerCase()
		if (map.get(n) === pins) return null
		map.set(n, pins)
		return { kind, index: n, rebuild: false }
	}

	private applyLvl(args: string[]): StateChange | null {
		// LVL ICH 1.L NO-CLIP  (mono: 1.1)
		const [group, chan, status] = args
		const m = /^(\d+)\.([LR1])$/.exec(chan ?? '')
		if (!METER_KINDS.includes(group) || !m || !status) return null
		const key = status.toUpperCase()
		const field = key.endsWith('LOW') ? 'low' : key.endsWith('CLIP') ? 'clip' : null
		if (!field) return null
		const value = !key.startsWith('NO-')
		const n = Number(m[1])
		const side: LevelSide = m[2] === 'L' ? 'L' : m[2] === 'R' ? 'R' : 'mono'
		const map = this.lvl[group as MeterKind]
		const sides = map.get(n) ?? {}
		const cur = sides[side]
		if (cur && cur[field] === value) return null
		sides[side] = { ...cur, [field]: value, updatedAt: this.now() }
		map.set(n, sides)
		return { kind: 'lvl', index: n, group: group as MeterKind, rebuild: false }
	}

	private applyMtr(args: string[], attrs: Attrs): StateChange | null {
		const [group, idx] = args
		const n = index(idx)
		if (!METER_KINDS.includes(group) || n === null || attrs.PEEK === undefined) return null
		const [l, r] = attrs.PEEK.split(/:(?=-?\d)/).map((v) => Number.parseInt(v, 10))
		if (!Number.isFinite(l)) return null
		const reading: MeterReading = { l, r: r !== undefined && Number.isFinite(r) ? r : undefined, updatedAt: this.now() }
		const map = this.mtr[group as MeterKind]
		const old = map.get(n)
		map.set(n, reading)
		return old && old.l === l && old.r === reading.r
			? null
			: { kind: 'mtr', index: n, group: group as MeterKind, rebuild: false }
	}
}
