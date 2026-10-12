import { describe, expect, it } from 'vitest'
import {
	CMSG2_HEADER_SIZE,
	CMSG2_MAGIC,
	CMSG2_MAX_DEPTH,
	CMSG2_TYPE,
	findLeaf,
	leafBigInt,
	leafMessage,
	leafNumber,
	leafString,
	parseCMsg2,
	parseCMsg2Header,
	type CMsg2Message,
} from '../../src/lwrp/cmsg2.js'
import { message, nested, packet, prefix, raw, str, u16, u32, u64, u8 } from '../fixtures/partyline/build.js'
import { PARTYLINE_FIXTURES, partylineFixture, type PartylineFixtureName } from '../fixtures/partyline/load.js'
import { rng } from '../fixtures/partyline/rng.js'

/** The decoded top-level message of a fixture */
function decoded(name: PartylineFixtureName): CMsg2Message {
	const p = parseCMsg2(partylineFixture(name))
	if (!p) throw new Error(`fixture ${name} does not decode`)
	return p.message
}

describe('constants', () => {
	it('match the sibling livewire-gpio module', () => {
		expect(CMSG2_MAGIC).toBe(0x03000207)
		expect(CMSG2_HEADER_SIZE).toBe(22)
	})
})

describe('parseCMsg2Header', () => {
	it('reads the 22-byte header of a real packet', () => {
		expect(parseCMsg2Header(partylineFixture('keepalive-xnode'))).toEqual({
			magic: CMSG2_MAGIC,
			pktNum: 0xc6056085,
			messageName: 'NEST',
			numLeaves: 3,
		})
	})

	it('accepts a bare header', () => {
		const buf = Buffer.concat([prefix(7), Buffer.from('READ'), Buffer.from([0x01, 0x02])])
		expect(buf.length).toBe(CMSG2_HEADER_SIZE)
		expect(parseCMsg2Header(buf)).toEqual({ magic: CMSG2_MAGIC, pktNum: 7, messageName: 'READ', numLeaves: 258 })
	})

	it('reads the message name as ascii, like livewire-gpio: the high bit is masked', () => {
		const buf = Buffer.concat([prefix(), Buffer.from([0xce, 0xc5, 0xd3, 0xd4, 0, 0])])
		expect(parseCMsg2Header(buf)?.messageName).toBe('NEST')
	})

	it('returns null below 22 bytes', () => {
		const buf = partylineFixture('keepalive-xnode')
		for (let n = 0; n < CMSG2_HEADER_SIZE; n++) expect(parseCMsg2Header(buf.subarray(0, n))).toBeNull()
	})

	it('returns null for a bad magic, whichever byte is wrong', () => {
		for (let i = 0; i < 4; i++) {
			const buf = Buffer.from(partylineFixture('keepalive-xnode'))
			buf[i] ^= 0x01
			expect(parseCMsg2Header(buf)).toBeNull()
		}
	})

	it('returns null for non-zero filler, whichever byte is set', () => {
		for (let i = 8; i < 16; i++) {
			const buf = Buffer.from(partylineFixture('keepalive-xnode'))
			buf[i] = 1
			expect(parseCMsg2Header(buf)).toBeNull()
		}
	})
})

