/**
 * CMsg2 binary protocol decoder (parse only), as used by the Livewire partyline adverts.
 * See _research/partyline/CMsg2-erratum.md (not in the repository) for the reverse-engineered grammar.
 *
 * The header API (`CMSG2_MAGIC`, `CMSG2_HEADER_SIZE`, `CMsg2Header`, `parseCMsg2Header`) is identical to
 * companion-module-axia-livewire-gpio's `src/cmsg2.ts`. The rest is not: a recursive decoder that also supports
 * strings (0x03) and nested messages (0x06), rejects the whole packet on an unknown type (that module skips it as if
 * it had no value, then misparses every following leaf), and has no packet builder.
 * `CMsg2Field` is this module's leaf; it is not that module's `CMsg2Leaf` (`{ lcid, type, rawValue }`).
 *
 * Grammar, everything big-endian:
 *
 *     packet  := magic:u32 pktNum:u32 filler[8]=0 message
 *     message := name[4] numLeaves:u16 leaf*
 *     leaf    := key[4] type:u8 value
 *     value   := u32 | u8 | u16 | u64               (types 0x01, 0x07, 0x08, 0x09)
 *              | len:u16 bytes[len]                 (type 0x03, string: NUL-padded buffer, cut at the first NUL)
 *              | len:u16 message                    (type 0x06, nested: the message must fill exactly `len` bytes)
 */

export const CMSG2_MAGIC = 0x03000207
export const CMSG2_HEADER_SIZE = 22

/** Leaf value types seen on the wire. Any other type makes `parseCMsg2` reject the packet. */
export const CMSG2_TYPE = {
	INT32: 0x01,
	STRING: 0x03,
	MESSAGE: 0x06,
	INT8: 0x07,
	INT16: 0x08,
	INT64: 0x09,
} as const

/** Messages nested deeper than this are rejected (real adverts nest 1 level). */
export const CMSG2_MAX_DEPTH = 8

export interface CMsg2Header {
	magic: number
	pktNum: number
	messageName: string
	numLeaves: number
}

/** u8, u16 and u32 are `number`; u64 is `bigint`; a string is cut at its first NUL (latin1); type 0x06 is a nested message. */
export type CMsg2Value = number | bigint | string | CMsg2Message

export interface CMsg2Field {
	/** The raw 4-byte key, big-endian */
	key: number
	/** The key as 4 ASCII characters when all four bytes are printable, else 8 hex digits (`ffffffff`) */
	name: string
	/** Wire type (see `CMSG2_TYPE`) */
	type: number
	value: CMsg2Value
}

export interface CMsg2Message {
	name: string
	leaves: CMsg2Field[]
}

export interface CMsg2Packet {
	header: CMsg2Header
	/** The top-level message (`header.messageName`, `header.numLeaves` leaves) */
	message: CMsg2Message
}

/**
 * Parse the 22-byte CMsg2 header from a buffer.
 * Returns null if the buffer is too short or the magic/filler are invalid.
 * Kept identical to livewire-gpio's, so `messageName` is 'ascii': the high bit is masked and CE C5 D3 D4 reads as
 * "NEST". The names inside `parseCMsg2`'s messages are 'latin1' and keep it.
 */
export function parseCMsg2Header(buf: Buffer): CMsg2Header | null {
	if (buf.length < CMSG2_HEADER_SIZE) {
		return null
	}

	const magic = buf.readUInt32BE(0)
	if (magic !== CMSG2_MAGIC) {
		return null
	}

	// Verify filler is zero (bytes 8–15)
	for (let i = 8; i < 16; i++) {
		if (buf[i] !== 0) {
			return null
		}
	}

	return {
		magic,
		pktNum: buf.readUInt32BE(4),
		messageName: buf.toString('ascii', 16, 20),
		numLeaves: buf.readUInt16BE(20),
	}
}

/** Byte size of the fixed-width value types */
const FIXED_SIZE: Readonly<Partial<Record<number, number>>> = {
	[CMSG2_TYPE.INT32]: 4,
	[CMSG2_TYPE.INT8]: 1,
	[CMSG2_TYPE.INT16]: 2,
	[CMSG2_TYPE.INT64]: 8,
}

function keyName(buf: Buffer, pos: number): string {
	for (let i = pos; i < pos + 4; i++) {
		if (buf[i] < 0x20 || buf[i] > 0x7e) return buf.toString('hex', pos, pos + 4)
	}
	return buf.toString('latin1', pos, pos + 4)
}

