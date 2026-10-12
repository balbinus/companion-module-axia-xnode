import type dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceDiscovery, type SourceDiscoveryOptions } from '../../src/device/discovery.js'
import { PartylineListener, type PartylineListenerOptions } from '../../src/device/partyline-listener.js'
import { partylineFixture, type PartylineFixtureName } from '../fixtures/partyline/load.js'

/** A PartylineListener stand-in: the test emits what the socket would */
class FakeListener extends EventEmitter {
	start = vi.fn()
	stop = vi.fn(async () => Promise.resolve())

	constructor(readonly options: PartylineListenerOptions) {
		super()
	}

	datagram(buf: Buffer, address = '10.96.30.223'): void {
		this.emit('message', buf, { address, family: 'IPv4', port: 48763, size: buf.length })
	}

	fixture(name: PartylineFixtureName, address?: string): void {
		this.datagram(partylineFixture(name), address)
	}
}

interface Rig {
	discovery: SourceDiscovery
	listeners: FakeListener[]
	logs: Array<[string, string]>
	events: string[]
	/** The listener of the current run */
	listener: () => FakeListener
	logged: (level: string) => string[]
}

function rig(options: Partial<SourceDiscoveryOptions> = {}): Rig {
	const listeners: FakeListener[] = []
	const logs: Array<[string, string]> = []
	const discovery = new SourceDiscovery({
		log: (level, msg) => logs.push([level, msg]),
		now: () => Date.now(),
		createListener: (opts) => {
			const listener = new FakeListener(opts)
			listeners.push(listener)
			return listener as unknown as PartylineListener
		},
		...options,
	})
	const events: string[] = []
	discovery.on('sources', () => events.push('sources'))
	discovery.on('usage', () => events.push('usage'))
	return {
		discovery,
		listeners,
		logs,
		events,
		listener: () => listeners[listeners.length - 1],
		logged: (level) => logs.filter(([l]) => l === level).map(([, msg]) => msg),
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('start', () => {
	it('creates one listener for the interface and starts it', () => {
		const r = rig({ interfaceIp: '10.96.30.50' })
		r.discovery.start()
		expect(r.listeners).toHaveLength(1)
		expect(r.listener().options).toEqual({ interfaceIp: '10.96.30.50' })
		expect(r.listener().start).toHaveBeenCalledTimes(1)
	})

	it('is a no-op when started', () => {
		const r = rig()
		r.discovery.start()
		r.discovery.start()
		expect(r.listeners).toHaveLength(1)
		expect(r.listener().start).toHaveBeenCalledTimes(1)
	})

	it('logs once, at info level, when the listener is up', () => {
		const r = rig()
		r.discovery.start()
		expect(r.logs).toEqual([])
		r.listener().emit('listening')
		expect(r.logs).toEqual([['info', 'Listening for Livewire adverts on 239.192.255.3:4001 (interface default)']])
	})

	it('names the interface in the log', () => {
		const r = rig({ interfaceIp: '10.96.30.50' })
		r.discovery.start()
		r.listener().emit('listening')
		expect(r.logged('info')).toEqual(['Listening for Livewire adverts on 239.192.255.3:4001 (interface 10.96.30.50)'])
	})

	it('has a directory before it starts, and an empty one', () => {
		const r = rig()
		expect(r.discovery.directory.sources()).toEqual([])
	})
})

describe('adverts', () => {
	it('decodes the datagrams into the directory', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		const { directory } = r.discovery
		expect(directory.deviceCount()).toBe(1)
		expect(directory.sources()).toHaveLength(8)
		expect(directory.lookupAddress('239.192.87.29')?.source).toMatchObject({
			channel: 22301,
			name: 'MIC 1',
			deviceIp: '10.96.30.223',
			deviceName: 'Node-223-0',
		})
		r.listener().fixture('usage-xnode-fader11')
		expect(directory.usedBy(22301)).toEqual({ engineIp: '10.96.30.235', fader: 11 })
	})

	it('takes the sender address for a device that does not say its IP', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('usage-xnode-fader11', '10.96.30.77')
		expect(r.discovery.directory.deviceCount()).toBe(1)
		expect(r.discovery.directory.usedBy(22301)).toEqual({ engineIp: '10.96.30.235', fader: 11 })
	})

	it('merges a full advert split over several datagrams', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-engine-part1', '10.96.30.235')
		expect(r.discovery.directory.sources()).toEqual([])
		r.listener().fixture('full-engine-part2', '10.96.30.235')
		expect(r.discovery.directory.sources()).toHaveLength(10)
	})

	it('ignores datagrams that arrive after stop()', async () => {
		const r = rig()
		r.discovery.start()
		const listener = r.listener()
		await r.discovery.stop()
		listener.fixture('full-xnode-223')
		expect(r.discovery.directory.deviceCount()).toBe(0)
		expect(listener.listenerCount('message')).toBe(0)
	})
})