describe('parseCMsg2 on real packets', () => {
	it('decodes a keepalive: header, leaf order, nested TERM', () => {
		const p = parseCMsg2(partylineFixture('keepalive-xnode'))
		expect(p?.header).toEqual({ magic: CMSG2_MAGIC, pktNum: 0xc6056085, messageName: 'NEST', numLeaves: 3 })
		expect(p?.message.name).toBe('NEST')
		expect(p?.message.leaves.map((l) => [l.name, l.type])).toEqual([
			['PVER', CMSG2_TYPE.INT16],
			['ADVT', CMSG2_TYPE.INT8],
			['TERM', CMSG2_TYPE.MESSAGE],
		])
		const term = leafMessage(p!.message, 'TERM')!
		expect(term.name).toBe('INDI')
		expect(term.leaves.map((l) => l.name)).toEqual(['ADVV', 'HWID', 'INIP', 'UDPC', 'NUMS'])
		expect(leafNumber(term, 'ADVV')).toBe(451)
		expect(leafNumber(term, 'HWID')).toBe(7903)
		expect(leafNumber(term, 'INIP')).toBe(0x0a601edf)
		expect(leafNumber(term, 'UDPC')).toBe(4000)
		expect(leafNumber(term, 'NUMS')).toBe(8)
	})

	it('keeps the raw key and wire type of each leaf', () => {
		const msg = decoded('keepalive-xnode')
		expect(findLeaf(msg, 'PVER')).toEqual({ key: 0x50564552, name: 'PVER', type: 0x08, value: 2 })
		expect(findLeaf(msg, 'ADVT')).toMatchObject({ key: 0x41445654, type: 0x07, value: 2 })
		const term = leafMessage(msg, 'TERM')!
		expect(findLeaf(term, 'ADVV')).toMatchObject({ type: 0x01, value: 451 })
	})

	it('decodes u64 as bigint and names an unprintable key by its 8 hex digits', () => {
		const msg = decoded('usage-xnode-fader1')
		const s1 = leafMessage(msg, 'S001')!
		expect(leafNumber(s1, 'PSID')).toBe(22301)
		expect(findLeaf(s1, 'BUSY')).toMatchObject({ type: 0x09, value: 0x00021eeb00000a60n })
		expect(findLeaf(msg, 'ffffffff')).toEqual({ key: 0xffffffff, name: 'ffffffff', type: 0x09, value: 0n })
		expect(findLeaf(msg, 'fffffffe')).toEqual({ key: 0xfffffffe, name: 'fffffffe', type: 0x09, value: 0n })
		expect(msg.leaves.at(-1)?.name).toBe('fffffffe')
	})

	it('cuts a string at its first NUL, ignoring the garbage after it', () => {
		const buf = partylineFixture('full-xnode-223')
		// The wire really has "SRC 8", NUL, then leftovers in the fixed buffer
		expect(buf.includes(Buffer.from('SRC 8\0h\0', 'latin1'))).toBe(true)
		const s8 = leafMessage(decoded('full-xnode-223'), 'S008')!
		expect(leafString(s8, 'PSNM')).toBe('SRC 8')
	})

	it('decodes the ETH4CAN: other leaf order, and a TYPE leaf that is a u32 holding ASCII', () => {
		const msg = decoded('full-eth4can')
		// ETH4CAN sends ADVT before PVER and HWID first in TERM: order is the sender's business
		expect(msg.leaves.map((l) => l.name)).toEqual(['ADVT', 'PVER', 'TERM'])
		const term = leafMessage(msg, 'TERM')!
		expect(term.leaves.map((l) => l.name)).toEqual(['HWID', 'ADVV', 'INIP', 'UDPC', 'NUMS', 'ATRN', 'TYPE'])
		expect(leafString(term, 'ATRN')).toBe('ETH4CAN_2')
		expect(leafNumber(term, 'TYPE')).toBe(Buffer.from('ECAN').readUInt32BE(0))
	})

	it('decodes every fixture, packet number and leaf count included', () => {
		for (const name of PARTYLINE_FIXTURES) {
			const buf = partylineFixture(name)
			const p = parseCMsg2(buf)
			expect(p, name).not.toBeNull()
			expect(p!.header.messageName, name).toBe('NEST')
			expect(p!.message.name, name).toBe('NEST')
			expect(p!.message.leaves.length, name).toBe(p!.header.numLeaves)
			expect(p!.header.pktNum, name).toBe(buf.readUInt32BE(4))
		}
	})

	it('works on a Buffer that is a view into a larger one', () => {
		const buf = partylineFixture('full-engine-part2')
		const view = Buffer.concat([Buffer.alloc(7, 0xaa), buf, Buffer.alloc(5, 0xbb)]).subarray(7, 7 + buf.length)
		expect(parseCMsg2(view)).toEqual(parseCMsg2(buf))
	})
})

