/** Variables and feedbacks that read the Livewire directory (source discovery) */
import { describe, expect, it, vi } from 'vitest'
import type { PartylineAdvert } from '../../src/lwrp/partyline.js'
import {
	computeVariableDefinitions,
	computeVariableValues,
	dstSourceName,
	evaluateSrcInUse,
	srcChannel,
	srcUsedByText,
	type DerivedConfig,
	type DirectoryView,
} from '../../src/model/derived.js'
import { LivewireDirectory } from '../../src/model/directory.js'
import { apply, loadedState } from '../fixtures/load.js'
import { networkDirectory } from '../helpers/directory.js'

const cfg: DerivedConfig = { meterMode: 'off', exposeXpointVariables: false, levelAlerts: true }

/** Node .223: SRC n is channel 22300+n (239.192.87.28+n), DST n listens to the backfeed of SRC n */
const node223 = (): ReturnType<typeof loadedState> => loadedState('legacy-analog4x4-a')

const vals = (directory?: DirectoryView, state = node223()): Record<string, string | number> =>
	computeVariableValues(state, cfg, true, directory)

/** A directory built by hand, as realistic adverts would fill it: SRC 1 of the node on fader 11 of the engine */
function handBuilt(): LivewireDirectory {
	const directory = new LivewireDirectory({ now: () => 0 })
	const full: PartylineAdvert = {
		kind: 'full',
		deviceIp: '10.96.30.223',
		deviceName: 'Node-223-0',
		configVersion: 451,
		sourceCount: 1,
		sources: [
			{
				slot: 'S001',
				channel: 22301,
				name: 'MIC 1',
				streamAddress: '239.192.87.29',
				backfeedAddress: '239.193.87.29',
			},
		],
		usage: [],
	}
	directory.ingest(full)
	directory.ingest({
		kind: 'usage',
		deviceIp: '10.96.30.223',
		sources: [],
		usage: [{ channel: 22301, usedBy: { engineIp: '10.96.30.235', fader: 11 } }],
	})
	return directory
}

describe('srcChannel', () => {
	it('reads the channel of the address a SRC sends to', () => {
		expect(srcChannel('239.192.87.29')).toBe(22301)
		expect(srcChannel(' 239.192.87.29;rtp-pt=97 ')).toBe(22301)
		expect(srcChannel('22301')).toBe(22301)
		expect(srcChannel('239.196.0.9')).toBe(9)
	})

	it('has none for a non-Livewire address or no address', () => {
		expect(srcChannel('239.10.0.1')).toBeUndefined()
		expect(srcChannel('')).toBeUndefined()
		expect(srcChannel(undefined)).toBeUndefined()
		expect(srcChannel('nonsense')).toBeUndefined()
	})
})

describe('src_N_used_by', () => {
	it('is engine IP / fader when a console uses the source', () => {
		const v = vals(handBuilt())
		expect(v.src_1_used_by).toBe('10.96.30.235/11')
		expect(v.src_2_used_by).toBe('')
	})

	it('follows the source to another fader', () => {
		const directory = handBuilt()
		directory.ingest({
			kind: 'usage',
			deviceIp: '10.96.30.223',
			sources: [],
			usage: [{ channel: 22301, usedBy: { engineIp: '10.96.30.235', fader: 1 } }],
		})
		expect(vals(directory).src_1_used_by).toBe('10.96.30.235/1')
		directory.ingest({
			kind: 'usage',
			deviceIp: '10.96.30.223',
			sources: [],
			usage: [{ channel: 22301, usedBy: null }],
		})
		expect(vals(directory).src_1_used_by).toBe('')
	})

	it('is empty without a directory (discovery off)', () => {
		expect(vals(undefined).src_1_used_by).toBe('')
	})

	it('comes from the captured network', () => {
		const v = vals(networkDirectory())
		expect(v.src_1_used_by).toBe('10.96.30.235/11')
		for (let n = 2; n <= 8; n++) expect(v[`src_${n}_used_by`]).toBe('')
	})

	it('goes with the channel the SRC sends to now', () => {
		const s = node223()
		apply(s, 'SRC 2 RTPA:"239.192.87.29"')
		expect(vals(handBuilt(), s).src_2_used_by).toBe('10.96.30.235/11')
		apply(s, 'SRC 1 RTPA:"239.10.0.1"') // not a Livewire channel
		expect(vals(handBuilt(), s).src_1_used_by).toBe('')
	})

	it('uses only the directory interface: a fake one is enough', () => {
		const usedBy = vi.fn((channel: number) => (channel === 22303 ? { engineIp: '10.0.0.9', fader: 3 } : null))
		const v = vals({ lookupAddress: () => undefined, usedBy })
		expect(v.src_3_used_by).toBe('10.0.0.9/3')
		expect(v.src_1_used_by).toBe('')
		expect(usedBy).toHaveBeenCalledWith(22301)
		expect(srcUsedByText({ usedBy }, '22303')).toBe('10.0.0.9/3')
	})
})

