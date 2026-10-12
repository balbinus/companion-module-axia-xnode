import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AdvertisedSource, PartylineAdvert, SourceUsage } from '../../src/lwrp/partyline.js'
import { LivewireDirectory } from '../../src/model/directory.js'

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

	it('emits sources when the device name changes, and not when it stays', () => {
		dir.ingest(keepalive(NODE_IP, 451, { deviceName: 'Studio A' }))
		expect(onSources).toHaveBeenCalledTimes(1)
		expect(dir.sources().every((s) => s.deviceName === 'Studio A')).toBe(true)
		dir.ingest(keepalive(NODE_IP, 451, { deviceName: 'Studio A' }))
		expect(onSources).toHaveBeenCalledTimes(1)
	})

	it('defaults the device name to its IP until it is known', () => {
		const d = new LivewireDirectory()
		d.ingest(full(NODE_IP, [source('S001', 1, 'A')], { deviceName: undefined }))
		expect(d.sources()[0].deviceName).toBe(NODE_IP)
		d.ingest(keepalive(NODE_IP, 1, { deviceName: NODE_NAME }))
		expect(d.sources()[0].deviceName).toBe(NODE_NAME)
		// an advert without a name (or an empty one) does not forget it
		d.ingest(keepalive(NODE_IP, 1))
		d.ingest(keepalive(NODE_IP, 1, { deviceName: '' }))
		expect(d.sources()[0].deviceName).toBe(NODE_NAME)
	})

	it('does not emit for the name of a device that has no sources yet', () => {
		dir.ingest(keepalive('10.96.30.224', 3, { deviceName: 'Other' }))
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
		dir.sources().pop()
		expect(dir.sources()).toHaveLength(1)
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
		dir.ingest(keepalive(NODE_IP, 1, { deviceName: 'x' }))
		dir.clear()
		expect(onSources).not.toHaveBeenCalled()
		expect(onUsage).not.toHaveBeenCalled()
	})

	it('forgets the pending state on clear()', () => {
		dir.ingest(full(NODE_IP, [source('S001', 1, 'A')], { sourceCount: 2, configVersion: 3 }))
		dir.clear()
		dir.ingest(full(NODE_IP, [source('S002', 2, 'B')], { sourceCount: 2, configVersion: 3 }))
		expect(dir.sources()).toEqual([])
	})
})
