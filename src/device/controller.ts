import { EventEmitter } from 'node:events'
import { anyWriteEnabled, isValidHost, isValidPort, type ModuleConfig } from '../config.js'
import type { LwrpLine } from '../lwrp/parser.js'
import { XNodeState, type MeterKind, type StateChange } from '../model/state.js'
import {
	LwrpConnection,
	LwrpConnectionError,
	LwrpError,
	LwrpInvalidCommandError,
	LwrpTimeoutError,
} from './connection.js'
import { HttpMeterStream } from './meters-http.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFn = (level: LogLevel, message: string) => void

/** Maps onto Companion's InstanceStatus in main.ts */
export type ControllerStatus = 'connecting' | 'ok' | 'connection_failure' | 'bad_config' | 'warning'

export type WriteVerb = 'MIX' | 'SRC' | 'DST' | 'GPO' | 'INP'
export interface WriteTarget {
	verb: WriteVerb
	index: number
}

export type ControllerConfig = Pick<
	ModuleConfig,
	| 'host'
	| 'port'
	| 'password'
	| 'allowMixerWrites'
	| 'allowSourceWrites'
	| 'allowLeaveFactoryMode'
	| 'allowGpoWrites'
	| 'meterMode'
	| 'meterInterval'
	| 'levelAlerts'
>

export interface ControllerTimings {
	queryTimeoutMs: number
	heartbeatMs: number
	resyncMs: number
	levelsReadyMs: number
	lvlPaceMs: number
	/** Max time the queue is held after the LVL subscriptions waiting for their first answers */
	lvlHoldMs: number
	/** Time the queue is held after LOGIN (it is not answered; an ERROR in that window means a wrong password) */
	loginSettleMs: number
	/** Reconnect delays; the last one repeats */
	backoffMs: number[]
	connectTimeoutMs: number
	listQuietMs: number
	httpMeterPort: number
}

export const DEFAULT_TIMINGS: ControllerTimings = {
	queryTimeoutMs: 3000,
	heartbeatMs: 15_000,
	resyncMs: 60_000,
	levelsReadyMs: 3000,
	lvlPaceMs: 20,
	lvlHoldMs: 1500,
	loginSettleMs: 100,
	backoffMs: [1000, 2000, 5000, 10_000, 30_000],
	connectTimeoutMs: 5000,
	listQuietMs: 250,
	httpMeterPort: 80,
}

export interface ControllerEvents {
	change: [change: StateChange]
	status: [status: ControllerStatus, message: string | undefined]
	/** After each full sync (initial, periodic, after reconnect) */
	synced: [complete: boolean]
}

interface Session {
	id: number
	conn: LwrpConnection
	synced: boolean
}

interface LevelChannel {
	group: MeterKind
	n: number
}

const SYNC_MAX_REQUERIES = 2
/** Consecutive unanswered sync queries after which the link is considered dead */
const SYNC_MAX_TIMEOUTS = 2
/** Unanswered queries in one sync (even if not consecutive) after which the link is considered dead */
const SYNC_MAX_TOTAL_TIMEOUTS = 5
/** Consecutive unanswered heartbeats before the session is dropped */
const HEARTBEAT_MAX_MISSES = 2

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

function verSignature(v: Record<string, string>): string {
	return ['DEVN', 'LWRP', 'NSRC', 'NDST', 'MIX', 'NGPI', 'NGPO', 'INP'].map((k) => v[k] ?? '').join('|')
}

export class XNodeController extends EventEmitter<ControllerEvents> {
	readonly state = new XNodeState()

	private readonly timings: ControllerTimings
	private session: Session | null = null
	private sessionSeq = 0
	private started = false
	private destroyed = false
	private currentStatus: ControllerStatus = 'connecting'
	private attempt = 0
	private syncing = false
	private partial = false
	private syncTimeouts = 0
	private syncTotalTimeouts = 0
	private heartbeatMisses = 0
	private levelsReadyFlag = false
	private levelChannels: LevelChannel[] = []
	private reconnectTimer: NodeJS.Timeout | undefined
	private heartbeatTimer: NodeJS.Timeout | undefined
	private resyncTimer: NodeJS.Timeout | undefined
	private levelsTimer: NodeJS.Timeout | undefined
	private meterTimer: NodeJS.Timeout | undefined
	private httpMeters: HttpMeterStream | undefined

