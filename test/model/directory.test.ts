import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AdvertisedSource, PartylineAdvert, SourceUsage } from '../../src/lwrp/partyline.js'
import {
	DEFAULT_EXPIRY_MS,
	LivewireDirectory,
	PENDING_MAX_AGE_MS,
	type DirectorySource,
} from '../../src/model/directory.js'

const NODE_IP = '10.96.30.223'
const NODE_NAME = 'Node-223-0'
const ENGINE_IP = '10.96.30.235'
const ENGINE_NAME = 'Engine402F59'

function source(slot: string, channel: number, name: string, stream?: string, backfeed?: string): AdvertisedSource {
	// The channel number is the low 16 bits of the addresses: 22301 = 87 * 256 + 29 -> 239.192.87.29 / 239.193.87.29
	const lo = channel % 256
	const hi = Math.floor(channel / 256)
	return {
		slot,
		channel,
		name,
		streamAddress: stream ?? `239.192.${hi}.${lo}`,
		backfeedAddress: backfeed ?? `239.193.${hi}.${lo}`,
	}
}

function keepalive(deviceIp: string, configVersion: number, extra: Partial<PartylineAdvert> = {}): PartylineAdvert {
	return { kind: 'keepalive', deviceIp, configVersion, sources: [], usage: [], ...extra }
}

function full(deviceIp: string, sources: AdvertisedSource[], extra: Partial<PartylineAdvert> = {}): PartylineAdvert {
	return {
		kind: 'full',
		deviceIp,
		configVersion: 1,
		sourceCount: sources.length,
		deviceName: deviceIp === NODE_IP ? NODE_NAME : deviceIp === ENGINE_IP ? ENGINE_NAME : undefined,
		sources,
		usage: [],
		...extra,
	}
}

function usage(deviceIp: string, entries: SourceUsage[]): PartylineAdvert {
	return { kind: 'usage', deviceIp, sources: [], usage: entries }
}

const FADER_1 = { engineIp: ENGINE_IP, fader: 1 }
const FADER_11 = { engineIp: ENGINE_IP, fader: 11 }

let clock = 0
let dir: LivewireDirectory
let onSources: Mock<() => void>
let onUsage: Mock<() => void>

beforeEach(() => {
	clock = 1_000_000
	dir = new LivewireDirectory({ now: () => clock })
	onSources = vi.fn<() => void>()
	onUsage = vi.fn<() => void>()
	dir.on('sources', onSources)
	dir.on('usage', onUsage)
})

