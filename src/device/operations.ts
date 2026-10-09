import type { ModuleConfig } from '../config.js'
import {
	channelToMulticast,
	isIpv4,
	isIpv4Multicast,
	isValidChannel,
	normaliseAddr,
	type ChannelKind,
} from '../lwrp/livewire.js'
import { formatCommand, mixCommand, quote } from '../lwrp/parser.js'
import {
	clamp,
	clampGain,
	GAIN_MAX_TENTHS,
	GAIN_MIN_TENTHS,
	isXpointOn,
	XPOINT_BUDGET,
	XPOINT_OFF_TENTHS,
} from '../lwrp/units.js'
import { findChannel } from '../model/iomap.js'
import type { XNodeState } from '../model/state.js'
import type { LogFn, WriteTarget, XNodeController } from './controller.js'

/** Adjust calls on the same target within this window are merged into one write. */
export const COALESCE_MS = 50
/**
 * `INP n GAIN` on the xNode2 mic input (measured): 140...690 (14.0-69.0 dB) is applied as is, above 690 is clamped
 * to 690, and anything below 140 is reset to 0 by the node. So the usable values are 0 and 140...690.
 */
export const MIC_GAIN_MIN_TENTHS = 140
export const MIC_GAIN_MAX_TENTHS = 690

/** Snap to what the node accepts: 0 or 140...690 (values below 70 become 0, 70-139 become 140). */
export function normaliseMicGain(tenths: number): number {
	if (tenths >= MIC_GAIN_MIN_TENTHS) return Math.min(tenths, MIC_GAIN_MAX_TENTHS)
	return tenths >= MIC_GAIN_MIN_TENTHS / 2 ? MIC_GAIN_MIN_TENTHS : 0
}
export const XNODE2_GAIN_MIN_TENTHS = -720
export const SRC_NAME_MAX = 16
export const PULSE_MIN_MS = 20
export const PULSE_MAX_MS = 600_000
export const SRC_MODES = { live: 12, standard: 240, aes67: 48 } as const
export const GPO_PINS = 5

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f"\\]/g
const DEFAULT_XP_MIN_DB = -80
const DEFAULT_XP_MAX_DB = 24

/** `[output, input, tenths]`; null tenths clears the crosspoint. */
export type XpointChange = [output: number, input: number, tenths: number | null]

export const SNAPSHOT_VERSION = 1

interface Snapshot {
	v: number
	devn: string
	mix: Record<string, Record<string, number>>
}

interface PendingAdjust {
	delta: number
	timer: NodeJS.Timeout
	flush: (delta: number) => Promise<void>
	waiters: Array<{ resolve: () => void; reject: (e: Error) => void }>
}

interface PendingPulse {
	timer: NodeJS.Timeout
	/** Level before the first (not yet restored) pulse */
	previous: 'h' | 'l'
}

type Permission = 'mixer' | 'source' | 'gpo'

