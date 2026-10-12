import { describe, expect, it } from 'vitest'
import { decodeAdvert, type PartylineAdvert } from '../../src/lwrp/partyline.js'
import { message, nested, packet, prefix, raw, str, u16, u32, u64, u8 } from '../fixtures/partyline/build.js'
import { PARTYLINE_FIXTURES, partylineFixture, type PartylineFixtureName } from '../fixtures/partyline/load.js'
import { rng } from '../fixtures/partyline/rng.js'

function decode(name: PartylineFixtureName, sender: string): PartylineAdvert {
	const advert = decodeAdvert(partylineFixture(name), sender)
	if (!advert) throw new Error(`fixture ${name} does not decode`)
	return advert
}

/** Rough shape of a source: slot, channel, name */
function brief(advert: PartylineAdvert): [string, number, string][] {
	return advert.sources.map((s) => [s.slot, s.channel, s.name])
}

/** Key of the two trailing u64 leaves of a usage advert */
const FFFFFFFF = Buffer.from([0xff, 0xff, 0xff, 0xff])
const FFFFFFFE = Buffer.from([0xff, 0xff, 0xff, 0xfe])

const ip = (a: number, b: number, c: number, d: number): number => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0

/** A NEST packet with a TERM block and extra top-level leaves */
function nest(advt: number, term: Buffer[], ...rest: Buffer[]): Buffer {
	return packet('NEST', [u16('PVER', 2), u8('ADVT', advt), nested('TERM', 'INDI', term), ...rest])
}

describe('decodeAdvert: real xNode packets', () => {
	it('keepalive from .223', () => {
		const a = decode('keepalive-xnode', '10.96.30.223')
		expect(a).toEqual({
			kind: 'keepalive',
			deviceIp: '10.96.30.223',
			hwid: 7903,
			configVersion: 451,
			sourceCount: 8,
			sources: [],
			usage: [],
		})
		expect(a.deviceName).toBeUndefined()
	})

	it('takes the device address from INIP, not from the sender', () => {
		expect(decode('keepalive-xnode', '192.168.1.1').deviceIp).toBe('10.96.30.223')
	})

	it('full advert from .224: 8 sources', () => {
		const a = decode('full-xnode-224', '10.96.30.224')
		expect(a).toMatchObject({
			kind: 'full',
			deviceIp: '10.96.30.224',
			deviceName: 'Node-224-0',
			hwid: 7904,
			configVersion: 43,
			sourceCount: 8,
			usage: [],
		})
		expect(a.sources).toHaveLength(8)
		expect(a.sources[0]).toEqual({
			slot: 'S001',
			channel: 22401,
			name: 'MIX ANIM',
			streamAddress: '239.192.87.129',
			backfeedAddress: '239.193.87.129',
		})
		expect(a.sources[1]).toEqual({
			slot: 'S002',
			channel: 22402,
			name: 'GEN M Haut',
			streamAddress: '239.192.87.130',
			backfeedAddress: '239.193.87.130',
		})
		expect(brief(a).map((s) => s[1])).toEqual([22401, 22402, 22403, 22404, 22405, 22406, 22407, 22408])
		expect(a.sources.map((s) => s.name)).toEqual([
			'MIX ANIM',
			'GEN M Haut',
			'TEL 1',
			'TEL 2',
			'ROMANO C2',
			'REMI C2',
			'STUDIO DJ',
			'SRC 8',
		])
	})

	it('full advert from .223: the NUL-terminated S008 name loses its trailing garbage', () => {
		const a = decode('full-xnode-223', '10.96.30.223')
		expect(a).toMatchObject({ kind: 'full', deviceName: 'Node-223-0', configVersion: 451, sourceCount: 8 })
		expect(a.sources).toHaveLength(8)
		expect(a.sources[0]).toEqual({
			slot: 'S001',
			channel: 22301,
			name: 'MIC 1',
			streamAddress: '239.192.87.29',
			backfeedAddress: '239.193.87.29',
		})
		expect(a.sources[7]).toMatchObject({ slot: 'S008', channel: 22308, name: 'SRC 8' })
		expect(a.sources[7].streamAddress).toBe('239.192.87.36')
	})

	it('full advert from .223 after the rename: new config version, new name', () => {
		const a = decode('full-xnode-223-renamed', '10.96.30.223')
		expect(a.configVersion).toBe(452)
		expect(a.sources).toHaveLength(8)
		expect(a.sources[1]).toMatchObject({ slot: 'S002', channel: 22302, name: 'TEST 2' })
		expect(a.sources[0].name).toBe('MIC 1')
		const before = decode('full-xnode-223', '10.96.30.223')
		expect(a.sources.filter((s, i) => s.name !== before.sources[i].name).map((s) => s.slot)).toEqual(['S002'])
	})

	it('full advert from the factory-fresh xNode2: no sources', () => {
		expect(decode('full-xnode2-empty', '10.96.30.225')).toEqual({
			kind: 'full',
			deviceIp: '10.96.30.225',
			deviceName: 'xnode2-815CF7',
			hwid: 7905,
			configVersion: 25,
			sourceCount: 0,
			sources: [],
			usage: [],
		})
	})

	it('full advert from the ETH4CAN: leaves in another order, TYPE ignored', () => {
		expect(decode('full-eth4can', '10.96.30.222')).toEqual({
			kind: 'full',
			deviceIp: '10.96.30.222',
			deviceName: 'ETH4CAN_2',
			hwid: 7902,
			configVersion: 1,
			sourceCount: 0,
			sources: [],
			usage: [],
		})
	})
})

