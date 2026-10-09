import net from 'node:net'
import { parseLine, type LwrpLine } from '../lwrp/parser.js'

/*
 * Observed answer shapes (lab devices, see _research/scratch/agent-b/answer-shapes.md)
 *
 *  Command        legacy xNode (LWRP 1.2)                  xNode2 (LWRP 1.4.x)
 *  VER            one line                                 one line
 *  IP             `IP ADDR:.. LINK:1` + `IP hostname X`    same (two lines)
 *  SET            one long line                            bare `SET` (no attributes)
 *  SRC / DST      BEGIN, n lines, END                      same (lines may be lost, END still comes)
 *  SRC n / DST n  one line                                 one line, ERROR 1002 when n is out of range
 *  MIX            24 lines `MIX n ..`, NOT wrapped         BEGIN, rows in string order, END
 *  MIX n          one line (`MIX 15 ` when empty)          one line, followed by an empty line
 *  MIXCFG         one line                                 one line
 *  INP            (never sent to legacy)                   BEGIN, n lines, END; `INP n` one line
 *  ADD GPI/GPO    ERROR 1000 (no GPIO)                     BEGIN, lines, END, then pushes
 *  CFG GPO        ERROR 1000                               BEGIN, lines, END
 *  GPO n          ERROR 1000                               one line; invalid port -> ERROR 1006
 *  MTR            BEGIN, ICH+OCH lines, END                BEGIN, HWI+HWO+ICH+OCH lines, END
 *  LVL x n        no immediate answer, lines after ~300 ms (queued as a `burst`)
 *  LOGIN          no answer at all (queued as a `burst`, an ERROR means a wrong password)
 *
 * Completion rules used by `query`:
 *  - a list command (bare `SRC`, `DST`, `MIX`, `INP`, `GPI`, `GPO`, `MTR`, `CFG GPO`, `ADD GPI|GPO`) completes on
 *    the END that follows its own BEGIN. Matching lines before the BEGIN are pushes (only emitted to `onLine`).
 *    Unwrapped lists (legacy MIX, IP) must pass `expectCount` (distinct indices) or `quietMs`.
 *  - any other command: the first matching line completes it; BEGIN/END are ignored
 *  - ERROR while a command is in flight rejects it (errors cannot be attributed, hence one in flight)
 * Answers are matched by verb (+ index), never by position, so pushes can interleave freely.
 */

export class LwrpError extends Error {
	constructor(
		readonly code: number,
		readonly text: string,
		readonly command?: string,
	) {
		super(`LWRP error ${code}${text ? ` ${text}` : ''}${command ? ` (command: ${command})` : ''}`)
		this.name = 'LwrpError'
	}
}

export class LwrpTimeoutError extends Error {
	constructor(
		readonly command: string,
		readonly timeoutMs: number,
	) {
		super(`Timeout after ${timeoutMs} ms waiting for the answer to "${command}"`)
		this.name = 'LwrpTimeoutError'
	}
}

/** The command contains characters that cannot be sent safely (never written to the socket) */
export class LwrpInvalidCommandError extends Error {
	constructor(readonly command: string) {
		super('Refusing to send a command with characters outside printable Latin-1')
		this.name = 'LwrpInvalidCommandError'
	}
}

const SAFE_COMMAND = /^[\x20-\x7e\xa0-\xff]*$/

export class LwrpConnectionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'LwrpConnectionError'
	}
}

export interface QueryOptions {
	/** Answer verb, default: the command verb (`ADD GPI` -> GPI, `CFG GPO` -> CFG) */
	verb?: string
	/** Answer index (first positional after the verb); default: the numeric 2nd token of the command, if any */
	index?: string | number
	/** Unwrapped multi-line answer: complete when this many distinct indices matched */
	expectCount?: number
	/** After the first matching line keep collecting until this many ms pass without another matching line */
	quietMs?: number
	/** Default 3000 */
	timeoutMs?: number
}

export interface WriteOptions {
	verb?: string
	index?: string | number
	/** How long to wait for an echo line before assuming "no echo" (default 500) */
	echoTimeoutMs?: number
}

