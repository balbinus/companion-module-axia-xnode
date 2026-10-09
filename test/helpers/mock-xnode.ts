/**
 * In-process fake Axia xNode speaking LWRP over TCP (127.0.0.1, ephemeral port).
 *
 *   const mock = await MockXNode.start({ dialect: 'xnode2' })     // or 'legacy'
 *   ... connect a client to mock.host:mock.port ...
 *   await mock.stop()
 *
 * Dialects (behaviour observed on real units, see design section 3 and answer-shapes.md):
 *  - `legacy`  LWRP 1.2, analog4x4: `MIX` list NOT wrapped (numeric order, empty rows `MIX 9 `), SRC/DST wrapped,
 *              `SET` is one line, VER carries a bogus `INP:1`, no GPIO (`ERROR 1000 bad command`), writes without
 *              LOGIN give `ERROR 1000 bad command`, the writer only gets an echo when its connection queried the
 *              object before, nonsense values are accepted (gains clamped), `INP`/`HWI`/`HWO` are unknown.
 *  - `xnode2`  LWRP 1.4.2, combo: every list wrapped in BEGIN/END, MIX rows in string order, attributes
 *              alphabetical, bare `SET`, INP 1..5, 2 GPI/GPO ports with `CFG GPO`, `ADD GPI|GPO` subscriptions
 *              (changed pin uppercase), writer always gets an echo (GPO never), `ERROR 1000 not authorized access`,
 *              `ERROR 1001` on invalid values, `1002 bad port number` / `1006 invalid port`.
 *
 * State model: SRC/DST/INP/CFG GPO merge attributes, `MIX o` rows merge crosspoints (`i:-` clears), a MIX write
 * while MIXCFG MODE != 0 switches to MODE 0, GPO writes uppercase the changed pins towards subscribers.
 * Querying an object subscribes that connection to it; changes made by another connection (or `externalWrite`)
 * are pushed to subscribed connections. `LVL` answers come after `lvlDelayMs` (xNode2: provisional NO-LOW,
 * then LOW after `lowDelayMs`).
 *
 * Fault injection: `reorder`, `dropLines`, `mute` (dead link), `closeConnections`, `down`/`up`, `delay`,
 * `push`, `injectError`, `injectIntoNextList`. Everything received is in `commands` (+ `violations()` for
 * commands the module must never send).
 */
import net from 'node:net'
import { parseLine, type LwrpLine } from '../../src/lwrp/parser.js'

export type Dialect = 'legacy' | 'xnode2'
/** String: case-insensitive command/line prefix on a word boundary (`SRC 2` matches `SRC 2 PSNM..`, not `SRC 20`). */
export type Match = string | RegExp

export interface MockOptions {
	dialect?: Dialect
	/** Initial state in baseline-dump style (`VER ...`, `SRC n ...`, ...); default: neutral built-in fixture */
	dump?: string
	/** Delay before the first LVL answer (default 25 ms) */
	lvlDelayMs?: number
	/** xNode2: delay between the provisional NO-LOW and the LOW push (default 120 ms) */
	lowDelayMs?: number
	/** Delay added to every answer/push (default 0) */
	answerDelayMs?: number
	/** xNode2: answers of a pipelined burst (several commands in one packet) come back in reverse order */
	reorder?: boolean
	/** Line terminator written to clients (default CRLF) */
	eol?: '\r\n' | '\n'
	/** Writer also receives the uppercase GPO push (real unit: no echo; default false) */
	gpoEchoToWriter?: boolean
}

export interface RecordedCommand {
	conn: number
	line: string
	verb: string
	loggedIn: boolean
	/** Received while `mute` was on (ignored by the mock) */
	muted: boolean
	/** Date.now() when the line was received */
	at: number
}

type Attrs = Record<string, string>

interface Block {
	lines: string[]
	list: boolean
}

interface Rule {
	match: Match
	times: number
}
interface DelayRule extends Rule {
	ms: number
}
interface ErrorRule extends Rule {
	error: string
}
interface DropRule extends Rule {
	anyAnswer: boolean
}

class Conn {
	buf = ''
	loggedIn = false
	/** Subscribed object keys: `SRC 3`, `DST 3`, `MIX 9`, `MIXCFG`, `INP 5` */
	subs = new Set<string>()
	gpio = new Set<'GPI' | 'GPO'>()
	lvl = new Set<string>()
	closed = false
	constructor(
		readonly id: number,
		readonly socket: net.Socket,
	) {}
}

const RE_INT = /^-?\d+$/
const OFF = -1000
const BARE_KEYS = new Set(['TYPE', 'VMOD'])

function matches(m: Match, line: string): boolean {
	if (m instanceof RegExp) return m.test(line)
	const a = line.trim().toUpperCase()
	const b = m.trim().toUpperCase()
	return a === b || a.startsWith(`${b} `)
}

function takeRule<T extends Rule>(rules: T[], line: string): T | undefined {
	const rule = rules.find((r) => r.times > 0 && matches(r.match, line))
	if (rule) {
		rule.times--
		if (rule.times <= 0) rules.splice(rules.indexOf(rule), 1)
	}
	return rule
}