describe('parseCMsg2 rejects malformed input', () => {
	it('rejects an empty buffer and anything below the header size', () => {
		expect(parseCMsg2(Buffer.alloc(0))).toBeNull()
		expect(parseCMsg2(Buffer.alloc(21))).toBeNull()
	})

	it('rejects a bad magic and non-zero filler', () => {
		const good = partylineFixture('keepalive-xnode')
		for (const i of [0, 1, 2, 3, 8, 9, 15]) {
			const buf = Buffer.from(good)
			buf[i] ^= 0x80
			expect(parseCMsg2(buf), `byte ${i}`).toBeNull()
		}
	})

	it('rejects every truncation of every fixture', () => {
		for (const name of PARTYLINE_FIXTURES) {
			const buf = partylineFixture(name)
			for (let n = 0; n < buf.length; n++) {
				expect(parseCMsg2(buf.subarray(0, n)), `${name} cut at ${n}`).toBeNull()
			}
			expect(parseCMsg2(buf), name).not.toBeNull()
		}
	})

	it('rejects trailing bytes after the last leaf', () => {
		for (const name of PARTYLINE_FIXTURES) {
			const buf = partylineFixture(name)
			expect(parseCMsg2(Buffer.concat([buf, Buffer.from([0])])), name).toBeNull()
			expect(parseCMsg2(Buffer.concat([buf, buf])), name).toBeNull()
		}
	})

	it('rejects a header that promises more leaves than the packet holds', () => {
		expect(parseCMsg2(Buffer.concat([prefix(), message('NEST', [u8('ADVT', 1)], 2)]))).toBeNull()
		expect(parseCMsg2(Buffer.concat([prefix(), message('NEST', [], 1)]))).toBeNull()
	})

	it('rejects a header that promises fewer leaves than the packet holds (trailing bytes)', () => {
		expect(parseCMsg2(Buffer.concat([prefix(), message('NEST', [u8('ADVT', 1), u8('PVER', 2)], 1)]))).toBeNull()
	})

	it('rejects unknown leaf types instead of misparsing what follows', () => {
		for (const type of [0x00, 0x02, 0x04, 0x05, 0x0a, 0x7f, 0xff]) {
			const p = packet('NEST', [u8('ADVT', 1), raw('XXXX', type, Buffer.alloc(4)), u8('PVER', 2)])
			expect(parseCMsg2(p), `type ${type}`).toBeNull()
		}
		// ... also inside a nested message
		expect(parseCMsg2(packet('NEST', [nested('TERM', 'INDI', [raw('XXXX', 0x02, Buffer.alloc(2))])]))).toBeNull()
	})

	it('rejects a string that overruns its message', () => {
		const long = Buffer.concat([Buffer.from([0x00, 0x20]), Buffer.from('short')])
		expect(parseCMsg2(packet('NEST', [raw('ATRN', 0x03, long)]))).toBeNull()
	})

	it('rejects a leaf whose fixed-width value is cut by the end of its nested message', () => {
		// The nested message ends 1 byte into a u32 even though the outer packet continues
		const inner = message('INDI', [u32('ADVV', 451)])
		const cut = inner.subarray(0, inner.length - 3)
		const leaf = raw('TERM', 0x06, Buffer.concat([Buffer.from([0, cut.length]), cut]))
		expect(parseCMsg2(packet('NEST', [leaf, u8('ADVT', 1)]))).toBeNull()
	})

	it('rejects a nested message whose length is too short, too long, or beyond the packet', () => {
		const leaves = [u32('ADVV', 451), u16('HWID', 7903)]
		const exact = message('INDI', leaves).length
		expect(parseCMsg2(packet('NEST', [nested('TERM', 'INDI', leaves)]))).not.toBeNull()
		for (const delta of [-1, 1, -exact, 100, 60000]) {
			const p = packet('NEST', [nested('TERM', 'INDI', leaves, exact + delta), u8('ADVT', 1)])
			expect(parseCMsg2(p), `delta ${delta}`).toBeNull()
		}
		// Padding inside the declared length: the nested message must end exactly there
		const padded = raw(
			'TERM',
			0x06,
			Buffer.concat([Buffer.from([0, exact + 2]), message('INDI', leaves), Buffer.alloc(2)]),
		)
		expect(parseCMsg2(packet('NEST', [padded]))).toBeNull()
	})

	it('rejects a nested message too short to hold name and count', () => {
		for (let len = 0; len < 6; len++) {
			const leaf = raw('TERM', 0x06, Buffer.concat([Buffer.from([0, len]), Buffer.alloc(len)]))
			expect(parseCMsg2(packet('NEST', [leaf])), `len ${len}`).toBeNull()
		}
	})

	it('rejects a nested message that promises more leaves than its length holds', () => {
		const inner = message('INDI', [u16('HWID', 1)], 2)
		const leaf = raw('TERM', 0x06, Buffer.concat([Buffer.from([0, inner.length]), inner]))
		// The second leaf would be the next top-level one: it must not be borrowed
		expect(parseCMsg2(packet('NEST', [leaf, u16('HWID', 2)]))).toBeNull()
	})

	it('limits nesting depth', () => {
		const chain = (depth: number): Buffer => {
			let leaves: Buffer[] = []
			for (let i = 0; i < depth; i++) leaves = [nested('TERM', 'INDI', leaves)]
			return packet('NEST', leaves)
		}
		expect(parseCMsg2(chain(1))).not.toBeNull()
		expect(parseCMsg2(chain(CMSG2_MAX_DEPTH))).not.toBeNull()
		expect(parseCMsg2(chain(CMSG2_MAX_DEPTH + 1))).toBeNull()
		expect(parseCMsg2(chain(2000))).toBeNull()
	})

	it('never throws on mutated or truncated real packets', () => {
		const next = rng(0xc0ffee)
		for (const name of PARTYLINE_FIXTURES) {
			const good = partylineFixture(name)
			for (let i = 0; i < 300; i++) {
				const buf = Buffer.from(good)
				for (let k = 1 + Math.floor(next() * 4); k > 0; k--)
					buf[Math.floor(next() * buf.length)] = Math.floor(next() * 256)
				const cut = next() < 0.3 ? buf.subarray(0, Math.floor(next() * buf.length)) : buf
				expect(() => parseCMsg2(cut), name).not.toThrow()
			}
		}
	})
})

