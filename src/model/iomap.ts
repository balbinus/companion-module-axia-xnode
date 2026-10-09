/** Mixer I/O map built from VER (design section 4). Channels are mono, 1-based on the wire. */

export type MixChannelKind = 'src' | 'dst' | 'phys'
export type MixSide = 'L' | 'R' | 'mono'

export interface MixChannel {
	/** Mixer row (output) or column (input) number used on the wire */
	number: number
	kind: MixChannelKind
	/** SRC n / DST n / physical input or output pair n (for inputs this is also the xNode2 `INP` index) */
	owner: number
	side: MixSide
	/** Label without user names, e.g. `SRC 3 L`, `Line 2 R`, `Mic` */
	base: string
}

/** A stereo pair (pair id = left channel number, odd) or a single mono channel (`right` undefined). */
export interface MixPair {
	id: number
	left: MixChannel
	right?: MixChannel
}

export interface MixIoMap {
	hasMixer: boolean
	/** Matched DEVN suffix (`analog4x4`, `aes4x4`, `combo`, `mic`), or null for unknown models */
	model: string | null
	outputs: MixChannel[]
	inputs: MixChannel[]
	outputPairs: MixPair[]
	inputPairs: MixPair[]
}

/** Lookup of user-visible names; XNodeState implements it. */
export interface NameLookup {
	srcName(n: number): string | undefined
	dstName(n: number): string | undefined
	inpName(n: number): string | undefined
}

type VerAttrs = Readonly<Record<string, string>>

interface PhysSpec {
	/** Base names of stereo pairs, then of mono channels */
	pairs: string[]
	monos: string[]
}

const PHYS_INPUTS: Record<string, PhysSpec> = {
	analog4x4: { pairs: ['Line 1', 'Line 2', 'Line 3', 'Line 4'], monos: [] },
	aes4x4: { pairs: ['AES 1', 'AES 2', 'AES 3', 'AES 4'], monos: [] },
	combo: { pairs: ['Line 1', 'Line 2', 'Line 3', 'AES'], monos: ['Mic'] },
	mic: { pairs: [], monos: ['Mic 1', 'Mic 2', 'Mic 3', 'Mic 4'] },
}

const PHYS_OUTPUTS: Record<string, string[]> = {
	analog4x4: ['Line 1', 'Line 2', 'Line 3', 'Line 4'],
	aes4x4: ['AES 1', 'AES 2', 'AES 3', 'AES 4'],
	combo: ['Line 1', 'Line 2', 'Line 3', 'AES 4'],
	mic: ['Line 1', 'Line 2', 'Line 3', 'Line 4'],
}

function toInt(v: string | undefined): number {
	const n = Number.parseInt(v ?? '', 10)
	return Number.isFinite(n) && n > 0 ? n : 0
}

/** DEVN suffix after the last `.`, lowercase ('' if no DEVN) */
export function devnSuffix(devn: string | undefined): string {
	const d = (devn ?? '').toLowerCase()
	return d.slice(d.lastIndexOf('.') + 1)
}

function pairUp(channels: MixChannel[]): MixPair[] {
	const pairs: MixPair[] = []
	for (let i = 0; i < channels.length; i++) {
		const left = channels[i]
		const next = channels[i + 1]
		if (left.side === 'L' && next && next.side === 'R' && next.owner === left.owner && next.kind === left.kind) {
			pairs.push({ id: left.number, left, right: next })
			i++
		} else {
			pairs.push({ id: left.number, left })
		}
	}
	return pairs
}

function stereo(first: number, kind: MixChannelKind, owner: number, name: string): MixChannel[] {
	return [
		{ number: first, kind, owner, side: 'L', base: `${name} L` },
		{ number: first + 1, kind, owner, side: 'R', base: `${name} R` },
	]
}

