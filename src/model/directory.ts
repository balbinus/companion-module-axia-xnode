import { EventEmitter } from 'node:events'
import type { AdvertisedSource, PartylineAdvert, SourceUser } from '../lwrp/partyline.js'

/**
 * The Livewire source directory: what the network's devices advertise on the partyline (see lwrp/partyline.ts).
 * Pure model: no sockets and no timers. The owner feeds it decoded adverts, calls `expire()` periodically and
 * debounces the events.
 *
 * Events are emitted synchronously, after the new state is in place, never nested: a listener may call
 * `ingest()`, `expire()` or `clear()`. That updates the state at once (so `sources()` is current), and what it
 * changed is announced when the running emit round ends, coalesced into one more round. If a listener throws, the
 * other event is still emitted and the first error is rethrown by the call that triggered the emission.
 */

export interface DirectorySource extends AdvertisedSource {
	deviceIp: string
	deviceName: string
}

export interface LivewireDirectoryOptions {
	/** A device not heard from for more than this is dropped by `expire()` (default 60 s) */
	expiryMs?: number
	/** Monotonic clock in ms, for tests (default performance.now: immune to wall-clock steps, e.g. NTP) */
	now?: () => number
}

export interface DirectoryEvents {
	/** The result of `sources()` changed (membership, names, addresses, device name) */
	sources: []
	/** The result of `usedBy()` changed for at least one channel */
	usage: []
}

export const DEFAULT_EXPIRY_MS = 60_000
/**
 * A split full advert arrives within milliseconds. A pending set older than this when another full datagram
 * arrives is abandoned: a lost datagram must not let slots of an earlier cycle complete the next one.
 */
export const PENDING_MAX_AGE_MS = 10_000

interface PendingAdvert {
	configVersion: number | undefined
	/** When the first datagram of the set arrived */
	startedAt: number
	/** Gathered so far, by slot */
	slots: Map<string, AdvertisedSource>
}

interface Device {
	ip: string
	/** Defaults to the IP until an advert carries the name */
	name: string
	lastSeen: number
	committed: AdvertisedSource[]
	pending: PendingAdvert | null
	/** channel -> user, as last reported by this device */
	usage: Map<number, SourceUser | null>
}

function ipSortKey(ip: string): number {
	const parts = ip.split('.').map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p > 255)) return NaN
	return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]
}

/** Numeric by octet for dotted quads (10.0.0.9 before 10.0.0.10), plain string order otherwise */
function compareIp(a: string, b: string): number {
	const ka = ipSortKey(a)
	const kb = ipSortKey(b)
	if (!Number.isNaN(ka) && !Number.isNaN(kb) && ka !== kb) return ka - kb
	return a < b ? -1 : a > b ? 1 : 0
}

function compareSources(a: DirectorySource, b: DirectorySource): number {
	return a.channel - b.channel || compareIp(a.deviceIp, b.deviceIp) || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0)
}

/** Every DirectorySource field: a field missing from this literal does not compile, so none escapes `sameSource` */
const SOURCE_FIELDS = Object.keys({
	slot: 0,
	channel: 0,
	name: 0,
	streamAddress: 0,
	backfeedAddress: 0,
	deviceIp: 0,
	deviceName: 0,
} satisfies Record<keyof DirectorySource, 0>) as Array<keyof DirectorySource>

function sameSource(a: DirectorySource, b: DirectorySource): boolean {
	return SOURCE_FIELDS.every((field) => a[field] === b[field])
}

/** What a device reports for a channel: the claim on its user, to settle between devices reporting different ones */
interface UsageClaim {
	user: SourceUser
	/** The device advertises the channel as a regular source (not as the backfeed of another device's) */
	owns: boolean
	ip: string
}

/** Total order: the owner of the source first, then the lowest IP */
function claimBeats(a: UsageClaim, b: UsageClaim): boolean {
	return a.owns !== b.owns ? a.owns : compareIp(a.ip, b.ip) < 0
}

function sameUsage(a: Map<number, Readonly<SourceUser>>, b: Map<number, Readonly<SourceUser>>): boolean {
	if (a.size !== b.size) return false
	for (const [channel, user] of a) {
		const other = b.get(channel)
		if (!other || other.engineIp !== user.engineIp || other.fader !== user.fader) return false
	}
	return true
}

export class LivewireDirectory extends EventEmitter<DirectoryEvents> {
	private readonly expiryMs: number
	private readonly now: () => number
	private readonly devices = new Map<string, Device>()
	/** What `sources()` / `usedBy()` currently report: events fire when a recomputation differs from these */
	private list: ReadonlyArray<Readonly<DirectorySource>> = []
	private usage = new Map<number, Readonly<SourceUser>>()
	/** Changes not announced yet; `flush()` empties them */
	private sourcesDirty = false
	private usageDirty = false
	private flushing = false

	constructor(options: LivewireDirectoryOptions = {}) {
		super()
		this.expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS
		this.now = options.now ?? (() => performance.now())
	}

	/** Feed one decoded advert */
	ingest(advert: PartylineAdvert): void {
		let device = this.devices.get(advert.deviceIp)
		if (!device) {
			device = {
				ip: advert.deviceIp,
				name: advert.deviceIp,
				lastSeen: 0,
				committed: [],
				pending: null,
				usage: new Map(),
			}
			this.devices.set(advert.deviceIp, device)
		}
		const now = this.now()
		device.lastSeen = now
		let changed = false
		if (advert.deviceName && advert.deviceName !== device.name) {
			device.name = advert.deviceName
			changed = true
		}

		if (advert.kind === 'full') {
			changed = this.gather(device, advert, now) || changed
		} else if (advert.kind === 'usage') {
			device.usage = new Map(advert.usage.map((u) => [u.channel, u.usedBy]))
			changed = true
		}
		// A keepalive only refreshes lastSeen: a different configVersion means a full advert follows shortly
		if (changed) this.refresh()
	}

