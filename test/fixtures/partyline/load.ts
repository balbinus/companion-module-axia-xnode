import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PARTYLINE_FIXTURES = [
	'keepalive-xnode',
	'full-xnode-224',
	'full-xnode-223',
	'full-xnode-223-renamed',
	'full-engine-part1',
	'full-engine-part2',
	'usage-xnode-fader1',
	'usage-xnode-fader11',
	'usage-engine',
	'full-eth4can',
	'full-xnode2-empty',
] as const

export type PartylineFixtureName = (typeof PARTYLINE_FIXTURES)[number]

/** One real UDP payload from a capture: hex text, `#` comment lines and whitespace ignored */
export function partylineFixture(name: PartylineFixtureName): Buffer {
	const text = readFileSync(fileURLToPath(new URL(`./${name}.hex`, import.meta.url)), 'utf8')
	const hex = text.replace(/#.*$/gm, '').replace(/\s+/g, '')
	if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error(`Bad hex in fixture ${name}`)
	return Buffer.from(hex, 'hex')
}