	constructor(
		private readonly config: ControllerConfig,
		private readonly log: LogFn = () => undefined,
		timings: Partial<ControllerTimings> = {},
	) {
		super()
		this.timings = { ...DEFAULT_TIMINGS, ...timings }
	}

	get status(): ControllerStatus {
		return this.currentStatus
	}

	/** Socket open (the initial sync may still be running) */
	get isConnected(): boolean {
		return this.session?.conn.isOpen === true
	}

	/** Connected and at least one sync finished */
	get isSynced(): boolean {
		return this.session?.synced === true && this.isConnected
	}

	/** True ~3 s after the LVL subscriptions: the first states are provisional */
	get levelsReady(): boolean {
		return this.levelsReadyFlag
	}

	/** Password without anything that cannot be sent on one line (the config value may be missing) */
	private get password(): string {
		const p: unknown = this.config.password
		return typeof p === 'string' ? p.replace(/[^\x20-\x7e\xa0-\xff]/g, '') : ''
	}

	/** Start connecting. Sets status BadConfig (and does not connect) when host or port are invalid. */
	start(): void {
		if (this.started || this.destroyed) return
		this.started = true
		if (!isValidHost(this.config.host) || !isValidPort(this.config.port)) {
			this.setStatus('bad_config', 'Host or port is missing or invalid')
			return
		}
		void this.connect()
	}

	/** Clears all timers and sockets. The controller cannot be restarted. */
	destroy(): void {
		if (this.destroyed) return
		this.destroyed = true
		// Listeners first: teardown emits (levels no longer ready) and nothing may reach the owner afterwards
		this.removeAllListeners()
		this.teardownSession()
		clearTimeout(this.reconnectTimer)
	}

	/**
	 * Send a write through the serialised queue, wait for its echo/ERROR, then always re-query the object
	 * (legacy nodes and GPO do not echo). Rejects with LwrpError on a device error. Returns the re-queried line.
	 */
	async writeAndVerify(cmd: string, target: WriteTarget): Promise<LwrpLine | null> {
		const session = this.session
		if (!session || !session.conn.isOpen) throw new LwrpConnectionError('Not connected')
		const conn = session.conn
		this.log('debug', `write: ${cmd}`)
		let failure: Error | undefined
		try {
			await conn.write(cmd, {
				verb: target.verb,
				index: target.index,
				echoTimeoutMs: target.verb === 'GPO' ? 200 : 500,
			})
		} catch (e) {
			failure = e instanceof Error ? e : new Error(String(e))
			if (e instanceof LwrpError) this.log('warn', `write rejected by device: ${cmd} -> ${errMsg(e)}`)
		}
		let verified: LwrpLine | null = null
		if (conn.isOpen) {
			try {
				verified =
					(await conn.query(`${target.verb} ${target.index}`, { timeoutMs: this.timings.queryTimeoutMs }))[0] ?? null
			} catch (e) {
				failure ??= e instanceof Error ? e : new Error(String(e))
			}
		}
		if (failure !== undefined) throw failure
		return verified
	}

	// ---------------------------------------------------------------- connection lifecycle

