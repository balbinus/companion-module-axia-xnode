import { describe, expect, it } from 'vitest'
import { formatCommand, mixCommand, parseLine, quote } from '../../src/lwrp/parser.js'
import { fixtureText } from '../fixtures/load.js'

function parsed(line: string) {
	const p = parseLine(line)
	if (!p) throw new Error(`expected a parsed line: ${JSON.stringify(line)}`)
	return p
}

describe('parseLine', () => {
	it('returns null for empty and whitespace-only lines', () => {
		expect(parseLine('')).toBeNull()
		expect(parseLine('   ')).toBeNull()
		expect(parseLine('\r\n')).toBeNull()
		expect(parseLine('\0')).toBeNull()
	})

	it('strips CRLF, trailing spaces and NULs', () => {
		const p = parsed('VER LWRP:1.2\r\n')
		expect(p.raw).toBe('VER LWRP:1.2')
		expect(p.attrs).toEqual({ LWRP: '1.2' })
		expect(parsed('END \0').raw).toBe('END')
	})

	it('parses BEGIN and END as bare verbs', () => {
		expect(parsed('BEGIN')).toMatchObject({ verb: 'BEGIN', args: [], attrs: {} })
		expect(parsed('END\r\n')).toMatchObject({ verb: 'END', args: [], attrs: {} })
	})

	it('accepts quoted and unquoted values for the same field', () => {
		expect(parsed('SRC 8 RTPA:239.192.87.36').attrs.RTPA).toBe('239.192.87.36')
		expect(parsed('SRC 8 RTPA:"239.192.87.36"').attrs.RTPA).toBe('239.192.87.36')
		expect(parsed('SRC 8 INGN:0').attrs.INGN).toBe('0')
		expect(parsed('SRC 8 INGN:"240"').attrs.INGN).toBe('240')
	})

	it('keeps spaces, <> and @ inside quoted values', () => {
		const p = parsed('DST 2 ADDR:"239.192.91.205 <Program 1@STD3-POWERSTATION>" NCHN:2')
		expect(p.attrs.ADDR).toBe('239.192.91.205 <Program 1@STD3-POWERSTATION>')
		expect(p.attrs.NCHN).toBe('2')
	})

	it('parses empty quoted values as empty strings', () => {
		const p = parsed('CFG GPO 1 NAME:"x" SRCA:""')
		expect(p.attrs).toEqual({ NAME: 'x', SRCA: '' })
		expect(p.verb).toBe('CFG')
		expect(p.args).toEqual(['GPO', '1'])
	})

	it('parses an unquoted empty value at end of line', () => {
		expect(parsed('FOO BAR:').attrs).toEqual({ BAR: '' })
	})

	it('keeps a colon inside a quoted value', () => {
		expect(parsed('SRC 1 LABL:"a:b c:d" X:1').attrs).toEqual({ LABL: 'a:b c:d', X: '1' })
	})

	it('accepts keys with digits, underscores and dots', () => {
		const p = parsed('SET LWS_802_1p_TAGE:1 LWS_802_1Q_PRIO:6 NID:223/0')
		expect(p.attrs).toEqual({ LWS_802_1p_TAGE: '1', LWS_802_1Q_PRIO: '6', NID: '223/0' })
		expect(parsed('LVL ICH 1 LOW.LEVEL:-400 CLIP.TIME:10').attrs).toEqual({ 'LOW.LEVEL': '-400', 'CLIP.TIME': '10' })
	})

	it('parses mixer crosspoints as numeric keys', () => {
		const p = parsed('MIX 9 1:-60 3:-25')
		expect(p.verb).toBe('MIX')
		expect(p.args).toEqual(['9'])
		expect(p.attrs).toEqual({ '1': '-60', '3': '-25' })
	})

	it('parses a cleared crosspoint (1:-)', () => {
		expect(parsed('MIX 9 1:- 2:0').attrs).toEqual({ '1': '-', '2': '0' })
	})

	it('parses the legacy empty mixer row with a trailing space', () => {
		const p = parsed('MIX 9 \r\n')
		expect(p).toMatchObject({ verb: 'MIX', args: ['9'], attrs: {} })
		expect(parsed('MIX 11')).toMatchObject({ verb: 'MIX', args: ['11'], attrs: {} })
	})

	it('parses meter peaks with two colon-separated values', () => {
		const p = parsed('MTR ICH 1 PEEK:-1000:-1000')
		expect(p.args).toEqual(['ICH', '1'])
		expect(p.attrs.PEEK).toBe('-1000:-1000')
		expect(parsed('MTR HWI 5 PEEK:-1000').attrs.PEEK).toBe('-1000')
	})

	it('parses node ids and wildcard values', () => {
		expect(parsed('SET NID:223/0').attrs.NID).toBe('223/0')
		expect(parsed('DST 1 VMOD:* OUGN:0').attrs).toEqual({ VMOD: '*', OUGN: '0' })
	})

	it('parses positional-only lines', () => {
		expect(parsed('IP hostname node-a-0')).toMatchObject({ verb: 'IP', args: ['hostname', 'node-a-0'], attrs: {} })
		expect(parsed('GPO 2 hhLhh')).toMatchObject({ verb: 'GPO', args: ['2', 'hhLhh'], attrs: {} })
		expect(parsed('LVL ICH 1.L NO-CLIP')).toMatchObject({ verb: 'LVL', args: ['ICH', '1.L', 'NO-CLIP'] })
		expect(parsed('LVL HWI 5.1 LOW')).toMatchObject({ verb: 'LVL', args: ['HWI', '5.1', 'LOW'] })
		expect(parsed('ERROR 1001 syntax error')).toMatchObject({ verb: 'ERROR', args: ['1001', 'syntax', 'error'] })
	})

	it('keeps case of the verb', () => {
		expect(parsed('ver LWRP:1.2').verb).toBe('ver')
	})

	it('treats a line starting with an attribute as having an empty verb', () => {
		const p = parsed('KEY:value other')
		expect(p.verb).toBe('')
		expect(p.args).toEqual(['other'])
		expect(p.attrs).toEqual({ KEY: 'value' })
	})

	it('lets later duplicate keys win', () => {
		expect(parsed('X A:1 A:2').attrs.A).toBe('2')
	})

	it('tolerates an unterminated quote by taking the rest of the line', () => {
		expect(parsed('X A:"abc def').attrs.A).toBe('abc def')
	})

	it('collapses repeated whitespace between tokens', () => {
		const p = parsed('MIX   9   1:0    2:-5')
		expect(p.args).toEqual(['9'])
		expect(p.attrs).toEqual({ '1': '0', '2': '-5' })
	})

	it('handles leading whitespace', () => {
		expect(parsed('  VER A:1').verb).toBe('VER')
	})

	it('parses the long legacy SET line', () => {
		const line = fixtureText('legacy-analog4x4-a')
			.split(/\r?\n/)
			.find((l) => l.startsWith('SET '))!
		const p = parsed(line)
		expect(p.attrs.LWS_802_1p_TAGE).toBe('1')
		expect(p.attrs.NID).toBe('223/0')
		expect(p.attrs.LWCLK_ADDR).toBe('239.192.255.1')
		expect(p.attrs.LWCLK_MODE).toBe('512')
	})

	it('parses every line of every fixture without throwing and keeps the verb', () => {
		for (const name of ['legacy-analog4x4-a', 'legacy-analog4x4-b', 'xnode2-combo'] as const) {
			for (const l of fixtureText(name).split(/\r?\n/)) {
				const p = parseLine(l)
				if (l.trim() === '') {
					expect(p).toBeNull()
				} else {
					expect(p?.verb).toBe(l.trim().split(/\s+/)[0])
				}
			}
		}
	})

	it('does not turn colons in free text of an ERROR line into attributes', () => {
		const p = parsed('ERROR 1000 bad command: foo')
		expect(p.attrs).toEqual({})
		expect(p.args).toEqual(['1000', 'bad', 'command:', 'foo'])
		expect(p.args.slice(1).join(' ')).toBe('bad command: foo')
	})
})

