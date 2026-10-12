import { EventEmitter } from 'node:events'
import { decodeAdvert, PARTYLINE_GROUP, PARTYLINE_PORT } from '../lwrp/partyline.js'
import { LivewireDirectory } from '../model/directory.js'
import type { LogFn } from './controller.js'
import { PartylineListener, type PartylineListenerOptions } from './partyline-listener.js'

/**
 * Livewire source discovery: the partyline listener, the decoder and the directory, wired together. Receive-only.
 * It never touches the instance status (the LWRP connection owns it): problems are only logged.
 */

export interface DiscoveryTimings {
	/** Period of `directory.expire()` */
	expireEveryMs: number
	/** Delay before trying again to bind and join the group after a failure */
	retryMs: number
	/** `sources` is re-emitted this long after the directory announced a change (further changes in the window ride along) */
	sourcesDebounceMs: number
	/** Same for `usage` */
	usageDebounceMs: number
	/** At most one log line per this period about datagrams that could not be used */
	junkLogMs: number
	/** Once listening, warn (once) if no device has been heard from after this long */
	silenceWarnMs: number
}

export const DEFAULT_DISCOVERY_TIMINGS: DiscoveryTimings = {
	expireEveryMs: 5000,
	retryMs: 30_000,
	sourcesDebounceMs: 5000, // names are not time critical
	usageDebounceMs: 100,
	junkLogMs: 60_000,
	silenceWarnMs: 60_000,
}

export interface SourceDiscoveryOptions {
	/** Local interface address to join the group on; '' or undefined lets the OS choose */
	interfaceIp?: string
	log: LogFn
	timings?: Partial<DiscoveryTimings>
	/** Test seam. Default: a real PartylineListener */
	createListener?: (opts: PartylineListenerOptions) => PartylineListener
	/** Clock of the directory, for tests (see LivewireDirectoryOptions) */
	now?: () => number
}

export interface SourceDiscoveryEvents {
	/** The directory's sources changed (debounced) */
	sources: []
	/** Who uses which source changed (debounced) */
	usage: []
}

export class SourceDiscovery extends EventEmitter<SourceDiscoveryEvents> {
	readonly directory: LivewireDirectory
	private readonly interfaceIp: string
	private readonly log: LogFn
	private readonly timings: DiscoveryTimings
	private readonly createListener: (opts: PartylineListenerOptions) => PartylineListener
	private running = false
	private listener: PartylineListener | undefined
	/** The current listener is bound and joined */
	private up = false
	private lastError: string | undefined
	/** Datagrams ignored since the last log line, and the last exception among them */
	private ignored = 0
	private ignoredError: string | undefined
	private expireTimer: NodeJS.Timeout | undefined
	private retryTimer: NodeJS.Timeout | undefined
	private junkTimer: NodeJS.Timeout | undefined
	private sourcesTimer: NodeJS.Timeout | undefined
	private usageTimer: NodeJS.Timeout | undefined
	private silenceTimer: NodeJS.Timeout | undefined
	/** The silence check has been scheduled in this run (it is done once per start) */
	private silenceArmed = false
	/** The "nothing heard" warning was logged and no advert has been decoded since */
	private silenceWarned = false
	/** Settles when the last listener released is closed */
	private closing: Promise<void> = Promise.resolve()

	constructor(options: SourceDiscoveryOptions) {
		super()
		this.interfaceIp = options.interfaceIp ?? ''
		this.log = options.log
		this.timings = { ...DEFAULT_DISCOVERY_TIMINGS, ...options.timings }
		this.createListener = options.createListener ?? ((opts) => new PartylineListener(opts))
		this.directory = new LivewireDirectory(options.now ? { now: options.now } : {})
	}

	/** Start listening. No-op if started; it retries by itself (see `retryMs`) when the network is not ready. */
	start(): void {
		if (this.running) return
		this.running = true
		this.up = false
		this.lastError = undefined
		this.silenceArmed = false
		this.silenceWarned = false
		this.directory.on('sources', this.onSources)
		this.directory.on('usage', this.onUsage)
		this.expireTimer = setInterval(this.expire, this.timings.expireEveryMs)
		const listener = this.createListener({ interfaceIp: this.interfaceIp })
		this.listener = listener
		listener.on('message', this.onMessage)
		listener.on('listening', this.onListening)
		listener.on('error', this.onError)
		listener.start()
	}