describe('events', () => {
	it('announces sources once, sourcesDebounceMs after the first change', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		expect(r.events).toEqual([])
		vi.advanceTimersByTime(4999)
		expect(r.events).toEqual([])
		vi.advanceTimersByTime(1)
		expect(r.events).toEqual(['sources'])
		vi.advanceTimersByTime(60_000 - 5000 - 5000)
		expect(r.events).toEqual(['sources'])
	})

	it('folds the changes of the window into one announcement', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		vi.advanceTimersByTime(4500)
		r.listener().fixture('full-xnode-223-renamed')
		r.listener().fixture('full-xnode-224', '10.96.30.224')
		vi.advanceTimersByTime(500)
		expect(r.events).toEqual(['sources'])
		expect(r.discovery.directory.sources()).toHaveLength(16)
		expect(r.discovery.directory.lookupAddress('239.192.87.30')?.source.name).toBe('TEST 2')
		// the next change starts a new window
		vi.advanceTimersByTime(10_000)
		r.listener().fixture('full-xnode-223')
		vi.advanceTimersByTime(5000)
		expect(r.events).toEqual(['sources', 'sources'])
	})

	it('announces usage usageDebounceMs after the change', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('usage-xnode-fader1')
		vi.advanceTimersByTime(99)
		expect(r.events).toEqual([])
		vi.advanceTimersByTime(1)
		expect(r.events).toEqual(['usage'])
		r.listener().fixture('usage-xnode-fader11')
		r.listener().fixture('usage-xnode-fader1')
		r.listener().fixture('usage-xnode-fader11')
		vi.advanceTimersByTime(100)
		expect(r.events).toEqual(['usage', 'usage'])
	})

	it('does not announce what did not change (keepalives, repeated adverts)', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		vi.advanceTimersByTime(5000)
		r.events.length = 0
		r.listener().fixture('keepalive-xnode')
		r.listener().fixture('full-xnode-223')
		vi.advanceTimersByTime(10_000)
		expect(r.events).toEqual([])
	})

	it('honours custom timings', () => {
		const r = rig({ timings: { sourcesDebounceMs: 10, usageDebounceMs: 5 } })
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		r.listener().fixture('usage-xnode-fader1')
		vi.advanceTimersByTime(5)
		expect(r.events).toEqual(['usage'])
		vi.advanceTimersByTime(5)
		expect(r.events).toEqual(['usage', 'sources'])
	})

	it('announces the sources of a device that expired', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		vi.advanceTimersByTime(5000)
		expect(r.events).toEqual(['sources'])
		// expiry is checked every 5 s and happens after 60 s without an advert
		vi.advanceTimersByTime(70_000)
		expect(r.discovery.directory.deviceCount()).toBe(0)
		expect(r.events).toEqual(['sources', 'sources'])
		expect(r.discovery.directory.sources()).toEqual([])
	})

	it('keeps a device alive that keeps sending', () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		for (let i = 0; i < 12; i++) {
			vi.advanceTimersByTime(10_000)
			r.listener().fixture('keepalive-xnode')
		}
		expect(r.discovery.directory.sources()).toHaveLength(8)
	})

	it('a throwing listener is logged, not thrown into the timer', () => {
		const r = rig()
		r.discovery.on('sources', () => {
			throw new Error('listener bug')
		})
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
		expect(r.logged('warn')).toEqual(["Livewire discovery: a 'sources' listener failed: listener bug"])
		expect(r.events).toEqual(['sources']) // the listener registered before it ran
	})
})

