import { describe, expect, it } from 'vitest'
import {
	MAX_CHANNEL,
	channelToMulticast,
	isIpv4,
	isIpv4Multicast,
	isValidChannel,
	multicastToChannel,
	normaliseAddr,
	parseDstAddr,
	parseKnownSources,
} from '../../src/lwrp/livewire.js'

describe('isValidChannel', () => {
	it('accepts 1..32767 integers', () => {
		expect(isValidChannel(1)).toBe(true)
		expect(isValidChannel(22301)).toBe(true)
		expect(isValidChannel(MAX_CHANNEL)).toBe(true)
		expect(MAX_CHANNEL).toBe(32767)
	})

	it('rejects everything else', () => {
		for (const n of [0, -1, 32768, 65535, 1.5, Number.NaN, Infinity, -Infinity]) expect(isValidChannel(n)).toBe(false)
		expect(isValidChannel('5' as unknown as number)).toBe(false)
	})
})

describe('channelToMulticast', () => {
	it('matches the design example 22301 = 239.192.87.29', () => {
		expect(channelToMulticast(22301)).toBe('239.192.87.29')
	})

	it('handles the extremes', () => {
		expect(channelToMulticast(1)).toBe('239.192.0.1')
		expect(channelToMulticast(255)).toBe('239.192.0.255')
		expect(channelToMulticast(256)).toBe('239.192.1.0')
		expect(channelToMulticast(32767)).toBe('239.192.127.255')
	})

	it('uses the right prefix per kind', () => {
		expect(channelToMulticast(22301, 'from')).toBe('239.192.87.29')
		expect(channelToMulticast(22301, 'to')).toBe('239.193.87.29')
		expect(channelToMulticast(22301, 'surround')).toBe('239.196.87.29')
	})

	it('throws for invalid channels', () => {
		for (const n of [0, -5, 32768, 1.5, Number.NaN, Infinity]) expect(() => channelToMulticast(n)).toThrow(RangeError)
	})
})

describe('multicastToChannel', () => {
	it('is the inverse of channelToMulticast for every kind', () => {
		for (const kind of ['from', 'to', 'surround'] as const) {
			for (const n of [1, 2, 255, 256, 257, 22301, 23501, 32767]) {
				expect(multicastToChannel(channelToMulticast(n, kind))).toEqual({ channel: n, kind })
			}
		}
	})

	it('parses the design example', () => {
		expect(multicastToChannel('239.192.87.29')).toEqual({ channel: 22301, kind: 'from' })
	})

	it('returns null for non-Livewire or invalid addresses', () => {
		expect(multicastToChannel('239.192.0.0')).toBeNull()
		expect(multicastToChannel('239.192.128.0')).toBeNull()
		expect(multicastToChannel('239.255.1.1')).toBeNull()
		expect(multicastToChannel('239.194.1.1')).toBeNull()
		expect(multicastToChannel('192.0.2.1')).toBeNull()
		expect(multicastToChannel('')).toBeNull()
		expect(multicastToChannel('22301')).toBeNull()
		expect(multicastToChannel('239.192.87')).toBeNull()
		expect(multicastToChannel('239.192.87.256')).toBeNull()
	})
})

describe('isIpv4 / isIpv4Multicast', () => {
	it('validates dotted quads', () => {
		expect(isIpv4('192.0.2.1')).toBe(true)
		expect(isIpv4('0.0.0.0')).toBe(true)
		expect(isIpv4('255.255.255.255')).toBe(true)
		for (const s of [
			'',
			'1.2.3',
			'1.2.3.4.5',
			'256.1.1.1',
			'1.2.3.-4',
			'a.b.c.d',
			' 1.2.3.4',
			'1.2.3.4 ',
			'1.2.3.4\n',
		]) {
			expect(isIpv4(s)).toBe(false)
		}
	})

	it('knows the multicast range edges', () => {
		expect(isIpv4Multicast('224.0.0.0')).toBe(true)
		expect(isIpv4Multicast('239.255.255.255')).toBe(true)
		expect(isIpv4Multicast('239.192.87.29')).toBe(true)
		expect(isIpv4Multicast('240.0.0.0')).toBe(false)
		expect(isIpv4Multicast('223.255.255.255')).toBe(false)
		expect(isIpv4Multicast('0.0.0.0')).toBe(false)
	})

	it('rejects garbage', () => {
		for (const s of [
			'',
			'abc',
			'239.192.87',
			'239.192.87.29.1',
			'239.192.87.256',
			'239.192.87.29 <x>',
			'-239.1.1.1',
			'239.192.87.',
		]) {
			expect(isIpv4Multicast(s)).toBe(false)
		}
	})

	it('rejects octets with leading zeros', () => {
		expect(isIpv4Multicast('239.192.087.029')).toBe(false)
		expect(isIpv4('01.2.3.4')).toBe(false)
	})
})

