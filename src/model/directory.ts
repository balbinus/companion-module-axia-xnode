import { EventEmitter } from 'node:events'
import type { AdvertisedSource, PartylineAdvert, SourceUser } from '../lwrp/partyline.js'

/**
 * The Livewire source directory: what the network's devices advertise on the partyline (see lwrp/partyline.ts).
 * Pure model: no sockets and no timers. The owner feeds it decoded adverts, calls `expire()` periodically and
 * debounces the events.
 */

export interface DirectorySource extends AdvertisedSource {
	deviceIp: string
	deviceName: string
}

export interface LivewireDirectoryOptions {
	/** A device not heard from for more than this is dropped by `expire()` (default 60 s) */
	expiryMs?: number
	/** Clock, for tests (default Date.now) */
	now?: () => number
}

export interface DirectoryEvents {
	/** The result of `sources()` changed (membership, names, addresses, device name) */
	sources: []
	/** The result of `usedBy()` changed for at least one channel */
	usage: []
}

export const DEFAULT_EXPIRY_MS = 60_000

interface PendingAdvert {
	configVersion: number | undefined
	/** Gathered so far, by slot */
	slots: Map<string, AdvertisedSource>
}

interface Device {
	ip: string
	/** Defaults to the IP until an advert carries the name */
	name: string
	hwid?: number
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

function sameSource(a: DirectorySource, b: DirectorySource): boolean {
	return (
		a.slot === b.slot &&
		a.channel === b.channel &&
		a.name === b.name &&
		a.streamAddress === b.streamAddress &&
		a.backfeedAddress === b.backfeedAddress &&
		a.deviceIp === b.deviceIp &&
		a.deviceName === b.deviceName
	)
}

function sameUsage(a: Map<number, SourceUser>, b: Map<number, SourceUser>): boolean {
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
	private list: DirectorySource[] = []
	private usage = new Map<number, SourceUser>()

	constructor(options: LivewireDirectoryOptions = {}) {
		super()
		this.expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS
		this.now = options.now ?? Date.now
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
		device.lastSeen = this.now()
		if (advert.hwid !== undefined) device.hwid = advert.hwid
		let changed = false
		if (advert.deviceName && advert.deviceName !== device.name) {
			device.name = advert.deviceName
			changed = true
		}

		if (advert.kind === 'full') {
			changed = this.gather(device, advert) || changed
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

	/** Committed sources, sorted by channel then device IP */
	sources(): DirectorySource[] {
		return [...this.list]
	}

	/**
	 * What advertises this multicast address. Priority: a source's own stream (`from`), then the backfeed of a
	 * source (`to`), then a console's backfeed source, whose stream is its backfeed address (`from`).
	 */
	lookupAddress(ip: string): { source: DirectorySource; kind: 'from' | 'to' } | undefined {
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

	/** The console engine using this channel's source (BUSY); null when unused or unknown */
	usedBy(channel: number): SourceUser | null {
		return this.usage.get(channel) ?? null
	}

	/** Forget everything */
	clear(): void {
		if (this.devices.size === 0) return
		this.devices.clear()
		this.refresh()
	}

	/** Merge a full advert into the device's pending set; commits it when complete. Returns true on a commit. */
	private gather(device: Device, advert: PartylineAdvert): boolean {
		// A different configVersion (either direction: it restarts on reboot) abandons what was gathered
		if (!device.pending || device.pending.configVersion !== advert.configVersion) {
			device.pending = { configVersion: advert.configVersion, slots: new Map() }
		}
		const pending = device.pending
		for (const source of advert.sources) pending.slots.set(source.slot, source)
		if (pending.slots.size < (advert.sourceCount ?? advert.sources.length)) return false
		device.committed = [...pending.slots.values()]
		device.pending = null
		return true
	}

	/** Recompute the public view and emit for what changed */
	private refresh(): void {
		const list: DirectorySource[] = []
		const usage = new Map<number, SourceUser>()
		for (const device of this.devices.values()) {
			for (const source of device.committed) {
				list.push({ ...source, deviceIp: device.ip, deviceName: device.name })
			}
			// Several devices may report a channel (a console also lists the sources it backfeeds): a user wins over null
			for (const [channel, user] of device.usage) {
				if (user && !usage.has(channel)) usage.set(channel, user)
			}
		}
		list.sort(compareSources)

		const sourcesChanged = list.length !== this.list.length || list.some((s, i) => !sameSource(s, this.list[i]))
		const usageChanged = !sameUsage(usage, this.usage)
		if (sourcesChanged) this.list = list
		if (usageChanged) this.usage = usage
		if (sourcesChanged) this.emit('sources')
		if (usageChanged) this.emit('usage')
	}
}