	private async connect(): Promise<void> {
		if (this.destroyed) return
		const id = ++this.sessionSeq
		// Only the very first attempt shows 'connecting'; during an outage the status stays 'connection_failure'
		if (this.attempt === 0) this.setStatus('connecting', `Connecting to ${this.config.host}:${this.config.port}`)
		const conn = new LwrpConnection({
			host: this.config.host.trim(),
			port: this.config.port,
			connectTimeoutMs: this.timings.connectTimeoutMs,
			onLine: (line) => this.onLine(id, line),
			onClose: (err) => this.onSocketClosed(id, err),
			onWarn: (message) => this.log('warn', message),
		})
		const session: Session = { id, conn, synced: false }
		this.session = session
		try {
			await conn.connect()
		} catch (e) {
			if (this.session === session) this.dropSession(session, `connection failed: ${errMsg(e)}`)
			return
		}
		if (this.session !== session || this.destroyed) return
		this.log('info', `connected to ${this.config.host}:${this.config.port}`)
		try {
			if (anyWriteEnabled(this.config)) {
				const { errors } = await conn.burst([`LOGIN ${this.password}`], {
					holdMs: this.timings.loginSettleMs,
				})
				if (this.session !== session) return
				if (errors.length > 0)
					this.log('warn', `login failed (${errors[0].message}); writes will be refused by the node`)
			}
			this.heartbeatMisses = 0
			this.heartbeatTimer = setInterval(() => void this.heartbeat(session), this.timings.heartbeatMs)
			const complete = await this.sync(session, true)
			if (this.session !== session) return
			this.attempt = 0
			session.synced = true
			this.setSyncStatus(complete)
			this.resyncTimer = setInterval(() => void this.resync(session), this.timings.resyncMs)
			this.emit('synced', complete)
			await this.subscribeLevels(session)
			this.startMeters(session)
		} catch (e) {
			if (this.session === session) this.dropSession(session, `sync failed: ${errMsg(e)}`)
		}
	}

	private onSocketClosed(id: number, err?: Error): void {
		const session = this.session
		if (!session || session.id !== id) return
		this.dropSession(session, err ? `connection lost: ${err.message}` : 'connection closed by the node')
	}

	private teardownSession(): void {
		const session = this.session
		this.session = null
		clearInterval(this.heartbeatTimer)
		clearInterval(this.resyncTimer)
		clearInterval(this.meterTimer)
		clearTimeout(this.levelsTimer)
		this.heartbeatTimer = this.resyncTimer = this.meterTimer = this.levelsTimer = undefined
		this.httpMeters?.stop()
		this.httpMeters = undefined
		session?.conn.close()
		this.syncing = false
		this.setLevelsReady(false)
	}

	private dropSession(session: Session, reason: string): void {
		if (this.session !== session || this.destroyed) return
		this.teardownSession()
		const delay = this.timings.backoffMs[Math.min(this.attempt, this.timings.backoffMs.length - 1)]
		this.log('warn', `${reason}; reconnecting`)
		this.setStatus('connection_failure', `${reason}; retrying in ${Math.max(1, Math.round(delay / 1000))} s`)
		this.attempt++
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = setTimeout(() => void this.connect(), delay)
	}

	private async heartbeat(session: Session): Promise<void> {
		if (this.session !== session) return
		try {
			await session.conn.query('VER', { timeoutMs: this.timings.queryTimeoutMs })
			this.heartbeatMisses = 0
		} catch (e) {
			if (e instanceof LwrpError) {
				this.heartbeatMisses = 0
				return // answered, so alive
			}
			if (e instanceof LwrpTimeoutError && ++this.heartbeatMisses < HEARTBEAT_MAX_MISSES) {
				this.log('debug', 'heartbeat missed once')
				return
			}
			this.dropSession(session, `heartbeat failed: ${errMsg(e)}`)
		}
	}

	private async resync(session: Session): Promise<void> {
		if (this.session !== session || this.syncing) return
		try {
			const complete = await this.sync(session, false)
			if (this.session !== session) return
			this.setSyncStatus(complete)
			this.emit('synced', complete)
		} catch (e) {
			if (this.session === session) this.dropSession(session, `resync failed: ${errMsg(e)}`)
		}
	}

	private setSyncStatus(complete: boolean): void {
		this.partial = !complete
		if (complete) this.setStatus('ok', undefined)
		else this.setStatus('warning', 'Partial sync: some items could not be read')
	}

	private setStatus(status: ControllerStatus, message: string | undefined): void {
		if (this.currentStatus === status && message === undefined) return
		this.currentStatus = status
		this.emit('status', status, message)
	}

	// ---------------------------------------------------------------- lines

	private onLine(id: number, line: LwrpLine): void {
		const session = this.session
		if (!session || session.id !== id) return
		if (line.verb === 'VER') {
			const old = this.state.ver
			if (
				Object.keys(old).length > 0 &&
				Object.keys(line.attrs).length > 0 &&
				verSignature(old) !== verSignature(line.attrs)
			) {
				this.log('info', 'VER changed (device model or counts); rebuilding the model')
				this.state.reset()
				if (session.synced) {
					queueMicrotask(() => this.dropSession(session, 'device identity changed'))
				}
			}
		}
		const change = this.state.applyLine(line)
		if (change) this.emit('change', change)
	}