const PERMISSION_TEXT: Record<Permission, string> = {
	mixer: 'Mixer & routing changes are disabled in the module configuration',
	source: 'Source (stream) changes are disabled in the module configuration',
	gpo: 'GPO control is disabled in the module configuration',
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

function attrInt(value: string | undefined): number | undefined {
	if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined
	return Number(value)
}

/**
 * Validated, permission-gated write operations on top of the controller.
 * Every method throws an Error with a user-facing message when the operation is refused or fails.
 * Gains are integer tenths of dB (the wire unit).
 */
export class XNodeOperations {
	private chain: Promise<unknown> = Promise.resolve()
	private readonly adjusts = new Map<string, PendingAdjust>()
	private readonly pulses = new Map<string, PendingPulse>()
	private destroyed = false

	constructor(
		readonly controller: XNodeController,
		readonly getConfig: () => ModuleConfig,
		readonly log: LogFn,
	) {}

	destroy(): void {
		this.destroyed = true
		for (const p of this.adjusts.values()) {
			clearTimeout(p.timer)
			for (const w of p.waiters) w.resolve()
		}
		this.adjusts.clear()
		for (const p of this.pulses.values()) clearTimeout(p.timer)
		this.pulses.clear()
	}

	// ---------------------------------------------------------------- plumbing

	private get state(): XNodeState {
		return this.controller.state
	}

	/** Runs `fn` after all earlier operations finished, so decisions see the state left by the previous write. */
	private async serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn)
		this.chain = run.catch(() => undefined)
		return run
	}

	private require(permission: Permission | null): void {
		if (this.destroyed) throw new Error('The module is shutting down')
		if (!this.controller.isConnected) throw new Error('Not connected to the node')
		if (!this.controller.isSynced) throw new Error('The node is still being read, try again in a moment')
		if (permission === null) return
		const cfg = this.getConfig()
		const allowed =
			permission === 'mixer'
				? cfg.allowMixerWrites
				: permission === 'source'
					? cfg.allowSourceWrites
					: cfg.allowGpoWrites
		if (!allowed) throw new Error(PERMISSION_TEXT[permission])
	}

	private index(kind: 'SRC' | 'DST' | 'GPO', n: number): number {
		const max = kind === 'SRC' ? this.state.nsrc : kind === 'DST' ? this.state.ndst : this.state.ngpo
		if (!Number.isInteger(n) || n < 1 || n > max) {
			throw new Error(max === 0 ? `This node has no ${kind} objects` : `${kind} ${n} does not exist (1-${max})`)
		}
		return n
	}

	private static integer(value: number, what: string): number {
		if (!Number.isInteger(value)) throw new Error(`${what} must be an integer number of tenths of dB`)
		return value
	}

	/** SRC INGN / DST OUGN clamp. xNode2 rejects (ERROR 1001) anything below -72 dB, legacy nodes accept down to -100 dB. */
	private clampDeviceGain(tenths: number): number {
		const value = clampGain(tenths)
		return this.state.isXNode2 ? Math.max(value, XNODE2_GAIN_MIN_TENTHS) : value
	}

	/** Crosspoint limits in tenths, sanitised: inside -100...+24 dB and min < max. */
	xpointLimits(): { min: number; max: number } {
		const cfg = this.getConfig()
		const fix = (v: unknown, fallback: number): number =>
			typeof v === 'number' && Number.isFinite(v)
				? clamp(Math.round(v * 10), GAIN_MIN_TENTHS, GAIN_MAX_TENTHS)
				: fallback * 10
		let min = fix(cfg.xpointMinDb, DEFAULT_XP_MIN_DB)
		let max = fix(cfg.xpointMaxDb, DEFAULT_XP_MAX_DB)
		if (min >= max) {
			min = DEFAULT_XP_MIN_DB * 10
			max = DEFAULT_XP_MAX_DB * 10
		}
		return { min, max }
	}

	/** Merge adjust calls on `key` (first call opens a window of COALESCE_MS, deltas accumulate), then run `flush(total)` serially. */
	private async coalesce(key: string, delta: number, flush: (total: number) => Promise<void>): Promise<void> {
		return new Promise((resolve, reject) => {
			let entry = this.adjusts.get(key)
			if (!entry) {
				const created: PendingAdjust = {
					delta: 0,
					flush,
					waiters: [],
					timer: setTimeout(() => {
						this.adjusts.delete(key)
						const total = created.delta
						this.serial(async () => {
							if (this.destroyed) return
							await created.flush(total)
						}).then(
							() => created.waiters.forEach((w) => w.resolve()),
							(e: unknown) => created.waiters.forEach((w) => w.reject(e instanceof Error ? e : new Error(errText(e)))),
						)
					}, COALESCE_MS),
				}
				this.adjusts.set(key, created)
				entry = created
			}
			entry.delta += delta
			entry.waiters.push({ resolve, reject })
		})
	}

	private async send(cmd: string, target: WriteTarget): Promise<void> {
		await this.controller.writeAndVerify(cmd, target)
	}

	// ---------------------------------------------------------------- mixer

	private checkMixerMode(): void {
		const mode = this.state.mixcfgMode
		if (mode === undefined) throw new Error('The mixer mode is not known yet')
		if (mode === 0) return
		if (!this.getConfig().allowLeaveFactoryMode) {
			throw new Error(
				`The mixer is in factory mode ${mode}; a crosspoint write would switch it to custom mode. Enable "Allow leaving factory mixer mode" to permit it`,
			)
		}
		this.log('warn', `Mixer is in factory mode ${mode}: this write switches the node to custom (MODE 0) mixing`)
	}

	/** Validate and write crosspoint changes, one `MIX` line per output row. Must run inside `serial`. */
	private async writeXpoints(changes: XpointChange[]): Promise<void> {
		this.require('mixer')
		const st = this.state
		if (!st.hasMixer) throw new Error('This node has no mixer')
		const { min, max } = this.xpointLimits()

		const final = new Map<string, XpointChange>()
		for (const [out, inp, tenths] of changes) {
			if (!findChannel(st.ioMap.outputs, out)) throw new Error(`Mixer output ${out} does not exist on this node`)
			const inMap = findChannel(st.ioMap.inputs, inp) !== undefined
			if (tenths !== null) {
				if (!inMap) throw new Error(`Mixer input ${inp} does not exist on this node`)
				XNodeOperations.integer(tenths, 'Crosspoint gain')
			} else if (!inMap && !isXpointOn(st.getXpoint(out, inp))) {
				continue // nothing to clear
			}
			let value = tenths === null ? null : clamp(tenths, min, max)
			if (value !== null && value <= XPOINT_OFF_TENTHS) value = null
			final.set(`${out}:${inp}`, [out, inp, value])
		}
		if (final.size === 0) return

		this.checkMixerMode()

		let delta = 0
		for (const [out, inp, value] of final.values()) {
			delta += (value !== null ? 1 : 0) - (isXpointOn(st.getXpoint(out, inp)) ? 1 : 0)
		}
		const used = st.xpointsUsed()
		if (delta > 0 && used + delta > XPOINT_BUDGET) {
			throw new Error(
				`Crosspoint budget exceeded: ${used} in use, this change adds ${delta}, the node allows ${XPOINT_BUDGET}`,
			)
		}

		const rows = new Map<number, Array<[number, number | null]>>()
		for (const [out, inp, value] of final.values()) {
			const row = rows.get(out) ?? []
			row.push([inp, value])
			rows.set(out, row)
		}
		for (const [out, entries] of rows) {
			entries.sort((a, b) => a[0] - b[0])
			await this.send(mixCommand(out, entries), { verb: 'MIX', index: out })
			for (const [inp, value] of entries) {
				const actual = st.getXpoint(out, inp)
				const ok = value === null ? !isXpointOn(actual) : actual === value
				if (!ok)
					throw new Error(`The node did not apply MIX ${out} ${inp}:${value ?? '-'} (reads back ${actual ?? 'off'})`)
			}
		}
	}

	/** Set all crosspoints to the gain. */
	async mixSet(xpoints: Array<[number, number]>, tenths: number): Promise<void> {
		this.require('mixer')
		XNodeOperations.integer(tenths, 'Crosspoint gain')
		await this.serial(async () => this.writeXpoints(xpoints.map(([o, i]) => [o, i, tenths])))
	}

	async mixClear(xpoints: Array<[number, number]>): Promise<void> {
		this.require('mixer')
		await this.serial(async () => this.writeXpoints(xpoints.map(([o, i]) => [o, i, null])))
	}

	/** All target crosspoints on -> clear all; otherwise set all at `onTenths`. */
	async mixToggle(xpoints: Array<[number, number]>, onTenths: number): Promise<void> {
		this.require('mixer')
		XNodeOperations.integer(onTenths, 'Crosspoint gain')
		await this.serial(async () => {
			const allOn = xpoints.length > 0 && xpoints.every(([o, i]) => isXpointOn(this.state.getXpoint(o, i)))
			return this.writeXpoints(xpoints.map(([o, i]) => [o, i, allOn ? null : onTenths]))
		})
	}

	/**
	 * Add `deltaTenths` to each crosspoint. Rapid calls (rotary encoders) within COALESCE_MS are summed per
	 * crosspoint and written once, relative to the state at write time. An OFF crosspoint counts as sitting at the
	 * configured minimum: a positive total turns it on at min + total, zero or negative leaves it off.
	 * An ON crosspoint is clamped to the limits and never turned off by adjusting.
	 */
	async mixAdjust(xpoints: Array<[number, number]>, deltaTenths: number): Promise<void> {
		this.require('mixer')
		XNodeOperations.integer(deltaTenths, 'Gain step')
		const st = this.state
		for (const [o, i] of xpoints) {
			if (!findChannel(st.ioMap.outputs, o) || !findChannel(st.ioMap.inputs, i)) {
				throw new Error(`Crosspoint ${o}/${i} does not exist on this node`)
			}
		}
		await Promise.all(
			xpoints.map(async ([o, i]) =>
				this.coalesce(`mix:${o}:${i}`, deltaTenths, async (total) => {
					const current = this.state.getXpoint(o, i)
					const { min, max } = this.xpointLimits()
					const on = isXpointOn(current)
					if (!on && total <= 0) return
					const target = clamp((on ? (current as number) : min) + total, min, max)
					if (on && target === current) return
					await this.writeXpoints([[o, i, target]])
				}),
			),
		)
	}

	/** Route only each `[output, input]` pair: every other input of the map is cleared on that output row. */
	async mixExclusive(xpoints: Array<[number, number]>, onTenths: number): Promise<void> {
		this.require('mixer')
		XNodeOperations.integer(onTenths, 'Crosspoint gain')
		await this.serial(async () => {
			const st = this.state
			const changes: XpointChange[] = []
			for (const [out, keep] of xpoints) {
				const inputs = new Set<number>(st.ioMap.inputs.map((c) => c.number))
				for (const [i, g] of st.mix.get(out) ?? []) if (isXpointOn(g)) inputs.add(i)
				for (const i of inputs) if (i !== keep) changes.push([out, i, null])
				changes.push([out, keep, onTenths])
			}
			return this.writeXpoints(changes)
		})
	}

	/** Clear every crosspoint that is on, on the given output rows. */
	async mixClearOutput(outputs: number[]): Promise<void> {
		this.require('mixer')
		await this.serial(async () => {
			const st = this.state
			const changes: XpointChange[] = []
			for (const out of outputs) {
				if (!findChannel(st.ioMap.outputs, out)) throw new Error(`Mixer output ${out} does not exist on this node`)
				for (const [i, g] of st.mix.get(out) ?? []) if (isXpointOn(g)) changes.push([out, i, null])
			}
			return this.writeXpoints(changes)
		})
	}

	/** Compact JSON of all mixer rows (crosspoints that are on, restricted to the I/O map). */
	async mixSnapshotStore(): Promise<string> {
		this.require(null)
		const st = this.state
		if (!st.hasMixer) throw new Error('This node has no mixer')
		const mix: Snapshot['mix'] = {}
		for (const out of st.ioMap.outputs) {
			const row: Record<string, number> = {}
			for (const inp of st.ioMap.inputs) {
				const g = st.getXpoint(out.number, inp.number)
				if (g !== undefined && isXpointOn(g)) row[String(inp.number)] = g
			}
			mix[String(out.number)] = row
		}
		const snapshot: Snapshot = { v: SNAPSHOT_VERSION, devn: st.ver.DEVN ?? '', mix }
		return JSON.stringify(snapshot)
	}

	/**
	 * Recall a snapshot made by mixSnapshotStore: validated, diffed against the current state, only changed rows
	 * are written. Rows missing from the snapshot are left alone. Returns the number of crosspoints changed.
	 */
	async mixSnapshotRecall(json: string): Promise<number> {
		this.require('mixer')
		const snapshot = this.parseSnapshot(json)
		return this.serial(async () => {
			const st = this.state
			const { min, max } = this.xpointLimits()
			const changes: XpointChange[] = []
			for (const [outKey, row] of Object.entries(snapshot.mix)) {
				const out = Number(outKey)
				const wanted = new Map<number, number>()
				for (const [inKey, g] of Object.entries(row)) {
					const value = clamp(g, min, max)
					if (value > XPOINT_OFF_TENTHS) wanted.set(Number(inKey), value)
				}
				const current = new Map<number, number>()
				for (const inp of st.ioMap.inputs) {
					const g = st.getXpoint(out, inp.number)
					if (g !== undefined && isXpointOn(g)) current.set(inp.number, g)
				}
				for (const inp of current.keys()) if (!wanted.has(inp)) changes.push([out, inp, null])
				for (const [inp, g] of wanted) if (current.get(inp) !== g) changes.push([out, inp, g])
			}
			if (changes.length === 0) {
				this.log('info', 'Mixer snapshot recall: nothing to change')
				return 0
			}
			await this.writeXpoints(changes)
			this.log('info', `Mixer snapshot recalled: ${changes.length} crosspoint(s) changed`)
			return changes.length
		})
	}

	private parseSnapshot(json: string): Snapshot {
		const st = this.state
		if (!st.hasMixer) throw new Error('This node has no mixer')
		let data: unknown
		try {
			data = JSON.parse(String(json))
		} catch {
			throw new Error('The mixer snapshot is not valid JSON')
		}
		const snap = data as Partial<Snapshot> | null
		if (!snap || typeof snap !== 'object' || snap.v !== SNAPSHOT_VERSION || typeof snap.mix !== 'object' || !snap.mix) {
			throw new Error('The mixer snapshot has an unknown format')
		}
		if (String(snap.devn ?? '').toLowerCase() !== (st.ver.DEVN ?? '').toLowerCase()) {
			throw new Error(
				`The mixer snapshot is for another device model (${snap.devn ?? '?'}, this node is ${st.ver.DEVN ?? '?'})`,
			)
		}
		const mix: Snapshot['mix'] = {}
		for (const [outKey, row] of Object.entries(snap.mix)) {
			if (!/^\d+$/.test(outKey) || !findChannel(st.ioMap.outputs, Number(outKey))) {
				throw new Error(`The mixer snapshot has an output that does not exist on this node: ${outKey}`)
			}
			if (!row || typeof row !== 'object') throw new Error(`The mixer snapshot row ${outKey} is malformed`)
			const clean: Record<string, number> = {}
			for (const [inKey, g] of Object.entries(row)) {
				if (!/^\d+$/.test(inKey) || !findChannel(st.ioMap.inputs, Number(inKey))) {
					throw new Error(`The mixer snapshot has an input that does not exist on this node: ${outKey}/${inKey}`)
				}
				if (typeof g !== 'number' || !Number.isInteger(g) || g < GAIN_MIN_TENTHS || g > GAIN_MAX_TENTHS) {
					throw new Error(`The mixer snapshot has an invalid gain at ${outKey}/${inKey}`)
				}
				clean[inKey] = g
			}
			mix[outKey] = clean
		}
		return { v: SNAPSHOT_VERSION, devn: snap.devn as string, mix }
	}

	// ---------------------------------------------------------------- GPO

	private pinLevels(port: number): string {
		const pins = this.state.gpo.get(port)
		if (!pins || pins.length < GPO_PINS) throw new Error(`The state of GPO ${port} is not known`)
		return pins
	}

	private checkPins(pins: number[]): number[] {
		const unique = [...new Set(pins)]
		if (unique.length === 0) throw new Error('No GPO pin selected')
		for (const p of unique)
			if (!Number.isInteger(p) || p < 1 || p > GPO_PINS) throw new Error(`GPO pin ${p} does not exist (1-${GPO_PINS})`)
		return unique
	}

	/** Write new levels for `pins`; must run inside `serial`. `permission` false is used by pulse restores. */
	private async writePins(
		port: number,
		pins: number[],
		level: (pin: number, current: 'h' | 'l') => 'h' | 'l',
		permission = true,
	): Promise<void> {
		this.require(permission ? 'gpo' : null)
		this.index('GPO', port)
		const current = this.pinLevels(port)
		const next = current.split('')
		for (const pin of this.checkPins(pins)) next[pin - 1] = level(pin, current[pin - 1] as 'h' | 'l')
		const text = next.join('')
		if (text === current) return
		const line = await this.controller.writeAndVerify(formatCommand('GPO', [port, text]), { verb: 'GPO', index: port })
		const actual = (line?.args[1] ?? this.state.gpo.get(port) ?? '').toLowerCase()
		if (actual !== text)
			throw new Error(`GPO ${port} did not change as requested (reads ${actual || '?'}, expected ${text})`)
	}

	async gpoSet(port: number, pins: number[], active: boolean): Promise<void> {
		this.require('gpo')
		await this.serial(async () => this.writePins(port, pins, () => (active ? 'l' : 'h')))
	}

	async gpoToggle(port: number, pins: number[]): Promise<void> {
		this.require('gpo')
		await this.serial(async () => this.writePins(port, pins, (_p, cur) => (cur === 'l' ? 'h' : 'l')))
	}

	/**
	 * Drive the pins to the active (or inactive) level, then restore the level they had before the pulse
	 * after `ms`. Re-triggering a running pulse restarts its timer and still restores the original level.
	 */
	async gpoPulse(port: number, pins: number[], ms: number, active = true): Promise<void> {
		this.require('gpo')
		if (!Number.isInteger(ms) || ms < PULSE_MIN_MS || ms > PULSE_MAX_MS) {
			throw new Error(`Pulse length must be ${PULSE_MIN_MS}-${PULSE_MAX_MS} ms`)
		}
		await this.serial(async () => {
			this.require('gpo')
			this.index('GPO', port)
			const unique = this.checkPins(pins)
			const current = this.pinLevels(port)
			const previous = new Map<number, 'h' | 'l'>()
			for (const pin of unique) {
				previous.set(pin, this.pulses.get(`${port}.${pin}`)?.previous ?? (current[pin - 1] as 'h' | 'l'))
			}
			await this.writePins(port, unique, () => (active ? 'l' : 'h'))
			for (const pin of unique) {
				const key = `${port}.${pin}`
				clearTimeout(this.pulses.get(key)?.timer)
				const prev = previous.get(pin) as 'h' | 'l'
				const timer = setTimeout(() => {
					this.pulses.delete(key)
					if (this.destroyed) return
					this.serial(async () => this.writePins(port, [pin], () => prev, false)).catch((e: unknown) =>
						this.log('warn', `GPO ${port} pin ${pin}: could not restore after pulse: ${errText(e)}`),
					)
				}, ms)
				this.pulses.set(key, { timer, previous: prev })
			}
		})
	}

	// ---------------------------------------------------------------- mic gain (xNode2)

	private micInput(n: number): number {
		const attrs = this.state.inp.get(n)
		if (!this.state.isXNode2 || !attrs || (attrs.TYPE ?? '').toUpperCase() !== 'MIC') {
			throw new Error(`INP ${n} is not a microphone input of this node`)
		}
		return n
	}

	async micGainSet(inp: number, tenths: number): Promise<void> {
		this.require('source')
		XNodeOperations.integer(tenths, 'Mic gain')
		await this.serial(async () => {
			this.require('source')
			this.micInput(inp)
			await this.writeMicGain(inp, normaliseMicGain(tenths))
		})
	}

	async micGainAdjust(inp: number, deltaTenths: number): Promise<void> {
		this.require('source')
		XNodeOperations.integer(deltaTenths, 'Gain step')
		this.micInput(inp)
		await this.coalesce(`mic:${inp}`, deltaTenths, async (total) => {
			this.require('source')
			this.micInput(inp)
			const current = attrInt(this.state.inp.get(inp)?.GAIN)
			if (current === undefined) throw new Error(`The gain of INP ${inp} is not known`)
			await this.writeMicGain(
				inp,
				normaliseMicGain(current < MIC_GAIN_MIN_TENTHS && total > 0 ? MIC_GAIN_MIN_TENTHS : current + total),
			)
		})
	}

	private async writeMicGain(inp: number, tenths: number): Promise<void> {
		if (attrInt(this.state.inp.get(inp)?.GAIN) === tenths) return
		await this.send(formatCommand('INP', [inp], { GAIN: tenths }), { verb: 'INP', index: inp })
		this.verifyInt('INP', inp, 'GAIN', this.state.inp.get(inp)?.GAIN, tenths)
	}

	private verifyInt(what: string, n: number, key: string, actual: string | undefined, expected: number): void {
		if (attrInt(actual) !== expected)
			throw new Error(`${what} ${n}: the node did not apply ${key}:${expected} (reads ${actual ?? '?'})`)
	}

	// ---------------------------------------------------------------- DST

	/** Connect a destination to Livewire channel `channel` ("from" 239.192.x.y or "to" 239.193.x.y). */
	async dstConnectChannel(n: number, channel: number, kind: ChannelKind = 'from'): Promise<void> {
		if (!isValidChannel(channel)) throw new Error(`Invalid Livewire channel ${channel} (1-32767)`)
		await this.dstConnectAddress(n, channelToMulticast(channel, kind))
	}

	async dstConnectAddress(n: number, ip: string): Promise<void> {
		const address = String(ip).trim()
		if (!isIpv4Multicast(address)) throw new Error(`"${address}" is not an IPv4 multicast address`)
		await this.writeDstAddr(n, address)
	}

	async dstDisconnect(n: number): Promise<void> {
		await this.writeDstAddr(n, '')
	}

	private async writeDstAddr(n: number, address: string): Promise<void> {
		this.require('mixer')
		await this.serial(async () => {
			this.require('mixer')
			this.index('DST', n)
			await this.send(formatCommand('DST', [n], { ADDR: address }), { verb: 'DST', index: n })
			const actual = this.state.dst.get(n)?.ADDR ?? ''
			if (normaliseAddr(actual) !== normaliseAddr(address)) {
				throw new Error(`DST ${n}: the node did not apply ADDR ${quote(address)} (reads ${quote(actual)})`)
			}
		})
	}

	async dstGainSet(n: number, tenths: number): Promise<void> {
		this.require('mixer')
		XNodeOperations.integer(tenths, 'Gain')
		await this.serial(async () => this.writeDstGain(n, tenths))
	}

	async dstGainAdjust(n: number, deltaTenths: number): Promise<void> {
		this.require('mixer')
		XNodeOperations.integer(deltaTenths, 'Gain step')
		this.index('DST', n)
		await this.coalesce(`dst:${n}`, deltaTenths, async (total) => {
			const current = attrInt(this.state.dst.get(n)?.OUGN)
			if (current === undefined) throw new Error(`The gain of DST ${n} is not known`)
			await this.writeDstGain(n, current + total)
		})
	}

	private async writeDstGain(n: number, tenths: number): Promise<void> {
		this.require('mixer')
		this.index('DST', n)
		const value = this.clampDeviceGain(tenths)
		if (attrInt(this.state.dst.get(n)?.OUGN) === value) return
		await this.send(formatCommand('DST', [n], { OUGN: value }), { verb: 'DST', index: n })
		this.verifyInt('DST', n, 'OUGN', this.state.dst.get(n)?.OUGN, value)
	}

	// ---------------------------------------------------------------- SRC

	async srcGainSet(n: number, tenths: number): Promise<void> {
		this.require('source')
		XNodeOperations.integer(tenths, 'Gain')
		await this.serial(async () => this.writeSrcGain(n, tenths))
	}

	async srcGainAdjust(n: number, deltaTenths: number): Promise<void> {
		this.require('source')
		XNodeOperations.integer(deltaTenths, 'Gain step')
		this.index('SRC', n)
		await this.coalesce(`src:${n}`, deltaTenths, async (total) => {
			const current = attrInt(this.state.src.get(n)?.INGN)
			if (current === undefined) throw new Error(`The gain of SRC ${n} is not known`)
			await this.writeSrcGain(n, current + total)
		})
	}

	private async writeSrcGain(n: number, tenths: number): Promise<void> {
		this.require('source')
		this.index('SRC', n)
		const value = this.clampDeviceGain(tenths)
		if (attrInt(this.state.src.get(n)?.INGN) === value) return
		await this.send(formatCommand('SRC', [n], { INGN: value }), { verb: 'SRC', index: n })
		this.verifyInt('SRC', n, 'INGN', this.state.src.get(n)?.INGN, value)
	}

	/** Enable, disable or toggle the stream (RTPE). */
	async srcEnable(n: number, mode: 'on' | 'off' | 'toggle'): Promise<void> {
		this.require('source')
		await this.serial(async () => {
			this.require('source')
			this.index('SRC', n)
			const current = this.state.src.get(n)?.RTPE
			if (mode === 'toggle' && current === undefined) throw new Error(`The stream state of SRC ${n} is not known`)
			const value = mode === 'toggle' ? (current === '1' ? 0 : 1) : mode === 'on' ? 1 : 0
			await this.send(formatCommand('SRC', [n], { RTPE: value }), { verb: 'SRC', index: n })
			this.verifyInt('SRC', n, 'RTPE', this.state.src.get(n)?.RTPE, value)
		})
	}

	/** Stream address from a Livewire channel number (`22301`, "from" range) or a multicast IPv4 address. Always sent as an IP. */
	async srcSetAddress(n: number, address: string | number, kind: ChannelKind = 'from'): Promise<void> {
		const text = String(address).trim()
		let ip: string
		if (/^\d+$/.test(text)) {
			const channel = Number(text)
			if (!isValidChannel(channel)) throw new Error(`Invalid Livewire channel ${text} (1-32767)`)
			ip = channelToMulticast(channel, kind)
		} else if (isIpv4(text) && isIpv4Multicast(text)) {
			ip = text
		} else {
			throw new Error(`"${text}" is neither a Livewire channel number nor an IPv4 multicast address`)
		}
		this.require('source')
		await this.serial(async () => {
			this.require('source')
			this.index('SRC', n)
			await this.send(formatCommand('SRC', [n], { RTPA: ip }), { verb: 'SRC', index: n })
			const actual = this.state.src.get(n)?.RTPA ?? ''
			if (normaliseAddr(actual) !== ip)
				throw new Error(`SRC ${n}: the node did not apply RTPA ${ip} (reads ${actual || '?'})`)
		})
	}

	/** Stream mode: 12 Live (low latency), 240 Standard, 48 AES67. */
	async srcSetMode(n: number, rtpp: number): Promise<void> {
		this.require('source')
		if (!Object.values<number>(SRC_MODES).includes(rtpp))
			throw new Error(`Unknown stream mode ${rtpp} (12 Live, 240 Standard, 48 AES67)`)
		await this.serial(async () => {
			this.require('source')
			this.index('SRC', n)
			await this.send(formatCommand('SRC', [n], { RTPP: rtpp }), { verb: 'SRC', index: n })
			this.verifyInt('SRC', n, 'RTPP', this.state.src.get(n)?.RTPP, rtpp)
		})
	}

	/** Rename a source: quotes and control characters are removed; 1-16 characters. */
	async srcRename(n: number, name: string): Promise<void> {
		this.require('source')
		const clean = String(name).replace(UNSAFE_CHARS, '').trim()
		if (clean === '') throw new Error('The source name is empty')
		if (clean.length > SRC_NAME_MAX)
			throw new Error(`The source name is too long (${clean.length} characters, maximum ${SRC_NAME_MAX})`)
		await this.serial(async () => {
			this.require('source')
			this.index('SRC', n)
			await this.send(formatCommand('SRC', [n], { PSNM: clean }), { verb: 'SRC', index: n })
			const actual = this.state.src.get(n)?.PSNM
			if (actual !== clean) throw new Error(`SRC ${n}: the node did not apply the name (reads ${quote(actual ?? '')})`)
		})
	}
}
