/** Tiny CMsg2 encoder for building synthetic (often malformed) packets in tests. Not part of the module. */

/** A 4-character key, or the raw 4 bytes */
export type Key = string | Buffer

function key(k: Key): Buffer {
	const b = typeof k === 'string' ? Buffer.from(k, 'latin1') : k
	if (b.length !== 4) throw new Error(`key must be 4 bytes: ${String(k)}`)
	return b
}

function be(bytes: number, value: number | bigint): Buffer {
	const b = Buffer.alloc(bytes)
	if (bytes === 8) b.writeBigUInt64BE(BigInt(value))
	else b.writeUIntBE(Number(value), 0, bytes)
	return b
}

/** Any leaf from its parts */
export function raw(k: Key, type: number, value: Buffer): Buffer {
	return Buffer.concat([key(k), Buffer.from([type]), value])
}

export const u8 = (k: Key, v: number): Buffer => raw(k, 0x07, be(1, v))
export const u16 = (k: Key, v: number): Buffer => raw(k, 0x08, be(2, v))
export const u32 = (k: Key, v: number): Buffer => raw(k, 0x01, be(4, v))
export const u64 = (k: Key, v: bigint): Buffer => raw(k, 0x09, be(8, v))

/** String leaf in a NUL-padded buffer of `width` bytes (default: just the text) */
export function str(k: Key, text: string, width = text.length): Buffer {
	const b = Buffer.alloc(width)
	b.write(text, 'latin1')
	return raw(k, 0x03, Buffer.concat([be(2, width), b]))
}

/** A message: name, leaf count and leaves. `count` overrides the leaf count. */
export function message(name: string, leaves: Buffer[], count = leaves.length): Buffer {
	return Buffer.concat([Buffer.from(name, 'latin1'), be(2, count), ...leaves])
}

/** Nested message leaf. `length` overrides the length field. */
export function nested(k: Key, name: string, leaves: Buffer[], length?: number): Buffer {
	const m = message(name, leaves)
	return raw(k, 0x06, Buffer.concat([be(2, length ?? m.length), m]))
}

/** The 16-byte packet prefix: magic, packet number, 8 zero bytes */
export function prefix(pktNum = 1): Buffer {
	return Buffer.concat([Buffer.from([0x03, 0x00, 0x02, 0x07]), be(4, pktNum), Buffer.alloc(8)])
}

/** A whole packet around a top-level message */
export function packet(name: string, leaves: Buffer[], pktNum = 1): Buffer {
	return Buffer.concat([prefix(pktNum), message(name, leaves)])
}