describe('decodeAdvert: real Engine packets', () => {
	it('full advert, datagram 1: 8 of 10 sources, slots not contiguous', () => {
		const a = decode('full-engine-part1', '10.96.30.235')
		expect(a).toMatchObject({
			kind: 'full',
			deviceIp: '10.96.30.235',
			deviceName: 'Engine402F59',
			hwid: 7915,
			configVersion: 18864,
			sourceCount: 10,
			usage: [],
		})
		expect(brief(a)).toEqual([
			['S001', 141, 'Program 1'],
			['S002', 142, 'Program 2'],
			['S003', 145, 'Program 4 Recor'],
			['S007', 150, 'CR Monitor Dire'],
			['S008', 151, 'CR Monitor'],
			['S009', 152, 'CR Headphones'],
			['S010', 153, 'Preview'],
			['S016', 143, 'Program 3'],
		])
		expect(a.sources[0]).toMatchObject({ streamAddress: '239.192.0.141', backfeedAddress: '239.193.0.141' })
	})

	it('full advert, datagram 2: the rest, including the backfeed source whose stream is a 239.193 address', () => {
		const a = decode('full-engine-part2', '10.96.30.235')
		expect(a).toMatchObject({ kind: 'full', deviceName: 'Engine402F59', configVersion: 18864, sourceCount: 10 })
		expect(a.sources).toEqual([
			{
				slot: 'S017',
				channel: 144,
				name: 'Program 4',
				streamAddress: '239.192.0.144',
				backfeedAddress: '239.193.0.144',
			},
			{
				slot: 'S201',
				channel: 22301,
				name: 'To: SRC 1',
				streamAddress: '239.193.87.29',
				backfeedAddress: '239.193.87.29',
			},
		])
	})

	it('both datagrams together give the advertised number of sources', () => {
		const a = decode('full-engine-part1', '10.96.30.235')
		const b = decode('full-engine-part2', '10.96.30.235')
		expect(a.sources.length + b.sources.length).toBe(a.sourceCount)
		expect(a.configVersion).toBe(b.configVersion)
	})

	it('usage advert (PVER 3): no sources, no usage, unknown top-level leaves ignored', () => {
		expect(decode('usage-engine', '10.96.30.235')).toEqual({
			kind: 'usage',
			deviceIp: '10.96.30.235',
			hwid: 7915,
			sources: [],
			usage: [],
		})
	})
})

