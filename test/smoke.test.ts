import { describe, expect, it } from 'vitest'
import { parseLine } from '../src/lwrp/parser.js'

describe('smoke', () => {
	it('parses a VER line', () => {
		expect(parseLine('VER LWRP:1.2 NSRC:8')?.attrs.NSRC).toBe('8')
	})
})
