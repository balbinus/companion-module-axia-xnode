import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { LwrpConnection, LwrpConnectionError, LwrpError, LwrpTimeoutError } from '../../src/device/connection.js'
import type { LwrpLine } from '../../src/lwrp/parser.js'
import { MockXNode, type Dialect, type MockOptions } from '../helpers/mock-xnode.js'
import { sleep, waitFor } from '../helpers/wait-for.js'

/** A scripted TCP peer for exact control over packets */
class RawServer {
	readonly received: string[] = []
	sockets: net.Socket[] = []
	port = 0
	private buf = ''
	private server = net.createServer((s) => {
		this.sockets.push(s)
		s.on('data', (d) => {
			this.buf += d.toString('latin1')
			let nl: number
			while ((nl = this.buf.indexOf('\n')) !== -1) {
				this.received.push(this.buf.slice(0, nl).replace(/\r$/, ''))
				this.buf = this.buf.slice(nl + 1)
			}
		})
		s.on('error', () => undefined)
	})

	static async start(): Promise<RawServer> {
		const r = new RawServer()
		await new Promise<void>((resolve) => r.server.listen(0, '127.0.0.1', resolve))
		r.port = (r.server.address() as net.AddressInfo).port
		return r
	}

	get socket(): net.Socket {
		return this.sockets[0]
	}

	write(data: string): void {
		this.socket.write(data, 'latin1')
	}

	async stop(): Promise<void> {
		for (const s of this.sockets) s.destroy()
		await new Promise<void>((resolve) => this.server.close(() => resolve()))
	}
}