describe('decodeAdvert: usage adverts', () => {
	it('xNode with SRC 1 on Engine fader 1', () => {
		const a = decode('usage-xnode-fader1', '10.96.30.223')
		expect(a.kind).toBe('usage')
		// No INIP in a usage advert: the sender is the device
		expect(a.deviceIp).toBe('10.96.30.223')
		expect(a.hwid).toBe(7903)
		expect(a.configVersion).toBeUndefined()
		expect(a.sourceCount).toBeUndefined()
		expect(a.deviceName).toBeUndefined()
		expect(a.sources).toEqual([])
		expect(a.usage).toHaveLength(8)
		expect(a.usage.map((u) => u.channel)).toEqual([22301, 22302, 22303, 22304, 22305, 22306, 22307, 22308])
		expect(a.usage[0]).toEqual({ channel: 22301, usedBy: { engineIp: '10.96.30.235', fader: 1 } })
		for (const u of a.usage.slice(1)) expect(u.usedBy).toBeNull()
	})

	it('xNode with SRC 1 on Engine fader 11 (BUSY carries the fader 0-based)', () => {
		const a = decode('usage-xnode-fader11', '10.96.30.223')
		expect(a.usage).toHaveLength(8)
		expect(a.usage[0]).toEqual({ channel: 22301, usedBy: { engineIp: '10.96.30.235', fader: 11 } })
		for (const u of a.usage.slice(1)) expect(u.usedBy).toBeNull()
	})

	it('decodes BUSY: IP halves in bytes 2-3 and 6-7, fader in bytes 4-5, bytes 0-1 ignored', () => {
		const busy = (v: bigint): Buffer =>
			nest(3, [u16('HWID', 1)], nested('S001', 'INDI', [u32('PSID', 5), u64('BUSY', v)]))
		const usedBy = (v: bigint) => decodeAdvert(busy(v), '1.2.3.4')?.usage[0].usedBy
		expect(usedBy(0x00021eeb00000a60n)).toEqual({ engineIp: '10.96.30.235', fader: 1 })
		expect(usedBy(0x00021eeb000a0a60n)).toEqual({ engineIp: '10.96.30.235', fader: 11 })
		expect(usedBy(0x0000c0a8_0000_0a01n)).toEqual({ engineIp: '10.1.192.168', fader: 1 })
		// These two pin the arithmetic only (every bit set, an all-zero IP), not anything seen from a real engine
		expect(usedBy(0xffffffffffffffffn)).toEqual({ engineIp: '255.255.255.255', fader: 65536 })
		expect(usedBy(0x00020000_0001_0000n)).toEqual({ engineIp: '0.0.0.0', fader: 2 })
		expect(usedBy(0n)).toBeNull()
	})

	it('skips S leaves that lack PSID or BUSY, or hold a BUSY of another type', () => {
		const p = nest(
			3,
			[u16('HWID', 1)],
			nested('S001', 'INDI', [u64('BUSY', 0n)]),
			nested('S002', 'INDI', [u32('PSID', 22302)]),
			nested('S003', 'INDI', [u32('PSID', 22303), u32('BUSY', 0)]),
			nested('S004', 'INDI', [u32('PSID', 22304), u64('BUSY', 0n)]),
			u64(FFFFFFFF, 0n),
			u64(FFFFFFFE, 0n),
		)
		expect(decodeAdvert(p, '1.2.3.4')?.usage).toEqual([{ channel: 22304, usedBy: null }])
	})

	it('a usage advert never reports sources, a full advert never reports usage', () => {
		const slot = nested('S001', 'INDI', [
			u32('PSID', 7),
			u64('BUSY', 0x00021eeb00000a60n),
			str('PSNM', 'X', 16),
			u32('FSID', ip(239, 192, 0, 7)),
		])
		const asUsage = decodeAdvert(nest(3, [u16('HWID', 1)], slot), '1.2.3.4')
		expect(asUsage?.sources).toEqual([])
		expect(asUsage?.usage).toHaveLength(1)
		const asFull = decodeAdvert(nest(1, [u16('HWID', 1)], slot), '1.2.3.4')
		expect(asFull?.usage).toEqual([])
		expect(asFull?.sources).toHaveLength(1)
		const asKeepalive = decodeAdvert(nest(2, [u16('HWID', 1)], slot), '1.2.3.4')
		expect(asKeepalive?.sources).toEqual([])
		expect(asKeepalive?.usage).toEqual([])
	})
})

