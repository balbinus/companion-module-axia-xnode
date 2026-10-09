import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpMeterStream } from '../../src/device/meters-http.js'
import type { LwrpLine } from '../../src/lwrp/parser.js'
import { sleep, waitFor } from '../helpers/wait-for.js'

interface MeterServer {
	port: number
	requests: http.IncomingMessage[]
	responses: http.ServerResponse[]
	/** Respond with this status instead of streaming (next request only) */
	failWith: number[]
	close: () => Promise<void>
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

/** A tiny HTTP/1.1 stand-in for the node's `/nph-cgi_mtr` stream (the real one is HTTP/1.0 without length) */
async function meterServer(): Promise<MeterServer> {
	const state: MeterServer = { port: 0, requests: [], responses: [], failWith: [], close: async () => undefined }
	const server = http.createServer((req, res) => {
		state.requests.push(req)
		const fail = state.failWith.shift()
		if (fail) {
			res.writeHead(fail)
			res.end()
			return
		}
		state.responses.push(res)
		res.writeHead(200, { 'Content-Type': 'text/plain' })
		res.write(`${' '.repeat(40)}\n`)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	state.port = (server.address() as AddressInfo).port
	state.close = async () => {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
	cleanups.push(async () => state.close())
	return state
}

function stream(
	srv: MeterServer,
	extra: { password?: string; intervalMs?: number; backoffMs?: number[]; stallMs?: number } = {},
) {
	const lines: LwrpLine[] = []
	const logs: string[] = []
	const s = new HttpMeterStream({
		host: '127.0.0.1',
		port: srv.port,
		password: extra.password ?? '',
		intervalMs: extra.intervalMs ?? 500,
		backoffMs: extra.backoffMs ?? [20, 40],
		stallMs: extra.stallMs,
		onLine: (l) => lines.push(l),
		log: (level, m) => logs.push(`${level}: ${m}`),
	})
	cleanups.push(() => s.stop())
	return { s, lines, logs }
}

describe('HttpMeterStream', () => {
	it('requests the meter feed with basic auth user:<password> and the interval', async () => {
		const srv = await meterServer()
		const { s } = stream(srv, { password: 'pw', intervalMs: 250 })
		s.start()
		await waitFor(() => srv.requests.length === 1)
		const req = srv.requests[0]
		expect(req.url).toBe('/nph-cgi_mtr?duration=-1&interval=250')
		expect(req.headers.authorization).toBe(`Basic ${Buffer.from('user:pw').toString('base64')}`)
		expect(req.headers.connection).toBe('close')
	})

	it('uses user: with an empty password and clamps the interval to 100 ms', async () => {
		const srv = await meterServer()
		const { s } = stream(srv, { intervalMs: 5 })
		s.start()
		await waitFor(() => srv.requests.length === 1)
		expect(srv.requests[0].headers.authorization).toBe(`Basic ${Buffer.from('user:').toString('base64')}`)
		expect(srv.requests[0].url).toContain('interval=100')
	})

	it('parses MTR lines even when chunks split them mid-token, skipping padding, blanks and other lines', async () => {
		const srv = await meterServer()
		const { s, lines } = stream(srv)
		s.start()
		await waitFor(() => srv.responses.length === 1)
		const res = srv.responses[0]
		for (const chunk of [
			'\nMTR HW',
			'O 1 PEEK:-2',
			'00:-210\nMTR HWI 2 PEEK:-5\r',
			'\n\nSOMETHING ELSE\nMTR ICH 3 PE',
			'EK:-1000:-1000\n',
		]) {
			res.write(chunk)
			await sleep(5)
		}
		await waitFor(() => lines.length === 3)
		expect(lines.map((l) => [l.args[0], l.args[1], l.attrs.PEEK])).toEqual([
			['HWO', '1', '-200:-210'],
			['HWI', '2', '-5'],
			['ICH', '3', '-1000:-1000'],
		])
	})

	it('reconnects after the server drops the stream, with backoff', async () => {
		const srv = await meterServer()
		const { s, lines } = stream(srv, { backoffMs: [30, 60] })
		s.start()
		await waitFor(() => srv.responses.length === 1)
		srv.responses[0].write('MTR HWI 1 PEEK:-1:-2\n')
		await waitFor(() => lines.length === 1)
		srv.responses[0].socket?.destroy()
		await waitFor(() => srv.responses.length === 2, { message: 'second request' })
		srv.responses[1].write('MTR HWI 1 PEEK:-3:-4\n')
		await waitFor(() => lines.length === 2)
		expect(lines[1].attrs.PEEK).toBe('-3:-4')
	})

	it('a response that ends normally is also reconnected', async () => {
		const srv = await meterServer()
		const { s } = stream(srv)
		s.start()
		await waitFor(() => srv.responses.length === 1)
		srv.responses[0].end()
		await waitFor(() => srv.responses.length === 2)
	})

	it('non-200 answers (wrong password) are logged and retried', async () => {
		const srv = await meterServer()
		srv.failWith.push(401, 401)
		const { s, logs } = stream(srv, { backoffMs: [20] })
		s.start()
		await waitFor(() => srv.responses.length === 1, { message: 'third request streams', timeoutMs: 600 })
		expect(srv.requests).toHaveLength(3)
		// logged once as a warning, the identical retries stay at debug level
		expect(logs.filter((l) => l.startsWith('warn') && l.includes('status 401'))).toHaveLength(1)
		expect(logs.filter((l) => l.includes('status 401'))).toHaveLength(2)
	})

	it('a stream that goes silent is dropped and reconnected', async () => {
		const srv = await meterServer()
		const { s, logs } = stream(srv, { stallMs: 80 })
		s.start()
		await waitFor(() => srv.responses.length === 1)
		await waitFor(() => srv.responses.length === 2, { message: 'reconnect after the stall' })
		expect(logs.some((l) => l.startsWith('warn') && l.includes('no data'))).toBe(true)
	})

	it('connection refused is retried until the server comes back', async () => {
		const srv = await meterServer()
		const port = srv.port
		await srv.close()
		const lines: LwrpLine[] = []
		const s = new HttpMeterStream({
			host: '127.0.0.1',
			port,
			password: '',
			intervalMs: 100,
			backoffMs: [20],
			onLine: (l) => lines.push(l),
		})
		cleanups.push(() => s.stop())
		s.start()
		await sleep(80)
		const revived = http.createServer((_req, res) => {
			res.writeHead(200)
			res.write('MTR OCH 1 PEEK:-7:-8\n')
		})
		cleanups.push(async () => {
			revived.closeAllConnections()
			await new Promise<void>((resolve) => revived.close(() => resolve()))
		})
		await new Promise<void>((resolve) => revived.listen(port, '127.0.0.1', resolve))
		await waitFor(() => lines.length === 1)
		expect(lines[0].args).toEqual(['OCH', '1'])
	})

	it('stop() closes the request, cancels the pending reconnect and nothing is delivered afterwards', async () => {
		const srv = await meterServer()
		const { s, lines } = stream(srv, { backoffMs: [30] })
		s.start()
		await waitFor(() => srv.responses.length === 1)
		const closed = new Promise<void>((resolve) => srv.requests[0].socket.once('close', () => resolve()))
		s.stop()
		await closed
		await sleep(120)
		expect(srv.requests).toHaveLength(1)
		expect(lines).toHaveLength(0)
	})

	it('stop() during the backoff wait prevents the next attempt', async () => {
		const srv = await meterServer()
		const { s } = stream(srv, { backoffMs: [80] })
		s.start()
		await waitFor(() => srv.responses.length === 1)
		srv.responses[0].socket?.destroy()
		await sleep(20)
		s.stop()
		await sleep(200)
		expect(srv.requests).toHaveLength(1)
	})

	it('start() twice opens one stream; start() after stop() works again', async () => {
		const srv = await meterServer()
		const { s } = stream(srv)
		s.start()
		s.start()
		await waitFor(() => srv.requests.length === 1)
		await sleep(40)
		expect(srv.requests).toHaveLength(1)
		s.stop()
		s.start()
		await waitFor(() => srv.requests.length === 2)
	})

	it('a peer that sends a huge line without newline does not grow memory without bound and recovers', async () => {
		const srv = await meterServer()
		const { s, lines } = stream(srv)
		s.start()
		await waitFor(() => srv.responses.length === 1)
		srv.responses[0].write('x'.repeat(70_000))
		await sleep(30)
		srv.responses[0].write('\nMTR ICH 1 PEEK:-9:-9\n')
		await waitFor(() => lines.length >= 1)
		expect(lines.at(-1)?.attrs.PEEK).toBe('-9:-9')
	})
})
