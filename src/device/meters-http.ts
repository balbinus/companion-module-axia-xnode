import http from 'node:http'
import { parseLine, type LwrpLine } from '../lwrp/parser.js'

/**
 * Streams `GET /nph-cgi_mtr?duration=-1&interval=<ms>` (the web UI meter feed): an endless HTTP/1.0 body of
 * `MTR HWO|HWI|ICH|OCH n PEEK:L:R` lines, preceded by blank padding. This is the only source of hardware
 * input/output meters on legacy xNodes. Basic auth is `user:<password>`.
 */

export interface HttpMeterOptions {
	host: string
	port?: number
	password: string
	intervalMs: number
	onLine: (line: LwrpLine) => void
	log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
	/** Reconnect delays, last repeats */
	backoffMs?: number[]
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 30_000]

export class HttpMeterStream {
	private req: http.ClientRequest | null = null
	private timer: NodeJS.Timeout | undefined
	private stopped = true
	private attempt = 0

	constructor(private readonly options: HttpMeterOptions) {}

	start(): void {
		if (!this.stopped) return
		this.stopped = false
		this.open()
	}

	stop(): void {
		this.stopped = true
		clearTimeout(this.timer)
		this.timer = undefined
		const req = this.req
		this.req = null
		req?.destroy()
	}

	private open(): void {
		if (this.stopped) return
		const { host, port = 80, password, intervalMs, onLine, log } = this.options
		const interval = Math.max(100, Math.round(intervalMs))
		let buffer = ''
		const req = http.get(
			{
				host,
				port,
				path: `/nph-cgi_mtr?duration=-1&interval=${interval}`,
				auth: `user:${password}`,
				headers: { Connection: 'close' },
			},
			(res) => {
				if (res.statusCode !== 200) {
					log?.('warn', `HTTP meter stream: status ${res.statusCode}`)
					res.destroy()
					return
				}
				this.attempt = 0
				res.setEncoding('latin1')
				res.on('data', (chunk: string) => {
					buffer += chunk
					let nl: number
					while ((nl = buffer.indexOf('\n')) !== -1) {
						const line = parseLine(buffer.slice(0, nl))
						buffer = buffer.slice(nl + 1)
						if (line && line.verb === 'MTR') onLine(line)
					}
					if (buffer.length > 65536) buffer = ''
				})
				res.on('close', () => this.scheduleReconnect(req))
			},
		)
		this.req = req
		req.on('error', (err) => {
			log?.('debug', `HTTP meter stream error: ${err.message}`)
			this.scheduleReconnect(req)
		})
	}

	private scheduleReconnect(req: http.ClientRequest): void {
		if (this.stopped || this.req !== req) return
		this.req = null
		req.destroy()
		const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF
		const delay = backoff[Math.min(this.attempt, backoff.length - 1)]
		this.attempt++
		this.timer = setTimeout(() => this.open(), delay)
	}
}