describe('decodeAdvert: device block', () => {
	it('falls back to the sender address when INIP is absent or zero', () => {
		expect(decodeAdvert(nest(2, [u16('HWID', 1)]), '10.0.0.9')?.deviceIp).toBe('10.0.0.9')
		expect(decodeAdvert(nest(2, [u32('INIP', 0)]), '10.0.0.9')?.deviceIp).toBe('10.0.0.9')
		expect(decodeAdvert(nest(2, [u32('INIP', ip(10, 96, 30, 223))]), '10.0.0.9')?.deviceIp).toBe('10.96.30.223')
		expect(decodeAdvert(nest(2, [u32('INIP', ip(255, 128, 0, 1))]), '10.0.0.9')?.deviceIp).toBe('255.128.0.1')
	})

	it('reports only the TERM fields that are present', () => {
		const a = decodeAdvert(nest(2, []), '10.0.0.9')
		expect(a).toEqual({ kind: 'keepalive', deviceIp: '10.0.0.9', sources: [], usage: [] })
		expect(Object.keys(a!).sort()).toEqual(['deviceIp', 'kind', 'sources', 'usage'])
	})

	it('trims the device name after cutting it at the NUL', () => {
		const a = decodeAdvert(nest(1, [str('ATRN', 'Node 7  ', 32)]), '10.0.0.9')
		expect(a?.deviceName).toBe('Node 7')
		expect(decodeAdvert(nest(1, [str('ATRN', '', 32)]), '10.0.0.9')?.deviceName).toBe('')
	})

	it('finds leaves by key whatever their order or the extra leaves around them', () => {
		const a = decodeAdvert(
			packet('NEST', [
				u64(FFFFFFFE, 0n),
				u8('ADVT', 2),
				u16('JUNK', 9),
				nested('TERM', 'INDI', [u16('NUMS', 3), u32('XXXX', 1), u32('ADVV', 9), u16('HWID', 4)]),
				u16('PVER', 2),
			]),
			'10.0.0.9',
		)
		expect(a).toEqual({
			kind: 'keepalive',
			deviceIp: '10.0.0.9',
			hwid: 4,
			configVersion: 9,
			sourceCount: 3,
			sources: [],
			usage: [],
		})
	})
})

describe('decodeAdvert: sources', () => {
	const src = (slot: string, ...leaves: Buffer[]): Buffer => nested(slot, 'INDI', leaves)

	it('skips a source without PSID but keeps the packet', () => {
		const a = decodeAdvert(
			nest(
				1,
				[],
				src('S001', str('PSNM', 'no id', 16)),
				src('S002', u32('PSID', 22302), str('PSNM', 'ok', 16)),
				src('S003', str('PSNM', 'no id either', 16), u32('FSID', ip(239, 192, 0, 3))),
			),
			'1.1.1.1',
		)
		expect(a?.sources.map((s) => [s.slot, s.channel, s.name])).toEqual([['S002', 22302, 'ok']])
	})

	it('skips sources and usage whose PSID is not a channel (1..65535)', () => {
		const ids = [0, 1, 0xffff, 0x10000, 0xffffffff]
		const full = decodeAdvert(nest(1, [], ...ids.map((id, i) => src(`S00${i}`, u32('PSID', id)))), '1.1.1.1')
		expect(full?.sources.map((s) => s.channel)).toEqual([1, 0xffff])
		const usage = decodeAdvert(
			nest(3, [], ...ids.map((id, i) => src(`S00${i}`, u32('PSID', id), u64('BUSY', 0n)))),
			'1.1.1.1',
		)
		expect(usage?.usage.map((u) => u.channel)).toEqual([1, 0xffff])
	})

	it('names a source without PSNM as an empty string; missing addresses stay empty too', () => {
		const a = decodeAdvert(nest(1, [], src('S001', u32('PSID', 5))), '1.1.1.1')
		expect(a?.sources).toEqual([{ slot: 'S001', channel: 5, name: '', streamAddress: '', backfeedAddress: '' }])
	})

	it('trims source names and cuts them at the first NUL', () => {
		const a = decodeAdvert(
			nest(
				1,
				[],
				src('S001', u32('PSID', 1), str('PSNM', '  Mic 1  ', 16)),
				src('S002', u32('PSID', 2), str('PSNM', 'SRC 8\0h\0junk', 16)),
			),
			'1.1.1.1',
		)
		expect(a?.sources.map((s) => s.name)).toEqual(['Mic 1', 'SRC 8'])
	})

	it('only reads S followed by 3 digits, and only nested messages', () => {
		const body = [u32('PSID', 5), str('PSNM', 'x', 8)]
		const a = decodeAdvert(
			nest(
				1,
				[],
				src('S01 ', ...body),
				src('SABC', ...body),
				src('S00a', ...body),
				src('T001', ...body),
				u32('S002', 7),
				src('S123', ...body),
				src('S201', ...body),
			),
			'1.1.1.1',
		)
		expect(a?.sources.map((s) => s.slot)).toEqual(['S123', 'S201'])
	})

	it('formats addresses as dotted quads', () => {
		const a = decodeAdvert(
			nest(1, [], src('S001', u32('PSID', 1), u32('FSID', ip(239, 192, 255, 0)), u32('BSID', ip(0, 1, 2, 3)))),
			'1.1.1.1',
		)
		expect(a?.sources[0]).toMatchObject({ streamAddress: '239.192.255.0', backfeedAddress: '0.1.2.3' })
	})

	it('keeps packet order and does not merge or reorder duplicate channels', () => {
		const a = decodeAdvert(
			nest(1, [], src('S009', u32('PSID', 9)), src('S001', u32('PSID', 1)), src('S002', u32('PSID', 9))),
			'1.1.1.1',
		)
		expect(a?.sources.map((s) => [s.slot, s.channel])).toEqual([
			['S009', 9],
			['S001', 1],
			['S002', 9],
		])
	})
})