describe('unusable datagrams', () => {
	const junk = [
		Buffer.from('hello world'),
		Buffer.alloc(0),
		Buffer.alloc(64, 0xff),
		partylineFixture('full-xnode-223').subarray(0, 40),
	]

	it('are counted and reported at most once a minute, at debug level', () => {
		const r = rig()
		r.discovery.start()
		for (let i = 0; i < 100; i++) r.listener().datagram(junk[i % junk.length])
		expect(r.logs).toEqual([])
		vi.advanceTimersByTime(59_999)
		expect(r.logs).toEqual([])
		vi.advanceTimersByTime(1)
		expect(r.logs).toEqual([['debug', 'Ignored 100 unusable datagrams on the Livewire partyline port']])
		// quiet again until more arrives
		vi.advanceTimersByTime(120_000)
		expect(r.logs).toHaveLength(1)
		r.listener().datagram(junk[0])
		vi.advanceTimersByTime(60_000)
		expect(r.logs).toHaveLength(2)
		expect(r.logs[1]).toEqual(['debug', 'Ignored 1 unusable datagram on the Livewire partyline port'])
	})

	it('a steady stream gives one line per minute', () => {
		const r = rig()
		r.discovery.start()
		for (let s = 0; s < 180; s++) {
			r.listener().datagram(junk[0])
			vi.advanceTimersByTime(1000)
		}
		expect(r.logs.map(([, msg]) => msg)).toEqual([
			'Ignored 60 unusable datagrams on the Livewire partyline port',
			'Ignored 60 unusable datagrams on the Livewire partyline port',
			'Ignored 60 unusable datagrams on the Livewire partyline port',
		])
	})

	it('do not disturb the adverts around them', () => {
		const r = rig()
		r.discovery.start()
		r.listener().datagram(junk[0])
		r.listener().fixture('full-xnode-223')
		r.listener().datagram(junk[3])
		expect(r.discovery.directory.sources()).toHaveLength(8)
	})

	it('an exception while ingesting is caught and counted, with its message', () => {
		const r = rig()
		r.discovery.start()
		vi.spyOn(r.discovery.directory, 'ingest').mockImplementation(() => {
			throw new Error('ingest bug')
		})
		expect(() => r.listener().fixture('full-xnode-223')).not.toThrow()
		vi.advanceTimersByTime(60_000)
		expect(r.logs).toEqual([
			['debug', 'Ignored 1 unusable datagram on the Livewire partyline port (last error: ingest bug)'],
		])
	})

	it('are not reported after stop()', async () => {
		const r = rig()
		r.discovery.start()
		r.listener().datagram(junk[0])
		await r.discovery.stop()
		vi.advanceTimersByTime(120_000)
		expect(r.logs).toEqual([])
	})
})