describe('full adverts', () => {
	it('commits a single-datagram full advert', () => {
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'MIC 1'), source('S002', 22302, 'MIC 2')]))
		expect(dir.sources()).toEqual([
			{ ...source('S001', 22301, 'MIC 1'), deviceIp: NODE_IP, deviceName: NODE_NAME },
			{ ...source('S002', 22302, 'MIC 2'), deviceIp: NODE_IP, deviceName: NODE_NAME },
		])
		expect(onSources).toHaveBeenCalledTimes(1)
		expect(onUsage).not.toHaveBeenCalled()
	})

	it('shows nothing until the advert is complete (8 + 2 sources over two datagrams)', () => {
		const first = Array.from({ length: 8 }, (_, i) => source(`S00${i + 1}`, 100 + i, `SRC ${i + 1}`))
		const second = [source('S201', 22301, 'To: SRC 1'), source('S202', 22302, 'To: SRC 2')]
		dir.ingest(full(ENGINE_IP, first, { sourceCount: 10, configVersion: 18864 }))
		expect(dir.sources()).toEqual([])
		expect(onSources).not.toHaveBeenCalled()
		dir.ingest(full(ENGINE_IP, second, { sourceCount: 10, configVersion: 18864 }))
		expect(dir.sources()).toHaveLength(10)
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('merges the datagrams in either order', () => {
		const first = Array.from({ length: 8 }, (_, i) => source(`S00${i + 1}`, 100 + i, `SRC ${i + 1}`))
		const second = [source('S201', 22301, 'To: SRC 1'), source('S202', 22302, 'To: SRC 2')]
		dir.ingest(full(ENGINE_IP, second, { sourceCount: 10, configVersion: 7 }))
		expect(dir.sources()).toEqual([])
		dir.ingest(full(ENGINE_IP, first, { sourceCount: 10, configVersion: 7 }))
		expect(dir.sources().map((s) => s.slot)).toEqual([
			'S001',
			'S002',
			'S003',
			'S004',
			'S005',
			'S006',
			'S007',
			'S008',
			'S201',
			'S202',
		])
	})

	it('counts distinct slots: a repeated datagram does not complete the advert', () => {
		const first = [source('S001', 1, 'A'), source('S002', 2, 'B')]
		dir.ingest(full(NODE_IP, first, { sourceCount: 3 }))
		dir.ingest(full(NODE_IP, first, { sourceCount: 3 }))
		expect(dir.sources()).toEqual([])
		dir.ingest(full(NODE_IP, [source('S003', 3, 'C')], { sourceCount: 3 }))
		expect(dir.sources()).toHaveLength(3)
	})

	it('abandons the pending set when the configVersion changes mid-way', () => {
		dir.ingest(
			full(NODE_IP, [source('S001', 1, 'old A'), source('S002', 2, 'old B')], { sourceCount: 3, configVersion: 5 }),
		)
		// new version starts over: the two old slots do not count towards it
		dir.ingest(full(NODE_IP, [source('S003', 3, 'new C')], { sourceCount: 3, configVersion: 6 }))
		expect(dir.sources()).toEqual([])
		dir.ingest(
			full(NODE_IP, [source('S001', 1, 'new A'), source('S002', 2, 'new B')], { sourceCount: 3, configVersion: 6 }),
		)
		expect(dir.sources().map((s) => s.name)).toEqual(['new A', 'new B', 'new C'])
	})

	it('replaces a repeated slot within the pending set', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'first')], { sourceCount: 2 }))
		dir.ingest(full(NODE_IP, [source('S001', 1, 'second'), source('S002', 2, 'B')], { sourceCount: 2 }))
		expect(dir.sources().map((s) => s.name)).toEqual(['second', 'B'])
	})

	it('commits when the configVersion goes down (device reboot)', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')], { configVersion: 452 }))
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A'), source('S002', 2, 'B')], { configVersion: 6 }))
		expect(dir.sources().map((s) => s.name)).toEqual(['A', 'B'])
		expect(onSources).toHaveBeenCalledTimes(2)
	})

	it('replaces the committed list wholesale', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A'), source('S002', 2, 'B')], { configVersion: 1 }))
		dir.ingest(full(NODE_IP, [source('S002', 2, 'B')], { configVersion: 2 }))
		expect(dir.sources().map((s) => s.channel)).toEqual([2])
	})

	it('treats sourceCount 0 as complete and empty', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')], { configVersion: 1 }))
		onSources.mockClear()
		dir.ingest(full(NODE_IP, [], { sourceCount: 0, configVersion: 2 }))
		expect(dir.sources()).toEqual([])
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('emits nothing for a device that advertises no sources', () => {
		dir.ingest(full('10.96.30.225', [], { sourceCount: 0, deviceName: 'xnode2-815CF7' }))
		expect(dir.sources()).toEqual([])
		expect(onSources).not.toHaveBeenCalled()
		expect(onUsage).not.toHaveBeenCalled()
	})

	it('uses the datagram length when sourceCount is unknown', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A'), source('S002', 2, 'B')], { sourceCount: undefined }))
		expect(dir.sources()).toHaveLength(2)
	})

	it('keeps devices apart', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
		dir.ingest(full('10.96.30.224', [source('S001', 2, 'B')], { sourceCount: 2 }))
		// the second device is incomplete and must not disturb the first
		expect(dir.sources().map((s) => s.name)).toEqual(['A'])
	})
})