	// ---------------------------------------------------------------- sync (design 5.2)

	/** Run one query; optional queries tolerate device errors and timeouts. Connection errors always propagate. */
	private async tryQuery(
		conn: LwrpConnection,
		cmd: string,
		opts: Parameters<LwrpConnection['query']>[1] = {},
		maxTimeouts = SYNC_MAX_TIMEOUTS,
		optional = false,
	): Promise<LwrpLine[] | null> {
		try {
			const lines = await conn.query(cmd, { timeoutMs: this.timings.queryTimeoutMs, ...opts })
			this.syncTimeouts = 0
			return lines
		} catch (e) {
			if (e instanceof LwrpError || e instanceof LwrpTimeoutError || e instanceof LwrpInvalidCommandError) {
				this.log('debug', `query "${cmd}" failed: ${errMsg(e)}`)
				if (e instanceof LwrpTimeoutError && optional) {
					// Some nodes never answer these; only mandatory queries count towards the dead-link limits
					// (the next mandatory query or the heartbeat catches a really dead link)
					this.log('debug', `optional query "${cmd}" timed out; ignored`)
				} else if (e instanceof LwrpTimeoutError) {
					this.syncTotalTimeouts++
					if (++this.syncTimeouts >= maxTimeouts || this.syncTotalTimeouts >= SYNC_MAX_TOTAL_TIMEOUTS)
						throw new LwrpConnectionError(`no answer to ${this.syncTimeouts} consecutive queries`)
				} else this.syncTimeouts = 0
				return null
			}
			throw e
		}
	}

	/** Returns true when the model is complete. Throws only for connection-level failures or a failed VER. */
	private async sync(session: Session, initial: boolean): Promise<boolean> {
		const conn = session.conn
		this.syncing = true
		this.syncTimeouts = 0
		this.syncTotalTimeouts = 0
		try {
			const ver = await conn.query('VER', { timeoutMs: this.timings.queryTimeoutMs })
			if (this.session !== session) return false
			if (ver.length === 0) throw new LwrpConnectionError('Empty VER answer')
			const st = this.state
			let complete = true
			const quiet = this.timings.listQuietMs

			await this.tryQuery(conn, 'IP', { expectCount: 2, quietMs: quiet }, SYNC_MAX_TIMEOUTS, true)
			await this.tryQuery(conn, 'SET', {}, SYNC_MAX_TIMEOUTS, true)

			const seen = new Map<string, Set<string>>()
			const collect = async (
				verb: string,
				cmd: string,
				opts: Parameters<LwrpConnection['query']>[1] = {},
			): Promise<void> => {
				const lines = await this.tryQuery(conn, cmd, opts)
				const set = seen.get(verb) ?? new Set<string>()
				seen.set(verb, set)
				for (const l of lines ?? []) if (l.args[0]) set.add(l.args[0])
			}

			if (st.nsrc > 0) await collect('SRC', 'SRC')
			if (st.ndst > 0) await collect('DST', 'DST')
			if (st.hasMixer) {
				await this.tryQuery(conn, 'MIXCFG')
				await collect('MIX', 'MIX', { expectCount: st.nmix, quietMs: quiet })
			}
			if (st.isXNode2 && st.ninp > 0) await collect('INP', 'INP')
			if (st.ngpo > 0) {
				await this.tryQuery(conn, 'CFG GPO', {}, SYNC_MAX_TIMEOUTS, true)
				await this.tryQuery(conn, initial ? 'ADD GPO' : 'GPO')
			}
			if (st.ngpi > 0) await this.tryQuery(conn, initial ? 'ADD GPI' : 'GPI')

			const expected: Array<[string, number]> = [
				['SRC', st.nsrc],
				['DST', st.ndst],
				['MIX', st.hasMixer ? st.nmix : 0],
				['INP', st.isXNode2 ? st.ninp : 0],
			]
			for (const [verb, count] of expected) {
				const have = seen.get(verb) ?? new Set<string>()
				for (let n = 1; n <= count; n++) {
					if (have.has(String(n))) continue
					let ok = false
					for (let attempt = 0; attempt < SYNC_MAX_REQUERIES && !ok; attempt++) {
						this.log('debug', `sync: missing ${verb} ${n}, re-querying`)
						ok = ((await this.tryQuery(conn, `${verb} ${n}`, {}, SYNC_MAX_TIMEOUTS + 1)) ?? []).length > 0
					}
					if (!ok) {
						complete = false
						this.log('warn', `sync: ${verb} ${n} could not be read`)
					}
				}
			}
			return complete
		} finally {
			this.syncing = false
		}
	}

