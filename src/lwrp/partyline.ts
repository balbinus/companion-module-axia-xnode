/**
 * Livewire partyline: the source advertisement protocol, CMsg2 messages multicast to 239.192.255.3:4001.
 * See _research/partyline/CMsg2-erratum.md (not in the repository) for the reverse-engineered format.
 */

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

/** Decode one partyline datagram. Returns null for anything that is not a well-formed advert. */
export function decodeAdvert(_buf: Buffer, _senderIp: string): PartylineAdvert | null {
	throw new Error('decodeAdvert: not implemented yet')
}