describe('full adverts repeating', () => {
	const first = Array.from({ length: 8 }, (_, i) => source(`S00${i + 1}`, 100 + i, `SRC ${i + 1}`))
	const second = [source('S201', 22301, 'To: SRC 1'), source('S202', 22302, 'To: SRC 2')]
	const datagram1 = (): PartylineAdvert => full(ENGINE_IP, first, { sourceCount: 10, configVersion: 18864 })
	const datagram2 = (): PartylineAdvert => full(ENGINE_IP, second, { sourceCount: 10, configVersion: 18864 })

	it('keeps the list visible and silent in steady state, between the datagrams of every cycle', () => {
		dir.ingest(datagram1())
		dir.ingest(datagram2())
		expect(dir.sources()).toHaveLength(10)
		expect(onSources).toHaveBeenCalledTimes(1)
		for (let cycle = 0; cycle < 3; cycle++) {
			clock += 160_000
			dir.ingest(keepalive(ENGINE_IP, 18864))
			dir.ingest(datagram1())
			expect(dir.sources()).toHaveLength(10)
			dir.ingest(datagram2())
			expect(dir.sources()).toHaveLength(10)
		}
		expect(onSources).toHaveBeenCalledTimes(1)
		expect(onUsage).not.toHaveBeenCalled()
	})

	it('keeps the list visible when the datagrams come in the other order', () => {
		dir.ingest(datagram2())
		dir.ingest(datagram1())
		clock += 160_000
		dir.ingest(datagram2())
		expect(dir.sources()).toHaveLength(10)
		dir.ingest(datagram1())
		expect(dir.sources()).toHaveLength(10)
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('keeps the old list until a larger set with the same configVersion is complete', () => {
		const ab = [source('S001', 1, 'A'), source('S002', 2, 'B')]
		dir.ingest(full(NODE_IP, ab, { configVersion: 3 }))
		onSources.mockClear()
		dir.ingest(full(NODE_IP, ab, { sourceCount: 3, configVersion: 3 }))
		expect(dir.sources().map((s) => s.name)).toEqual(['A', 'B'])
		expect(onSources).not.toHaveBeenCalled()
		dir.ingest(full(NODE_IP, [source('S003', 3, 'C')], { sourceCount: 3, configVersion: 3 }))
		expect(dir.sources().map((s) => s.name)).toEqual(['A', 'B', 'C'])
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('commits a smaller set with the same configVersion at once', () => {
		const abc = [source('S001', 1, 'A'), source('S002', 2, 'B'), source('S003', 3, 'C')]
		dir.ingest(full(NODE_IP, abc, { configVersion: 3 }))
		onSources.mockClear()
		dir.ingest(full(NODE_IP, abc.slice(0, 2), { sourceCount: 2, configVersion: 3 }))
		expect(dir.sources().map((s) => s.name)).toEqual(['A', 'B'])
		expect(onSources).toHaveBeenCalledTimes(1)
	})
})

describe('incomplete adverts', () => {
	const old1 = [source('S001', 1, 'old A'), source('S002', 2, 'old B')]
	const new1 = [source('S001', 1, 'new A'), source('S002', 2, 'new B')]
	const tail = [source('S201', 3, 'To: new')]
	const datagram1 = (sources: AdvertisedSource[]): PartylineAdvert =>
		full(NODE_IP, sources, { sourceCount: 3, configVersion: 5 })

	it('does not complete a set from the slots of an earlier cycle after a lost datagram', () => {
		dir.ingest(datagram1(old1)) // the second datagram of this cycle is lost
		clock += 160_000
		// same configVersion, but S001 and S002 changed since: the tail alone must not borrow the old slots
		dir.ingest(datagram1(tail))
		expect(dir.sources()).toEqual([])
		expect(onSources).not.toHaveBeenCalled()
		dir.ingest(datagram1(new1))
		expect(dir.sources().map((s) => s.name)).toEqual(['new A', 'new B', 'To: new'])
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('commits a fresh complete cycle after a lost datagram', () => {
		dir.ingest(datagram1(old1))
		clock += 160_000
		dir.ingest(datagram1(new1))
		dir.ingest(datagram1(tail))
		expect(dir.sources().map((s) => s.name)).toEqual(['new A', 'new B', 'To: new'])
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('merges datagrams up to PENDING_MAX_AGE_MS apart, and not further', () => {
		dir.ingest(datagram1(old1))
		clock += PENDING_MAX_AGE_MS
		dir.ingest(datagram1(tail))
		expect(dir.sources()).toHaveLength(3)

		const other = new LivewireDirectory({ now: () => clock })
		other.ingest(datagram1(old1))
		clock += PENDING_MAX_AGE_MS + 1
		other.ingest(datagram1(tail))
		expect(other.sources()).toEqual([])
	})

	it('measures the age from the first datagram of the set, not from the last', () => {
		dir.ingest(datagram1(old1))
		clock += 6000
		dir.ingest(datagram1(old1))
		clock += 6000
		dir.ingest(datagram1(tail))
		expect(dir.sources()).toEqual([])
	})

	it('keeps the committed list while a stale set is abandoned', () => {
		dir.ingest(datagram1([...old1, ...tail]))
		onSources.mockClear()
		dir.ingest(datagram1(old1))
		clock += 160_000
		dir.ingest(datagram1(tail))
		expect(dir.sources()).toHaveLength(3)
		expect(onSources).not.toHaveBeenCalled()
	})
})

describe('change events', () => {
	beforeEach(() => {
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'SRC 1'), source('S002', 22302, 'SRC 2')], { configVersion: 451 }))
		onSources.mockClear()
	})

	it('emits sources once for a rename', () => {
		dir.ingest(keepalive(NODE_IP, 452))
		expect(onSources).not.toHaveBeenCalled()
		expect(dir.sources().map((s) => s.name)).toEqual(['SRC 1', 'SRC 2'])
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'SRC 1'), source('S002', 22302, 'TEST 2')], { configVersion: 452 }))
		expect(onSources).toHaveBeenCalledTimes(1)
		expect(dir.sources().map((s) => s.name)).toEqual(['SRC 1', 'TEST 2'])
		dir.ingest(keepalive(NODE_IP, 452))
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('emits sources when an address changes', () => {
		dir.ingest(
			full(NODE_IP, [source('S001', 22301, 'SRC 1', '239.192.1.1'), source('S002', 22302, 'SRC 2')], {
				configVersion: 452,
			}),
		)
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('emits nothing when an identical list is committed again', () => {
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'SRC 1'), source('S002', 22302, 'SRC 2')], { configVersion: 451 }))
		dir.ingest(full(NODE_IP, [source('S002', 22302, 'SRC 2'), source('S001', 22301, 'SRC 1')], { configVersion: 451 }))
		expect(onSources).not.toHaveBeenCalled()
		expect(onUsage).not.toHaveBeenCalled()
	})

	it('emits nothing when only the configVersion changed', () => {
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'SRC 1'), source('S002', 22302, 'SRC 2')], { configVersion: 9 }))
		expect(onSources).not.toHaveBeenCalled()
	})

	// Only full adverts carry the device name (ATRN)
	it('emits sources when the device name changes, and not when it stays', () => {
		const sources = [source('S001', 22301, 'SRC 1'), source('S002', 22302, 'SRC 2')]
		dir.ingest(full(NODE_IP, sources, { configVersion: 451, deviceName: 'Studio A' }))
		expect(onSources).toHaveBeenCalledTimes(1)
		expect(dir.sources().map((s) => s.deviceName)).toEqual(['Studio A', 'Studio A'])
		dir.ingest(full(NODE_IP, sources, { configVersion: 451, deviceName: 'Studio A' }))
		dir.ingest(keepalive(NODE_IP, 451))
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('defaults the device name to its IP until it is known', () => {
		const d = new LivewireDirectory()
		d.ingest(full(NODE_IP, [source('S001', 1, 'A')], { deviceName: undefined }))
		expect(d.sources()[0].deviceName).toBe(NODE_IP)
		d.ingest(full(NODE_IP, [source('S001', 1, 'A')], { deviceName: NODE_NAME }))
		expect(d.sources()[0].deviceName).toBe(NODE_NAME)
		// an advert without a name (or an empty one) does not forget it
		d.ingest(keepalive(NODE_IP, 1))
		d.ingest(full(NODE_IP, [source('S001', 1, 'A')], { deviceName: '' }))
		expect(d.sources()[0].deviceName).toBe(NODE_NAME)
	})

	it('does not emit for the name of a device that has no sources', () => {
		dir.ingest(full('10.96.30.224', [], { sourceCount: 0, configVersion: 3, deviceName: 'Other' }))
		expect(onSources).not.toHaveBeenCalled()
	})

	it('keeps the old list while a keepalive announces another configVersion', () => {
		dir.ingest(keepalive(NODE_IP, 999))
		expect(dir.sources()).toHaveLength(2)
		expect(onSources).not.toHaveBeenCalled()
	})

	it('emits synchronously, with the new state already visible', () => {
		const seen: number[] = []
		dir.on('sources', () => seen.push(dir.sources().length))
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'SRC 1')], { configVersion: 452 }))
		expect(seen).toEqual([1])
	})
})