	/** Stop listening and forget the directory. Idempotent; no event is emitted once it has been called. */
	async stop(): Promise<void> {
		this.running = false
		const timers = [
			this.expireTimer,
			this.retryTimer,
			this.junkTimer,
			this.sourcesTimer,
			this.usageTimer,
			this.silenceTimer,
		]
		for (const timer of timers) clearTimeout(timer)
		this.expireTimer = this.retryTimer = this.junkTimer = this.sourcesTimer = this.usageTimer = undefined
		this.silenceTimer = undefined
		this.ignored = 0
		this.ignoredError = undefined
		this.directory.off('sources', this.onSources)
		this.directory.off('usage', this.onUsage)
		this.directory.clear()
		const listener = this.listener
		this.listener = undefined
		this.up = false
		if (listener) {
			listener.off('message', this.onMessage)
			listener.off('listening', this.onListening)
			listener.off('error', this.onError)
			this.closing = listener.stop()
		}
		return this.closing
	}

	private readonly onMessage = (buf: Buffer, rinfo: { address: string }): void => {
		if (!this.running) return
		try {
			const advert = decodeAdvert(buf, rinfo.address)
			if (advert) {
				this.directory.ingest(advert)
				this.heard()
			} else {
				this.ignore(undefined)
			}
		} catch (e) {
			this.ignore(e instanceof Error ? e.message : String(e))
		}
	}

	private readonly onListening = (): void => {
		if (!this.running) return
		this.up = true
		this.lastError = undefined
		this.log(
			'info',
			`Listening for Livewire adverts on ${PARTYLINE_GROUP}:${PARTYLINE_PORT} (interface ${this.interfaceIp || 'default'})`,
		)
		if (!this.silenceArmed) {
			this.silenceArmed = true
			this.silenceTimer = setTimeout(this.checkSilence, this.timings.silenceWarnMs)
		}
	}

	/** Listening for a while without hearing any device: the usual cause is the network setup, not the devices */
	private readonly checkSilence = (): void => {
		this.silenceTimer = undefined
		if (!this.running || this.directory.deviceCount() > 0) return
		this.silenceWarned = true
		this.log(
			'warn',
			`No Livewire advertisement received on ${PARTYLINE_GROUP}:${PARTYLINE_PORT} (interface ${this.interfaceIp || 'default'}) ` +
				`after ${Math.round(this.timings.silenceWarnMs / 1000)} s: check the interface IP, Docker host networking, ` +
				'and that the firewall allows UDP 4001 multicast',
		)
	}

	/** An advert was decoded: say so if the silence warning was logged */
	private heard(): void {
		if (!this.silenceWarned) return
		this.silenceWarned = false
		this.log('info', 'Livewire advertisements are now being received')
	}

	private readonly onError = (err: Error): void => {
		if (!this.running) return
		if (err.message !== this.lastError) {
			this.lastError = err.message
			this.log('warn', `Livewire advert listener: ${err.message}`)
		}
		// Before 'listening' the listener has given its socket up (bind or join failed): try again later.
		// After it, the socket is kept and an error is only worth a log line.
		if (!this.up) this.scheduleRetry()
	}

	private scheduleRetry(): void {
		if (this.retryTimer) return
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined
			if (this.running && !this.up) this.listener?.start()
		}, this.timings.retryMs)
	}

	private readonly expire = (): void => {
		try {
			this.directory.expire()
		} catch (e) {
			this.log('debug', `Livewire directory expiry: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	/** Count a datagram that could not be used; the count is logged (debug) at most once per `junkLogMs` */
	private ignore(error: string | undefined): void {
		this.ignored++
		if (error !== undefined) this.ignoredError = error
		this.junkTimer ??= setTimeout(() => {
			this.junkTimer = undefined
			const count = this.ignored
			const last = this.ignoredError
			this.ignored = 0
			this.ignoredError = undefined
			if (!this.running || count === 0) return
			this.log(
				'debug',
				`Ignored ${count} unusable datagram${count === 1 ? '' : 's'} on the Livewire partyline port${last ? ` (last error: ${last})` : ''}`,
			)
		}, this.timings.junkLogMs)
	}

	private readonly onSources = (): void => {
		this.sourcesTimer ??= setTimeout(() => {
			this.sourcesTimer = undefined
			this.announce('sources')
		}, this.timings.sourcesDebounceMs)
	}

	private readonly onUsage = (): void => {
		this.usageTimer ??= setTimeout(() => {
			this.usageTimer = undefined
			this.announce('usage')
		}, this.timings.usageDebounceMs)
	}

	/** Emit from a timer: whatever a listener throws must not escape into the process */
	private announce(event: keyof SourceDiscoveryEvents): void {
		if (!this.running) return
		try {
			this.emit(event)
		} catch (e) {
			this.log(
				'warn',
				`Livewire discovery: a '${event}' listener failed: ${e instanceof Error ? e.message : String(e)}`,
			)
		}
	}
}