describe('dst_N_source_name', () => {
	it('names what a DST listens to', () => {
		const s = node223()
		apply(s, 'DST 3 ADDR:"239.192.87.129"') // MIX ANIM of node .224
		apply(s, 'DST 4 ADDR:"22401"') // the same, as a channel number
		apply(s, 'DST 5 ADDR:"239.192.87.130;rtp-pt=97"')
		const v = vals(networkDirectory(), s)
		expect(v.dst_3_source_name).toBe('MIX ANIM')
		expect(v.dst_4_source_name).toBe('MIX ANIM')
		expect(v.dst_5_source_name).toBe('GEN M Haut')
	})

	it('puts "To: " before the name of a source whose backfeed it listens to', () => {
		const v = vals(networkDirectory())
		expect(v.dst_1_source_name).toBe('To: MIC 1') // 239.193.87.29
		expect(v.dst_2_source_name).toBe('To: SRC 2')
		expect(v.dst_8_source_name).toBe('To: SRC 8')
	})

	it('does not double the "To:" of a console backfeed source', () => {
		// the engine alone: 239.193.87.29 is its own backfeed source "To: SRC 1" (a "from" address)
		const engine = networkDirectory(['full-engine-part1', 'full-engine-part2'])
		expect(vals(engine).dst_1_source_name).toBe('To: SRC 1')
		// and a source that is called "To: …" itself, listened to through its backfeed
		const directory = new LivewireDirectory({ now: () => 0 })
		directory.ingest({
			kind: 'full',
			deviceIp: '10.0.0.1',
			deviceName: 'Node',
			sourceCount: 1,
			sources: [
				{
					slot: 'S001',
					channel: 5,
					name: 'To: Phone',
					streamAddress: '239.192.0.5',
					backfeedAddress: '239.193.0.5',
				},
			],
			usage: [],
		})
		expect(dstSourceName(directory, '239.193.0.5')).toBe('To: Phone')
		expect(dstSourceName(directory, '239.192.0.5')).toBe('To: Phone')
	})

	it('finds a source by stream address, backfeed address or channel number', () => {
		expect(dstSourceName(handBuilt(), '239.192.87.29')).toBe('MIC 1')
		expect(dstSourceName(handBuilt(), '239.193.87.29')).toBe('To: MIC 1')
		expect(dstSourceName(handBuilt(), ' 22301 ')).toBe('MIC 1')
	})

	it('is empty when nothing is known: unknown address, no address, no directory', () => {
		expect(dstSourceName(handBuilt(), '239.192.1.1')).toBe('')
		expect(dstSourceName(handBuilt(), '')).toBe('')
		expect(dstSourceName(handBuilt(), 'not an address')).toBe('')
		expect(dstSourceName(undefined, '239.192.87.29')).toBe('')
		expect(vals(undefined).dst_1_source_name).toBe('')
		const s = node223()
		apply(s, 'DST 1 ADDR:""')
		expect(vals(handBuilt(), s).dst_1_source_name).toBe('')
	})

	it('is empty for a source without a name', () => {
		const directory = new LivewireDirectory({ now: () => 0 })
		directory.ingest({
			kind: 'full',
			deviceIp: '10.0.0.1',
			sourceCount: 1,
			sources: [{ slot: 'S001', channel: 5, name: '', streamAddress: '239.192.0.5', backfeedAddress: '239.193.0.5' }],
			usage: [],
		})
		expect(dstSourceName(directory, '239.192.0.5')).toBe('')
		expect(dstSourceName(directory, '239.193.0.5')).toBe('')
	})

	it('follows a rename and an expiry', () => {
		let clock = 0
		const directory = new LivewireDirectory({ now: () => clock })
		const advert = (name: string, version: number): PartylineAdvert => ({
			kind: 'full',
			deviceIp: '10.0.0.1',
			deviceName: 'Node',
			configVersion: version,
			sourceCount: 1,
			sources: [{ slot: 'S001', channel: 5, name, streamAddress: '239.192.0.5', backfeedAddress: '239.193.0.5' }],
			usage: [],
		})
		directory.ingest(advert('MIC 1', 1))
		expect(dstSourceName(directory, '239.192.0.5')).toBe('MIC 1')
		directory.ingest(advert('TEST 2', 2))
		expect(dstSourceName(directory, '239.192.0.5')).toBe('TEST 2')
		clock += 61_000
		directory.expire()
		expect(dstSourceName(directory, '239.192.0.5')).toBe('')
	})
})