/** Build the I/O map from VER attributes. No `MIX` attribute means no mixer. */
export function buildIoMap(ver: VerAttrs): MixIoMap {
	const nmix = toInt(ver.MIX)
	if (!nmix) return { hasMixer: false, model: null, outputs: [], inputs: [], outputPairs: [], inputPairs: [] }

	const suffix = devnSuffix(ver.DEVN)
	const known = suffix in PHYS_INPUTS
	const nsrc = toInt(ver.NSRC)
	const ndst = toInt(ver.NDST)

	// Outputs: SRC n L/R, then physical outputs
	const outputs: MixChannel[] = []
	for (let n = 1; n <= nsrc && outputs.length + 2 <= nmix; n++) outputs.push(...stereo(2 * n - 1, 'src', n, `SRC ${n}`))
	if (known) {
		PHYS_OUTPUTS[suffix].forEach((name, i) => {
			const first = 2 * nsrc + 2 * i + 1
			if (first + 1 <= nmix) outputs.push(...stereo(first, 'phys', i + 1, name))
		})
	} else {
		for (let n = 2 * nsrc + 1; n <= nmix; n++)
			outputs.push({ number: n, kind: 'phys', owner: n - 2 * nsrc, side: 'mono', base: `Out ${n}` })
	}

	// Inputs: DST n L/R, then physical inputs
	const inputs: MixChannel[] = []
	for (let n = 1; n <= ndst; n++) inputs.push(...stereo(2 * n - 1, 'dst', n, `DST ${n}`))
	const base = 2 * ndst
	if (known) {
		const spec = PHYS_INPUTS[suffix]
		let next = base + 1
		spec.pairs.forEach((name, i) => {
			inputs.push(...stereo(next, 'phys', i + 1, name))
			next += 2
		})
		spec.monos.forEach((name, i) => {
			inputs.push({ number: next, kind: 'phys', owner: spec.pairs.length + i + 1, side: 'mono', base: name })
			next++
		})
	} else {
		for (let n = base + 1; n <= 24; n++)
			inputs.push({ number: n, kind: 'phys', owner: n - base, side: 'mono', base: `In ${n}` })
	}

	return {
		hasMixer: true,
		model: known ? suffix : null,
		outputs,
		inputs,
		outputPairs: pairUp(outputs),
		inputPairs: pairUp(inputs),
	}
}

function userName(ch: MixChannel, names?: NameLookup): string | undefined {
	if (!names) return undefined
	const name = ch.kind === 'src' ? names.srcName(ch.owner) : ch.kind === 'dst' ? names.dstName(ch.owner) : undefined
	return name && name.trim() !== '' ? name : undefined
}

function physName(ch: MixChannel, isInput: boolean, names?: NameLookup): string | undefined {
	if (!names || !isInput || ch.kind !== 'phys') return undefined
	const name = names.inpName(ch.owner)
	return name && name.trim() !== '' ? name : undefined
}

function describe(base: string, owner: string, name: string | undefined): string {
	return name && name !== owner ? `${base} · ${name}` : base
}

/** `SRC 3 L · TEL 1`, `DST 2 R · Program 3`, `Line 1 L`, `Mic · Microphone 5` (the `·` suffix only when a distinct name is known). */
export function channelLabel(ch: MixChannel, isInput: boolean, names?: NameLookup): string {
	const owner = ch.kind === 'src' ? `SRC ${ch.owner}` : ch.kind === 'dst' ? `DST ${ch.owner}` : ''
	return describe(ch.base, owner, userName(ch, names) ?? physName(ch, isInput, names))
}

/** Pair label without side: `SRC 3 · TEL 1`; mono entries use the channel label. */
export function pairLabel(pair: MixPair, isInput: boolean, names?: NameLookup): string {
	if (!pair.right) return channelLabel(pair.left, isInput, names)
	const ch = pair.left
	const base = ch.base.replace(/ L$/, '')
	const owner = ch.kind === 'src' ? `SRC ${ch.owner}` : ch.kind === 'dst' ? `DST ${ch.owner}` : ''
	return describe(base, owner, userName(ch, names) ?? physName(ch, isInput, names))
}

export function findChannel(list: readonly MixChannel[], n: number): MixChannel | undefined {
	return list.find((c) => c.number === n)
}