describe('silence', () => {
	const WARNING =
		'No Livewire advertisement received on 239.192.255.3:4001 (interface default) after 60 s: ' +
		'check the interface IP, Docker host networking, and that the firewall allows UDP 4001 multicast'

	it('warns once, silenceWarnMs after the listener is up, when no device was heard', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		vi.advanceTimersByTime(59_999)
		expect(r.logged('warn')).toEqual([])
		vi.advanceTimersByTime(1)
		expect(r.logged('warn')).toEqual([WARNING])
		vi.advanceTimersByTime(600_000)
		expect(r.logged('warn')).toEqual([WARNING])
	})

	it('names the interface', () => {
		const r = rig({ interfaceIp: '10.96.30.50' })
		r.discovery.start()
		r.listener().emit('listening')
		vi.advanceTimersByTime(60_000)
		expect(r.logged('warn')).toEqual([WARNING.replace('(interface default)', '(interface 10.96.30.50)')])
	})

	it('waits for the listener to be up: nothing while it is failing', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', new Error('ENODEV'))
		vi.advanceTimersByTime(30_000) // the retry
		r.listener().emit('error', new Error('ENODEV'))
		vi.advanceTimersByTime(29_000) // 59 s after the start, not yet after the join
		r.listener().emit('listening')
		vi.advanceTimersByTime(59_999)
		expect(r.logged('warn')).toEqual(['Livewire advert listener: ENODEV'])
		vi.advanceTimersByTime(1)
		expect(r.logged('warn')).toEqual(['Livewire advert listener: ENODEV', WARNING])
	})

	it('does not warn when a device was heard (a keepalive is enough)', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		r.listener().fixture('keepalive-xnode')
		for (let i = 0; i < 12; i++) {
			vi.advanceTimersByTime(10_000)
			r.listener().fixture('keepalive-xnode')
		}
		expect(r.logged('warn')).toEqual([])
		expect(r.logged('info')).toHaveLength(1) // "Listening", and no "now received"
	})

	it('unusable datagrams are not adverts', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		r.listener().datagram(Buffer.from('junk'))
		vi.advanceTimersByTime(60_000)
		expect(r.logged('warn')).toEqual([WARNING])
		r.listener().datagram(Buffer.from('junk'))
		expect(r.logged('info')).toHaveLength(1)
	})

	it('says so, once, when adverts start arriving after the warning', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		vi.advanceTimersByTime(60_000)
		r.listener().fixture('full-xnode-223')
		expect(r.logged('info')).toEqual([
			'Listening for Livewire adverts on 239.192.255.3:4001 (interface default)',
			'Livewire advertisements are now being received',
		])
		r.listener().fixture('keepalive-xnode')
		r.listener().fixture('full-xnode-224', '10.96.30.224')
		expect(r.logged('info')).toHaveLength(2)
		expect(r.logged('warn')).toEqual([WARNING])
	})

	it('warns at most once per start: not again if the directory empties later', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		vi.advanceTimersByTime(60_000)
		r.listener().fixture('keepalive-xnode')
		vi.advanceTimersByTime(600_000) // the device expires
		expect(r.discovery.directory.deviceCount()).toBe(0)
		expect(r.logged('warn')).toEqual([WARNING])
	})

	it('honours a custom delay', () => {
		const r = rig({ timings: { silenceWarnMs: 1500 } })
		r.discovery.start()
		r.listener().emit('listening')
		vi.advanceTimersByTime(1499)
		expect(r.logged('warn')).toEqual([])
		vi.advanceTimersByTime(1)
		expect(r.logged('warn')).toEqual([WARNING.replace('after 60 s', 'after 2 s')])
	})

	it('stop() clears the timer: no warning afterwards', async () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		expect(vi.getTimerCount()).toBe(2) // expiry interval and silence check
		await r.discovery.stop()
		expect(vi.getTimerCount()).toBe(0)
		vi.advanceTimersByTime(600_000)
		expect(r.logged('warn')).toEqual([])
	})

	it('a new start gets its own check and its own warning', async () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		vi.advanceTimersByTime(60_000)
		await r.discovery.stop()
		r.discovery.start()
		r.listener().emit('listening')
		vi.advanceTimersByTime(59_999)
		expect(r.logged('warn')).toEqual([WARNING])
		vi.advanceTimersByTime(1)
		expect(r.logged('warn')).toEqual([WARNING, WARNING])
		// and an advert after the second warning gets its "now received", not hidden by the first run's
		r.listener().fixture('keepalive-xnode')
		expect(r.logged('info').at(-1)).toBe('Livewire advertisements are now being received')
	})

	it('is not re-armed by a second "listening" of the same run', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		vi.advanceTimersByTime(30_000)
		r.listener().emit('listening')
		vi.advanceTimersByTime(30_000)
		expect(r.logged('warn')).toEqual([WARNING])
	})
})