export interface LwrpConnectionOptions {
	host: string
	port: number
	connectTimeoutMs?: number
	/** Every parsed line, before any query completion logic runs */
	onLine: (line: LwrpLine) => void
	/** Called once when the socket closes or errors after `connect()` succeeded */
	onClose: (error?: Error) => void
	/** Diagnostics (e.g. line buffer overflow) */
	onWarn?: (message: string) => void
}

/** A line without terminator longer than this is garbage: it is dropped (up to the next newline) */
export const MAX_LINE_BUFFER = 64 * 1024

export interface BurstOptions {
	/** Delay between two commands (xNode2 occasionally drops lines of a tight burst) */
	paceMs?: number
	/** Release the queue after this long at the latest (also the plain settle time when no answer is expected) */
	holdMs: number
	/** Release early once `expectKeys` distinct keys were returned by `answerKey` (ERRORs count as answers) */
	answerKey?: (line: LwrpLine) => string | undefined
	expectKeys?: number
}

export interface BurstResult {
	/** ERRORs received while the burst held the queue (they cannot be attributed more precisely) */
	errors: LwrpError[]
	/** Distinct answer keys seen */
	answered: number
}

const LIST_VERBS = new Set(['SRC', 'DST', 'MIX', 'INP', 'GPI', 'GPO', 'MTR'])

interface Matcher {
	/** Bare list command: the answer is wrapped in BEGIN/END (unless unwrapped via expectCount/quietMs) */
	list: boolean
	verb: string
	/** Extra leading positional args (`CFG GPO`) */
	prefix: string[]
	index?: string
}

function buildMatcher(cmd: string, opts: { verb?: string; index?: string | number }): Matcher {
	const tokens = cmd.trim().split(/\s+/)
	let verb = tokens[0].toUpperCase()
	const prefix: string[] = []
	let rest = tokens.slice(1)
	if (verb === 'ADD' && rest.length > 0) {
		verb = rest[0].toUpperCase()
		rest = rest.slice(1)
	} else if (verb === 'CFG' && rest.length > 0) {
		prefix.push(rest[0].toUpperCase())
		rest = rest.slice(1)
	}
	const first = rest[0]
	const index = opts.index !== undefined ? String(opts.index) : first && /^\d+$/.test(first) ? first : undefined
	const list = rest.length === 0 && (LIST_VERBS.has(verb) || prefix[0] === 'GPO')
	return { list, verb: (opts.verb ?? verb).toUpperCase(), prefix, index }
}

function matches(m: Matcher, line: LwrpLine, withIndex = true): boolean {
	if (line.verb.toUpperCase() !== m.verb) return false
	for (let i = 0; i < m.prefix.length; i++) if ((line.args[i] ?? '').toUpperCase() !== m.prefix[i]) return false
	return !withIndex || m.index === undefined || line.args[m.prefix.length] === m.index
}

interface InFlight {
	/** Returns true when the request is complete */
	onLine: (line: LwrpLine) => boolean
	fail: (error: Error) => void
}

export class LwrpConnection {
	private socket: net.Socket | null = null
	private buffer = ''
	private discarding = false
	private open = false
	private inFlight: InFlight | null = null
	private chain: Promise<unknown> = Promise.resolve()
	private queued = 0

	constructor(private readonly options: LwrpConnectionOptions) {}

	get isOpen(): boolean {
		return this.open
	}

