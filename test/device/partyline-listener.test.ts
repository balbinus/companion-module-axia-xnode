import dgram from 'node:dgram'
import { EventEmitter, once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PartylineListener, type PartylineListenerOptions } from '../../src/device/partyline-listener.js'
import { PARTYLINE_GROUP, PARTYLINE_PORT } from '../../src/lwrp/partyline.js'
import { waitFor } from '../helpers/wait-for.js'

/** A dgram.Socket stand-in: the test decides when the bind callback fires and when close completes */
class FakeSocket extends EventEmitter {
	bindCallback: (() => void) | undefined
	closeCallback: (() => void) | undefined
	holdClose = false
	bind = vi.fn((_port: number, callback?: () => void) => {
		this.bindCallback = callback
	})
	addMembership = vi.fn()
	dropMembership = vi.fn()
	send = vi.fn()
	close = vi.fn((callback?: () => void) => {
		this.closeCallback = callback
		if (!this.holdClose) queueMicrotask(() => callback?.())
	})

	/** The OS finished binding */
	listen(): void {
		this.bindCallback?.()
	}

	get asSocket(): dgram.Socket {
		return this as unknown as dgram.Socket
	}
}

const rinfo = { address: '10.96.30.223', family: 'IPv4', port: 50000, size: 4 } satisfies dgram.RemoteInfo

interface Rig {
	listener: PartylineListener
	sockets: FakeSocket[]
	events: string[]
	errors: Error[]
	messages: Array<{ buf: Buffer; rinfo: dgram.RemoteInfo }>
}