describe('variables with and without a directory', () => {
	it('define the same variables either way: they are always defined', () => {
		const s = node223()
		const defs = Object.keys(computeVariableDefinitions(s, cfg)).sort()
		expect(defs).toContain('src_1_used_by')
		expect(defs).toContain('dst_8_source_name')
		for (const directory of [undefined, new LivewireDirectory(), networkDirectory()]) {
			expect(Object.keys(vals(directory, s)).sort()).toEqual(defs)
		}
	})

	it('are text, empty when unknown', () => {
		const v = vals(new LivewireDirectory())
		for (let n = 1; n <= 8; n++) {
			expect(v[`src_${n}_used_by`]).toBe('')
			expect(v[`dst_${n}_source_name`]).toBe('')
		}
	})

	it('definitions carry readable names', () => {
		const defs = computeVariableDefinitions(node223(), cfg)
		expect(defs.dst_2_source_name).toEqual({ name: 'DST 2: source name (from Livewire adverts)' })
		expect(defs.src_2_used_by).toEqual({ name: 'SRC 2: console using this source' })
	})
})

describe('evaluateSrcInUse', () => {
	/** `null` stands for "no directory" (a default would replace undefined) */
	const inUse = (src: number, engine = '', directory: DirectoryView | null = handBuilt()): boolean =>
		evaluateSrcInUse(node223(), directory ?? undefined, src, engine)

	it('is true for a source a console owns', () => {
		expect(inUse(1)).toBe(true)
		expect(inUse(2)).toBe(false)
		expect(inUse(99)).toBe(false) // no such SRC
	})

	it('can be limited to one engine', () => {
		expect(inUse(1, '10.96.30.235')).toBe(true)
		expect(inUse(1, ' 10.96.30.235 ')).toBe(true)
		expect(inUse(1, '10.96.30.236')).toBe(false)
		expect(inUse(1, '10.96.30')).toBe(false)
		expect(inUse(1, '   ')).toBe(true) // blank = any
		expect(evaluateSrcInUse(node223(), handBuilt(), 1, undefined)).toBe(true)
	})

	it('is false when discovery is off or nothing is known', () => {
		expect(inUse(1, '', null)).toBe(false)
		expect(inUse(1, '', new LivewireDirectory())).toBe(false)
	})

	it('follows the usage and the SRC address', () => {
		const directory = handBuilt()
		const s = node223()
		expect(evaluateSrcInUse(s, directory, 1, '')).toBe(true)
		directory.ingest({
			kind: 'usage',
			deviceIp: '10.96.30.223',
			sources: [],
			usage: [{ channel: 22301, usedBy: null }],
		})
		expect(evaluateSrcInUse(s, directory, 1, '')).toBe(false)
		apply(s, 'SRC 3 RTPA:"239.192.87.29"')
		directory.ingest({
			kind: 'usage',
			deviceIp: '10.96.30.223',
			sources: [],
			usage: [{ channel: 22301, usedBy: { engineIp: '10.96.30.235', fader: 2 } }],
		})
		expect(evaluateSrcInUse(s, directory, 3, '')).toBe(true)
		apply(s, 'SRC 3 RTPA:"239.192.87.30"') // moved to another channel
		expect(evaluateSrcInUse(s, directory, 3, '')).toBe(false)
	})

	it('knows the SRC by its channel, not by its number', () => {
		const v = vals(networkDirectory())
		expect(v.src_1_channel).toBe(22301)
		expect(evaluateSrcInUse(node223(), networkDirectory(), 1, '10.96.30.235')).toBe(true)
	})
})