describe('parseCMsg2 on synthetic packets', () => {
	it('accepts an empty message', () => {
		expect(parseCMsg2(packet('PING', []))?.message).toEqual({ name: 'PING', leaves: [] })
	})

	it('decodes every value type', () => {
		const p = parseCMsg2(
			packet('TEST', [
				u32('AAAA', 0xdeadbeef),
				u8('BBBB', 255),
				u16('CCCC', 65535),
				u64('DDDD', 0xfedcba9876543210n),
				str('EEEE', 'hi', 8),
				str('FFFF', ''),
				nested('GGGG', 'SUBM', [u8('HHHH', 7)]),
			]),
		)
		expect(p?.message.leaves.map((l) => l.value)).toEqual([
			0xdeadbeef,
			255,
			65535,
			0xfedcba9876543210n,
			'hi',
			'',
			{ name: 'SUBM', leaves: [{ key: 0x48484848, name: 'HHHH', type: 0x07, value: 7 }] },
		])
	})

	it('treats a string that fills its buffer as is, and a NUL-only buffer as empty', () => {
		const p = parseCMsg2(
			packet('TEST', [str('AAAA', 'abcd'), str('BBBB', '', 4), raw('CCCC', 0x03, Buffer.from([0, 3, 0, 0x41, 0x42]))]),
		)
		expect(p?.message.leaves.map((l) => l.value)).toEqual(['abcd', '', ''])
	})

	it('decodes string bytes as latin1', () => {
		const p = parseCMsg2(packet('TEST', [raw('AAAA', 0x03, Buffer.from([0, 3, 0x43, 0xe9, 0xff]))]))
		expect(p?.message.leaves[0].value).toBe('Céÿ')
	})

	it('names a key with any unprintable byte by its hex digits', () => {
		const keys = [
			Buffer.from([0x41, 0x42, 0x43, 0x00]),
			Buffer.from([0x1f, 0x42, 0x43, 0x44]),
			Buffer.from([0x41, 0x42, 0x43, 0x7f]),
			Buffer.from([0x41, 0x42, 0x43, 0x80]),
		]
		const p = parseCMsg2(packet('TEST', [...keys.map((k) => u8(k, 1)), u8(' ~Az', 1)]))
		expect(p?.message.leaves.map((l) => l.name)).toEqual(['41424300', '1f424344', '4142437f', '41424380', ' ~Az'])
	})

	it('decodes message names as latin1, so a high-bit name is not NEST (the header is ascii and says NEST)', () => {
		const name = '\u00ce\u00c5\u00d3\u00d4'
		const p = parseCMsg2(packet(name, [nested('SUBM', name, [])]))
		expect(p?.message.name).toBe(name)
		expect(p?.message.name).not.toBe('NEST')
		expect(leafMessage(p!.message, 'SUBM')?.name).toBe(name)
		expect(p?.header.messageName).toBe('NEST')
	})

	it('keeps leaf order and duplicates; findLeaf returns the first', () => {
		const msg = parseCMsg2(packet('TEST', [u8('DUPE', 1), u8('OTHR', 5), u8('DUPE', 2)]))!.message
		expect(msg.leaves.map((l) => l.value)).toEqual([1, 5, 2])
		expect(leafNumber(msg, 'DUPE')).toBe(1)
	})
})