/** Parse one message occupying `[pos, end)` at most; returns it with the offset just after its last leaf. */
function parseMessage(buf: Buffer, pos: number, end: number, depth: number): [CMsg2Message, number] | null {
	if (depth > CMSG2_MAX_DEPTH || pos + 6 > end) return null
	// latin1, not ascii, which would mask the high bit
	const name = buf.toString('latin1', pos, pos + 4)
	const count = buf.readUInt16BE(pos + 4)
	pos += 6

	const leaves: CMsg2Field[] = []
	for (let i = 0; i < count; i++) {
		if (pos + 5 > end) return null
		const key = buf.readUInt32BE(pos)
		const leafName = keyName(buf, pos)
		const type = buf[pos + 4]
		pos += 5

		let value: CMsg2Value
		const size = FIXED_SIZE[type]
		if (size !== undefined) {
			if (pos + size > end) return null
			switch (type) {
				case CMSG2_TYPE.INT32:
					value = buf.readUInt32BE(pos)
					break
				case CMSG2_TYPE.INT16:
					value = buf.readUInt16BE(pos)
					break
				case CMSG2_TYPE.INT8:
					value = buf[pos]
					break
				default:
					value = buf.readBigUInt64BE(pos)
			}
			pos += size
		} else if (type === CMSG2_TYPE.STRING || type === CMSG2_TYPE.MESSAGE) {
			if (pos + 2 > end) return null
			const len = buf.readUInt16BE(pos)
			pos += 2
			if (pos + len > end) return null
			if (type === CMSG2_TYPE.STRING) {
				const nul = buf.subarray(pos, pos + len).indexOf(0)
				value = buf.toString('latin1', pos, nul === -1 ? pos + len : pos + nul)
			} else {
				const inner = parseMessage(buf, pos, pos + len, depth + 1)
				if (!inner || inner[1] !== pos + len) return null
				value = inner[0]
			}
			pos += len
		} else {
			return null
		}
		leaves.push({ key, name: leafName, type, value })
	}
	return [{ name, leaves }, pos]
}

/**
 * Decode a whole CMsg2 packet, nested messages included.
 * Returns null for anything malformed (bad magic or filler, truncation, unknown leaf type, a nested message that does
 * not fill its length, trailing bytes after the last leaf, nesting deeper than `CMSG2_MAX_DEPTH`). Never throws.
 */
export function parseCMsg2(buf: Buffer): CMsg2Packet | null {
	const header = parseCMsg2Header(buf)
	if (!header) return null
	const parsed = parseMessage(buf, 16, buf.length, 0)
	if (!parsed || parsed[1] !== buf.length) return null
	return { header, message: parsed[0] }
}

/** First leaf of that name (4 ASCII characters, or the 8 hex digits of an unprintable key) */
export function findLeaf(message: CMsg2Message, name: string): CMsg2Field | undefined {
	return message.leaves.find((l) => l.name === name)
}

/** Wire types that decode to a `number` */
export type CMsg2IntType = typeof CMSG2_TYPE.INT8 | typeof CMSG2_TYPE.INT16 | typeof CMSG2_TYPE.INT32

/**
 * Value of a u8/u16/u32 leaf, undefined when absent or of another type.
 * With `type`, a leaf of another width is undefined too: a u8 where a u32 is expected is not that field.
 */
export function leafNumber(message: CMsg2Message, name: string, type?: CMsg2IntType): number | undefined {
	const leaf = findLeaf(message, name)
	return typeof leaf?.value === 'number' && (type === undefined || leaf.type === type) ? leaf.value : undefined
}

/** Value of a u64 leaf, undefined when absent or of another type */
export function leafBigInt(message: CMsg2Message, name: string): bigint | undefined {
	const v = findLeaf(message, name)?.value
	return typeof v === 'bigint' ? v : undefined
}

/** Value of a string leaf (already cut at the first NUL), undefined when absent or of another type */
export function leafString(message: CMsg2Message, name: string): string | undefined {
	const v = findLeaf(message, name)?.value
	return typeof v === 'string' ? v : undefined
}

/** Value of a nested message leaf, undefined when absent or of another type */
export function leafMessage(message: CMsg2Message, name: string): CMsg2Message | undefined {
	const v = findLeaf(message, name)?.value
	return typeof v === 'object' ? v : undefined
}