export function channelToIp(channel: number): string {
	return `239.192.${channel >> 8}.${channel & 255}`
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** Neutral fixtures (documentation addresses, RFC 5737). Same shape as the real dumps. */
export function makeDump(dialect: Dialect, host = dialect === 'legacy' ? '192.0.2.23' : '192.0.2.25'): string {
	const out: string[] = []
	if (dialect === 'legacy') {
		out.push(
			'VER LWRP:1.2 DEVN:"axiaxnode.analog4x4" NSRC:8 NDST:8 NGPI:0 NGPO:0 PRODUCT:"Axia xNode" MODEL:"Analog 4x4 I/O" SVER:2.4.7-1 FPSTAT:1 INP:1 KEY:6 MIXCFG:1 MIX:24',
			`IP ADDR:"${host}" LINK:1`,
			'IP hostname Node-23-0',
			'SET LWS_802_1p_TAGE:1 LWS_802_1Q_PRIO:6 LWCLK_PRIO:4 ADIP:"239.192.255.3" NID:23/0 PTP_DOM:0 ENABLE_SAP:1',
		)
		for (let n = 1; n <= 8; n++)
			out.push(`SRC ${n} PSNM:"SRC ${n}" RTPE:1 RTPP:12 RTPA:239.192.87.${28 + n}${n === 8 ? ' INGN:0' : ''}`)
		for (let n = 1; n <= 8; n++) out.push(`DST ${n} NAME:"DST ${n}" ADDR:"239.193.87.${28 + n}" NCHN:2 VMOD:* OUGN:0`)
		out.push('MIXCFG MODE:0')
		for (let o = 1; o <= 24; o++) {
			if (o <= 8) out.push(`MIX ${o} ${16 + o}:0`)
			else if (o >= 17) out.push(`MIX ${o} ${o - 16}:0`)
			else out.push(o === 12 ? `MIX ${o} 10:-100` : `MIX ${o} `)
		}
	} else {
		out.push(
			'VER DEVN:"axiaxnode2.combo" INP:5 LWRP:1.4.2 MIX:24 MIXCFG:1 MODEL:"Mixed Signal I/O" NDST:8 NGPI:2 NGPO:2 NSRC:8 PRODUCT:"Axia xNode2" SVER:1.3.1',
			`IP ADDR:${host} LINK:1`,
			'IP hostname xnode2-000001',
			'SET',
		)
		for (let n = 1; n <= 8; n++)
			out.push(
				`SRC ${n} IFA:"${host}" INGN:0 LABL:"" NCHN:2 PSNM:"Sender${n}" RTPA:"239.192.1.${n - 1}" RTPE:0 RTPP:48`,
			)
		for (let n = 1; n <= 8; n++)
			out.push(`DST ${n} ADDR:"239.192.2.${n - 1}" IFA:"${host}" NAME:"Receiver${n}" NCHN:2 OUGN:0`)
		out.push('MIXCFG MODE:5')
		for (let o = 1; o <= 24; o++) {
			if (o <= 8) out.push(`MIX ${o} ${16 + o}:0`)
			else if (o >= 17) out.push(`MIX ${o} ${o - 16}:0`)
			else out.push(`MIX ${o}`)
		}
		out.push(
			'INP 1 NAME:"Analog 1" TYPE:ANALAOG',
			'INP 2 NAME:"Analog 2" TYPE:ANALAOG',
			'INP 3 NAME:"Analog 3" TYPE:ANALAOG',
			'INP 4 NAME:"AES 4" SRCE:1 TYPE:AES',
			'INP 5 GAIN:0 NAME:"Microphone 5" PHPW:0 TYPE:MIC',
			'GPI 1 hhhhh',
			'GPI 2 hhhhh',
			'GPO 1 hhhhh',
			'GPO 2 hhhhh',
			'CFG GPO 1 NAME:"GPIO_1" SRCA:""',
			'CFG GPO 2 NAME:"GPIO_2" SRCA:""',
		)
	}
	return out.join('\n')
}

export class MockXNode {
	readonly host = '127.0.0.1'
	port = 0
	readonly dialect: Dialect

	/** Every command line received, in order (also while muted) */
	readonly commands: RecordedCommand[] = []

	// ---- device state
	ver: Attrs = {}
	ip: { addr: string; link: string; hostname: string } = { addr: '', link: '1', hostname: '' }
	setAttrs: Attrs = {}
	src = new Map<number, Attrs>()
	dst = new Map<number, Attrs>()
	inp = new Map<number, Attrs>()
	cfgGpo = new Map<number, Attrs>()
	mix = new Map<number, Map<number, number>>()
	mixcfgMode = 0
	gpi = new Map<number, string>()
	gpo = new Map<number, string>()
	/** `ICH 1` -> peak tenths [L, R] (one value for mono) */
	meters = new Map<string, number[]>()
	/** `ICH 1.L` -> level alert state */
	levels = new Map<string, { low: boolean; clip: boolean }>()

	// ---- knobs (plain fields: change them at any time)
	reorder: boolean
	/** Dead link: socket stays open, nothing is processed or sent */
	mute = false
	answerDelayMs: number
	lvlDelayMs: number
	lowDelayMs: number
	gpoEchoToWriter: boolean
	/** Never echo a write back to its writer (what legacy nodes do for objects the writer did not query) */
	noEcho = false

	private readonly eol: string
	private server: net.Server
	private conns: Conn[] = []
	private connSeq = 0
	private timers = new Set<NodeJS.Timeout>()
	private delayRules: DelayRule[] = []
	private errorRules: ErrorRule[] = []
	private dropRules: DropRule[] = []
	private nextListInjection: string[] | null = null
	private listening = false

	private constructor(options: MockOptions) {
		this.dialect = options.dialect ?? 'xnode2'
		this.reorder = options.reorder ?? false
		this.answerDelayMs = options.answerDelayMs ?? 0
		this.lvlDelayMs = options.lvlDelayMs ?? 25
		this.lowDelayMs = options.lowDelayMs ?? 120
		this.gpoEchoToWriter = options.gpoEchoToWriter ?? false
		this.eol = options.eol ?? '\r\n'
		this.loadDump(options.dump ?? makeDump(this.dialect))
		this.server = this.createServer()
	}

	static async start(options: MockOptions = {}): Promise<MockXNode> {
		const mock = new MockXNode(options)
		await mock.listen(0)
		return mock
	}

	// ------------------------------------------------------------------ lifecycle

	private createServer(): net.Server {
		const server = net.createServer((socket) => this.onConnection(socket))
		server.on('error', () => undefined)
		return server
	}

	private async listen(port: number): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once('error', reject)
			this.server.listen(port, this.host, () => {
				this.server.off('error', reject)
				resolve()
			})
		})
		this.port = (this.server.address() as net.AddressInfo).port
		this.listening = true
	}

	/** Close all connections and stop listening (new connections are refused until `up()`) */
	async down(): Promise<void> {
		this.closeConnections()
		if (!this.listening) return
		this.listening = false
		await new Promise<void>((resolve) => this.server.close(() => resolve()))
	}

	/** Listen again on the same port after `down()` */
	async up(): Promise<void> {
		if (this.listening) return
		this.server = this.createServer()
		await this.listen(this.port)
	}

	/** Close everything, clear timers. Safe to call twice. */
	async stop(): Promise<void> {
		for (const t of this.timers) clearTimeout(t)
		this.timers.clear()
		await this.down()
	}

	/** Open server-side sockets (use `waitFor(() => mock.connectionCount === n)`) */
	get connectionCount(): number {
		return this.conns.filter((c) => !c.closed).length
	}

	/** Close the nth open connection (default: all) from the server side */
	closeConnections(which?: number): void {
		const open = this.conns.filter((c) => !c.closed)
		for (const c of which === undefined ? open : open.slice(which, which + 1)) c.socket.destroy()
	}

	private onConnection(socket: net.Socket): void {
		const conn = new Conn(++this.connSeq, socket)
		this.conns.push(conn)
		socket.setNoDelay(true)
		socket.on('data', (chunk) => this.onData(conn, chunk.toString('latin1')))
		socket.on('error', () => undefined)
		socket.on('close', () => {
			conn.closed = true
		})
	}

	// ------------------------------------------------------------------ recorded commands

	/** Recorded command lines (optionally only those whose verb is `verb`) */
	lines(verb?: string): string[] {
		return this.commands.filter((c) => verb === undefined || c.verb === verb.toUpperCase()).map((c) => c.line)
	}

	clearCommands(): void {
		this.commands.length = 0
	}

	/**
	 * Commands the module must never send (brief, hard rules): SET/IP/MIXCFG/CFG writes, INP SRCE/PHPW,
	 * LVL threshold parameters, INP on legacy, writes without LOGIN, any verb outside the known set.
	 */
	violations(): string[] {
		const bad: string[] = []
		const known = new Set([
			'LOGIN',
			'VER',
			'IP',
			'SET',
			'SRC',
			'DST',
			'MIX',
			'MIXCFG',
			'INP',
			'GPI',
			'GPO',
			'CFG',
			'ADD',
			'MTR',
			'LVL',
		])
		for (const c of this.commands) {
			const p = parseLine(c.line)
			if (!p) continue
			const attrs = Object.keys(p.attrs)
			const isWrite = this.isWrite(p)
			let why = ''
			if (!known.has(p.verb.toUpperCase())) why = 'unknown verb'
			else if (
				['SET', 'IP', 'MIXCFG', 'CFG'].includes(p.verb) &&
				(attrs.length > 0 || (p.verb === 'IP' && p.args.length))
			)
				why = `forbidden write ${p.verb}`
			else if (p.verb === 'INP' && (attrs.includes('SRCE') || attrs.includes('PHPW'))) why = 'forbidden INP attribute'
			else if (p.verb === 'INP' && this.dialect === 'legacy') why = 'INP on a legacy node'
			else if (p.verb === 'LVL' && (attrs.length > 0 || p.args.length > 2)) why = 'LVL parameters'
			else if (isWrite && !c.loggedIn) why = 'write without LOGIN'
			if (why) bad.push(`${why}: ${c.line}`)
		}
		return bad
	}

	private isWrite(p: LwrpLine): boolean {
		const attrs = Object.keys(p.attrs).length
		switch (p.verb) {
			case 'SRC':
			case 'DST':
			case 'INP':
			case 'MIX':
			case 'MIXCFG':
			case 'SET':
				return attrs > 0
			case 'GPO':
				return p.args.length >= 2
			default:
				return false
		}
	}

	// ------------------------------------------------------------------ fault injection

	/** Delay answers to commands matching `match` by `ms` (on top of `answerDelayMs`) */
	delay(match: Match, ms: number, times = Infinity): void {
		this.delayRules.push({ match, ms, times })
	}

	/** Answer commands matching `match` with an ERROR line instead of processing them */
	injectError(match: Match, error = 'ERROR 1000 bad command', times = 1): void {
		this.errorRules.push({ match, error, times })
	}

	/**
	 * Drop answer lines matching `match` (e.g. `'SRC 2'`, `/^MIX 7\b/`). By default only lines inside
	 * multi-line answers are dropped (so a re-query of the single object works); `anyAnswer` drops those too.
	 */
	dropLines(match: Match, times = 1, anyAnswer = false): void {
		this.dropRules.push({ match, times, anyAnswer })
	}

	/** Insert unsolicited lines after the first row of the next multi-line answer (push interleaved in a list) */
	injectIntoNextList(lines: string[]): void {
		this.nextListInjection = lines
	}

	clearFaults(): void {
		this.delayRules = []
		this.errorRules = []
		this.dropRules = []
		this.nextListInjection = null
		this.reorder = false
		this.mute = false
		this.noEcho = false
		this.answerDelayMs = 0
	}

	/** Send raw lines to connections (default all open ones; or the nth open one) */
	push(lines: string | string[], which?: number): void {
		const arr = Array.isArray(lines) ? lines : [lines]
		const open = this.conns.filter((c) => !c.closed)
		for (const c of which === undefined ? open : open.slice(which, which + 1)) this.send(c, arr, 0)
	}

	/** Write raw bytes with no processing (split packets etc.) to the nth open connection */
	pushRaw(data: string, which = 0): void {
		this.conns.filter((c) => !c.closed)[which]?.socket.write(data, 'latin1')
	}

	// ------------------------------------------------------------------ state helpers for tests

	/** Apply a write as if another logged-in client sent it: state changes, subscribers get the push */
	externalWrite(cmd: string): void {
		const p = parseLine(cmd)
		if (!p) return
		const ghost = new Conn(0, undefined as unknown as net.Socket)
		ghost.loggedIn = true
		this.handleWrite(ghost, p)
	}

	/** Simulate an external GPI pin change and push it (uppercase changed pin) to `ADD GPI` subscribers */
	setGpi(port: number, pins: string): void {
		const old = this.gpi.get(port) ?? 'hhhhh'
		this.gpi.set(port, pins.toLowerCase())
		this.pushGpio('GPI', port, old, pins.toLowerCase(), null)
	}

	/** Change a level alert and push it to LVL subscribers of that channel */
	setLevel(group: string, n: number, side: 'L' | 'R' | '1', state: { low?: boolean; clip?: boolean }): void {
		const key = `${group} ${n}.${side}`
		const cur = this.levels.get(key) ?? { low: true, clip: false }
		const lines: string[] = []
		if (state.low !== undefined && state.low !== cur.low) lines.push(`LVL ${key} ${state.low ? 'LOW' : 'NO-LOW'}`)
		if (state.clip !== undefined && state.clip !== cur.clip) lines.push(`LVL ${key} ${state.clip ? 'CLIP' : 'NO-CLIP'}`)
		this.levels.set(key, { ...cur, ...state })
		for (const c of this.conns) if (!c.closed && c.lvl.has(`${group} ${n}`)) this.send(c, lines, 0)
	}

	setMeter(group: string, n: number, peaks: number[]): void {
		this.meters.set(`${group} ${n}`, peaks)
	}

	/** Crosspoint gain in tenths, undefined when off */
	xpoint(output: number, input: number): number | undefined {
		return this.mix.get(output)?.get(input)
	}

	/** Open connections whose subscription set contains `key` (`SRC 3`, `MIXCFG`, ...) */
	subscribers(key: string): number {
		return this.conns.filter((c) => !c.closed && c.subs.has(key)).length
	}

	/** Open connections subscribed to LVL for `GROUP n` */
	lvlSubscribers(key: string): number {
		return this.conns.filter((c) => !c.closed && c.lvl.has(key)).length
	}

	// ------------------------------------------------------------------ dump loading

	/** Replace the whole state from baseline-style dump text (`BEGIN`/`END` lines are ignored) */
	loadDump(text: string): void {
		this.ver = {}
		this.src.clear()
		this.dst.clear()
		this.inp.clear()
		this.cfgGpo.clear()
		this.mix.clear()
		this.gpi.clear()
		this.gpo.clear()
		this.setAttrs = {}
		for (const raw of text.split(/\r?\n/)) {
			const l = parseLine(raw)
			if (!l) continue
			const n = Number(l.args[0])
			switch (l.verb) {
				case 'VER':
					this.ver = { ...l.attrs }
					break
				case 'IP':
					if (l.args[0] === 'hostname') this.ip.hostname = l.args[1] ?? ''
					else {
						this.ip.addr = l.attrs.ADDR ?? ''
						this.ip.link = l.attrs.LINK ?? '1'
					}
					break
				case 'SET':
					this.setAttrs = { ...l.attrs }
					break
				case 'SRC':
					this.src.set(n, { ...l.attrs })
					break
				case 'DST':
					this.dst.set(n, { ...l.attrs })
					break
				case 'INP':
					this.inp.set(n, { ...l.attrs })
					break
				case 'MIXCFG':
					this.mixcfgMode = Number(l.attrs.MODE ?? 0)
					break
				case 'MIX':
					this.mix.set(n, new Map(Object.entries(l.attrs).map(([i, g]) => [Number(i), Number(g)])))
					break
				case 'GPI':
					this.gpi.set(n, (l.args[1] ?? 'hhhhh').toLowerCase())
					break
				case 'GPO':
					this.gpo.set(n, (l.args[1] ?? 'hhhhh').toLowerCase())
					break
				case 'CFG':
					if (l.args[0] === 'GPO') this.cfgGpo.set(Number(l.args[1]), { ...l.attrs })
					break
			}
		}
		if (this.dialect === 'legacy') this.ver.INP ??= '1'
		this.resetLevels()
	}

	private resetLevels(): void {
		this.levels.clear()
		for (const ch of this.levelChannels())
			for (const side of ch.sides) this.levels.set(`${ch.key}.${side}`, { low: true, clip: false })
	}

	private levelChannels(): Array<{ group: string; n: number; key: string; sides: Array<'L' | 'R' | '1'> }> {
		const out: Array<{ group: string; n: number; key: string; sides: Array<'L' | 'R' | '1'> }> = []
		const add = (group: string, count: number, mono: number[] = []): void => {
			for (let n = 1; n <= count; n++)
				out.push({ group, n, key: `${group} ${n}`, sides: mono.includes(n) ? ['1'] : ['L', 'R'] })
		}
		add('ICH', this.num('NSRC'))
		add('OCH', this.num('NDST'))
		if (this.dialect === 'xnode2') {
			const combo = (this.ver.DEVN ?? '').endsWith('.combo')
			add('HWI', this.num('INP'), combo ? [5] : [])
			add('HWO', 4)
		}
		return out
	}

	private num(key: string): number {
		return Number.parseInt(this.ver[key] ?? '0', 10) || 0
	}

	// ------------------------------------------------------------------ output

	private send(conn: Conn, lines: string[], delayMs: number): void {
		if (lines.length === 0) return
		const write = (): void => {
			if (this.mute || conn.closed || conn.socket.destroyed) return
			conn.socket.write(lines.map((l) => l + this.eol).join(''), 'latin1')
		}
		const total = delayMs + this.answerDelayMs
		if (total <= 0) write()
		else this.later(write, total)
	}

	private later(fn: () => void, ms: number): void {
		const t = setTimeout(() => {
			this.timers.delete(t)
			fn()
		}, ms)
		this.timers.add(t)
	}

	private fmtValue(key: string, value: string): string {
		if (RE_INT.test(value) || BARE_KEYS.has(key)) return value
		if (this.dialect === 'legacy' && key === 'RTPA' && IPV4_RE.test(value)) return value
		return `"${value}"`
	}

	private fmtAttrs(attrs: Attrs): string {
		const keys = Object.keys(attrs)
		if (this.dialect === 'xnode2') keys.sort()
		return keys.map((k) => `${k}:${this.fmtValue(k, attrs[k])}`).join(' ')
	}

	private fmtObject(verb: string, n: number, attrs: Attrs): string {
		return `${verb} ${n} ${this.fmtAttrs(attrs)}`.trimEnd()
	}

	private fmtMix(o: number): string {
		const row = this.mix.get(o) ?? new Map<number, number>()
		const body = [...row]
			.sort((a, b) => a[0] - b[0])
			.map(([i, g]) => `${i}:${g}`)
			.join(' ')
		return this.dialect === 'legacy' ? `MIX ${o} ${body}` : `MIX ${o}${body ? ` ${body}` : ''}`
	}

	private wrap(lines: string[]): Block {
		return { lines: ['BEGIN', ...lines, 'END'], list: true }
	}

	private err(code: number, text: string): Block {
		return { lines: [`ERROR ${code} ${text}`], list: false }
	}

	private get badCommand(): Block {
		return this.err(1000, 'bad command')
	}

	private get notAuthorized(): Block {
		return this.dialect === 'legacy' ? this.badCommand : this.err(1000, 'not authorized access')
	}

	// ------------------------------------------------------------------ input

	private onData(conn: Conn, chunk: string): void {
		conn.buf += chunk
		const batch: Array<{ block: Block; delay: number }> = []
		let nl: number
		while ((nl = conn.buf.indexOf('\n')) !== -1) {
			const line = conn.buf.slice(0, nl).replace(/\r$/, '')
			conn.buf = conn.buf.slice(nl + 1)
			if (line.trim() === '') continue
			const p = parseLine(line)
			this.commands.push({
				conn: conn.id,
				line: line.trim(),
				verb: (p?.verb ?? '').toUpperCase(),
				loggedIn: conn.loggedIn,
				muted: this.mute,
				at: Date.now(),
			})
			if (this.mute || !p) continue
			const delay = takeRule(this.delayRules, line)?.ms ?? 0
			const injected = takeRule(this.errorRules, line)
			const block: Block = injected ? { lines: [injected.error], list: false } : this.handle(conn, p)
			if (block.lines.length > 0) batch.push({ block, delay })
		}
		if (this.reorder && this.dialect === 'xnode2' && batch.length > 1) batch.reverse()
		for (const { block, delay } of batch) this.send(conn, this.finalize(block), delay)
	}

	private finalize(block: Block): string[] {
		let lines = block.lines
		for (const rule of this.dropRules) {
			if (rule.times <= 0 || (!block.list && !rule.anyAnswer)) continue
			const idx = lines.findIndex((l) => l !== 'BEGIN' && l !== 'END' && matches(rule.match, l))
			if (idx !== -1) {
				lines = lines.filter((_, i) => i !== idx)
				rule.times--
			}
		}
		this.dropRules = this.dropRules.filter((r) => r.times > 0)
		if (block.list && this.nextListInjection) {
			const at = lines[0] === 'BEGIN' ? 2 : 1
			lines = [...lines.slice(0, at), ...this.nextListInjection, ...lines.slice(at)]
			this.nextListInjection = null
		}
		return lines
	}

	private handle(conn: Conn, p: LwrpLine): Block {
		const none: Block = { lines: [], list: false }
		switch (p.verb.toUpperCase()) {
			case 'LOGIN':
				conn.loggedIn = true
				return none
			case 'VER':
				return { lines: [`VER ${this.fmtAttrs(this.ver)}`], list: false }
			case 'IP': {
				const addr = this.dialect === 'legacy' ? `"${this.ip.addr}"` : this.ip.addr
				return {
					lines: [`IP ADDR:${addr} LINK:${this.ip.link}`, `IP hostname ${this.ip.hostname}`],
					list: false,
				}
			}
			case 'SET':
				if (Object.keys(p.attrs).length > 0) {
					if (!conn.loggedIn) return this.notAuthorized
					Object.assign(this.setAttrs, p.attrs)
					return none
				}
				return {
					lines: [`SET ${this.dialect === 'legacy' ? this.fmtAttrs(this.setAttrs) : ''}`.trimEnd()],
					list: false,
				}
			case 'SRC':
				return this.handleObject(conn, 'SRC', this.src, p)
			case 'DST':
				return this.handleObject(conn, 'DST', this.dst, p)
			case 'INP':
				return this.dialect === 'legacy' ? this.badCommand : this.handleObject(conn, 'INP', this.inp, p)
			case 'MIX':
				return this.handleMix(conn, p)
			case 'MIXCFG':
				if (Object.keys(p.attrs).length > 0) {
					if (!conn.loggedIn) return this.notAuthorized
					this.mixcfgMode = Number(p.attrs.MODE ?? this.mixcfgMode)
					this.notify('MIXCFG', [`MIXCFG MODE:${this.mixcfgMode}`], conn, false)
					return none
				}
				conn.subs.add('MIXCFG')
				return { lines: [`MIXCFG MODE:${this.mixcfgMode}`], list: false }
			case 'GPI':
			case 'GPO':
				return this.handleGpio(conn, p.verb.toUpperCase() as 'GPI' | 'GPO', p, false)
			case 'ADD':
				if (['GPI', 'GPO'].includes((p.args[0] ?? '').toUpperCase()))
					return this.handleGpio(conn, p.args[0].toUpperCase() as 'GPI' | 'GPO', { ...p, args: p.args.slice(1) }, true)
				return this.badCommand
			case 'CFG':
				return this.handleCfg(p)
			case 'MTR':
				return this.handleMtr(p)
			case 'LVL':
				return this.handleLvl(conn, p)
			default:
				return this.badCommand
		}
	}

	// ---- SRC / DST / INP

	private handleObject(conn: Conn, verb: 'SRC' | 'DST' | 'INP', map: Map<number, Attrs>, p: LwrpLine): Block {
		const x2 = this.dialect === 'xnode2'
		const idx = p.args[0]
		const writeAttrs = Object.keys(p.attrs).length > 0
		if (idx === undefined) {
			for (const n of map.keys()) conn.subs.add(`${verb} ${n}`)
			return this.wrap([...map].map(([n, a]) => this.fmtObject(verb, n, a)))
		}
		const n = Number(idx)
		const attrs = Number.isInteger(n) ? map.get(n) : undefined
		if (!attrs)
			return x2
				? verb === 'INP'
					? this.err(1006, 'invalid port')
					: this.err(1002, 'bad port number')
				: this.badCommand
		if (!writeAttrs) {
			conn.subs.add(`${verb} ${n}`)
			return { lines: [this.fmtObject(verb, n, attrs)], list: false }
		}
		if (!conn.loggedIn) return this.notAuthorized
		const written: Attrs = {}
		for (const [k, raw] of Object.entries(p.attrs)) {
			if (!(k in attrs)) continue // unknown attributes are silently ignored
			let value = raw
			if (k === 'INGN' || k === 'OUGN') {
				if (!RE_INT.test(raw)) {
					if (x2) return this.err(1001, 'syntax error')
				} else {
					const v = Number(raw)
					if (x2 && (v < OFF || v > 240)) return this.err(1001, 'syntax error')
					value = String(Math.max(OFF, Math.min(240, v)))
				}
			} else if (x2 && (k === 'RTPA' || k === 'ADDR')) {
				const first = raw.split(' ')[0]
				if (raw !== '' && !IPV4_RE.test(first) && !/^\d{1,5}$/.test(first)) return this.err(1001, 'syntax error')
				if (/^\d{1,5}$/.test(first)) value = channelToIp(Number(first)) + raw.slice(first.length)
			} else if (x2 && (k === 'RTPE' || k === 'PHPW') && !/^[01]$/.test(raw)) {
				return this.err(1001, 'syntax error')
			} else if (x2 && k === 'GAIN' && !(RE_INT.test(raw) && Number(raw) >= 0 && Number(raw) <= 700)) {
				return this.err(1001, 'syntax error')
			}
			written[k] = value
		}
		Object.assign(attrs, written)
		const line = verb === 'INP' ? this.fmtObject(verb, n, written) : this.fmtObject(verb, n, attrs)
		this.notify(`${verb} ${n}`, [line], conn, x2)
		return { lines: [], list: false }
	}

	// ---- MIX

	private handleMix(conn: Conn, p: LwrpLine): Block {
		const x2 = this.dialect === 'xnode2'
		const nmix = this.num('MIX')
		const idx = p.args[0]
		const writeAttrs = Object.entries(p.attrs)
		if (idx === undefined) {
			for (let o = 1; o <= nmix; o++) conn.subs.add(`MIX ${o}`)
			const rows = Array.from({ length: nmix }, (_, i) => i + 1)
			if (x2) rows.sort((a, b) => String(a).localeCompare(String(b)))
			const lines = rows.map((o) => this.fmtMix(o))
			return x2 ? this.wrap(lines) : { lines, list: true }
		}
		const o = Number(idx)
		if (!Number.isInteger(o) || o < 1 || o > nmix) return x2 ? this.err(1002, 'bad port number') : this.badCommand
		if (writeAttrs.length === 0) {
			conn.subs.add(`MIX ${o}`)
			return { lines: x2 ? [this.fmtMix(o), ''] : [this.fmtMix(o)], list: false }
		}
		if (!conn.loggedIn) return this.notAuthorized
		const row = this.mix.get(o) ?? new Map<number, number>()
		const edits: Array<[number, number | null]> = []
		for (const [k, raw] of writeAttrs) {
			const input = Number(k)
			if (!Number.isInteger(input) || input < 1) continue
			if (raw === '-') edits.push([input, null])
			else if (/^-?\d+$/.test(raw)) edits.push([input, Number(raw) <= OFF ? null : Number(raw)])
			else if (/^-?\d+\.\d+$/.test(raw))
				edits.push([input, x2 ? (Math.trunc(Number(raw)) <= OFF ? null : Math.trunc(Number(raw))) : null])
			else if (x2) return this.err(1001, 'syntax error')
			else edits.push([input, null])
		}
		for (const [input, gain] of edits) {
			if (!x2 && input > 25) continue // silently ignored on legacy
			if (gain === null) row.delete(input)
			else row.set(input, gain)
		}
		this.mix.set(o, row)
		if (this.mixcfgMode !== 0) {
			this.mixcfgMode = 0
			this.notify('MIXCFG', ['MIXCFG MODE:0'], conn, false)
		}
		this.notify(`MIX ${o}`, [this.fmtMix(o)], conn, x2)
		return { lines: [], list: false }
	}

	// ---- GPIO

	private handleGpio(conn: Conn, verb: 'GPI' | 'GPO', p: LwrpLine, subscribe: boolean): Block {
		if (this.dialect === 'legacy' || this.num(verb === 'GPI' ? 'NGPI' : 'NGPO') === 0) return this.badCommand
		const map = verb === 'GPI' ? this.gpi : this.gpo
		const idx = p.args[0]
		if (idx === undefined) {
			if (subscribe) conn.gpio.add(verb)
			return this.wrap([...map].map(([n, pins]) => `${verb} ${n} ${pins}`))
		}
		if (/\./.test(idx)) return this.err(1002, 'bad port number')
		const n = Number(idx)
		if (!Number.isInteger(n) || !map.has(n)) return this.err(1006, 'invalid port')
		if (p.args.length === 1) {
			if (subscribe) conn.gpio.add(verb)
			return { lines: [`${verb} ${n} ${map.get(n)}`], list: false }
		}
		if (verb === 'GPI') return this.badCommand
		if (!conn.loggedIn) return this.notAuthorized
		if (p.args.length > 2 || !/^[hl]{5}$/i.test(p.args[1])) return this.err(1001, 'syntax error')
		const old = map.get(n) ?? 'hhhhh'
		const pins = p.args[1].toLowerCase()
		map.set(n, pins)
		this.pushGpio('GPO', n, old, pins, conn)
		return { lines: [], list: false }
	}

	private pushGpio(verb: 'GPI' | 'GPO', n: number, old: string, pins: string, writer: Conn | null): void {
		if (old === pins) return
		const shown = [...pins].map((c, i) => (c !== old[i] ? c.toUpperCase() : c)).join('')
		for (const c of this.conns) {
			if (c.closed || !c.gpio.has(verb)) continue
			if (c === writer && !this.gpoEchoToWriter) continue
			this.send(c, [`${verb} ${n} ${shown}`], 0)
		}
	}

	private handleCfg(p: LwrpLine): Block {
		if (this.dialect === 'legacy' || p.args[0]?.toUpperCase() !== 'GPO' || this.num('NGPO') === 0)
			return this.badCommand
		if (p.args[1] === undefined) return this.wrap([...this.cfgGpo].map(([n, a]) => `CFG GPO ${n} ${this.fmtAttrs(a)}`))
		const a = this.cfgGpo.get(Number(p.args[1]))
		return a ? { lines: [`CFG GPO ${p.args[1]} ${this.fmtAttrs(a)}`], list: false } : this.err(1006, 'invalid port')
	}

	// ---- MTR / LVL

	private meterLine(group: string, n: number, mono: boolean): string {
		const v = this.meters.get(`${group} ${n}`) ?? (mono ? [OFF] : [OFF, OFF])
		return `MTR ${group} ${n} PEEK:${v.join(':')}`
	}

	private handleMtr(p: LwrpLine): Block {
		const x2 = this.dialect === 'xnode2'
		const chans = this.levelChannels().filter((c) => x2 || c.group === 'ICH' || c.group === 'OCH')
		const order = x2 ? ['HWI', 'HWO', 'ICH', 'OCH'] : ['ICH', 'OCH']
		const lines = order.flatMap((g) =>
			chans.filter((c) => c.group === g).map((c) => this.meterLine(c.group, c.n, c.sides[0] === '1')),
		)
		if (p.args.length === 0) return this.wrap(lines)
		const want = p.args.slice(0, 2).join(' ')
		const hit = lines.find((l) => l.startsWith(`MTR ${want} `))
		return hit ? { lines: [hit], list: false } : this.err(x2 ? 1002 : 1000, x2 ? 'bad port number' : 'bad command')
	}

	private handleLvl(conn: Conn, p: LwrpLine): Block {
		const key = p.args.slice(0, 2).join(' ')
		const ch = this.levelChannels().find((c) => c.key === key)
		if (!ch)
			return p.args.length === 2 && ['ICH', 'OCH', 'HWI', 'HWO'].includes(p.args[0]) && this.dialect === 'xnode2'
				? this.err(1002, 'bad port number')
				: this.badCommand
		conn.lvl.add(key)
		const x2 = this.dialect === 'xnode2'
		const alert = (side: string, field: 'low' | 'clip', state: boolean): string =>
			`LVL ${key}.${side} ${state ? '' : 'NO-'}${field === 'low' ? 'LOW' : 'CLIP'}`
		this.later(() => {
			if (conn.closed) return
			const lines: string[] = []
			for (const side of ch.sides) {
				const st = this.levels.get(`${key}.${side}`) ?? { low: true, clip: false }
				// xNode2 reports a provisional NO-LOW first, LOW follows after the low time
				lines.push(alert(side, 'low', x2 ? false : st.low), alert(side, 'clip', st.clip))
				if (x2) lines.push('')
			}
			this.send(conn, lines, 0)
			if (x2) {
				this.later(() => {
					if (conn.closed) return
					const low = ch.sides.filter((s) => this.levels.get(`${key}.${s}`)?.low).map((s) => alert(s, 'low', true))
					this.send(conn, low, 0)
				}, this.lowDelayMs)
			}
		}, this.lvlDelayMs)
		return { lines: [], list: false }
	}

	// ---- change distribution

	/** Send `lines` to subscribers of `key`; the writer gets them if it is subscribed or `writerAlwaysEchoes` */
	private notify(key: string, lines: string[], writer: Conn, writerAlwaysEchoes: boolean): void {
		for (const c of this.conns) {
			if (c.closed) continue
			if (c === writer && this.noEcho) continue
			if (c === writer ? writerAlwaysEchoes || c.subs.has(key) : c.subs.has(key)) this.send(c, lines, 0)
		}
	}

	private handleWrite(conn: Conn, p: LwrpLine): void {
		this.handle(conn, p)
	}
}