describe('leaf helpers', () => {
	const msg = parseCMsg2(
		packet('TEST', [u16('NUMB', 12), u64('BIGG', 5n), str('TEXT', 'abc'), nested('SUBM', 'INDI', [u8('INNR', 1)])]),
	)!.message

	it('return the value for the matching type', () => {
		expect(leafNumber(msg, 'NUMB')).toBe(12)
		expect(leafBigInt(msg, 'BIGG')).toBe(5n)
		expect(leafString(msg, 'TEXT')).toBe('abc')
		expect(leafMessage(msg, 'SUBM')?.name).toBe('INDI')
		expect(findLeaf(msg, 'NUMB')?.type).toBe(CMSG2_TYPE.INT16)
	})

	it('leafNumber checks the wire width when given a type, and accepts any width when not', () => {
		expect(leafNumber(msg, 'NUMB', CMSG2_TYPE.INT16)).toBe(12)
		expect(leafNumber(msg, 'NUMB', CMSG2_TYPE.INT8)).toBeUndefined()
		expect(leafNumber(msg, 'NUMB', CMSG2_TYPE.INT32)).toBeUndefined()
		expect(leafNumber(msg, 'NONE', CMSG2_TYPE.INT16)).toBeUndefined()
		// A u64 is a bigint, never a number
		expect(leafNumber(msg, 'BIGG', CMSG2_TYPE.INT32)).toBeUndefined()
		expect(leafNumber(msg, 'NUMB')).toBe(12)
	})

	it('return undefined when absent or of another type', () => {
		expect(findLeaf(msg, 'NONE')).toBeUndefined()
		expect(leafNumber(msg, 'NONE')).toBeUndefined()
		expect(leafNumber(msg, 'BIGG')).toBeUndefined()
		expect(leafNumber(msg, 'TEXT')).toBeUndefined()
		expect(leafNumber(msg, 'SUBM')).toBeUndefined()
		expect(leafBigInt(msg, 'NUMB')).toBeUndefined()
		expect(leafString(msg, 'NUMB')).toBeUndefined()
		expect(leafString(msg, 'SUBM')).toBeUndefined()
		expect(leafMessage(msg, 'NUMB')).toBeUndefined()
		expect(leafMessage(msg, 'TEXT')).toBeUndefined()
	})
})

describe('fixture builder (test/fixtures/partyline/build.ts)', () => {
	// The synthetic tests are only as good as the builder: it must give the exact wire bytes of real packets
	const hex = (b: Buffer): string => b.toString('hex')

	it('re-encodes the real keepalive byte for byte', () => {
		const built = packet(
			'NEST',
			[
				u16('PVER', 2),
				u8('ADVT', 2),
				nested('TERM', 'INDI', [
					u32('ADVV', 451),
					u16('HWID', 7903),
					u32('INIP', 0x0a601edf),
					u16('UDPC', 4000),
					u16('NUMS', 8),
				]),
			],
			0xc6056085,
		)
		expect(hex(built)).toBe(hex(partylineFixture('keepalive-xnode')))
	})

	it('re-encodes a real usage advert byte for byte (u64 leaves, unprintable keys)', () => {
		const built = packet(
			'NEST',
			[
				u16('PVER', 2),
				u8('ADVT', 3),
				nested('TERM', 'INDI', [u16('HWID', 7903)]),
				...Array.from({ length: 8 }, (_, i) =>
					nested(`S00${i + 1}`, 'INDI', [u32('PSID', 22301 + i), u64('BUSY', i === 0 ? 0x00021eeb00000a60n : 0n)]),
				),
				u64(Buffer.from([0xff, 0xff, 0xff, 0xff]), 0n),
				u64(Buffer.from([0xff, 0xff, 0xff, 0xfe]), 0n),
			],
			0xc6056086,
		)
		expect(hex(built)).toBe(hex(partylineFixture('usage-xnode-fader1')))
	})

	it('re-encodes a real full advert with a NUL-padded string byte for byte', () => {
		const built = packet(
			'NEST',
			[
				u16('PVER', 2),
				u8('ADVT', 1),
				nested('TERM', 'INDI', [
					u32('ADVV', 25),
					u16('HWID', 0x1ee1),
					u32('INIP', 0x0a601ee1),
					u16('UDPC', 4000),
					u16('NUMS', 0),
					str('ATRN', 'xnode2-815CF7', 32),
				]),
			],
			0x6aa14de5,
		)
		expect(hex(built)).toBe(hex(partylineFixture('full-xnode2-empty')))
	})
})