describe('usage', () => {
	it('reports the engine using a channel', () => {
		expect(dir.usedBy(22301)).toBeNull()
		dir.ingest(
			usage(NODE_IP, [
				{ channel: 22301, usedBy: FADER_1 },
				{ channel: 22302, usedBy: null },
			]),
		)
		expect(dir.usedBy(22301)).toEqual(FADER_1)
		expect(dir.usedBy(22302)).toBeNull()
		expect(onUsage).toHaveBeenCalledTimes(1)
		expect(onSources).not.toHaveBeenCalled()
	})

	it('emits usage when the user changes, once, and not when it stays', () => {
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]))
		onUsage.mockClear()
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]))
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: { ...FADER_1 } }]))
		expect(onUsage).not.toHaveBeenCalled()
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_11 }]))
		expect(onUsage).toHaveBeenCalledTimes(1)
		expect(dir.usedBy(22301)).toEqual(FADER_11)
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: null }]))
		expect(onUsage).toHaveBeenCalledTimes(2)
		expect(dir.usedBy(22301)).toBeNull()
	})

	it('replaces the device usage wholesale', () => {
		dir.ingest(
			usage(NODE_IP, [
				{ channel: 1, usedBy: FADER_1 },
				{ channel: 2, usedBy: FADER_1 },
			]),
		)
		dir.ingest(usage(NODE_IP, [{ channel: 2, usedBy: FADER_11 }]))
		expect(dir.usedBy(1)).toBeNull()
		expect(dir.usedBy(2)).toEqual(FADER_11)
	})

	it('does not emit usage when a channel goes from unknown to explicitly unused', () => {
		dir.ingest(usage(NODE_IP, [{ channel: 5, usedBy: null }]))
		expect(onUsage).not.toHaveBeenCalled()
	})

	it('prefers a reported user over another device reporting the channel unused', () => {
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]))
		dir.ingest(usage(ENGINE_IP, [{ channel: 22301, usedBy: null }]))
		expect(dir.usedBy(22301)).toEqual(FADER_1)
	})

	it('does not touch the sources', () => {
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'SRC 1')]))
		onSources.mockClear()
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]))
		expect(dir.sources()).toHaveLength(1)
		expect(onSources).not.toHaveBeenCalled()
	})
})