describe('listener failures', () => {
	const failure = (message = 'bind EADDRNOTAVAIL 10.96.30.50:4001'): Error => new Error(message)

	it('logs a warning', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', failure())
		expect(r.logs).toEqual([['warn', 'Livewire advert listener: bind EADDRNOTAVAIL 10.96.30.50:4001']])
	})

	it('does not repeat the same message consecutively, but logs another one', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', failure('a'))
		r.listener().emit('error', failure('a'))
		r.listener().emit('error', failure('b'))
		r.listener().emit('error', failure('a'))
		expect(r.logged('warn')).toEqual([
			'Livewire advert listener: a',
			'Livewire advert listener: b',
			'Livewire advert listener: a',
		])
	})

	it('logs the same message again once the listener has come up in between', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', failure('a'))
		r.listener().emit('listening')
		r.listener().emit('error', failure('a'))
		expect(r.logged('warn')).toHaveLength(2)
	})

	it('retries every retryMs while the listener is not up, with a single warning', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', failure())
		expect(r.listener().start).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(29_999)
		expect(r.listener().start).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(1)
		expect(r.listener().start).toHaveBeenCalledTimes(2)
		r.listener().emit('error', failure())
		vi.advanceTimersByTime(30_000)
		expect(r.listener().start).toHaveBeenCalledTimes(3)
		expect(r.listeners).toHaveLength(1) // the same listener is started again
		expect(r.logged('warn')).toHaveLength(1)
	})

	it('schedules a single retry when several errors come in a row', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', failure('a'))
		r.listener().emit('error', failure('b'))
		vi.advanceTimersByTime(30_000)
		expect(r.listener().start).toHaveBeenCalledTimes(2)
	})

	it('a synchronous failure of start() is retried too', () => {
		const r = rig({
			createListener: (opts) => {
				const listener = new FakeListener(opts)
				listener.start.mockImplementation(() => listener.emit('error', failure('socket')))
				r.listeners.push(listener)
				return listener as unknown as PartylineListener
			},
		})
		r.discovery.start()
		expect(r.logged('warn')).toEqual(['Livewire advert listener: socket'])
		vi.advanceTimersByTime(30_000)
		expect(r.listener().start).toHaveBeenCalledTimes(2)
	})

	it('stops retrying once the listener is up', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', failure())
		vi.advanceTimersByTime(30_000)
		r.listener().emit('listening')
		vi.advanceTimersByTime(300_000)
		expect(r.listener().start).toHaveBeenCalledTimes(2)
		expect(r.logged('info')).toHaveLength(1)
	})

	it('a retry that is already scheduled does nothing if the listener came up meanwhile', () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', failure())
		r.listener().emit('listening')
		vi.advanceTimersByTime(30_000)
		expect(r.listener().start).toHaveBeenCalledTimes(1)
	})

	it('an error after listening is only logged: the socket is kept', () => {
		const r = rig({ timings: { silenceWarnMs: 10_000_000 } })
		r.discovery.start()
		r.listener().emit('listening')
		r.listener().emit('error', failure('ENETDOWN'))
		vi.advanceTimersByTime(300_000)
		expect(r.logged('warn')).toEqual(['Livewire advert listener: ENETDOWN'])
		expect(r.listener().start).toHaveBeenCalledTimes(1)
		expect(r.listener().stop).not.toHaveBeenCalled()
	})

	it('uses the configured retry delay', () => {
		const r = rig({ timings: { retryMs: 1000 } })
		r.discovery.start()
		r.listener().emit('error', failure())
		vi.advanceTimersByTime(1000)
		expect(r.listener().start).toHaveBeenCalledTimes(2)
	})

	it('never throws, whatever the listener reports', () => {
		const r = rig()
		r.discovery.start()
		expect(() => r.listener().emit('error', new Error(''))).not.toThrow()
	})
})