describe('quote', () => {
	it('wraps in double quotes', () => {
		expect(quote('Studio 1')).toBe('"Studio 1"')
		expect(quote('')).toBe('""')
	})

	it('removes quotes, backslashes and control characters', () => {
		expect(quote('a"b\\c')).toBe('"abc"')
		expect(quote('a\r\nb')).toBe('"ab"')
		expect(quote('a\tb\0c\x7fd')).toBe('"abcd"')
	})

	it('can never contain a quote or line break inside the value', () => {
		const nasty = ['x"\r\nMIX 1 1:0', '"; DROP', '\\"', '\n', '\r', '"\\"\r\n"']
		for (const s of nasty) {
			const q = quote(s)
			expect(q.slice(1, -1)).not.toMatch(/["\\\r\n]/)
			expect(q.startsWith('"') && q.endsWith('"')).toBe(true)
		}
	})
})

describe('formatCommand', () => {
	it('formats verb, args and attributes', () => {
		expect(formatCommand('SRC', [3], { PSNM: 'TEL 1', INGN: -20 })).toBe('SRC 3 PSNM:"TEL 1" INGN:-20')
		expect(formatCommand('VER')).toBe('VER')
		expect(formatCommand('GPO', [1, 'lhhhh'])).toBe('GPO 1 lhhhh')
		expect(formatCommand('LOGIN', ['secret'])).toBe('LOGIN secret')
	})

	it('quotes string values and sends numbers bare', () => {
		expect(formatCommand('DST', [2], { ADDR: '22302', OUGN: 0 })).toBe('DST 2 ADDR:"22302" OUGN:0')
	})

	it('round-trips through parseLine', () => {
		const cmd = formatCommand('DST', [2], { ADDR: '239.192.91.205 <Program 1@X>', NAME: '', OUGN: -35 })
		const p = parsed(cmd)
		expect(p.verb).toBe('DST')
		expect(p.args).toEqual(['2'])
		expect(p.attrs).toEqual({ ADDR: '239.192.91.205 <Program 1@X>', NAME: '', OUGN: '-35' })
	})

	it('can never produce a second command through attribute values', () => {
		const nasty = ['x"\r\nMIX 1 1:0', 'a\nGPO 1 lllll', '\\"\r\n', '"\r\n"']
		for (const s of nasty) {
			const cmd = formatCommand('SRC', [1], { PSNM: s })
			expect(cmd).not.toMatch(/[\r\n]/)
			const p = parsed(cmd)
			expect(p.verb).toBe('SRC')
			expect(Object.keys(p.attrs)).toEqual(['PSNM'])
			expect(p.args).toEqual(['1'])
		}
	})

	it('rejects verbs and args that are not plain tokens', () => {
		expect(() => formatCommand('SRC\r\nMIX')).toThrow(RangeError)
		expect(() => formatCommand('SRC MIX')).toThrow(RangeError)
		expect(() => formatCommand('')).toThrow(RangeError)
		expect(() => formatCommand('SRC', ['1\r\nMIX 1'])).toThrow(RangeError)
		expect(() => formatCommand('SRC', ['1 2'])).toThrow(RangeError)
		expect(() => formatCommand('SRC', ['a"b'])).toThrow(RangeError)
		expect(() => formatCommand('SRC', [''])).toThrow(RangeError)
		expect(() => formatCommand('SRC', [Number.NaN])).toThrow(RangeError)
		expect(() => formatCommand('SRC', [Infinity])).toThrow(RangeError)
	})

	it('rejects attribute keys that are not plain', () => {
		expect(() => formatCommand('SRC', [1], { 'A B': 1 })).toThrow(RangeError)
		expect(() => formatCommand('SRC', [1], { 'A:B': 1 })).toThrow(RangeError)
		expect(() => formatCommand('SRC', [1], { 'A\r\nB': 1 })).toThrow(RangeError)
		expect(() => formatCommand('SRC', [1], { '': 1 })).toThrow(RangeError)
	})

	it('accepts dotted and underscore keys', () => {
		expect(formatCommand('LVL', ['ICH', 1], { 'LOW.LEVEL': -400 })).toBe('LVL ICH 1 LOW.LEVEL:-400')
	})

	it('refuses non-integer or non-finite number values', () => {
		expect(() => formatCommand('SRC', [1], { INGN: 2.5 })).toThrow(RangeError)
		expect(() => formatCommand('SRC', [1], { INGN: Number.NaN })).toThrow(RangeError)
		expect(() => formatCommand('SRC', [1], { INGN: Infinity })).toThrow(RangeError)
		expect(() => formatCommand('SRC', [1], { INGN: -Infinity })).toThrow(RangeError)
	})

	it('never prints negative zero', () => {
		expect(formatCommand('SRC', [1], { INGN: -0 })).toBe('SRC 1 INGN:0')
	})

	it('refuses integers that would be printed in exponent notation', () => {
		expect(() => formatCommand('SRC', [1], { INGN: 1e21 })).toThrow(RangeError)
	})
})

describe('mixCommand', () => {
	it('formats set and clear entries', () => {
		expect(mixCommand(9, [[1, -60]])).toBe('MIX 9 1:-60')
		expect(
			mixCommand(9, [
				[1, 0],
				[3, -25],
			]),
		).toBe('MIX 9 1:0 3:-25')
		expect(mixCommand(9, [[1, null]])).toBe('MIX 9 1:-')
		expect(mixCommand(9, [])).toBe('MIX 9')
	})

	it('round-trips through parseLine', () => {
		const p = parsed(
			mixCommand(12, [
				[10, -100],
				[2, null],
			]),
		)
		expect(p.args).toEqual(['12'])
		expect(p.attrs).toEqual({ '10': '-100', '2': '-' })
	})

	it('refuses non-integer gains', () => {
		expect(() => mixCommand(9, [[1, 2.5]])).toThrow(RangeError)
		expect(() => mixCommand(9, [[1, Number.NaN]])).toThrow(RangeError)
		expect(() => mixCommand(9, [[1, Infinity]])).toThrow(RangeError)
	})

	it('refuses invalid inputs', () => {
		expect(() => mixCommand(9, [[0, 0]])).toThrow(RangeError)
		expect(() => mixCommand(9, [[-1, 0]])).toThrow(RangeError)
		expect(() => mixCommand(9, [[1.5, 0]])).toThrow(RangeError)
		expect(() => mixCommand(9, [[Number.NaN, 0]])).toThrow(RangeError)
	})

	it('refuses invalid outputs that are not tokens', () => {
		expect(() => mixCommand(Number.NaN, [])).toThrow(RangeError)
		expect(() => mixCommand('9 1:0' as unknown as number, [])).toThrow(RangeError)
		expect(() => mixCommand('9\r\nGPO' as unknown as number, [])).toThrow(RangeError)
	})

	it('never prints negative zero', () => {
		expect(mixCommand(9, [[1, -0]])).toBe('MIX 9 1:0')
	})

	it('refuses non-integer or non-positive output rows', () => {
		expect(() => mixCommand(1.5, [[1, 0]])).toThrow(RangeError)
		expect(() => mixCommand(-3, [[1, 0]])).toThrow(RangeError)
		expect(() => mixCommand(0, [[1, 0]])).toThrow(RangeError)
	})

	it('refuses gains that would be printed in exponent notation', () => {
		expect(() => mixCommand(9, [[1, 1e21]])).toThrow(RangeError)
	})
})