	// ---------------------------------------------------------------- levels

	private computeLevelChannels(): LevelChannel[] {
		const st = this.state
		const out: LevelChannel[] = []
		for (let n = 1; n <= st.nsrc; n++) out.push({ group: 'ICH', n })
		for (let n = 1; n <= st.ndst; n++) out.push({ group: 'OCH', n })
		if (st.isXNode2) {
			const owners = (channels: Array<{ kind: string; owner: number }>): number[] => [
				...new Set(channels.filter((c) => c.kind === 'phys').map((c) => c.owner)),
			]
			let hwi = owners(st.ioMap.inputs)
			if (hwi.length === 0 && st.ninp > 0) hwi = Array.from({ length: st.ninp }, (_, i) => i + 1)
			for (const n of hwi) out.push({ group: 'HWI', n })
			for (const n of owners(st.ioMap.outputs)) out.push({ group: 'HWO', n })
		}
		return out
	}

	private async subscribeLevels(session: Session): Promise<void> {
		// undefined means on (the config default)
		if (this.config.levelAlerts === false) return
		this.levelChannels = this.computeLevelChannels()
		if (this.levelChannels.length === 0) return
		// One queued item: paced (xNode2 occasionally drops lines of bursts), holds the queue until the first
		// answers arrived so that an ERROR is never attributed to a write. Never sends threshold parameters.
		const { errors } = await session.conn.burst(
			this.levelChannels.map((ch) => `LVL ${ch.group} ${ch.n}`),
			{
				paceMs: this.timings.lvlPaceMs,
				holdMs: this.timings.lvlHoldMs,
				answerKey: (l) => (l.verb === 'LVL' ? `${l.args[0]} ${(l.args[1] ?? '').split('.')[0]}` : undefined),
				expectKeys: this.levelChannels.length,
			},
		)
		if (this.session !== session) return
		for (const e of errors) this.log('warn', `level subscription: ${e.message}`)
		this.levelsTimer = setTimeout(() => this.setLevelsReady(true), this.timings.levelsReadyMs)
	}

	private setLevelsReady(ready: boolean): void {
		if (this.levelsReadyFlag === ready) return
		this.levelsReadyFlag = ready
		for (const ch of this.levelChannels)
			this.emit('change', { kind: 'lvl', index: ch.n, group: ch.group, rebuild: false })
	}

	// ---------------------------------------------------------------- meters

	private startMeters(session: Session): void {
		const mode = this.config.meterMode
		const interval = Math.max(
			100,
			typeof this.config.meterInterval === 'number' ? this.config.meterInterval || 500 : 500,
		)
		if (mode === 'poll') {
			this.meterTimer = setInterval(() => {
				// low priority: never queue behind other work
				if (this.session !== session || session.conn.pending > 0) return
				void session.conn.query('MTR', { timeoutMs: 1500 }).catch(() => undefined)
			}, interval)
		} else if (mode === 'http') {
			this.httpMeters = new HttpMeterStream({
				host: this.config.host.trim(),
				port: this.timings.httpMeterPort,
				password: this.password,
				intervalMs: interval,
				onLine: (line) => {
					const change = this.state.applyLine(line)
					if (change) this.emit('change', change)
				},
				log: this.log,
			})
			this.httpMeters.start()
		}
	}

	/** True while a sync is running or the last sync was partial (for diagnostics) */
	get syncState(): { syncing: boolean; partial: boolean } {
		return { syncing: this.syncing, partial: this.partial }
	}
}
