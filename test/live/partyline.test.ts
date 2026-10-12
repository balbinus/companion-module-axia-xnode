/**
 * Live check of the source discovery on a real Livewire network. Skipped unless PARTYLINE_LIVE=1.
 *   PARTYLINE_IFACE   optional: IP of the local network interface to join the group on (default: the system's)
 * Receive-only: it only listens to 239.192.255.3:4001, nothing is ever sent. Keepalives come every 10-20 s and full
 * adverts about every 150 s, so a source can take that long to show up: the test waits up to ~200 s for one.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { SourceDiscovery } from '../../src/device/discovery.js'
import { waitFor } from '../helpers/wait-for.js'

const LIVE = process.env.PARTYLINE_LIVE === '1'
const IFACE = process.env.PARTYLINE_IFACE?.trim() || undefined

const DEVICE_WAIT_MS = 60_000
const SOURCES_WAIT_MS = 200_000

describe.skipIf(!LIVE)('live partyline discovery', () => {
	const logs: string[] = []
	const events: string[] = []
	const discovery = new SourceDiscovery({
		interfaceIp: IFACE,
		log: (level, msg) => logs.push(`${level}: ${msg}`),
		timings: { sourcesDebounceMs: 200, usageDebounceMs: 50 },
	})
	discovery.on('sources', () => events.push('sources'))
	discovery.on('usage', () => events.push('usage'))

	afterAll(async () => {
		await discovery.stop()
	})

	it('joins the group and hears at least one device', async () => {
		discovery.start()
		await waitFor(() => discovery.directory.deviceCount() > 0, {
			timeoutMs: DEVICE_WAIT_MS,
			intervalMs: 250,
			message: `no advert in ${DEVICE_WAIT_MS / 1000} s (interface ${IFACE ?? 'default'}; logs: ${logs.join(' | ')})`,
		})
		expect(logs.some((l) => l.startsWith('info: Listening for Livewire adverts on 239.192.255.3:4001'))).toBe(true)
		expect(logs.filter((l) => l.startsWith('warn:'))).toEqual([])
	}, 90_000)

	it(
		'learns the sources of the network from a full advert',
		async () => {
			const sources = await waitFor(
				() => {
					const list = discovery.directory.sources()
					return list.length > 0 ? list : undefined
				},
				{
					timeoutMs: SOURCES_WAIT_MS,
					intervalMs: 500,
					message: `no source in ${SOURCES_WAIT_MS / 1000} s (devices heard: ${discovery.directory.deviceCount()})`,
				},
			)
			for (const s of sources) {
				expect(s.channel).toBeGreaterThanOrEqual(1)
				expect(s.deviceIp).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)
			}
			await waitFor(() => events.includes('sources'), { timeoutMs: 5000, message: "no 'sources' event" })
			console.info(
				`partyline: ${discovery.directory.deviceCount()} devices, ${sources.length} sources, e.g. ${sources
					.slice(0, 3)
					.map((s) => `${s.channel} "${s.name}" (${s.deviceName})`)
					.join(', ')}`,
			)
		},
		SOURCES_WAIT_MS + 30_000,
	)

	it('stops cleanly and forgets everything', async () => {
		await discovery.stop()
		expect(discovery.directory.deviceCount()).toBe(0)
		expect(discovery.directory.sources()).toEqual([])
		const seen = events.length
		await new Promise((resolve) => setTimeout(resolve, 1000))
		expect(events.length).toBe(seen)
		await discovery.stop() // idempotent
	})
})
