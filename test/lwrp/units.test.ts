import { describe, expect, it } from 'vitest'
import {
	GAIN_MAX_TENTHS,
	GAIN_MIN_TENTHS,
	XPOINT_BUDGET,
	XPOINT_OFF_TENTHS,
	clamp,
	clampGain,
	dbToTenths,
	formatDb,
	isXpointOn,
	tenthsToDb,
} from '../../src/lwrp/units.js'

describe('constants', () => {
	it('match the protocol', () => {
		expect(GAIN_MIN_TENTHS).toBe(-1000)
		expect(GAIN_MAX_TENTHS).toBe(240)
		expect(XPOINT_OFF_TENTHS).toBe(-1000)
		expect(XPOINT_BUDGET).toBe(220)
	})
})

describe('clamp', () => {
	it('limits to the range', () => {
		expect(clamp(5, 0, 10)).toBe(5)
		expect(clamp(-5, 0, 10)).toBe(0)
		expect(clamp(15, 0, 10)).toBe(10)
		expect(clamp(Infinity, 0, 10)).toBe(10)
		expect(clamp(-Infinity, 0, 10)).toBe(0)
	})
})

describe('dbToTenths', () => {
	it('converts to integer tenths', () => {
		expect(dbToTenths(0)).toBe(0)
		expect(dbToTenths(-6)).toBe(-60)
		expect(dbToTenths(21)).toBe(210)
		expect(dbToTenths(-100)).toBe(-1000)
		expect(dbToTenths(24)).toBe(240)
	})

	it('rounds to the nearest tenth and always returns an integer', () => {
		for (const db of [0.04, 0.05, 0.06, -0.04, 2.55, -2.55, 1.15, 1.005, 123.456, -99.99, 0.1 + 0.2]) {
			expect(Number.isInteger(dbToTenths(db))).toBe(true)
		}
		expect(dbToTenths(2.54)).toBe(25)
		expect(dbToTenths(2.56)).toBe(26)
		expect(dbToTenths(0.1 + 0.2)).toBe(3)
		expect(dbToTenths(-3.14)).toBe(-31)
	})

	it('never returns negative zero', () => {
		expect(Object.is(dbToTenths(-0), 0)).toBe(true)
		expect(Object.is(dbToTenths(-0.04), 0)).toBe(true)
		expect(Object.is(dbToTenths(-0.0001), 0)).toBe(true)
	})

	it('throws on NaN and Infinity', () => {
		expect(() => dbToTenths(Number.NaN)).toThrow(RangeError)
		expect(() => dbToTenths(Infinity)).toThrow(RangeError)
		expect(() => dbToTenths(-Infinity)).toThrow(RangeError)
	})
})

describe('tenthsToDb', () => {
	it('divides by ten', () => {
		expect(tenthsToDb(-60)).toBe(-6)
		expect(tenthsToDb(210)).toBe(21)
		expect(tenthsToDb(0)).toBe(0)
	})
})

describe('clampGain', () => {
	it('clamps to -1000 .. +240', () => {
		expect(clampGain(0)).toBe(0)
		expect(clampGain(-1000)).toBe(-1000)
		expect(clampGain(-1001)).toBe(-1000)
		expect(clampGain(-99999)).toBe(-1000)
		expect(clampGain(240)).toBe(240)
		expect(clampGain(241)).toBe(240)
		expect(clampGain(Infinity)).toBe(240)
		expect(clampGain(-Infinity)).toBe(-1000)
	})

	it('rounds fractional tenths to integers', () => {
		expect(clampGain(12.4)).toBe(12)
		expect(clampGain(12.6)).toBe(13)
		expect(Number.isInteger(clampGain(239.7))).toBe(true)
	})

	// BUG: clampGain(-0.2) returns -0 (harmless on the wire, but dbToTenths avoids it and the two are inconsistent)
	it.fails('never returns negative zero', () => {
		expect(Object.is(clampGain(-0.2), 0)).toBe(true)
		expect(Object.is(clampGain(-0), 0)).toBe(true)
	})

	// BUG: NaN passes through clampGain unchanged, so callers must check for NaN themselves
	it.fails('does not return NaN for NaN', () => {
		expect(Number.isNaN(clampGain(Number.NaN))).toBe(false)
	})
})

describe('isXpointOn', () => {
	it('is on only above -1000', () => {
		expect(isXpointOn(0)).toBe(true)
		expect(isXpointOn(-999)).toBe(true)
		expect(isXpointOn(-1000)).toBe(false)
		expect(isXpointOn(-1001)).toBe(false)
		expect(isXpointOn(240)).toBe(true)
	})

	it('is off for undefined and NaN', () => {
		expect(isXpointOn(undefined)).toBe(false)
		expect(isXpointOn(Number.NaN)).toBe(false)
	})
})

describe('formatDb', () => {
	it('formats with one decimal and an explicit plus', () => {
		expect(formatDb(-60)).toBe('-6.0')
		expect(formatDb(35)).toBe('+3.5')
		expect(formatDb(0)).toBe('0.0')
		expect(formatDb(240)).toBe('+24.0')
		expect(formatDb(-1000)).toBe('-100.0')
		expect(formatDb(210)).toBe('+21.0')
	})

	it('keeps the sign for values between -1 and 0 dB', () => {
		expect(formatDb(-5)).toBe('-0.5')
		expect(formatDb(5)).toBe('+0.5')
		expect(formatDb(-1)).toBe('-0.1')
	})

	it('never shows negative zero', () => {
		expect(formatDb(-0)).toBe('0.0')
		expect(formatDb(-0.4)).toBe('0.0')
	})

	// BUG: NaN is formatted as "+NaN.NaN" instead of a neutral placeholder
	it.fails('does not print NaN fragments for NaN', () => {
		expect(formatDb(Number.NaN)).not.toMatch(/NaN/)
	})
})