describe('usage reported by several devices', () => {
	// Node .223 owns 22301; the Engine .235 lists its backfeed as a source of its own (stream == backfeed)
	const nodeSource = source('S001', 22301, 'MIC 1', '239.192.87.29', '239.193.87.29')
	const engineSource = source('S201', 22301, 'To: MIC 1', '239.193.87.29', '239.193.87.29')
	const OTHER_IP = '10.96.30.100'

	function hear(directory: LivewireDirectory, ...adverts: PartylineAdvert[]): void {
		for (const advert of adverts) directory.ingest(advert)
	}
	const nodeAdvert = (): PartylineAdvert => full(NODE_IP, [nodeSource])
	const engineAdvert = (): PartylineAdvert => full(ENGINE_IP, [engineSource])

	it.each([
		['node first', true],
		['engine first', false],
	])('prefers the device that owns the channel as a regular source (%s)', (_name, nodeFirst) => {
		const nodeUsage = usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }])
		const engineUsage = usage(ENGINE_IP, [{ channel: 22301, usedBy: FADER_11 }])
		hear(
			dir,
			...(nodeFirst
				? [nodeAdvert(), engineAdvert(), nodeUsage, engineUsage]
				: [engineUsage, engineAdvert(), nodeAdvert(), nodeUsage]),
		)
		expect(dir.usedBy(22301)).toEqual(FADER_1)
	})

	it('does not flip when an unrelated device expires and reappears', () => {
		const nodeUsage = usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }])
		const engineUsage = usage(ENGINE_IP, [{ channel: 22301, usedBy: FADER_11 }])
		// a device with a lower IP than both, which owns nothing
		const otherUsage = usage(OTHER_IP, [{ channel: 22301, usedBy: { engineIp: OTHER_IP, fader: 3 } }])
		// the owner is heard last, so that the order the devices were heard in cannot be what decides
		hear(dir, otherUsage, engineAdvert(), engineUsage, nodeAdvert(), nodeUsage)
		expect(dir.usedBy(22301)).toEqual(FADER_1)
		onUsage.mockClear()

		// the third device stops talking and expires while `alive` and the node keep talking, then it comes back
		const bounce = (alive: string, comeBack: PartylineAdvert[]): void => {
			for (let i = 0; i < 2; i++) {
				clock += 40_000
				hear(dir, keepalive(NODE_IP, 1), keepalive(alive, 1))
			}
			dir.expire()
			expect(dir.usedBy(22301)).toEqual(FADER_1)
			hear(dir, ...comeBack)
			expect(dir.usedBy(22301)).toEqual(FADER_1)
		}
		bounce(ENGINE_IP, [otherUsage])
		bounce(OTHER_IP, [engineAdvert(), engineUsage])
		expect(onUsage).not.toHaveBeenCalled()
	})

	it('falls back to the other device when the owner expires, and back when it returns', () => {
		const nodeUsage = usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }])
		const engineUsage = usage(ENGINE_IP, [{ channel: 22301, usedBy: FADER_11 }])
		hear(dir, nodeAdvert(), engineAdvert(), nodeUsage, engineUsage)
		clock += 30_000
		hear(dir, keepalive(ENGINE_IP, 1))
		clock += 31_000
		dir.expire()
		expect(dir.usedBy(22301)).toEqual(FADER_11)
		hear(dir, nodeAdvert(), nodeUsage)
		expect(dir.usedBy(22301)).toEqual(FADER_1)
	})

	it.each([
		['low IP first', true],
		['high IP first', false],
	])('settles between non-owners by the lowest IP, numerically (%s)', (_name, lowFirst) => {
		const low = usage('10.96.30.9', [{ channel: 22301, usedBy: { engineIp: '10.96.30.9', fader: 4 } }])
		const high = usage('10.96.30.100', [{ channel: 22301, usedBy: { engineIp: '10.96.30.100', fader: 5 } }])
		hear(dir, ...(lowFirst ? [low, high] : [high, low]))
		expect(dir.usedBy(22301)).toEqual({ engineIp: '10.96.30.9', fader: 4 })
	})

	it('does not count a backfeed source as owning the channel', () => {
		// the Engine only lists the backfeed; with the node gone, the lowest IP decides, not the Engine's source
		const low = usage('10.96.30.9', [{ channel: 22301, usedBy: { engineIp: '10.96.30.9', fader: 4 } }])
		hear(dir, engineAdvert(), usage(ENGINE_IP, [{ channel: 22301, usedBy: FADER_11 }]), low)
		expect(dir.usedBy(22301)).toEqual({ engineIp: '10.96.30.9', fader: 4 })
	})

	it('lets the lowest IP among several owners decide', () => {
		const other = source('S001', 22301, 'MIC 1 dup')
		hear(dir, nodeAdvert(), full(OTHER_IP, [other]))
		hear(
			dir,
			usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]),
			usage(OTHER_IP, [{ channel: 22301, usedBy: FADER_11 }]),
		)
		expect(dir.usedBy(22301)).toEqual(FADER_11)
	})

	it('still prefers any user over null, owner or not', () => {
		hear(dir, nodeAdvert(), engineAdvert())
		hear(
			dir,
			usage(NODE_IP, [{ channel: 22301, usedBy: null }]),
			usage(ENGINE_IP, [{ channel: 22301, usedBy: FADER_11 }]),
		)
		expect(dir.usedBy(22301)).toEqual(FADER_11)
	})

	it('answers per channel', () => {
		hear(dir, nodeAdvert(), engineAdvert())
		hear(
			dir,
			usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]),
			usage(ENGINE_IP, [
				{ channel: 22301, usedBy: FADER_11 },
				{ channel: 22399, usedBy: FADER_11 },
			]),
		)
		expect(dir.usedBy(22301)).toEqual(FADER_1)
		expect(dir.usedBy(22399)).toEqual(FADER_11)
	})
})