describe('stop', () => {
	it('stops the listener and forgets everything', async () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('listening')
		r.listener().fixture('full-xnode-223')
		const listener = r.listener()
		await r.discovery.stop()
		expect(listener.stop).toHaveBeenCalledTimes(1)
		expect(r.discovery.directory.sources()).toEqual([])
		expect(r.discovery.directory.deviceCount()).toBe(0)
		expect(listener.listenerCount('message')).toBe(0)
		expect(listener.listenerCount('listening')).toBe(0)
		expect(listener.listenerCount('error')).toBe(0)
	})

	it('waits for the listener to be closed', async () => {
		const r = rig()
		r.discovery.start()
		let release = (): void => undefined
		r.listener().stop.mockImplementation(async () => new Promise<void>((resolve) => (release = resolve)))
		let done = false
		const stopping = r.discovery.stop().then(() => (done = true))
		await Promise.resolve()
		expect(done).toBe(false)
		release()
		await stopping
		expect(done).toBe(true)
	})

	it('clears every timer', async () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', new Error('x')) // retry timer
		r.listener().datagram(Buffer.from('junk')) // junk timer
		r.listener().fixture('full-xnode-223') // sources debounce
		r.listener().fixture('usage-xnode-fader1') // usage debounce
		expect(vi.getTimerCount()).toBe(5) // and the expiry interval
		await r.discovery.stop()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('emits nothing afterwards, even for changes that were waiting', async () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		r.listener().fixture('usage-xnode-fader1')
		await r.discovery.stop()
		vi.advanceTimersByTime(300_000)
		expect(r.events).toEqual([])
		expect(r.logs).toEqual([])
	})

	it('does not announce the clearing of the directory', async () => {
		const r = rig()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		vi.advanceTimersByTime(5000)
		r.events.length = 0
		await r.discovery.stop()
		vi.advanceTimersByTime(10_000)
		expect(r.events).toEqual([])
	})

	it('is idempotent, and fine before start()', async () => {
		const r = rig()
		await r.discovery.stop()
		r.discovery.start()
		const listener = r.listener()
		await r.discovery.stop()
		await r.discovery.stop()
		await Promise.all([r.discovery.stop(), r.discovery.stop()])
		expect(listener.stop).toHaveBeenCalledTimes(1)
	})

	it('ignores listener events that are still on their way', async () => {
		const r = rig()
		r.discovery.start()
		const listener = r.listener()
		listener.on('error', () => undefined) // as the real listener, an EventEmitter throws on an unheard 'error'
		await r.discovery.stop()
		listener.emit('listening')
		listener.emit('error', new Error('late'))
		vi.advanceTimersByTime(300_000)
		expect(r.logs).toEqual([])
		expect(listener.start).toHaveBeenCalledTimes(1)
	})
})

describe('restart', () => {
	it('start() after stop() listens again with a fresh listener', async () => {
		const r = rig({ interfaceIp: '10.96.30.50' })
		r.discovery.start()
		r.listener().emit('listening')
		r.listener().fixture('full-xnode-223')
		vi.advanceTimersByTime(5000)
		await r.discovery.stop()
		r.events.length = 0

		r.discovery.start()
		expect(r.listeners).toHaveLength(2)
		expect(r.listener().options).toEqual({ interfaceIp: '10.96.30.50' })
		expect(r.listener().start).toHaveBeenCalledTimes(1)
		r.listener().emit('listening')
		expect(r.logged('info')).toHaveLength(2)

		r.listener().fixture('full-xnode-224', '10.96.30.224')
		r.listener().fixture('usage-xnode-fader11')
		vi.advanceTimersByTime(5000)
		expect(r.events).toEqual(['usage', 'sources'])
		expect(r.discovery.directory.sources().map((s) => s.deviceIp)).toEqual(Array(8).fill('10.96.30.224'))
		expect(r.discovery.directory.usedBy(22301)).toEqual({ engineIp: '10.96.30.235', fader: 11 })
	})

	it('keeps the same directory object, so that holders of it stay valid', async () => {
		const r = rig()
		const { directory } = r.discovery
		r.discovery.start()
		await r.discovery.stop()
		r.discovery.start()
		expect(r.discovery.directory).toBe(directory)
	})

	it('the retry and error state of the previous run do not leak into the next', async () => {
		const r = rig()
		r.discovery.start()
		r.listener().emit('error', new Error('a'))
		await r.discovery.stop()
		r.discovery.start()
		r.listener().emit('error', new Error('a'))
		expect(r.logged('warn')).toHaveLength(2)
		vi.advanceTimersByTime(30_000)
		expect(r.listener().start).toHaveBeenCalledTimes(2)
		expect(r.listeners[0].start).toHaveBeenCalledTimes(1)
	})

	it('can start while the previous listener is still closing', async () => {
		const r = rig()
		r.discovery.start()
		let release = (): void => undefined
		r.listener().stop.mockImplementation(async () => new Promise<void>((resolve) => (release = resolve)))
		const stopping = r.discovery.stop()
		r.discovery.start()
		r.listener().fixture('full-xnode-223')
		expect(r.discovery.directory.sources()).toHaveLength(8)
		release()
		await stopping
		expect(r.discovery.directory.sources()).toHaveLength(8)
	})
})