	/** Number of queued plus in-flight requests */
	get pending(): number {
		return this.queued
	}

	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ host: this.options.host, port: this.options.port })
			this.socket = socket
			socket.setNoDelay(true)
			socket.setKeepAlive(true, 10_000)
			let settled = false
			const timer = setTimeout(() => {
				fail(new LwrpConnectionError(`Connection to ${this.options.host}:${this.options.port} timed out`))
			}, this.options.connectTimeoutMs ?? 5000)
			const fail = (err: Error): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				socket.destroy()
				this.socket = null
				reject(err)
			}
			socket.once('connect', () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				this.open = true
				resolve()
			})
			socket.on('data', (chunk) => {
				if (this.socket === socket) this.onData(chunk.toString('latin1'))
			})
			socket.on('error', (err) => {
				if (!settled) fail(err)
				else this.handleClose(socket, err)
			})
			socket.on('close', () => {
				if (!settled) fail(new LwrpConnectionError('Connection closed'))
				else this.handleClose(socket)
			})
		})
	}

	/** Close the socket; pending requests are rejected. Does not call `onClose`. */
	close(): void {
		const socket = this.socket
		this.socket = null
		this.open = false
		this.buffer = ''
		this.discarding = false
		socket?.removeAllListeners('data')
		socket?.on('error', () => undefined)
		socket?.destroy()
		this.failAll(new LwrpConnectionError('Connection closed'))
	}

	/** Write a raw line outside the queue. Prefer `burst` for anything that may be answered. Throws if not open. */
	send(cmd: string): void {
		if (!this.open || !this.socket) throw new LwrpConnectionError('Not connected')
		// Latin-1 encoding truncates code points > 0xFF to their low byte (U+010D -> CR): never let them through
		if (!SAFE_COMMAND.test(cmd)) throw new LwrpInvalidCommandError(cmd)
		this.socket.write(`${cmd}\r\n`, 'latin1')
	}

	/** Send a command and collect its answer (see the header comment for the completion rules). */
	async query(cmd: string, opts: QueryOptions = {}): Promise<LwrpLine[]> {
		const timeoutMs = opts.timeoutMs ?? 3000
		const matcher = buildMatcher(cmd, opts)
		return this.enqueue(
			cmd,
			async (inFlight) =>
				new Promise<LwrpLine[]>((resolve, reject) => {
					const lines: LwrpLine[] = []
					const seen = new Set<string>()
					let begun = false
					let quiet: NodeJS.Timeout | undefined
					const unwrapped = opts.expectCount !== undefined || opts.quietMs !== undefined
					const done = (err?: Error): void => {
						clearTimeout(timer)
						clearTimeout(quiet)
						if (err) reject(err)
						else resolve(lines)
					}
					const timer = setTimeout(() => done(new LwrpTimeoutError(cmd, timeoutMs)), timeoutMs)
					inFlight.fail = done
					inFlight.onLine = (line) => {
						if (line.verb === 'ERROR') {
							done(new LwrpError(Number.parseInt(line.args[0] ?? '', 10) || 0, line.args.slice(1).join(' '), cmd))
							return true
						}
						if (matcher.list && !begun && line.verb === 'BEGIN') {
							// the answer starts here: whatever matched before was a push
							begun = true
							lines.length = 0
							seen.clear()
							clearTimeout(quiet)
							return false
						}
						if (begun) {
							if (line.verb === 'END') {
								done()
								return true
							}
							if (matches(matcher, line, false)) lines.push(line)
							return false
						}
						if (!matches(matcher, line)) return false
						if (matcher.list && !unwrapped) return false // a push, the BEGIN is still to come
						lines.push(line)
						seen.add(line.args[matcher.prefix.length] ?? '')
						if (opts.expectCount !== undefined) {
							if (seen.size >= opts.expectCount) {
								done()
								return true
							}
						} else if (opts.quietMs === undefined) {
							done()
							return true
						}
						clearTimeout(quiet)
						quiet = setTimeout(() => done(), opts.quietMs ?? 200)
						return false
					}
					this.write0(cmd, done)
				}),
		)
	}

	/**
	 * Send a write and wait for its echo (a line with the same verb + index) or an ERROR.
	 * No echo is not an error: legacy nodes and GPO do not echo. Resolves with the echo or null.
	 */
	async write(cmd: string, opts: WriteOptions = {}): Promise<LwrpLine | null> {
		const echoMs = opts.echoTimeoutMs ?? 500
		const matcher = buildMatcher(cmd, opts)
		return this.enqueue(
			cmd,
			async (inFlight) =>
				new Promise<LwrpLine | null>((resolve, reject) => {
					const timer = setTimeout(() => resolve(null), echoMs)
					const done = (result: LwrpLine | Error | null): void => {
						clearTimeout(timer)
						if (result instanceof Error) reject(result)
						else resolve(result)
					}
					inFlight.fail = done
					inFlight.onLine = (line) => {
						if (line.verb === 'ERROR') {
							done(new LwrpError(Number.parseInt(line.args[0] ?? '', 10) || 0, line.args.slice(1).join(' '), cmd))
							return true
						}
						if (matches(matcher, line)) {
							done(line)
							return true
						}
						return false
					}
					this.write0(cmd, done)
				}),
		)
	}

	/**
	 * Queue a group of commands that are not answered per command (LOGIN, LVL subscriptions). Sends them,
	 * then holds the queue until the expected first answers arrived or `holdMs` elapsed, so an ERROR cannot be
	 * attributed to a later command. ERRORs received meanwhile are returned, not thrown.
	 */
	async burst(cmds: string[], opts: BurstOptions): Promise<BurstResult> {
		return this.enqueue(
			cmds[0] ?? '',
			async (inFlight) =>
				new Promise<BurstResult>((resolve, reject) => {
					const errors: LwrpError[] = []
					const keys = new Set<string>()
					const timers = new Set<NodeJS.Timeout>()
					let finished = false
					const finish = (err?: Error): void => {
						if (finished) return
						finished = true
						for (const t of timers) clearTimeout(t)
						if (err) reject(err)
						else resolve({ errors, answered: keys.size })
					}
					const check = (): void => {
						if (opts.expectKeys !== undefined && keys.size >= opts.expectKeys && sent) finish()
					}
					let sent = false
					inFlight.fail = finish
					inFlight.onLine = (line) => {
						if (line.verb === 'ERROR') {
							errors.push(new LwrpError(Number.parseInt(line.args[0] ?? '', 10) || 0, line.args.slice(1).join(' ')))
							keys.add(`ERROR#${errors.length}`)
						} else {
							const key = opts.answerKey?.(line)
							if (key !== undefined) keys.add(key)
						}
						check()
						return finished
					}
					const sendFrom = (i: number): void => {
						if (finished) return
						try {
							while (i < cmds.length) {
								this.send(cmds[i++])
								if (opts.paceMs && i < cmds.length) {
									const t = setTimeout(() => {
										timers.delete(t)
										sendFrom(i)
									}, opts.paceMs)
									timers.add(t)
									return
								}
							}
						} catch (e) {
							finish(e as Error)
							return
						}
						sent = true
						check()
					}
					timers.add(setTimeout(() => finish(), opts.holdMs + (opts.paceMs ?? 0) * cmds.length))
					sendFrom(0)
				}),
		)
	}

	private write0(cmd: string, fail: (e: Error) => void): void {
		try {
			this.send(cmd)
		} catch (e) {
			fail(e as Error)
		}
	}

	private async enqueue<T>(_cmd: string, run: (inFlight: InFlight) => Promise<T>): Promise<T> {
		if (!this.open) return Promise.reject(new LwrpConnectionError('Not connected'))
		this.queued++
		const task = this.chain.then(async () => {
			const inFlight: InFlight = {
				onLine: () => false,
				fail: () => undefined,
			}
			try {
				if (!this.open) throw new LwrpConnectionError('Not connected')
				this.inFlight = inFlight
				return await run(inFlight)
			} finally {
				if (this.inFlight === inFlight) this.inFlight = null
				this.queued--
			}
		})
		this.chain = task.catch(() => undefined)
		return task
	}

	private onData(chunk: string): void {
		this.buffer += chunk
		let nl: number
		while ((nl = this.buffer.indexOf('\n')) !== -1) {
			const raw = this.buffer.slice(0, nl)
			this.buffer = this.buffer.slice(nl + 1)
			if (this.discarding) {
				this.discarding = false // the tail of an oversized line
				continue
			}
			const line = parseLine(raw)
			if (!line) continue
			try {
				this.options.onLine(line)
			} catch {
				// a listener bug must never break framing
			}
			this.inFlight?.onLine(line)
		}
		if (this.buffer.length > MAX_LINE_BUFFER) {
			this.options.onWarn?.(`dropping ${this.buffer.length} bytes received without a line terminator`)
			this.buffer = ''
			this.discarding = true
		}
	}

	private handleClose(socket: net.Socket, error?: Error): void {
		if (this.socket !== socket) return
		this.socket = null
		this.open = false
		this.buffer = ''
		this.discarding = false
		socket.destroy()
		this.failAll(error ?? new LwrpConnectionError('Connection closed'))
		this.options.onClose(error)
	}

	private failAll(error: Error): void {
		const f = this.inFlight
		this.inFlight = null
		f?.fail(error)
	}
}