describe('decodeAdvert: rejects what is not an advert', () => {
	it('rejects an unknown or missing ADVT', () => {
		for (const advt of [0, 4, 5, 255])
			expect(decodeAdvert(nest(advt, [u16('HWID', 1)]), '1.1.1.1'), `ADVT ${advt}`).toBeNull()
		const noAdvt = packet('NEST', [u16('PVER', 2), nested('TERM', 'INDI', [u16('HWID', 1)])])
		expect(decodeAdvert(noAdvt, '1.1.1.1')).toBeNull()
		// A string is not a number
		const text = packet('NEST', [str('ADVT', '2'), nested('TERM', 'INDI', [])])
		expect(decodeAdvert(text, '1.1.1.1')).toBeNull()
	})

	it('rejects another top-level message', () => {
		for (const name of ['READ', 'nest', 'INDI', 'NES\0']) {
			const p = packet(name, [u16('PVER', 2), u8('ADVT', 2), nested('TERM', 'INDI', [])])
			expect(decodeAdvert(p, '1.1.1.1'), name).toBeNull()
		}
		expect(decodeAdvert(packet('NEST', [u8('ADVT', 2), nested('TERM', 'INDI', [])]), '1.1.1.1')).not.toBeNull()
	})

	it('rejects a packet with no device block', () => {
		expect(decodeAdvert(packet('NEST', [u16('PVER', 2), u8('ADVT', 2)]), '1.1.1.1')).toBeNull()
		expect(decodeAdvert(packet('NEST', [u8('ADVT', 2), u32('TERM', 1)]), '1.1.1.1')).toBeNull()
	})

	it('rejects bad magic, non-zero filler, and garbage', () => {
		const good = partylineFixture('keepalive-xnode')
		for (const i of [0, 3, 8, 15]) {
			const buf = Buffer.from(good)
			buf[i] ^= 0x10
			expect(decodeAdvert(buf, '1.1.1.1'), `byte ${i}`).toBeNull()
		}
		expect(decodeAdvert(Buffer.alloc(0), '1.1.1.1')).toBeNull()
		expect(decodeAdvert(Buffer.from('LWRP\r\n'), '1.1.1.1')).toBeNull()
		expect(decodeAdvert(Buffer.alloc(100), '1.1.1.1')).toBeNull()
		expect(decodeAdvert(Buffer.concat([prefix(), message('NEST', [], 1)]), '1.1.1.1')).toBeNull()
	})

	it('rejects every truncation of every fixture, without throwing', () => {
		for (const name of PARTYLINE_FIXTURES) {
			const buf = partylineFixture(name)
			for (let n = 0; n < buf.length; n++) {
				expect(decodeAdvert(buf.subarray(0, n), '1.1.1.1'), `${name} cut at ${n}`).toBeNull()
			}
		}
	})

	it('rejects trailing bytes, an unknown leaf type, and a nested length mismatch', () => {
		const good = partylineFixture('full-xnode-224')
		expect(decodeAdvert(Buffer.concat([good, Buffer.from([0])]), '1.1.1.1')).toBeNull()
		const unknown = packet('NEST', [
			u16('PVER', 2),
			u8('ADVT', 2),
			raw('ZZZZ', 0x02, Buffer.alloc(4)),
			nested('TERM', 'INDI', []),
		])
		expect(decodeAdvert(unknown, '1.1.1.1')).toBeNull()
		const mismatch = packet('NEST', [u8('ADVT', 2), nested('TERM', 'INDI', [u16('HWID', 1)], 9), u16('PVER', 2)])
		expect(decodeAdvert(mismatch, '1.1.1.1')).toBeNull()
	})

	it('never throws on mutated real packets', () => {
		const next = rng(12345)
		for (const name of PARTYLINE_FIXTURES) {
			const good = partylineFixture(name)
			for (let i = 0; i < 300; i++) {
				const buf = Buffer.from(good)
				for (let k = 1 + Math.floor(next() * 4); k > 0; k--)
					buf[Math.floor(next() * buf.length)] = Math.floor(next() * 256)
				expect(() => decodeAdvert(buf, '1.1.1.1'), name).not.toThrow()
			}
		}
	})
})

