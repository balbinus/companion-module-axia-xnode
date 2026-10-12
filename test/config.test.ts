import { describe, expect, it } from 'vitest'
import { GetConfigFields, isValidInterfaceIp } from '../src/config.js'

describe('isValidInterfaceIp', () => {
	it('accepts an empty value (system default) and IPv4 addresses', () => {
		for (const v of ['', '  ', '10.96.30.50', ' 192.168.1.2 ', '0.0.0.0']) expect(isValidInterfaceIp(v)).toBe(true)
	})

	it('rejects anything else', () => {
		for (const v of [
			'eth0',
			'10.96.30',
			'10.96.30.256',
			'10.96.30.50/24',
			'::1',
			'10.96.30.50:4001',
			'01.2.3.4',
			5,
			null,
		]) {
			expect(isValidInterfaceIp(v)).toBe(false)
		}
	})
})

describe('source discovery fields', () => {
	const fields = GetConfigFields()
	const field = (id: string): Record<string, unknown> => {
		const f = fields.find((x) => x.id === id)
		if (!f) throw new Error(`no config field ${id}`)
		return f as unknown as Record<string, unknown>
	}

	it('discovery is a checkbox, on by default', () => {
		expect(field('discoverSources')).toMatchObject({
			type: 'checkbox',
			label: 'Discover Livewire sources',
			default: true,
		})
		expect(String(field('discoverSources').tooltip)).toMatch(/239\.192\.255\.3.*4001.*Receive-only.*host networking/)
	})

	it('the interface is an optional text, shown only when discovery is on', () => {
		const f = field('partylineInterface')
		expect(f).toMatchObject({
			type: 'textinput',
			label: 'Livewire network interface IP (optional)',
			default: '',
			isVisibleExpression: '$(options:discoverSources)',
		})
		const re = new RegExp(String(f.regex).slice(1, -1))
		expect(re.test('')).toBe(true)
		expect(re.test('10.96.30.50')).toBe(true)
		expect(re.test('eth0')).toBe(false)
		expect(re.test('10.96.30')).toBe(false)
	})

	it('both sit right after the known sources', () => {
		const ids = fields.map((f) => f.id)
		const at = ids.indexOf('knownSources')
		expect(ids.slice(at + 1, at + 3)).toEqual(['discoverSources', 'partylineInterface'])
	})

	it('field ids are unique', () => {
		const ids = fields.map((f) => f.id)
		expect(new Set(ids).size).toBe(ids.length)
	})
})
