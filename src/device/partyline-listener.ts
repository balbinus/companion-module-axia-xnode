import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { PARTYLINE_GROUP, PARTYLINE_PORT } from '../lwrp/partyline.js'

/**
 * Receive-only multicast socket for the Livewire partyline (239.192.255.3:4001). It never sends anything and
 * knows nothing about the payload: `message` carries the raw datagrams, decoding is up to the owner.
 */

export interface PartylineListenerOptions {
	/** Local interface address to join the group on; '' or undefined lets the OS choose */
	interfaceIp?: string
	/** Default PARTYLINE_GROUP */
	group?: string
	/** Default PARTYLINE_PORT */
	port?: number
	/** Test seam. Default: a UDP4 socket with `reuseAddr` (other Livewire software may listen on the same port) */
	createSocket?: () => dgram.Socket
}

export interface PartylineListenerEvents {
	message: [buf: Buffer, rinfo: dgram.RemoteInfo]
	/** Bound and joined to the group */
	listening: []
	/**
	 * Bind, membership or socket failure, or an exception thrown by an owner's `message` or `listening` handler.
	 * Failing to bind or join releases the socket, so `start()` may be called again to retry; any other error
	 * leaves it open. Only emitted while someone listens for it: without a listener the error is dropped instead
	 * of crashing the process. Whatever an `error` handler throws is dropped too.
	 */
	error: [err: Error]
}

export class PartylineListener extends EventEmitter<PartylineListenerEvents> {
	private readonly interfaceIp: string | undefined
	private readonly group: string
	private readonly port: number
	private readonly createSocket: () => dgram.Socket
	private socket: dgram.Socket | null = null
	private joined = false
	private listening = false
	/** Settles when every socket released so far is closed */
	private closing: Promise<void> = Promise.resolve()

	constructor(options: PartylineListenerOptions = {}) {
		super()
		this.interfaceIp = options.interfaceIp || undefined
		this.group = options.group ?? PARTYLINE_GROUP
		this.port = options.port ?? PARTYLINE_PORT
		this.createSocket = options.createSocket ?? (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }))
	}

	/** Bind, join the group, then emit `listening`. Failures are emitted as `error`, never thrown. No-op if started. */
	start(): void {
		if (this.socket) return
		let socket: dgram.Socket
		try {
			socket = this.createSocket()
		} catch (e) {
			this.report(e)
			return
		}
		this.socket = socket
		this.joined = false
		this.listening = false
		// Everything below is silent once this socket is no longer the current one (stop, restart, failure)
		const current = (): boolean => this.socket === socket
		socket.on('error', (err: Error) => {
			if (current()) this.fail(socket, err)
		})
		socket.on('message', (buf: Buffer, rinfo: dgram.RemoteInfo) => {
			if (current()) this.guard(() => this.emit('message', buf, rinfo))
		})
		try {
			socket.bind(this.port, () => {
				if (!current()) return
				try {
					socket.addMembership(this.group, this.interfaceIp)
				} catch (e) {
					this.fail(socket, e)
					return
				}
				this.joined = true
				this.listening = true
				this.guard(() => this.emit('listening'))
			})
		} catch (e) {
			this.fail(socket, e)
		}
	}

	/** Leave the group and close the socket. Idempotent; resolves once closed. No events are emitted afterwards. */
	async stop(): Promise<void> {
		const socket = this.socket
		const joined = this.joined
		this.socket = null
		this.joined = false
		this.listening = false
		if (socket) this.release(socket, joined)
		return this.closing
	}

	private fail(socket: dgram.Socket, e: unknown): void {
		if (!this.listening) {
			// Not up yet (bind or join failed): give the socket up so that start() can retry
			this.socket = null
			this.release(socket, this.joined)
		}
		this.report(e)
	}

	/** Run an owner's handler: its exception is reported as `error` instead of escaping into the socket's dispatch */
	private guard(emit: () => void): void {
		try {
			emit()
		} catch (e) {
			this.report(e)
		}
	}

	private report(e: unknown): void {
		if (this.listenerCount('error') === 0) return
		try {
			this.emit('error', e instanceof Error ? e : new Error(String(e)))
		} catch {
			// a throwing `error` handler has nobody left to tell, and must not recurse into report()
		}
	}

	/** Best-effort leave + close. The socket keeps its (silenced) error handler while closing. */
	private release(socket: dgram.Socket, joined: boolean): void {
		if (joined) {
			try {
				socket.dropMembership(this.group, this.interfaceIp)
			} catch {
				// already gone with the interface or the socket
			}
		}
		const closed = new Promise<void>((resolve) => {
			try {
				socket.close(() => resolve())
			} catch {
				resolve() // not running
			}
		})
		this.closing = Promise.all([this.closing, closed]).then(() => undefined)
	}
}