function rig(options: PartylineListenerOptions = {}, { errorHandler = true } = {}): Rig {
	const sockets: FakeSocket[] = []
	const listener = new PartylineListener({
		...options,
		createSocket: () => {
			const socket = new FakeSocket()
			sockets.push(socket)
			return socket.asSocket
		},
	})
	const events: string[] = []
	const errors: Error[] = []
	const messages: Rig['messages'] = []
	listener.on('listening', () => events.push('listening'))
	listener.on('message', (buf, info) => {
		events.push('message')
		messages.push({ buf, rinfo: info })
	})
	if (errorHandler) {
		listener.on('error', (err) => {
			events.push('error')
			errors.push(err)
		})
	}
	return { listener, sockets, events, errors, messages }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('start', () => {
	it('binds the partyline port, then joins the group once bound', () => {
		const { listener, sockets, events } = rig()
		listener.start()
		expect(sockets).toHaveLength(1)
		expect(sockets[0].bind).toHaveBeenCalledTimes(1)
		expect(sockets[0].bind.mock.calls[0][0]).toBe(PARTYLINE_PORT)
		expect(sockets[0].addMembership).not.toHaveBeenCalled()
		expect(events).toEqual([])

		sockets[0].listen()
		expect(sockets[0].addMembership).toHaveBeenCalledExactlyOnceWith(PARTYLINE_GROUP, undefined)
		expect(events).toEqual(['listening'])
	})

	it('creates a UDP4 socket with reuseAddr by default', () => {
		const fake = new FakeSocket()
		const spy = vi.spyOn(dgram, 'createSocket').mockReturnValue(fake.asSocket)
		const listener = new PartylineListener()
		listener.start()
		expect(spy).toHaveBeenCalledExactlyOnceWith({ type: 'udp4', reuseAddr: true })
		expect(fake.bind).toHaveBeenCalledTimes(1)
	})

	it('uses the configured group, port and interface', () => {
		const { listener, sockets } = rig({ group: '239.1.2.3', port: 5555, interfaceIp: '10.96.30.100' })
		listener.start()
		expect(sockets[0].bind.mock.calls[0][0]).toBe(5555)
		sockets[0].listen()
		expect(sockets[0].addMembership).toHaveBeenCalledExactlyOnceWith('239.1.2.3', '10.96.30.100')
	})

	it('passes an empty interfaceIp as undefined so that the OS chooses', () => {
		const { listener, sockets } = rig({ interfaceIp: '' })
		listener.start()
		sockets[0].listen()
		expect(sockets[0].addMembership).toHaveBeenCalledExactlyOnceWith(PARTYLINE_GROUP, undefined)
	})

	it('is a no-op when already started', () => {
		const { listener, sockets } = rig()
		listener.start()
		listener.start()
		sockets[0].listen()
		listener.start()
		expect(sockets).toHaveLength(1)
		expect(sockets[0].bind).toHaveBeenCalledTimes(1)
	})

	it('forwards datagrams untouched', () => {
		const { listener, sockets, messages } = rig()
		listener.start()
		sockets[0].listen()
		const a = Buffer.from([1, 2, 3, 4])
		const b = Buffer.from('CMsg2')
		sockets[0].emit('message', a, rinfo)
		sockets[0].emit('message', b, { ...rinfo, address: '10.96.30.235' })
		expect(messages).toHaveLength(2)
		expect(messages[0].buf).toBe(a)
		expect(messages[0].rinfo).toBe(rinfo)
		expect(messages[1].buf).toBe(b)
		expect(messages[1].rinfo.address).toBe('10.96.30.235')
	})

	it('never sends anything', async () => {
		const { listener, sockets } = rig()
		listener.start()
		sockets[0].listen()
		sockets[0].emit('message', Buffer.from('x'), rinfo)
		await listener.stop()
		expect(sockets[0].send).not.toHaveBeenCalled()
	})
})

describe('errors', () => {
	it('emits error, not throws, when joining the group fails, and gives the socket up', () => {
		const { listener, sockets, events, errors } = rig({ interfaceIp: '10.9.9.9' })
		listener.start()
		sockets[0].addMembership.mockImplementation(() => {
			throw new Error('addMembership EADDRNOTAVAIL')
		})
		expect(() => sockets[0].listen()).not.toThrow()
		expect(errors.map((e) => e.message)).toEqual(['addMembership EADDRNOTAVAIL'])
		expect(events).toEqual(['error'])
		expect(sockets[0].close).toHaveBeenCalledTimes(1)
		expect(sockets[0].dropMembership).not.toHaveBeenCalled()
	})

	it('can start again after a failed join', () => {
		const { listener, sockets, events } = rig()
		listener.start()
		sockets[0].addMembership.mockImplementation(() => {
			throw new Error('nope')
		})
		sockets[0].listen()
		listener.start()
		expect(sockets).toHaveLength(2)
		sockets[1].listen()
		expect(events).toEqual(['error', 'listening'])
		// the abandoned socket stays silent
		sockets[0].emit('message', Buffer.from('late'), rinfo)
		expect(events).toEqual(['error', 'listening'])
	})

	it('emits error when bind throws', () => {
		const fake = new FakeSocket()
		fake.bind.mockImplementation(() => {
			throw new Error('ERR_SOCKET_ALREADY_BOUND')
		})
		const listener = new PartylineListener({ createSocket: () => fake.asSocket })
		const errors: Error[] = []
		listener.on('error', (e) => errors.push(e))
		expect(() => listener.start()).not.toThrow()
		expect(errors.map((e) => e.message)).toEqual(['ERR_SOCKET_ALREADY_BOUND'])
		expect(fake.close).toHaveBeenCalledTimes(1)
	})

	it('forwards a socket error that happens before the bind completes, and gives the socket up', () => {
		const { listener, sockets, errors } = rig()
		listener.start()
		sockets[0].emit('error', new Error('bind EADDRINUSE 0.0.0.0:4001'))
		expect(errors.map((e) => e.message)).toEqual(['bind EADDRINUSE 0.0.0.0:4001'])
		expect(sockets[0].close).toHaveBeenCalledTimes(1)
		// the bind callback of the abandoned socket does nothing
		sockets[0].listen()
		expect(sockets[0].addMembership).not.toHaveBeenCalled()
		listener.start()
		expect(sockets).toHaveLength(2)
	})

	it('forwards a socket error after listening and keeps the socket', () => {
		const { listener, sockets, errors, events } = rig()
		listener.start()
		sockets[0].listen()
		sockets[0].emit('error', new Error('recv ENETDOWN'))
		expect(errors.map((e) => e.message)).toEqual(['recv ENETDOWN'])
		expect(sockets[0].close).not.toHaveBeenCalled()
		// still receiving, and start() does not open a second socket
		sockets[0].emit('message', Buffer.from('x'), rinfo)
		listener.start()
		expect(sockets).toHaveLength(1)
		expect(events).toEqual(['listening', 'error', 'message'])
	})

	it('wraps a non-Error throw', () => {
		const { listener, sockets, errors } = rig()
		listener.start()
		sockets[0].addMembership.mockImplementation(() => {
			throw 'boom' // eslint-disable-line @typescript-eslint/only-throw-error
		})
		sockets[0].listen()
		expect(errors[0]).toBeInstanceOf(Error)
		expect(errors[0].message).toBe('boom')
	})

	it('reports a createSocket failure instead of throwing', () => {
		const l = new PartylineListener({
			createSocket: () => {
				throw new Error('EMFILE')
			},
		})
		const errors: Error[] = []
		l.on('error', (e) => errors.push(e))
		expect(() => l.start()).not.toThrow()
		expect(errors.map((e) => e.message)).toEqual(['EMFILE'])
	})

	it('does not crash the process when nobody listens for errors', async () => {
		const { listener, sockets } = rig({}, { errorHandler: false })
		listener.start()
		sockets[0].addMembership.mockImplementation(() => {
			throw new Error('no listener for me')
		})
		expect(() => sockets[0].listen()).not.toThrow()
		listener.start()
		expect(() => sockets[1].emit('error', new Error('again'))).not.toThrow()
		await listener.stop()
	})
})

describe('stop', () => {
	it('leaves the group, closes the socket and resolves when closed', async () => {
		const { listener, sockets } = rig({ group: '239.1.2.3', interfaceIp: '10.96.30.100' })
		listener.start()
		sockets[0].listen()
		sockets[0].holdClose = true
		let resolved = false
		const stopped = listener.stop().then(() => (resolved = true))
		expect(sockets[0].dropMembership).toHaveBeenCalledExactlyOnceWith('239.1.2.3', '10.96.30.100')
		expect(sockets[0].close).toHaveBeenCalledTimes(1)
		await Promise.resolve()
		await Promise.resolve()
		expect(resolved).toBe(false)
		sockets[0].closeCallback?.()
		await stopped
		expect(resolved).toBe(true)
	})

	it('is idempotent and fine before start', async () => {
		const { listener, sockets } = rig()
		await listener.stop()
		listener.start()
		sockets[0].listen()
		await listener.stop()
		await listener.stop()
		expect(sockets[0].close).toHaveBeenCalledTimes(1)
		expect(sockets[0].dropMembership).toHaveBeenCalledTimes(1)
	})

	it('lets a concurrent stop() wait for the same close', async () => {
		const { listener, sockets } = rig()
		listener.start()
		sockets[0].listen()
		sockets[0].holdClose = true
		void listener.stop()
		let second = false
		const secondStop = listener.stop().then(() => (second = true))
		await Promise.resolve()
		await Promise.resolve()
		expect(second).toBe(false)
		sockets[0].closeCallback?.()
		await secondStop
		expect(second).toBe(true)
	})

	it('does not drop a membership that was never joined', async () => {
		const { listener, sockets } = rig()
		listener.start()
		await listener.stop()
		expect(sockets[0].dropMembership).not.toHaveBeenCalled()
		expect(sockets[0].close).toHaveBeenCalledTimes(1)
	})

	it('silences a bind callback that arrives after stop', async () => {
		const { listener, sockets, events } = rig()
		listener.start()
		await listener.stop()
		sockets[0].listen()
		expect(sockets[0].addMembership).not.toHaveBeenCalled()
		expect(events).toEqual([])
	})

	it('silences messages and errors that arrive after stop', async () => {
		const { listener, sockets, events } = rig()
		listener.start()
		sockets[0].listen()
		await listener.stop()
		sockets[0].emit('message', Buffer.from('late'), rinfo)
		expect(() => sockets[0].emit('error', new Error('late'))).not.toThrow()
		expect(events).toEqual(['listening'])
	})

	it('still closes when dropMembership or close throw', async () => {
		const { listener, sockets } = rig()
		listener.start()
		sockets[0].listen()
		sockets[0].dropMembership.mockImplementation(() => {
			throw new Error('ENODEV')
		})
		sockets[0].close.mockImplementation(() => {
			throw new Error('ERR_SOCKET_DGRAM_NOT_RUNNING')
		})
		await expect(listener.stop()).resolves.toBeUndefined()
		expect(sockets[0].close).toHaveBeenCalledTimes(1)
	})

	it('can be started again with a fresh socket', async () => {
		const { listener, sockets, events, messages } = rig()
		listener.start()
		sockets[0].listen()
		await listener.stop()

		listener.start()
		expect(sockets).toHaveLength(2)
		expect(sockets[1]).not.toBe(sockets[0])
		sockets[1].listen()
		expect(sockets[1].addMembership).toHaveBeenCalledTimes(1)

		sockets[0].emit('message', Buffer.from('old'), rinfo)
		sockets[1].emit('message', Buffer.from('new'), rinfo)
		expect(messages.map((m) => m.buf.toString())).toEqual(['new'])
		expect(events).toEqual(['listening', 'listening', 'message'])
	})

	it('ignores the old socket callbacks when restarted before the old bind completed', async () => {
		const { listener, sockets, events } = rig()
		listener.start()
		void listener.stop()
		listener.start()
		sockets[0].listen()
		expect(events).toEqual([])
		sockets[1].listen()
		expect(events).toEqual(['listening'])
		expect(sockets[0].addMembership).not.toHaveBeenCalled()
	})
})

describe('with a real socket', () => {
	const cleanups: Array<() => Promise<void>> = []
	afterEach(async () => {
		for (const c of cleanups.splice(0).reverse()) await c()
	})

	/** A free UDP port (found by binding and releasing one) */
	async function freePort(): Promise<number> {
		const s = dgram.createSocket('udp4')
		s.bind(0)
		await once(s, 'listening')
		const { port } = s.address()
		await new Promise<void>((resolve) => s.close(() => resolve()))
		return port
	}

	/** A real socket, minus the multicast membership (needs a multicast-capable interface) */
	function realListener(port: number): PartylineListener {
		const listener = new PartylineListener({
			port,
			createSocket: () => {
				const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
				vi.spyOn(socket, 'addMembership').mockImplementation(() => undefined)
				vi.spyOn(socket, 'dropMembership').mockImplementation(() => undefined)
				return socket
			},
		})
		cleanups.push(async () => listener.stop())
		return listener
	}

	async function sendTo(port: number, payload: Buffer): Promise<void> {
		const sender = dgram.createSocket('udp4')
		await new Promise<void>((resolve, reject) => {
			sender.send(payload, port, '127.0.0.1', (err) => (err ? reject(err) : resolve()))
		})
		await new Promise<void>((resolve) => sender.close(() => resolve()))
	}

	it('receives datagrams on the bound port, and again after a restart', async () => {
		const port = await freePort()
		const listener = realListener(port)
		const received: string[] = []
		listener.on('message', (buf) => received.push(buf.toString()))
		listener.on('error', (err) => {
			throw err
		})

		const listening = once(listener, 'listening')
		listener.start()
		await listening
		await sendTo(port, Buffer.from('one'))
		await waitFor(() => received.length === 1, { message: 'first datagram' })

		await listener.stop()
		const again = once(listener, 'listening')
		listener.start()
		await again
		await sendTo(port, Buffer.from('two'))
		await waitFor(() => received.length === 2, { message: 'datagram after restart' })
		expect(received).toEqual(['one', 'two'])
	})

	it('receives nothing after stop', async () => {
		const port = await freePort()
		const listener = realListener(port)
		const received: string[] = []
		listener.on('message', (buf) => received.push(buf.toString()))
		const listening = once(listener, 'listening')
		listener.start()
		await listening
		await listener.stop()
		await sendTo(port, Buffer.from('late'))
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(received).toEqual([])
	})
})