	/** Drop the devices not heard from for more than `expiryMs` */
	expire(): void {
		const limit = this.now() - this.expiryMs
		let removed = false
		for (const [ip, device] of this.devices) {
			if (device.lastSeen < limit) {
				this.devices.delete(ip)
				removed = true
			}
		}
		if (removed) this.refresh()
	}

	/** Devices heard from and not expired yet, whether or not their sources are known (diagnostics) */
	deviceCount(): number {
		return this.devices.size
	}

	/** Committed sources, sorted by channel then device IP. The entries are frozen. */
	sources(): ReadonlyArray<Readonly<DirectorySource>> {
		return [...this.list]
	}

	/**
	 * What advertises this multicast address. Priority: a source's own stream (`from`), then the backfeed of a
	 * source (`to`), then a console's backfeed source, whose stream is its backfeed address (`from`).
	 */
	lookupAddress(ip: string): { source: Readonly<DirectorySource>; kind: 'from' | 'to' } | undefined {
		const addr = ip.trim()
		for (const source of this.list) {
			if (source.streamAddress === addr && source.streamAddress !== source.backfeedAddress)
				return { source, kind: 'from' }
		}
		for (const source of this.list) {
			if (source.backfeedAddress === addr && source.streamAddress !== source.backfeedAddress)
				return { source, kind: 'to' }
		}
		for (const source of this.list) {
			if (source.streamAddress === addr) return { source, kind: 'from' }
		}
		return undefined
	}

	/** The console engine using this channel's source (BUSY); null when unused or unknown. The result is frozen. */
	usedBy(channel: number): Readonly<SourceUser> | null {
		return this.usage.get(channel) ?? null
	}

	/** Forget everything */
	clear(): void {
		if (this.devices.size === 0) return
		this.devices.clear()
		this.refresh()
	}

	/** Merge a full advert into the device's pending set; commits it when complete. Returns true on a commit. */
	private gather(device: Device, advert: PartylineAdvert, now: number): boolean {
		// A different configVersion (either direction: it restarts on reboot) abandons what was gathered, and so
		// does a set that has been waiting too long: its missing datagram is lost, and slots that changed since
		// without a version bump must not complete the next cycle
		if (
			!device.pending ||
			device.pending.configVersion !== advert.configVersion ||
			now - device.pending.startedAt > PENDING_MAX_AGE_MS
		) {
			device.pending = { configVersion: advert.configVersion, startedAt: now, slots: new Map() }
		}
		const pending = device.pending
		for (const source of advert.sources) pending.slots.set(source.slot, source)
		if (pending.slots.size < (advert.sourceCount ?? advert.sources.length)) return false
		device.committed = [...pending.slots.values()]
		device.pending = null
		return true
	}

	/** Recompute the public view and announce what changed */
	private refresh(): void {
		const list: Array<Readonly<DirectorySource>> = []
		const claims = new Map<number, UsageClaim>()
		for (const device of this.devices.values()) {
			const owned = new Set<number>()
			for (const source of device.committed) {
				list.push(Object.freeze({ ...source, deviceIp: device.ip, deviceName: device.name }))
				if (source.streamAddress !== source.backfeedAddress) owned.add(source.channel)
			}
			// Several devices may report a channel (a console also lists the sources it backfeeds): a user wins over
			// null; between users, the device that owns the source wins, then the lowest IP. The answer does not
			// depend on the order in which the devices were heard.
			for (const [channel, user] of device.usage) {
				if (!user) continue
				const claim: UsageClaim = { user, owns: owned.has(channel), ip: device.ip }
				const best = claims.get(channel)
				if (!best || claimBeats(claim, best)) claims.set(channel, claim)
			}
		}
		list.sort(compareSources)
		const usage = new Map<number, Readonly<SourceUser>>()
		for (const [channel, claim] of claims) usage.set(channel, Object.freeze({ ...claim.user }))

		if (list.length !== this.list.length || list.some((s, i) => !sameSource(s, this.list[i]))) {
			this.list = list
			this.sourcesDirty = true
		}
		if (!sameUsage(usage, this.usage)) {
			this.usage = usage
			this.usageDirty = true
		}
		this.flush()
	}

	/**
	 * Emit `sources` then `usage` for what is dirty, until nothing is. A call from a listener (re-entrancy) returns
	 * at once: the running flush announces what it added. Both events go out even if a listener throws; the first
	 * error is rethrown at the end.
	 */
	private flush(): void {
		if (this.flushing) return
		this.flushing = true
		let failure: { error: unknown } | undefined
		const emit = (event: keyof DirectoryEvents): void => {
			try {
				this.emit(event)
			} catch (error) {
				failure ??= { error }
			}
		}
		try {
			while (this.sourcesDirty || this.usageDirty) {
				if (this.sourcesDirty) {
					this.sourcesDirty = false
					emit('sources')
				}
				if (this.usageDirty) {
					this.usageDirty = false
					emit('usage')
				}
			}
		} finally {
			this.flushing = false
		}
		if (failure) throw failure.error
	}
}
