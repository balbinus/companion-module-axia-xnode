/**
 * Livewire partyline: the source advertisement protocol, CMsg2 messages multicast to 239.192.255.3:4001.
 * See _research/partyline/CMsg2-erratum.md (not in the repository) for the reverse-engineered format.
 */

import { leafBigInt, leafMessage, leafNumber, leafString, parseCMsg2, type CMsg2Message } from './cmsg2.js'

export const PARTYLINE_GROUP = '239.192.255.3'
export const PARTYLINE_PORT = 4001

/** ADVT 2 = keepalive, 1 = full advert, 3 = source usage (BUSY) */
export type AdvertKind = 'keepalive' | 'full' | 'usage'

export interface AdvertisedSource {
	/** Slot key in the advert (`S001`, `S201`…). Not contiguous: key sources by channel. */
	slot: string
	/** PSID: Livewire channel number */
	channel: number
	/** PSNM, cut at the first NUL and trimmed */
	name: string
	/** FSID, dotted quad: the source's audio (239.192.x.y; 239.193.x.y for a console's backfeed source) */
	streamAddress: string
	/** BSID, dotted quad: the backfeed towards this source (239.193.x.y) */
	backfeedAddress: string
}

/** The console engine that owns a source (backfeed and source GPIO), from BUSY */
export interface SourceUser {
	engineIp: string
	/** 1-based fader number (BUSY carries it 0-based) */
	fader: number
}

export interface SourceUsage {
	channel: number
	/** null when no engine uses the source (BUSY = 0) */
	usedBy: SourceUser | null
}

export interface PartylineAdvert {
	kind: AdvertKind
	/** TERM.INIP when present and non-zero, else the UDP sender address (usage adverts carry no INIP) */
	deviceIp: string
	/** TERM.HWID */
	hwid?: number
	/** TERM.ADVV: config version. Compare for equality only: it restarts from a low value on reboot. */
	configVersion?: number
	/** TERM.NUMS: total number of sources the device advertises */
	sourceCount?: number
	/** TERM.ATRN */
	deviceName?: string
	/** Full adverts: the sources in this datagram. A full advert can span several datagrams with the same configVersion. */
	sources: AdvertisedSource[]
	/** Usage adverts: BUSY per source */
	usage: SourceUsage[]
}

const SLOT_RE = /^S\d{3}$/

/** u32 to dotted quad */
function dottedQuad(n: number): string {
	return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
}

function kindOf(advt: number | undefined): AdvertKind | undefined {
	switch (advt) {
		case 1:
			return 'full'
		case 2:
			return 'keepalive'
		case 3:
			return 'usage'
		default:
			return undefined
	}
}

/** The `Snnn` leaves that hold a nested message, in packet order */
function* slots(msg: CMsg2Message): Generator<[string, CMsg2Message]> {
	for (const leaf of msg.leaves) {
		if (SLOT_RE.test(leaf.name) && typeof leaf.value === 'object') yield [leaf.name, leaf.value]
	}
}

/** A missing address stays '' rather than dropping the source: name and channel are still useful */
function addressOf(src: CMsg2Message, key: string): string {
	const n = leafNumber(src, key)
	return n === undefined ? '' : dottedQuad(n)
}

function decodeSources(msg: CMsg2Message): AdvertisedSource[] {
	const out: AdvertisedSource[] = []
	for (const [slot, src] of slots(msg)) {
		const channel = leafNumber(src, 'PSID')
		if (channel === undefined) continue
		out.push({
			slot,
			channel,
			name: (leafString(src, 'PSNM') ?? '').trim(),
			streamAddress: addressOf(src, 'FSID'),
			backfeedAddress: addressOf(src, 'BSID'),
		})
	}
	return out
}

/** BUSY bytes b0..b7: b2-3 = engine IP low half, b4-5 = fader (0-based), b6-7 = engine IP high half, b0-1 unknown. 0 = unused. */
function decodeBusy(busy: bigint): SourceUser | null {
	if (busy === 0n) return null
	const b = Buffer.alloc(8)
	b.writeBigUInt64BE(busy)
	return { engineIp: `${b[6]}.${b[7]}.${b[2]}.${b[3]}`, fader: b.readUInt16BE(4) + 1 }
}

function decodeUsage(msg: CMsg2Message): SourceUsage[] {
	const out: SourceUsage[] = []
	for (const [, src] of slots(msg)) {
		const channel = leafNumber(src, 'PSID')
		const busy = leafBigInt(src, 'BUSY')
		if (channel === undefined || busy === undefined) continue
		out.push({ channel, usedBy: decodeBusy(busy) })
	}
	return out
}

/** Decode one partyline datagram. Returns null for anything that is not a well-formed advert. */
export function decodeAdvert(buf: Buffer, senderIp: string): PartylineAdvert | null {
	const msg = parseCMsg2(buf)?.message
	if (msg?.name !== 'NEST') return null
	const kind = kindOf(leafNumber(msg, 'ADVT'))
	const term = leafMessage(msg, 'TERM')
	if (kind === undefined || term === undefined) return null

	const inip = leafNumber(term, 'INIP')
	const advert: PartylineAdvert = {
		kind,
		deviceIp: inip ? dottedQuad(inip) : senderIp,
		sources: kind === 'full' ? decodeSources(msg) : [],
		usage: kind === 'usage' ? decodeUsage(msg) : [],
	}
	const hwid = leafNumber(term, 'HWID')
	if (hwid !== undefined) advert.hwid = hwid
	const configVersion = leafNumber(term, 'ADVV')
	if (configVersion !== undefined) advert.configVersion = configVersion
	const sourceCount = leafNumber(term, 'NUMS')
	if (sourceCount !== undefined) advert.sourceCount = sourceCount
	const deviceName = leafString(term, 'ATRN')
	if (deviceName !== undefined) advert.deviceName = deviceName.trim()
	return advert
}