describe('expire', () => {
	it('keeps a device up to exactly expiryMs and drops it after', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
		onSources.mockClear()
		clock += 60_000
		dir.expire()
		expect(dir.sources()).toHaveLength(1)
		expect(onSources).not.toHaveBeenCalled()
		clock += 1
		dir.expire()
		expect(dir.sources()).toEqual([])
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('honours a custom expiryMs', () => {
		const d = new LivewireDirectory({ expiryMs: 5000, now: () => clock })
		d.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
		clock += 5001
		d.expire()
		expect(d.sources()).toEqual([])
	})

	it('is refreshed by every kind of advert', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
		clock += 40_000
		dir.ingest(keepalive(NODE_IP, 1))
		clock += 40_000
		dir.expire()
		expect(dir.sources()).toHaveLength(1)
		dir.ingest(usage(NODE_IP, []))
		clock += 40_000
		dir.expire()
		expect(dir.sources()).toHaveLength(1)
		clock += 21_000
		dir.expire()
		expect(dir.sources()).toEqual([])
	})

	it('only drops the stale devices', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
		clock += 30_000
		dir.ingest(full(ENGINE_IP, [source('S201', 2, 'B')]))
		clock += 31_000
		dir.expire()
		expect(dir.sources().map((s) => s.deviceIp)).toEqual([ENGINE_IP])
	})

	it('emits usage only when the removed device contributed usage', () => {
		dir.ingest(keepalive('10.96.30.224', 1))
		clock += 61_000
		dir.expire()
		expect(onSources).not.toHaveBeenCalled()
		expect(onUsage).not.toHaveBeenCalled()

		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]))
		onUsage.mockClear()
		clock += 61_000
		dir.expire()
		expect(onUsage).toHaveBeenCalledTimes(1)
		expect(onSources).not.toHaveBeenCalled()
		expect(dir.usedBy(22301)).toBeNull()
	})

	it('starts afresh when an expired device comes back', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')], { configVersion: 5 }))
		clock += 61_000
		dir.expire()
		dir.ingest(keepalive(NODE_IP, 5))
		expect(dir.sources()).toEqual([])
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')], { configVersion: 5 }))
		expect(dir.sources()).toHaveLength(1)
	})
})

describe('lookupAddress', () => {
	// The Engine lists the backfeed of node source 22301 as a source of its own
	const nodeSource = source('S001', 22301, 'MIC 1', '239.192.87.29', '239.193.87.29')
	const consoleSource = source('S201', 22301, 'To: SRC 1', '239.193.87.29', '239.193.87.29')

	beforeEach(() => {
		dir.ingest(full(NODE_IP, [nodeSource, source('S002', 22302, 'MIC 2', '239.192.87.30', '239.193.87.30')]))
		dir.ingest(full(ENGINE_IP, [consoleSource]))
	})

	it('finds the source whose stream it is', () => {
		const hit = dir.lookupAddress('239.192.87.29')
		expect(hit?.kind).toBe('from')
		expect(hit?.source).toMatchObject({ deviceIp: NODE_IP, deviceName: NODE_NAME, name: 'MIC 1', slot: 'S001' })
	})

	it('finds the source a backfeed goes to, before the console source that outputs it', () => {
		const hit = dir.lookupAddress('239.193.87.29')
		expect(hit?.kind).toBe('to')
		expect(hit?.source).toMatchObject({ deviceIp: NODE_IP, name: 'MIC 1' })
	})

	it('falls back to a console backfeed source when no node source claims the address', () => {
		dir.clear()
		dir.ingest(full(ENGINE_IP, [consoleSource]))
		const hit = dir.lookupAddress('239.193.87.29')
		expect(hit?.kind).toBe('from')
		expect(hit?.source).toMatchObject({ deviceIp: ENGINE_IP, name: 'To: SRC 1' })
	})

	it('prefers a stream match over a backfeed match', () => {
		// source B streams on the address that source A uses as its backfeed
		dir.ingest(
			full(
				'10.96.30.224',
				[source('S001', 5, 'A', '239.192.0.5', '239.193.0.9'), source('S002', 6, 'B', '239.193.0.9', '239.193.0.6')],
				{ sourceCount: 2 },
			),
		)
		expect(dir.lookupAddress('239.193.0.9')).toMatchObject({ kind: 'from', source: { name: 'B' } })
	})

	it('resolves ties by sources() order', () => {
		dir.ingest(full('10.96.30.224', [source('S001', 22300, 'Earlier', '239.192.87.29', '239.193.99.99')]))
		expect(dir.lookupAddress('239.192.87.29')?.source.name).toBe('Earlier')
	})

	it('trims the input and matches exactly', () => {
		expect(dir.lookupAddress('  239.192.87.29 ')?.source.name).toBe('MIC 1')
		expect(dir.lookupAddress('239.192.87.2')).toBeUndefined()
		expect(dir.lookupAddress('239.192.87.290')).toBeUndefined()
		expect(dir.lookupAddress('')).toBeUndefined()
	})

	it('returns undefined for an unknown address', () => {
		expect(dir.lookupAddress('239.192.1.1')).toBeUndefined()
	})

	it('follows the committed sources: gone with the device', () => {
		clock += 61_000
		dir.expire()
		expect(dir.lookupAddress('239.192.87.29')).toBeUndefined()
	})
})