describe('decodeAdvert: wire widths', () => {
	const SENDER = '10.0.0.9'
	const numeric: ((k: string, v: number) => Buffer)[] = [u8, u16, u32, (k, v) => u64(k, BigInt(v))]
	const widthOf = [8, 16, 32, 64]
	/** `key` = `value` at every numeric width but `bits`, and as a string */
	const wrongWidths = (key: string, value: number, bits: number): Buffer[] => [
		...numeric.filter((_, i) => widthOf[i] !== bits).map((f) => f(key, value)),
		str(key, String(value)),
	]
	const src = (...leaves: Buffer[]): Buffer => nested('S001', 'INDI', leaves)

	it('ADVT must be a u8: any other width is not an advert', () => {
		for (const advt of wrongWidths('ADVT', 2, 8)) {
			const p = packet('NEST', [u16('PVER', 2), advt, nested('TERM', 'INDI', [])])
			expect(decodeAdvert(p, SENDER), advt.toString('hex')).toBeNull()
		}
	})

	it('INIP must be a u32: any other width falls back to the sender address', () => {
		for (const inip of wrongWidths('INIP', 5, 32))
			expect(decodeAdvert(nest(2, [inip]), SENDER)?.deviceIp, inip.toString('hex')).toBe(SENDER)
		expect(decodeAdvert(nest(2, [u32('INIP', 5)]), SENDER)?.deviceIp).toBe('0.0.0.5')
	})

	it('HWID and NUMS must be u16, ADVV a u32: another width leaves the field out', () => {
		const field = { HWID: 'hwid', NUMS: 'sourceCount', ADVV: 'configVersion' } as const
		for (const [key, prop] of Object.entries(field)) {
			const bits = key === 'ADVV' ? 32 : 16
			for (const leaf of wrongWidths(key, 5, bits)) {
				const a = decodeAdvert(nest(1, [leaf]), SENDER)
				expect(a, `${key} ${leaf.toString('hex')}`).not.toBeNull()
				expect(a).not.toHaveProperty(prop)
			}
		}
		expect(decodeAdvert(nest(1, [u16('HWID', 5), u16('NUMS', 6), u32('ADVV', 7)]), SENDER)).toMatchObject({
			hwid: 5,
			sourceCount: 6,
			configVersion: 7,
		})
	})

	it('ATRN must be a string', () => {
		for (const atrn of numeric.map((f) => f('ATRN', 5)))
			expect(decodeAdvert(nest(1, [atrn]), SENDER), atrn.toString('hex')).not.toHaveProperty('deviceName')
	})

	it('PSID must be a u32: a source of another width is skipped, in full and in usage adverts', () => {
		for (const psid of wrongWidths('PSID', 5, 32)) {
			const full = decodeAdvert(nest(1, [], src(psid, str('PSNM', 'x', 8))), SENDER)
			expect(full?.sources, psid.toString('hex')).toEqual([])
			const usage = decodeAdvert(nest(3, [], src(psid, u64('BUSY', 0n))), SENDER)
			expect(usage?.usage, psid.toString('hex')).toEqual([])
		}
	})

	it('FSID and BSID must be u32: another width gives the unknown address, the source stays', () => {
		for (const key of ['FSID', 'BSID'])
			for (const leaf of wrongWidths(key, 5, 32)) {
				const a = decodeAdvert(nest(1, [], src(u32('PSID', 7), leaf)), SENDER)
				expect(a?.sources, `${key} ${leaf.toString('hex')}`).toEqual([
					{ slot: 'S001', channel: 7, name: '', streamAddress: '', backfeedAddress: '' },
				])
			}
	})

	it('PSNM must be a string, BUSY a u64', () => {
		for (const psnm of numeric.map((f) => f('PSNM', 5)))
			expect(decodeAdvert(nest(1, [], src(u32('PSID', 7), psnm)), SENDER)?.sources[0].name).toBe('')
		for (const busy of wrongWidths('BUSY', 5, 64))
			expect(decodeAdvert(nest(3, [], src(u32('PSID', 7), busy)), SENDER)?.usage, busy.toString('hex')).toEqual([])
	})
})