describe('parseDstAddr', () => {
	it('handles the disconnected form', () => {
		expect(parseDstAddr('')).toEqual({ raw: '' })
		expect(parseDstAddr('   ')).toEqual({ raw: '   ' })
	})

	it('parses a bare channel number as a "from" address', () => {
		expect(parseDstAddr('22302')).toEqual({
			raw: '22302',
			ip: '239.192.87.30',
			channel: 22302,
			kind: 'from',
		})
	})

	it('parses a multicast IP', () => {
		expect(parseDstAddr('239.192.87.30')).toEqual({
			raw: '239.192.87.30',
			ip: '239.192.87.30',
			channel: 22302,
			kind: 'from',
		})
		expect(parseDstAddr('239.193.87.29')).toMatchObject({ channel: 22301, kind: 'to' })
		expect(parseDstAddr('239.196.87.29')).toMatchObject({ channel: 22301, kind: 'surround' })
	})

	it('parses IP with a <label>', () => {
		const p = parseDstAddr('239.192.91.205 <Program 1@STD3-POWERSTATION>')
		expect(p.ip).toBe('239.192.91.205')
		expect(p.channel).toBe(91 * 256 + 205)
		expect(p.kind).toBe('from')
		expect(p.label).toBe('Program 1@STD3-POWERSTATION')
	})

	it('parses IP with a label without <>', () => {
		const p = parseDstAddr('239.192.91.205 Program 1@STD3-POWERSTATION')
		expect(p.ip).toBe('239.192.91.205')
		expect(p.label).toBe('Program 1@STD3-POWERSTATION')
	})

	it('parses channel number with a label', () => {
		const p = parseDstAddr('22302 <MIC 2@A1-MICROS>')
		expect(p).toMatchObject({ ip: '239.192.87.30', channel: 22302, label: 'MIC 2@A1-MICROS' })
	})

	it('ignores an empty label', () => {
		expect(parseDstAddr('239.192.87.30 <>').label).toBeUndefined()
		expect(parseDstAddr('239.192.87.30  ').label).toBeUndefined()
	})

	it('gives an ip without channel for non-Livewire addresses', () => {
		const p = parseDstAddr('239.255.1.1')
		expect(p.ip).toBe('239.255.1.1')
		expect(p.channel).toBeUndefined()
		expect(p.kind).toBeUndefined()
	})

	it('returns only raw for garbage and out-of-range numbers', () => {
		for (const s of ['hello', '0', '32768', '99999', '-1', '1.2.3', '256.1.1.1', 'not-an-ip']) {
			expect(parseDstAddr(s)).toEqual({ raw: s })
		}
	})

	it('keeps raw unchanged', () => {
		expect(parseDstAddr('  22302 ').raw).toBe('  22302 ')
	})
})

describe('normaliseAddr', () => {
	it('maps the documented forms', () => {
		expect(normaliseAddr('')).toBe('')
		expect(normaliseAddr('22302')).toBe('239.192.87.30')
		expect(normaliseAddr('239.192.87.30')).toBe('239.192.87.30')
		expect(normaliseAddr('239.192.91.205 <Program 1@STD3-POWERSTATION>')).toBe('239.192.91.205')
		expect(normaliseAddr('239.192.91.205 Program 1@STD3-POWERSTATION')).toBe('239.192.91.205')
	})

	it('treats the legacy channel form and the xNode2-normalised form as equal', () => {
		expect(normaliseAddr('22302')).toBe(normaliseAddr('239.192.87.30'))
		expect(normaliseAddr('22302 <MIC 2@A1-MICROS>')).toBe(normaliseAddr('239.192.87.30 <MIC 2@A1-MICROS>'))
		expect(normaliseAddr('22302')).toBe(normaliseAddr(channelToMulticast(22302)))
		expect(normaliseAddr('239.192.87.30 ')).toBe(normaliseAddr(' 22302'))
	})

	it('keeps "from" and "to" addresses distinct', () => {
		expect(normaliseAddr('239.193.87.29')).not.toBe(normaliseAddr('22301'))
	})

	it('returns the trimmed input for unknown strings', () => {
		expect(normaliseAddr('  foo ')).toBe('foo')
		expect(normaliseAddr('32768')).toBe('32768')
		expect(normaliseAddr('   ')).toBe('')
	})
})

describe('parseKnownSources', () => {
	it('parses channel and IP keys', () => {
		expect(parseKnownSources('22301=Studio Mic 1\n239.192.87.30=Studio Mic 2')).toEqual([
			{ channel: 22301, ip: '239.192.87.29', label: 'Studio Mic 1' },
			{ channel: 22302, ip: '239.192.87.30', label: 'Studio Mic 2' },
		])
	})

	it('skips comments, blank and invalid lines, and handles CRLF', () => {
		const text = [
			'# my sources',
			'',
			'   ',
			'22301=Mic',
			'foo=bar',
			'0=zero',
			'99999=big',
			'22302 x=bad',
			'22303 = Spaced  ',
			'',
		].join('\r\n')
		expect(parseKnownSources(text)).toEqual([
			{ channel: 22301, ip: '239.192.87.29', label: 'Mic' },
			{ channel: 22303, ip: '239.192.87.31', label: 'Spaced' },
		])
	})

	it('uses the key as label when none is given', () => {
		expect(parseKnownSources('22301')).toEqual([{ channel: 22301, ip: '239.192.87.29', label: '22301' }])
		expect(parseKnownSources('22301=')).toEqual([{ channel: 22301, ip: '239.192.87.29', label: '22301' }])
	})

	it('keeps additional = signs in the label', () => {
		expect(parseKnownSources('22301=a=b')[0].label).toBe('a=b')
	})

	it('returns [] for empty input', () => {
		expect(parseKnownSources('')).toEqual([])
		expect(parseKnownSources('# only a comment')).toEqual([])
	})

	it('has no channel for IPs outside the Livewire ranges', () => {
		expect(parseKnownSources('239.255.1.1=Other')).toEqual([{ channel: undefined, ip: '239.255.1.1', label: 'Other' }])
	})

	it('rejects unicast addresses', () => {
		expect(parseKnownSources('192.0.2.5=Unicast')).toEqual([])
	})
})