describe('sources ordering and housekeeping', () => {
	it('sorts by channel, then by device IP numerically', () => {
		dir.ingest(full('10.96.30.223', [source('S001', 30, 'c30'), source('S002', 10, 'c10')], { sourceCount: 2 }))
		dir.ingest(full('10.96.30.9', [source('S001', 20, 'c20'), source('S002', 30, 'c30 on .9')], { sourceCount: 2 }))
		expect(dir.sources().map((s) => `${s.channel}@${s.deviceIp}`)).toEqual([
			'10@10.96.30.223',
			'20@10.96.30.9',
			'30@10.96.30.9',
			'30@10.96.30.223',
		])
	})

	it('returns a copy that callers cannot use to alter the directory', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
		;(dir.sources() as DirectorySource[]).pop()
		expect(dir.sources()).toHaveLength(1)
	})

	it('returns frozen sources, so that a consumer cannot corrupt what changes are compared with', () => {
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'A', '239.192.87.29', '239.193.87.29')]))
		const [entry] = dir.sources()
		expect(Object.isFrozen(entry)).toBe(true)
		expect(() => {
			;(entry as DirectorySource).name = 'hacked'
		}).toThrow(TypeError)
		const hit = dir.lookupAddress('239.192.87.29')
		expect(hit?.source).toBe(entry)
		expect(() => {
			;(hit!.source as DirectorySource).streamAddress = '239.192.0.1'
		}).toThrow(TypeError)
		expect(dir.sources()[0]).toMatchObject({ name: 'A', streamAddress: '239.192.87.29' })

		// the baseline is intact: committing the same list again is silent
		onSources.mockClear()
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'A', '239.192.87.29', '239.193.87.29')], { configVersion: 2 }))
		expect(onSources).not.toHaveBeenCalled()
	})

	it('returns a frozen user', () => {
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: { ...FADER_1 } }]))
		const user = dir.usedBy(22301)!
		expect(Object.isFrozen(user)).toBe(true)
		expect(() => {
			;(user as { fader: number }).fader = 9
		}).toThrow(TypeError)
		expect(dir.usedBy(22301)).toEqual(FADER_1)
	})

	it('clear() drops everything and emits for what was visible', () => {
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'A')]))
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]))
		onSources.mockClear()
		onUsage.mockClear()
		dir.clear()
		expect(dir.sources()).toEqual([])
		expect(dir.usedBy(22301)).toBeNull()
		expect(dir.lookupAddress('239.192.87.29')).toBeUndefined()
		expect(onSources).toHaveBeenCalledTimes(1)
		expect(onUsage).toHaveBeenCalledTimes(1)
	})

	it('clear() on an empty or invisible directory emits nothing', () => {
		dir.clear()
		dir.ingest(full(NODE_IP, [], { sourceCount: 0, deviceName: 'x' }))
		dir.clear()
		expect(onSources).not.toHaveBeenCalled()
		expect(onUsage).not.toHaveBeenCalled()
	})

	it('deviceCount() counts the devices heard from, with or without known sources', () => {
		expect(dir.deviceCount()).toBe(0)
		dir.ingest(keepalive(NODE_IP, 1))
		expect(dir.deviceCount()).toBe(1)
		expect(dir.sources()).toEqual([])
		dir.ingest(keepalive(NODE_IP, 1))
		dir.ingest(full(ENGINE_IP, [source('S001', 1, 'A')]))
		expect(dir.deviceCount()).toBe(2)
		clock += 60_001
		dir.ingest(keepalive(NODE_IP, 1))
		dir.expire()
		expect(dir.deviceCount()).toBe(1)
		dir.clear()
		expect(dir.deviceCount()).toBe(0)
	})

	it('forgets the pending state on clear()', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')], { sourceCount: 2, configVersion: 3 }))
		dir.clear()
		dir.ingest(full(NODE_IP, [source('S002', 2, 'B')], { sourceCount: 2, configVersion: 3 }))
		expect(dir.sources()).toEqual([])
	})
})

