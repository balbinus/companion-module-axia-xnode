/** Livewire channel <-> multicast helpers and address parsing. */

export type ChannelKind = 'from' | 'to' | 'surround'

export const MAX_CHANNEL = 32767

const PREFIX: Record<ChannelKind, [number, number]> = {
	from: [239, 192],
	to: [239, 193],
	surround: [239, 196],
}

export function isValidChannel(n: number): boolean {
	return Number.isInteger(n) && n >= 1 && n <= MAX_CHANNEL
}

/** Channel N -> `239.192.(N>>8).(N&255)` (`239.193` for backfeed "to" sources, `239.196` for surround). */
export function channelToMulticast(n: number, kind: ChannelKind = 'from'): string {
	if (!isValidChannel(n)) throw new RangeError(`Invalid Livewire channel: ${n}`)
	const [a, b] = PREFIX[kind]
	return `${a}.${b}.${n >> 8}.${n & 255}`
}

function octets(ip: string): number[] | null {
	const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(ip)
	if (!m) return null
	const o = m.slice(1).map(Number)
	return o.every((v) => v <= 255) ? o : null
}

export function isIpv4(s: string): boolean {
	return octets(s) !== null
}

/** 224.0.0.0/4 */
export function isIpv4Multicast(s: string): boolean {
	const o = octets(s)
	return o !== null && o[0] >= 224 && o[0] <= 239
}

/** Reverse of channelToMulticast; null if the address is not a Livewire channel address. */
export function multicastToChannel(ip: string): { channel: number; kind: ChannelKind } | null {
	const o = octets(ip)
	if (!o) return null
	for (const kind of Object.keys(PREFIX) as ChannelKind[]) {
		const [a, b] = PREFIX[kind]
		if (o[0] === a && o[1] === b) {
			const channel = (o[2] << 8) | o[3]
			return isValidChannel(channel) ? { channel, kind } : null
		}
	}
	return null
}

export interface ParsedAddr {
	raw: string
	/** Multicast IP (computed as a "from" address when the device holds a bare channel number) */
	ip?: string
	/** Livewire channel number, when the address is one */
	channel?: number
	/** Livewire address kind when `channel` is set */
	kind?: ChannelKind
	/** Source label, without `<>` */
	label?: string
}

/** Parse a DST ADDR value: `""`, `239.192.87.30`, `22302`, `239.192.91.205 <Label>`, `239.192.91.205 Label`. */
export function parseDstAddr(addr: string): ParsedAddr {
	const raw = addr
	const m = /^\s*(\S+)(?:\s+(.*?))?\s*$/.exec(addr)
	if (!m) return { raw }
	const result: ParsedAddr = { raw }
	const head = m[1]
	if (isIpv4(head)) {
		result.ip = head
	} else if (/^\d+$/.test(head) && isValidChannel(Number(head))) {
		result.ip = channelToMulticast(Number(head), 'from')
	} else {
		return { raw }
	}
	const known = multicastToChannel(result.ip)
	if (known) {
		result.channel = known.channel
		result.kind = known.kind
	}
	if (m[2]) {
		const label = m[2].replace(/^<(.*)>$/, '$1').trim()
		if (label) result.label = label
	}
	return result
}

/** Canonical form for comparisons: the IP for IPs/channels (label dropped), '' when disconnected, else the trimmed input. */
export function normaliseAddr(addr: string): string {
	const p = parseDstAddr(addr)
	return p.ip ?? addr.trim()
}

export interface KnownSource {
	channel?: number
	ip: string
	label: string
}

/** Parse the "known sources" config text: `22301=Studio Mic 1` or `239.192.87.29=Name`, one per line, `#` comments. */
export function parseKnownSources(text: string): KnownSource[] {
	const out: KnownSource[] = []
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim()
		if (t === '' || t.startsWith('#')) continue
		const eq = t.indexOf('=')
		const key = (eq === -1 ? t : t.slice(0, eq)).trim()
		const label = eq === -1 ? '' : t.slice(eq + 1).trim()
		const p = parseDstAddr(key)
		if (!p.ip || key.includes(' ') || !isIpv4Multicast(p.ip)) continue
		out.push({ channel: p.channel, ip: p.ip, label: label || key })
	}
	return out
}