interface Harness {
	conn: LwrpConnection
	lines: LwrpLine[]
	closes: Array<Error | undefined>
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

async function connectTo(port: number): Promise<Harness> {
	const lines: LwrpLine[] = []
	const closes: Array<Error | undefined> = []
	const conn = new LwrpConnection({
		host: '127.0.0.1',
		port,
		onLine: (l) => lines.push(l),
		onClose: (e) => closes.push(e),
	})
	cleanups.push(() => conn.close())
	await conn.connect()
	return { conn, lines, closes }
}

async function withMock(dialect: Dialect, extra: MockOptions = {}): Promise<[MockXNode, Harness]> {
	const mock = await MockXNode.start({ dialect, ...extra })
	cleanups.push(async () => mock.stop())
	return [mock, await connectTo(mock.port)]
}

async function withRaw(): Promise<[RawServer, Harness]> {
	const raw = await RawServer.start()
	cleanups.push(async () => raw.stop())
	const h = await connectTo(raw.port)
	await waitFor(() => raw.sockets.length === 1)
	return [raw, h]
}

describe('framing', () => {
	it('accepts CRLF and bare LF line endings', async () => {
		const [raw, h] = await withRaw()
		raw.write('VER LWRP:1.2\r\nIP hostname a\nMIXCFG MODE:0\r\n')
		await waitFor(() => h.lines.length === 3)
		expect(h.lines.map((l) => l.verb)).toEqual(['VER', 'IP', 'MIXCFG'])
	})

	it('reassembles lines split across packets (even inside a token and between CR and LF)', async () => {
		const [raw, h] = await withRaw()
		for (const part of ['VER LW', 'RP:1.4.2 NSRC', ':8\r', '\nDST 1 NAME:"a', ' b"\r\n']) {
			raw.write(part)
			await sleep(8)
		}
		await waitFor(() => h.lines.length === 2)
		expect(h.lines[0].attrs).toEqual({ LWRP: '1.4.2', NSRC: '8' })
		expect(h.lines[1].attrs.NAME).toBe('a b')
	})

	it('handles several lines in one packet and ignores empty lines', async () => {
		const [raw, h] = await withRaw()
		raw.write('BEGIN\r\n\r\nSRC 1 PSNM:a\r\n\r\nSRC 2 PSNM:b\r\nEND\r\n')
		await waitFor(() => h.lines.length === 4)
		expect(h.lines.map((l) => l.raw)).toEqual(['BEGIN', 'SRC 1 PSNM:a', 'SRC 2 PSNM:b', 'END'])
	})

	it('writes commands terminated with CRLF', async () => {
		const [raw, h] = await withRaw()
		h.conn.send('LOGIN')
		await waitFor(() => raw.received.length === 1)
		expect(raw.received).toEqual(['LOGIN'])
	})

	it('a throwing onLine listener does not break framing or the query', async () => {
		const raw = await RawServer.start()
		cleanups.push(async () => raw.stop())
		const conn = new LwrpConnection({
			host: '127.0.0.1',
			port: raw.port,
			onLine: () => {
				throw new Error('listener bug')
			},
			onClose: () => undefined,
		})
		cleanups.push(() => conn.close())
		await conn.connect()
		await waitFor(() => raw.sockets.length === 1)
		const q = conn.query('VER')
		await waitFor(() => raw.received.length === 1)
		raw.write('VER LWRP:1.2\r\n')
		await expect(q).resolves.toHaveLength(1)
	})
})

describe('query queue', () => {
	it('keeps exactly one command in flight and runs them in order', async () => {
		const [raw, h] = await withRaw()
		const results = [h.conn.query('VER'), h.conn.query('SRC 3'), h.conn.query('DST 2')]
		expect(h.conn.pending).toBe(3)
		await waitFor(() => raw.received.length === 1)
		await sleep(30)
		expect(raw.received).toEqual(['VER']) // nothing else sent before the answer
		raw.write('VER LWRP:1.2\r\n')
		await waitFor(() => raw.received.length === 2)
		await sleep(30)
		expect(raw.received).toEqual(['VER', 'SRC 3'])
		raw.write('SRC 3 PSNM:x\r\n')
		await waitFor(() => raw.received.length === 3)
		raw.write('DST 2 NAME:y\r\n')
		const answers = await Promise.all(results)
		expect(answers.map((a) => a[0].verb)).toEqual(['VER', 'SRC', 'DST'])
		expect(h.conn.pending).toBe(0)
	})

	it('a failed (timed out) request does not stall the queue', async () => {
		const [raw, h] = await withRaw()
		const first = h.conn.query('SRC 1', { timeoutMs: 40 })
		const second = h.conn.query('VER', { timeoutMs: 1000 })
		await expect(first).rejects.toBeInstanceOf(LwrpTimeoutError)
		await waitFor(() => raw.received.length === 2)
		raw.write('VER LWRP:1.2\r\n')
		await expect(second).resolves.toHaveLength(1)
	})

	it('rejects with LwrpTimeoutError carrying command and timeout, and clears its timers', async () => {
		const [, h] = await withRaw()
		const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
		const err = await h.conn.query('MIXCFG', { timeoutMs: 30 }).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(LwrpTimeoutError)
		expect(err).toMatchObject({ command: 'MIXCFG', timeoutMs: 30 })
		expect(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length).toBeLessThanOrEqual(before)
	})
})

describe('answer completion', () => {
	it('collects a BEGIN/END list and ignores non-matching lines inside it', async () => {
		const [mock, h] = await withMock('xnode2')
		const lines = await h.conn.query('SRC')
		expect(lines.map((l) => l.args[0])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
		expect(mock.lines()).toEqual(['SRC'])
	})

	it('completes a single object query on its first matching line, and ignores the trailing empty line (xNode2 MIX n)', async () => {
		const [, h] = await withMock('xnode2')
		const lines = await h.conn.query('MIX 1')
		expect(lines).toHaveLength(1)
		expect(lines[0].attrs).toEqual({ '17': '0' })
		// the next query is not confused by the empty line
		await expect(h.conn.query('MIXCFG')).resolves.toHaveLength(1)
	})

	it('legacy unwrapped MIX list completes by expected row count', async () => {
		const [, h] = await withMock('legacy')
		const t0 = Date.now()
		const lines = await h.conn.query('MIX', { expectCount: 24, quietMs: 2000 })
		expect(lines).toHaveLength(24)
		expect(Date.now() - t0).toBeLessThan(1500) // did not wait for the quiet gap
		expect(lines[8].raw).toBe('MIX 9') // trailing space stripped by the parser
		expect(lines[8].attrs).toEqual({})
	})

	it('legacy unwrapped MIX list with a missing row completes by quiet gap', async () => {
		const [mock, h] = await withMock('legacy')
		mock.dropLines('MIX 7')
		const lines = await h.conn.query('MIX', { expectCount: 24, quietMs: 60 })
		expect(lines.map((l) => l.args[0])).not.toContain('7')
		expect(lines).toHaveLength(23)
	})

	it('multi-line IP answer (two lines, distinct sub-keys)', async () => {
		const [, h] = await withMock('legacy')
		const lines = await h.conn.query('IP', { expectCount: 2, quietMs: 100 })
		expect(lines.map((l) => l.raw)).toEqual(['IP ADDR:"192.0.2.23" LINK:1', 'IP hostname Node-23-0'])
	})

	it('CFG GPO and ADD GPI queries match the right answer verbs', async () => {
		const [, h] = await withMock('xnode2')
		const cfg = await h.conn.query('CFG GPO')
		expect(cfg.map((l) => l.raw.slice(0, 9))).toEqual(['CFG GPO 1', 'CFG GPO 2'])
		const gpi = await h.conn.query('ADD GPI')
		expect(gpi.map((l) => l.verb)).toEqual(['GPI', 'GPI'])
	})

	it('interleaved push of another object during a list is emitted and does not break completion', async () => {
		const [mock, h] = await withMock('xnode2')
		mock.injectIntoNextList(['MIXCFG MODE:0', 'DST 3 NAME:"pushed"'])
		const lines = await h.conn.query('SRC')
		expect(lines).toHaveLength(8)
		expect(h.lines.map((l) => l.raw)).toContain('MIXCFG MODE:0')
		expect(h.lines.map((l) => l.raw)).toContain('DST 3 NAME:"pushed"')
		await expect(h.conn.query('VER')).resolves.toHaveLength(1)
	})

	it('a push between BEGIN and a single-object answer of another verb leaves the answer intact', async () => {
		const [raw, h] = await withRaw()
		const q = h.conn.query('SRC 3')
		await waitFor(() => raw.received.length === 1)
		raw.write('DST 1 NAME:z\r\nMIXCFG MODE:0\r\nSRC 3 PSNM:ok\r\n')
		const lines = await q
		expect(lines.map((l) => l.raw)).toEqual(['SRC 3 PSNM:ok'])
		expect(h.lines).toHaveLength(3)
	})

	// BUG: a push of the same verb arriving before BEGIN completes the list query early and the leftover BEGIN/END desynchronises the next query
	it.fails('a same-verb push arriving before the BEGIN of a list does not corrupt this or the next query', async () => {
		const [raw, h] = await withRaw()
		const q1 = h.conn.query('SRC')
		const q2 = h.conn.query('DST')
		await waitFor(() => raw.received.length === 1)
		raw.write('SRC 5 PSNM:pushed\r\n')
		await waitFor(() => raw.received.length === 2) // the next query has started
		raw.write('BEGIN\r\nSRC 1 PSNM:a\r\nSRC 2 PSNM:b\r\nEND\r\n')
		await sleep(20)
		raw.write('BEGIN\r\nDST 1 NAME:a\r\nDST 2 NAME:b\r\nEND\r\n')
		const [a, b] = await Promise.all([q1, q2])
		expect(a.length).toBeGreaterThanOrEqual(2)
		expect(b).toHaveLength(2)
	})

	it('a list answer that is empty (BEGIN, END) yields no lines', async () => {
		const [raw, h] = await withRaw()
		const q = h.conn.query('GPI')
		await waitFor(() => raw.received.length === 1)
		raw.write('BEGIN\r\nEND\r\n')
		await expect(q).resolves.toEqual([])
	})
})

describe('errors', () => {
	it('attributes ERROR to the in-flight command and keeps the queue going', async () => {
		const [mock, h] = await withMock('xnode2')
		const bad = h.conn.query('SRC 9')
		const good = h.conn.query('VER')
		const err = await bad.catch((e: unknown) => e)
		expect(err).toBeInstanceOf(LwrpError)
		expect(err).toMatchObject({ code: 1002, text: 'bad port number', command: 'SRC 9' })
		await expect(good).resolves.toHaveLength(1)
		expect(mock.lines()).toEqual(['SRC 9', 'VER'])
	})

	it('ERROR is still emitted through onLine, and an ERROR with nothing in flight is harmless', async () => {
		const [raw, h] = await withRaw()
		raw.write('ERROR 1000 bad command\r\n')
		await waitFor(() => h.lines.length === 1)
		expect(h.lines[0].args).toEqual(['1000', 'bad', 'command'])
		const q = h.conn.query('VER')
		await waitFor(() => raw.received.length === 1)
		raw.write('VER LWRP:1.2\r\n')
		await expect(q).resolves.toHaveLength(1)
	})

	it('inside a BEGIN..END list an ERROR rejects the query', async () => {
		const [raw, h] = await withRaw()
		const q = h.conn.query('SRC')
		await waitFor(() => raw.received.length === 1)
		raw.write('BEGIN\r\nSRC 1 PSNM:a\r\nERROR 1000 bad command\r\n')
		await expect(q).rejects.toBeInstanceOf(LwrpError)
	})

	it('legacy: unknown verbs and GPIO give ERROR 1000 bad command', async () => {
		const [, h] = await withMock('legacy')
		await expect(h.conn.query('ADD GPI', { verb: 'GPI' })).rejects.toMatchObject({ code: 1000, text: 'bad command' })
		await expect(h.conn.query('GPO 1')).rejects.toMatchObject({ code: 1000 })
	})
})

describe('write', () => {
	it('legacy: no echo unless this connection queried the object -> resolves null after the echo window', async () => {
		const [mock, h] = await withMock('legacy')
		h.conn.send('LOGIN')
		const t0 = Date.now()
		const echo = await h.conn.write('DST 8 OUGN:-100', { echoTimeoutMs: 80 })
		expect(echo).toBeNull()
		expect(Date.now() - t0).toBeGreaterThanOrEqual(70)
		expect(mock.dst.get(8)?.OUGN).toBe('-100') // the write itself was applied
	})

	it('legacy: after querying the object the write is echoed', async () => {
		const [, h] = await withMock('legacy')
		await h.conn.query('DST 8')
		h.conn.send('LOGIN')
		const echo = await h.conn.write('DST 8 OUGN:-100', { echoTimeoutMs: 1000 })
		expect(echo?.attrs.OUGN).toBe('-100')
		expect(echo?.verb).toBe('DST')
	})

	it('xNode2 always echoes (and resolves as soon as the echo arrives)', async () => {
		const [, h] = await withMock('xnode2')
		h.conn.send('LOGIN')
		const t0 = Date.now()
		const echo = await h.conn.write('DST 8 OUGN:-100', { echoTimeoutMs: 2000 })
		expect(echo?.attrs.OUGN).toBe('-100')
		expect(Date.now() - t0).toBeLessThan(1000)
	})

	it('GPO writes never echo', async () => {
		const [mock, h] = await withMock('xnode2')
		h.conn.send('LOGIN')
		expect(await h.conn.write('GPO 1 lhhhh', { echoTimeoutMs: 60 })).toBeNull()
		expect(mock.gpo.get(1)).toBe('lhhhh')
	})

	it('rejects with the device error (write without LOGIN, invalid value)', async () => {
		const [, h] = await withMock('xnode2')
		await expect(h.conn.write('DST 8 OUGN:-100', { echoTimeoutMs: 500 })).rejects.toMatchObject({
			code: 1000,
			text: 'not authorized access',
		})
		h.conn.send('LOGIN')
		await expect(h.conn.write('DST 8 OUGN:500')).rejects.toMatchObject({ code: 1001 })
	})

	it('legacy write without LOGIN -> ERROR 1000 bad command; unknown attribute is silently accepted after LOGIN', async () => {
		const [, h] = await withMock('legacy')
		await expect(h.conn.write('SRC 1 INGN:0')).rejects.toMatchObject({ code: 1000, text: 'bad command' })
		h.conn.send('LOGIN')
		expect(await h.conn.write('DST 8 BOGUS:1', { echoTimeoutMs: 40 })).toBeNull()
	})

	it('writes are serialised behind pending queries', async () => {
		const [raw, h] = await withRaw()
		const q = h.conn.query('VER')
		const w = h.conn.write('DST 1 OUGN:5', { echoTimeoutMs: 50 })
		await waitFor(() => raw.received.length === 1)
		await sleep(30)
		expect(raw.received).toEqual(['VER'])
		raw.write('VER LWRP:1.2\r\n')
		await q
		await waitFor(() => raw.received.length === 2)
		await expect(w).resolves.toBeNull()
	})

	it('a mixer write echo is matched by verb and output index', async () => {
		const [raw, h] = await withRaw()
		const w = h.conn.write('MIX 9 1:-60', { echoTimeoutMs: 1000 })
		await waitFor(() => raw.received.length === 1)
		raw.write('MIX 10 3:0\r\nMIX 9 1:-60\r\n')
		const echo = await w
		expect(echo?.raw).toBe('MIX 9 1:-60')
	})
})

describe('close and failure paths', () => {
	it('connect to a closed port rejects and leaves the connection unusable', async () => {
		const raw = await RawServer.start()
		const port = raw.port
		await raw.stop()
		const conn = new LwrpConnection({ host: '127.0.0.1', port, onLine: () => undefined, onClose: () => undefined })
		await expect(conn.connect()).rejects.toThrow()
		expect(conn.isOpen).toBe(false)
		await expect(conn.query('VER')).rejects.toBeInstanceOf(LwrpConnectionError)
		expect(() => conn.send('VER')).toThrow(LwrpConnectionError)
	})

	it('server closing mid-query rejects the in-flight query once and calls onClose once', async () => {
		const [raw, h] = await withRaw()
		const q = h.conn.query('VER')
		await waitFor(() => raw.received.length === 1)
		raw.socket.destroy()
		await expect(q).rejects.toBeInstanceOf(Error)
		await waitFor(() => h.closes.length === 1)
		await sleep(30)
		expect(h.closes).toHaveLength(1)
		expect(h.conn.isOpen).toBe(false)
		await expect(h.conn.write('DST 1 OUGN:0')).rejects.toBeInstanceOf(LwrpConnectionError)
	})

	// BUG: requests still queued when the socket closes are rejected but never leave `pending` (queued-- is skipped), so pending stays > 0
	it.fails('after the socket closes, queued requests are rejected and pending returns to 0', async () => {
		const [raw, h] = await withRaw()
		const qs = [h.conn.query('VER'), h.conn.query('SRC'), h.conn.query('DST')].map(async (p) =>
			p.catch((e: unknown) => e),
		)
		await waitFor(() => raw.received.length === 1)
		raw.socket.destroy()
		const results = await Promise.all(qs)
		expect(results.every((r) => r instanceof Error)).toBe(true)
		expect(h.conn.pending).toBe(0)
	})

	it('close() rejects the in-flight request, does not call onClose, and is idempotent', async () => {
		const [raw, h] = await withRaw()
		const q = h.conn.query('VER').catch((e: unknown) => e)
		await waitFor(() => raw.received.length === 1)
		h.conn.close()
		expect(await q).toBeInstanceOf(LwrpConnectionError)
		h.conn.close()
		await waitFor(() => raw.socket.destroyed)
		await sleep(20)
		expect(h.closes).toHaveLength(0)
		expect(h.conn.isOpen).toBe(false)
	})

	it('late data after close() is ignored', async () => {
		const [raw, h] = await withRaw()
		const sock = raw.socket
		h.conn.close()
		sock.write('VER LWRP:1.2\r\n')
		await sleep(30)
		expect(h.lines).toHaveLength(0)
	})

	it('can reconnect on a fresh instance against the same server (state is per instance)', async () => {
		const mock = await MockXNode.start({ dialect: 'xnode2' })
		cleanups.push(async () => mock.stop())
		const a = await connectTo(mock.port)
		await a.conn.query('VER')
		a.conn.close()
		const b = await connectTo(mock.port)
		await expect(b.conn.query('VER')).resolves.toHaveLength(1)
		await waitFor(() => mock.connectionCount === 1)
	})

	it('close() leaves no sockets behind on the server', async () => {
		const [mock, h] = await withMock('xnode2')
		await h.conn.query('VER')
		expect(mock.connectionCount).toBe(1)
		h.conn.close()
		await waitFor(() => mock.connectionCount === 0)
	})

	it('a dead link (device mute) yields a timeout, not a hang', async () => {
		const [mock, h] = await withMock('xnode2')
		mock.mute = true
		await expect(h.conn.query('VER', { timeoutMs: 50 })).rejects.toBeInstanceOf(LwrpTimeoutError)
		mock.mute = false
		await expect(h.conn.query('VER', { timeoutMs: 1000 })).resolves.toHaveLength(1)
	})
})