describe('listeners', () => {
	/** A device that contributes sources and usage: once the clock has moved on, expiring it changes both */
	function populate(): void {
		dir.ingest(full(NODE_IP, [source('S001', 22301, 'MIC 1')]))
		dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]))
		onSources.mockClear()
		onUsage.mockClear()
		clock += 61_000
	}

	describe('that throw', () => {
		it('do not lose the usage event, and the first error is rethrown after both emits', () => {
			populate()
			const calls: string[] = []
			dir.on('sources', () => {
				calls.push('sources')
				throw new Error('sources boom')
			})
			dir.on('usage', () => calls.push('usage'))
			expect(() => dir.expire()).toThrow('sources boom')
			expect(calls).toEqual(['sources', 'usage'])
			expect(onSources).toHaveBeenCalledTimes(1)
			expect(onUsage).toHaveBeenCalledTimes(1)
			// the new state is in place
			expect(dir.sources()).toEqual([])
			expect(dir.usedBy(22301)).toBeNull()
		})

		it('rethrow the usage error when only that one throws', () => {
			populate()
			dir.on('usage', () => {
				throw new Error('usage boom')
			})
			expect(() => dir.expire()).toThrow('usage boom')
			expect(onSources).toHaveBeenCalledTimes(1)
		})

		it('rethrow the first error when both throw', () => {
			populate()
			dir.on('sources', () => {
				throw new Error('sources boom')
			})
			dir.on('usage', () => {
				throw new Error('usage boom')
			})
			expect(() => dir.expire()).toThrow('sources boom')
			expect(onUsage).toHaveBeenCalledTimes(1)
		})

		it('leave the directory working', () => {
			populate()
			const boom = vi.fn(() => {
				throw new Error('boom')
			})
			dir.on('sources', boom)
			expect(() => dir.expire()).toThrow('boom')
			expect(() => dir.ingest(full(NODE_IP, [source('S001', 1, 'A')]))).toThrow('boom')
			expect(dir.sources().map((s) => s.name)).toEqual(['A'])
			expect(boom).toHaveBeenCalledTimes(2)
			dir.off('sources', boom)
			dir.ingest(full(NODE_IP, [source('S001', 1, 'B')], { configVersion: 2 }))
			expect(dir.sources().map((s) => s.name)).toEqual(['B'])
		})
	})

	describe('that call back into the directory', () => {
		it('see the new state at once, and the resulting events follow the running round, not nested', () => {
			const log: string[] = []
			let reentered = false
			let inside = 0
			let deepest = 0
			dir.on('sources', () => {
				inside++
				deepest = Math.max(deepest, inside)
				log.push(`sources:${dir.sources().length}`)
				if (!reentered) {
					reentered = true
					dir.ingest(usage(NODE_IP, [{ channel: 22301, usedBy: FADER_1 }]))
					log.push(`visible:${dir.usedBy(22301)?.fader}`)
				}
				inside--
			})
			dir.on('usage', () => {
				inside++
				deepest = Math.max(deepest, inside)
				log.push('usage')
				inside--
			})
			dir.ingest(full(NODE_IP, [source('S001', 22301, 'A')]))
			expect(log).toEqual(['sources:1', 'visible:1', 'usage'])
			expect(deepest).toBe(1)
			expect(onSources).toHaveBeenCalledTimes(1)
			expect(onUsage).toHaveBeenCalledTimes(1)
		})

		it('get one more round for a source change they make, in order, without duplicates', () => {
			const log: string[] = []
			let reentered = false
			dir.on('sources', () => {
				log.push(`sources:${dir.sources().length}`)
				if (!reentered) {
					reentered = true
					dir.ingest(full(ENGINE_IP, [source('S201', 2, 'B')]))
				}
			})
			dir.on('usage', () => log.push('usage'))
			dir.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
			expect(log).toEqual(['sources:1', 'sources:2'])
			expect(dir.sources().map((s) => s.name)).toEqual(['A', 'B'])
			expect(onSources).toHaveBeenCalledTimes(2)
			expect(onUsage).not.toHaveBeenCalled()
		})

		it('may clear() the directory', () => {
			const seen: number[] = []
			let reentered = false
			dir.on('sources', () => {
				seen.push(dir.sources().length)
				if (!reentered) {
					reentered = true
					dir.clear()
				}
			})
			dir.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
			// the second round announces the clear: the last event always matches the final state
			expect(seen).toEqual([1, 0])
			expect(dir.sources()).toEqual([])
		})

		it('coalesce the changes they make while announcing: one usage event for several', () => {
			populate()
			dir.on('sources', () => {
				dir.ingest(usage(ENGINE_IP, [{ channel: 5, usedBy: FADER_11 }]))
				dir.ingest(usage(ENGINE_IP, [{ channel: 6, usedBy: FADER_11 }]))
			})
			dir.expire() // sources and usage both change; the listener changes the usage twice more
			expect(onUsage).toHaveBeenCalledTimes(1)
			expect(dir.usedBy(5)).toBeNull()
			expect(dir.usedBy(6)).toEqual(FADER_11)
		})

		it('keep an error for the call that started the round, not for their own call', () => {
			populate()
			let rethrown: unknown
			dir.on('sources', () => {
				try {
					dir.ingest(full(ENGINE_IP, [source('S201', 2, 'B')]))
				} catch (e) {
					rethrown = e
				}
			})
			dir.on('usage', () => {
				throw new Error('usage boom')
			})
			expect(() => dir.expire()).toThrow('usage boom')
			expect(rethrown).toBeUndefined()
		})
	})
})

describe('default clock', () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('is not moved by wall-clock steps', () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-10-12T10:00:00Z'))
		const d = new LivewireDirectory()
		d.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
		vi.setSystemTime(new Date('2026-10-12T11:00:00Z')) // NTP catches up after boot without an RTC
		d.expire()
		expect(d.sources()).toHaveLength(1)
		vi.setSystemTime(new Date('2026-10-12T09:00:00Z'))
		d.expire()
		expect(d.sources()).toHaveLength(1)
	})

	it('measures expiry with performance.now()', () => {
		let t = 5000
		vi.spyOn(performance, 'now').mockImplementation(() => t)
		const d = new LivewireDirectory()
		d.ingest(full(NODE_IP, [source('S001', 1, 'A')]))
		t += DEFAULT_EXPIRY_MS
		d.expire()
		expect(d.sources()).toHaveLength(1)
		t += 1
		d.expire()
		expect(d.sources()).toEqual([])
	})
})