describe('with the real PartylineListener', () => {
	/** A dgram socket stand-in; the first sockets fail to join the group */
	class FakeSocket extends EventEmitter {
		bind = vi.fn((_port: number, callback?: () => void) => queueMicrotask(() => callback?.()))
		addMembership = vi.fn()
		dropMembership = vi.fn()
		close = vi.fn((callback?: () => void) => queueMicrotask(() => callback?.()))
	}

	function realRig(failures: number): { r: Rig; sockets: FakeSocket[] } {
		const sockets: FakeSocket[] = []
		const r = rig({
			interfaceIp: '10.96.30.50',
			createListener: (opts) =>
				new PartylineListener({
					...opts,
					createSocket: () => {
						const socket = new FakeSocket()
						if (sockets.length < failures) {
							socket.addMembership.mockImplementation(() => {
								throw new Error('addMembership EADDRNOTAVAIL')
							})
						}
						sockets.push(socket)
						return socket as unknown as dgram.Socket
					},
				}),
		})
		return { r, sockets }
	}

	it('retries after a join failure and then feeds the directory', async () => {
		const { r, sockets } = realRig(1)
		r.discovery.start()
		await vi.advanceTimersByTimeAsync(0)
		expect(r.logged('warn')).toEqual(['Livewire advert listener: addMembership EADDRNOTAVAIL'])
		expect(r.logged('info')).toEqual([])
		expect(sockets).toHaveLength(1)
		expect(sockets[0].close).toHaveBeenCalled() // given up by the listener

		await vi.advanceTimersByTimeAsync(30_000)
		expect(sockets).toHaveLength(2)
		expect(sockets[1].addMembership).toHaveBeenCalledWith('239.192.255.3', '10.96.30.50')
		expect(r.logged('info')).toEqual(['Listening for Livewire adverts on 239.192.255.3:4001 (interface 10.96.30.50)'])

		sockets[1].emit('message', partylineFixture('full-xnode-223'), { address: '10.96.30.223' })
		expect(r.discovery.directory.sources()).toHaveLength(8)
		await vi.advanceTimersByTimeAsync(5000)
		expect(r.events).toEqual(['sources'])

		await vi.advanceTimersByTimeAsync(300_000 - 5000)
		expect(sockets).toHaveLength(2) // up: no more retries
		await r.discovery.stop()
		expect(sockets[1].close).toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('keeps retrying while the network is not there', async () => {
		const { r, sockets } = realRig(3)
		r.discovery.start()
		await vi.advanceTimersByTimeAsync(90_000)
		expect(sockets).toHaveLength(4)
		expect(r.logged('warn')).toHaveLength(1) // the same failure is logged once
		expect(r.logged('info')).toHaveLength(1)
		await r.discovery.stop()
	})
})