describe('decodeAdvert: unknown and zero addresses', () => {
	const src = (...leaves: Buffer[]): Buffer => nested('S001', 'INDI', leaves)

	// '' means unknown, for an absent address and for 0.0.0.0 alike
	it('maps a zero FSID or BSID to the empty string, like an absent one', () => {
		const zero = decodeAdvert(nest(1, [], src(u32('PSID', 7), u32('FSID', 0), u32('BSID', 0))), '1.1.1.1')
		expect(zero?.sources[0]).toMatchObject({ streamAddress: '', backfeedAddress: '' })
		const half = decodeAdvert(
			nest(1, [], src(u32('PSID', 7), u32('FSID', 0), u32('BSID', ip(239, 193, 0, 7)))),
			'1.1.1.1',
		)
		expect(half?.sources[0]).toMatchObject({ streamAddress: '', backfeedAddress: '239.193.0.7' })
	})
})

describe('decodeAdvert: names', () => {
	const src = (...leaves: Buffer[]): Buffer => nested('S001', 'INDI', leaves)

	it('drops control characters from names after the NUL cut, then trims', () => {
		const a = decodeAdvert(
			nest(
				1,
				[str('ATRN', '\x1b[31mNode\x07 7\x7f \x01', 32)],
				src(u32('PSID', 1), str('PSNM', '\x1b[31m Mic\t1 \0\x1bjunk', 24)),
			),
			'1.1.1.1',
		)
		expect(a?.deviceName).toBe('[31mNode 7')
		expect(a?.sources[0].name).toBe('[31m Mic1')
	})

	it('leaves a name made only of control characters empty, and keeps printable latin1', () => {
		const a = decodeAdvert(
			nest(1, [str('ATRN', '\x1b\x07 \x7f', 16)], src(u32('PSID', 1), str('PSNM', 'Café ÿ', 16))),
			'1.1.1.1',
		)
		expect(a?.deviceName).toBe('')
		expect(a?.sources[0].name).toBe('Café ÿ')
	})

	it('rejects a high-bit message name that ascii would read as NEST', () => {
		const p = packet('ÎÅÓÔ', [u16('PVER', 2), u8('ADVT', 2), nested('TERM', 'INDI', [])])
		expect(p.subarray(16, 20).toString('ascii')).toBe('NEST')
		expect(decodeAdvert(p, '1.1.1.1')).toBeNull()
	})
})

