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
			disableAutoExpression: true, // partylineInterface depends on it
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
	})

	it('the interface regex agrees with isValidInterfaceIp', () => {
		const regex = String(field('partylineInterface').regex)
		expect(regex.startsWith('/') && regex.endsWith('/')).toBe(true)
		const re = new RegExp(regex.slice(1, -1))
		const cases = [
			'',
			'0.0.0.0',
			'10.96.30.50',
			'192.168.1.2',
			'255.255.255.255',
			'100.99.249.200',
			'10.96.30',
			'10.96.30.50.1',
			'10.96.30.256',
			'10.96.30.300',
			'10.96.30.1000',
			'10.96.30.',
			'.10.96.30',
			'10..30.50',
			'01.2.3.4',
			'1.2.3.04',
			'1.02.3.4',
			'00.0.0.0',
			'001.2.3.4',
			'10.96.30.-1',
			'10.96.30.5a',
			'a.b.c.d',
			'eth0',
			'::1',
			'10.96.30.50/24',
			'10.96.30.50:4001',
		]
		for (const value of cases) {
			expect(re.test(value), JSON.stringify(value)).toBe(isValidInterfaceIp(value))
		}
		// stricter only about padding, which the module trims
		for (const value of [' 10.96.30.50', '10.96.30.50 ', ' ', '10.96.30.50\n']) {
			expect(re.test(value), JSON.stringify(value)).toBe(false)
			expect(isValidInterfaceIp(value)).toBe(true)
		}
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
