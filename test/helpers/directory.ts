import { decodeAdvert } from '../../src/lwrp/partyline.js'
import { LivewireDirectory } from '../../src/model/directory.js'
import { partylineFixture, type PartylineFixtureName } from '../fixtures/partyline/load.js'

/** The captured network: who sent what (the usage advert carries no device IP, the sender stands for it) */
const NETWORK: Array<[PartylineFixtureName, string]> = [
	['full-xnode-223', '10.96.30.223'],
	['full-xnode-224', '10.96.30.224'],
	['full-engine-part1', '10.96.30.235'],
	['full-engine-part2', '10.96.30.235'],
	['usage-xnode-fader11', '10.96.30.223'],
]

/**
 * A directory fed with real captured adverts: xNodes .223 (channels 22301-22308, `MIC 1` on 22301 =
 * 239.192.87.29, backfeed 239.193.87.29) and .224 (22401-22408), and the console Engine .235 (channels 141-153
 * and its backfeed source `To: SRC 1` on 239.193.87.29). SRC 1 of .223 is used by Engine .235, fader 11.
 */
export function networkDirectory(only?: PartylineFixtureName[]): LivewireDirectory {
	const directory = new LivewireDirectory({ now: () => 0 })
	for (const [name, sender] of NETWORK) {
		if (only && !only.includes(name)) continue
		const advert = decodeAdvert(partylineFixture(name), sender)
		if (!advert) throw new Error(`fixture ${name} does not decode`)
		directory.ingest(advert)
	}
	return directory
}