describe('decodeAdvert: deliberate leniency', () => {
	const SENDER = '10.0.0.9'
	const term = (hwid: number): Buffer => nested('TERM', 'INDI', [u16('HWID', hwid)])

	it('the first ADVT and the first TERM win, even when the first ADVT has the wrong width', () => {
		expect(decodeAdvert(packet('NEST', [u8('ADVT', 2), u8('ADVT', 1), term(1), term(2)]), SENDER)).toMatchObject({
			kind: 'keepalive',
			hwid: 1,
		})
		expect(decodeAdvert(packet('NEST', [u8('ADVT', 1), u8('ADVT', 2), term(2), term(1)]), SENDER)).toMatchObject({
			kind: 'full',
			hwid: 2,
		})
		expect(decodeAdvert(packet('NEST', [u16('ADVT', 2), u8('ADVT', 2), term(1)]), SENDER)).toBeNull()
	})

	it('ignores PVER: any value, any type, or none', () => {
		for (const pver of [u16('PVER', 3), u16('PVER', 99), u8('PVER', 0), str('PVER', 'x')]) {
			const p = packet('NEST', [pver, u8('ADVT', 2), term(1)])
			expect(decodeAdvert(p, SENDER), pver.toString('hex')).toMatchObject({ kind: 'keepalive', hwid: 1 })
		}
		expect(decodeAdvert(packet('NEST', [u8('ADVT', 2), term(1)]), SENDER)).toMatchObject({ hwid: 1 })
	})

	it('does not check the message name of TERM and the Snnn leaves (INDI in every capture)', () => {
		const p = packet('NEST', [
			u8('ADVT', 1),
			nested('TERM', 'XXXX', [u16('HWID', 5)]),
			nested('S001', 'ÎÅÓÔ', [u32('PSID', 9)]),
		])
		const a = decodeAdvert(p, SENDER)
		expect(a?.hwid).toBe(5)
		expect(a?.sources.map((s) => s.channel)).toEqual([9])
	})
})

describe('decodeAdvert: every single-byte mutation of real packets', () => {
	const QUAD = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
	const u32max = 0xffffffff

	/** What is wrong with a decoded advert, if anything */
	function problems(a: PartylineAdvert): string[] {
		const out: string[] = []
		const isInt = (n: unknown, min: number, max: number): boolean =>
			typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max
		const check = (ok: boolean, what: string): void => {
			if (!ok) out.push(what)
		}
		// eslint-disable-next-line no-control-regex
		const cleanName = (n: string): boolean => n === n.trim() && !/[\x00-\x1f\x7f]/.test(n)
		check(['keepalive', 'full', 'usage'].includes(a.kind), `kind ${a.kind}`)
		check(QUAD.test(a.deviceIp), `deviceIp ${a.deviceIp}`)
		check(a.hwid === undefined || isInt(a.hwid, 0, 0xffff), `hwid ${a.hwid}`)
		check(a.configVersion === undefined || isInt(a.configVersion, 0, u32max), `configVersion ${a.configVersion}`)
		check(a.sourceCount === undefined || isInt(a.sourceCount, 0, 0xffff), `sourceCount ${a.sourceCount}`)
		check(a.deviceName === undefined || cleanName(a.deviceName), `deviceName ${JSON.stringify(a.deviceName)}`)
		for (const s of a.sources) {
			check(isInt(s.channel, 1, 0xffff), `channel ${s.channel}`)
			check(cleanName(s.name), `source name ${JSON.stringify(s.name)}`)
			for (const addr of [s.streamAddress, s.backfeedAddress]) check(addr === '' || QUAD.test(addr), `address ${addr}`)
		}
		for (const u of a.usage) {
			check(isInt(u.channel, 1, 0xffff), `usage channel ${u.channel}`)
			if (u.usedBy) {
				check(QUAD.test(u.usedBy.engineIp), `engineIp ${u.usedBy.engineIp}`)
				check(isInt(u.usedBy.fader, 1, 65536), `fader ${u.usedBy.fader}`)
			}
		}
		check(a.kind === 'full' || a.sources.length === 0, 'sources outside a full advert')
		check(a.kind === 'usage' || a.usage.length === 0, 'usage outside a usage advert')
		return out
	}

	// A keepalive has no sources: the others add source and usage fields (a channel is a u32, so any value goes)
	it.each(['keepalive-xnode', 'full-xnode2-empty', 'usage-xnode-fader1', 'full-engine-part2'] as const)(
		'%s: never throws, and every advert it still decodes is sane',
		(name) => {
			const good = partylineFixture(name)
			const bad: string[] = []
			for (let i = 0; i < good.length; i++) {
				const buf = Buffer.from(good)
				for (let v = 0; v < 256; v++) {
					if (v === good[i]) continue
					buf[i] = v
					try {
						const a = decodeAdvert(buf, '1.1.1.1')
						if (a) for (const p of problems(a)) bad.push(`byte ${i} = ${v}: ${p}`)
					} catch (e) {
						bad.push(`byte ${i} = ${v} threw ${String(e)}`)
					}
				}
			}
			expect(bad).toEqual([])
		},
	)
})
