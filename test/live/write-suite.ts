/**
 * Shared write checks for the writable lab nodes (legacy and xNode2). Registers describe/it blocks, so call it from a
 * *.test.ts file. Targets are chosen at runtime among unused objects, the start state is snapshotted, and everything is
 * restored with raw writes in afterAll (also on failure), then compared against a fresh read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LwrpError } from '../../src/device/connection.js'
import { XNodeOperations } from '../../src/device/operations.js'
import { normaliseAddr } from '../../src/lwrp/livewire.js'
import { sleep, waitFor } from '../helpers/wait-for.js'
import {
	connectRig,
	freshSnapshot,
	READ_ONLY,
	recordSends,
	restoreDevice,
	snapshotDevice,
	type DeviceSnapshot,
	type Rig,
} from './helpers.js'

export interface SuiteOptions {
	host: string | undefined
	label: string
	xnode2: boolean
}

export function registerWriteSuite({ host, label, xnode2 }: SuiteOptions): void {
	describe.skipIf(!host)(`live write: ${label}`, () => {
		let a: Rig
		let b: Rig
		let sent: string[]
		let restoreSpy: () => void
		let original: DeviceSnapshot
		let mixerOk = false
		let outRow = 0
		let srcN = 0
		let dstN = 0

		const st = (): Rig['ctrl']['state'] => a.ctrl.state
		const row = (o: number): Record<string, number> => snapshotDevice(st()).mix[String(o)] ?? {}
		/** Commands with the given prefix sent after `since` */
		const sentSince = (since: number, prefix: string): string[] =>
			sent.slice(since).filter((c) => c.startsWith(`${prefix} `) && c.trim().split(/\s+/).length >= 3)
		const gainOf = (map: 'src' | 'dst', n: number): string | undefined =>
			st()[map].get(n)?.[map === 'src' ? 'INGN' : 'OUGN']

		beforeAll(async () => {
			const rec = recordSends()
			sent = rec.sent
			restoreSpy = rec.restore
			a = await connectRig(host as string)
			b = await connectRig(host as string, READ_ONLY, { backoffMs: [200] })
			original = snapshotDevice(a.ctrl.state)
			const state = a.ctrl.state
			mixerOk = state.mixcfgMode === 0
			const rowEmpty = (o: number): boolean => (state.mix.get(o)?.size ?? 0) === 0
			const inputUsed = (i: number): boolean => [...state.mix.values()].some((r) => r.has(i))
			// SRC n feeds mixer outputs 2n-1 / 2n; DST n is mixer inputs 2n-1 / 2n
			for (let n = state.nsrc; n >= 1 && srcN === 0; n--) if (rowEmpty(2 * n - 1) && rowEmpty(2 * n)) srcN = n
			for (let n = state.ndst; n >= 1 && dstN === 0; n--) if (!inputUsed(2 * n - 1) && !inputUsed(2 * n)) dstN = n
			for (let o = 9; o <= 16 && outRow === 0; o++) {
				if (rowEmpty(o) && o !== 2 * srcN - 1 && o !== 2 * srcN) outRow = o
			}
		}, 40_000)

		afterAll(async () => {
			try {
				if (a?.ctrl.isSynced) {
					await sleep(700) // let pending pulse restores run
					await restoreDevice(a, original)
				}
			} finally {
				await a?.close()
				await b?.close()
				restoreSpy?.()
			}
		}, 40_000)

		it('starts clean: factory mode off, unused targets found', () => {
			expect(a.ctrl.syncState.partial).toBe(false)
			expect(srcN, 'unused SRC').toBeGreaterThan(0)
			expect(dstN, 'unused DST').toBeGreaterThan(0)
			if (mixerOk) expect(outRow, 'empty mixer row in 9-16').toBeGreaterThan(0)
			else console.warn(`${label}: MIXCFG MODE is ${st().mixcfgMode}, mixer write tests are skipped`)
			expect(sent.some((c) => c.startsWith('LOGIN'))).toBe(true)
		})

		describe('mixer', () => {
			it('sets, stereo-sets, clears and toggles crosspoints', async (ctx) => {
				if (!mixerOk) return ctx.skip()
				const { ops } = a
				const used = st().xpointsUsed()

				let since = sent.length
				await ops.mixSet([[outRow, 1]], -200)
				expect(row(outRow)).toEqual({ '1': -200 })
				expect(sentSince(since, 'MIX')).toEqual([`MIX ${outRow} 1:-200`])
				expect(st().xpointsUsed()).toBe(used + 1)

				since = sent.length
				await ops.mixSet(
					[
						[outRow, 1],
						[outRow, 2],
					],
					0,
				)
				expect(row(outRow)).toEqual({ '1': 0, '2': 0 })
				expect(sentSince(since, 'MIX')).toEqual([`MIX ${outRow} 1:0 2:0`])

				const pair: Array<[number, number]> = [
					[outRow, 1],
					[outRow, 2],
				]
				await ops.mixToggle(pair, -100) // all on -> clear
				expect(row(outRow)).toEqual({})
				await ops.mixToggle(pair, -100) // all off -> on at -10 dB
				expect(row(outRow)).toEqual({ '1': -100, '2': -100 })
				await ops.mixClear([[outRow, 1]])
				expect(row(outRow)).toEqual({ '2': -100 })
				await ops.mixToggle(pair, 0) // mixed -> set all
				expect(row(outRow)).toEqual({ '1': 0, '2': 0 })
				await ops.mixClear(pair)
				expect(row(outRow)).toEqual({})
				expect(st().xpointsUsed()).toBe(used)
			}, 30_000)

			it('clamps gains to the configured limits and stores the clamped value', async (ctx) => {
				if (!mixerOk) return ctx.skip()
				const { ops } = a
				await ops.mixSet([[outRow, 1]], 400)
				expect(row(outRow)).toEqual({ '1': 240 })
				await ops.mixSet([[outRow, 1]], -900)
				expect(row(outRow)).toEqual({ '1': -800 })
				await ops.mixSet([[outRow, 1]], -1000) // below the configured minimum: clamped to it
				expect(row(outRow)).toEqual({ '1': -800 })
				await ops.mixClear([[outRow, 1]])
				expect(row(outRow)).toEqual({})
			}, 30_000)

			it('coalesces an adjust burst into one MIX write', async (ctx) => {
				if (!mixerOk) return ctx.skip()
				const { ops } = a
				await ops.mixSet([[outRow, 1]], -200)
				const since = sent.length
				await Promise.all([1, 2, 3, 4, 5].map(async () => ops.mixAdjust([[outRow, 1]], 10)))
				expect(sentSince(since, 'MIX')).toEqual([`MIX ${outRow} 1:-150`])
				expect(row(outRow)).toEqual({ '1': -150 })
				// an off crosspoint is turned on at the configured minimum plus the step
				await ops.mixClear([[outRow, 1]])
				await ops.mixAdjust([[outRow, 1]], 30)
				expect(row(outRow)).toEqual({ '1': -770 })
				await ops.mixClear([[outRow, 1]])
				const before = sent.length
				await ops.mixAdjust([[outRow, 1]], -30) // off + negative: nothing to do
				expect(sentSince(before, 'MIX')).toEqual([])
			}, 30_000)

			it('routes exclusively and clears an output row', async (ctx) => {
				if (!mixerOk) return ctx.skip()
				const { ops } = a
				await ops.mixSet(
					[
						[outRow, 3],
						[outRow, 4],
					],
					-100,
				)
				const since = sent.length
				await ops.mixExclusive([[outRow, 1]], 0)
				expect(row(outRow)).toEqual({ '1': 0 })
				const writes = sentSince(since, 'MIX')
				expect(writes).toHaveLength(1)
				expect(writes[0].startsWith(`MIX ${outRow} `)).toBe(true)
				await ops.mixSet([[outRow, 5]], -300)
				const before = sent.length
				await ops.mixClearOutput([outRow])
				expect(row(outRow)).toEqual({})
				expect(sentSince(before, 'MIX')).toHaveLength(1)
				const idle = sent.length
				await ops.mixClearOutput([outRow]) // already empty: no write
				expect(sentSince(idle, 'MIX')).toEqual([])
			}, 30_000)

			it('stores and recalls a snapshot (round trip)', async (ctx) => {
				if (!mixerOk) return ctx.skip()
				const { ops } = a
				const json = await ops.mixSnapshotStore()
				const parsed = JSON.parse(json) as { v: number; devn: string; mix: Record<string, Record<string, number>> }
				expect(parsed.devn).toBe(st().ver.DEVN)
				expect(Object.keys(parsed.mix)).toHaveLength(st().ioMap.outputs.length)
				const baseline = snapshotDevice(st()).mix

				await ops.mixSet(
					[
						[outRow, 1],
						[outRow, 2],
					],
					-50,
				)
				expect(row(outRow)).toEqual({ '1': -50, '2': -50 })
				const since = sent.length
				expect(await ops.mixSnapshotRecall(json)).toBe(2)
				expect(row(outRow)).toEqual({})
				expect(sentSince(since, 'MIX')).toEqual([`MIX ${outRow} 1:- 2:-`])
				expect(snapshotDevice(st()).mix).toEqual(baseline)
				expect(await ops.mixSnapshotRecall(json)).toBe(0)

				await expect(ops.mixSnapshotRecall('{nope')).rejects.toThrow(/not valid JSON/)
				await expect(ops.mixSnapshotRecall(JSON.stringify({ ...parsed, devn: 'other.model' }))).rejects.toThrow(
					/another device model/,
				)
			}, 30_000)

			it('refuses invalid or forbidden mixer writes without sending anything', async (ctx) => {
				if (!mixerOk) return ctx.skip()
				const { ops } = a
				const since = sent.length
				const outCount = st().ioMap.outputs.length
				await expect(ops.mixSet([[outCount + 1, 1]], 0)).rejects.toThrow(/does not exist/)
				await expect(ops.mixSet([[outRow, 26]], 0)).rejects.toThrow(/does not exist/)
				await expect(ops.mixSet([[outRow, 1]], 1.5)).rejects.toThrow(/integer/)
				await expect(ops.mixAdjust([[outRow, 99]], 10)).rejects.toThrow(/does not exist/)
				const denied = new XNodeOperations(
					a.ctrl,
					() => ({ ...a.config, allowMixerWrites: false }),
					() => undefined,
				)
				await expect(denied.mixSet([[outRow, 1]], 0)).rejects.toThrow(/disabled/)
				await expect(denied.dstConnectAddress(dstN, '239.192.1.1')).rejects.toThrow(/disabled/)
				await expect(denied.dstGainSet(dstN, 0)).rejects.toThrow(/disabled/)
				await denied.destroy()
				expect(sent.slice(since).filter((c) => /^(MIX|DST|SRC|GPO|INP)\b/.test(c) && /[:\d] ?[-\d]/.test(c))).toEqual(
					[],
				)
				expect(row(outRow)).toEqual({})
			}, 30_000)
		})

		describe('destinations', () => {
			it('connects by channel, by address, and disconnects', async () => {
				const { ops } = a
				await ops.dstConnectChannel(dstN, 22302)
				expect(normaliseAddr(st().dst.get(dstN)?.ADDR ?? '')).toBe('239.192.87.30')
				await ops.dstConnectChannel(dstN, 22302, 'to')
				expect(normaliseAddr(st().dst.get(dstN)?.ADDR ?? '')).toBe('239.193.87.30')
				await ops.dstConnectAddress(dstN, '239.192.91.205')
				expect(normaliseAddr(st().dst.get(dstN)?.ADDR ?? '')).toBe('239.192.91.205')
				await ops.dstDisconnect(dstN)
				expect(st().dst.get(dstN)?.ADDR ?? '').toBe('')
			}, 30_000)

			it('sets gain, clamps it and coalesces an adjust burst', async () => {
				const { ops } = a
				await ops.dstGainSet(dstN, -100)
				expect(gainOf('dst', dstN)).toBe('-100')
				await ops.dstGainSet(dstN, 500)
				expect(gainOf('dst', dstN)).toBe('240')
				await ops.dstGainSet(dstN, 0)
				const since = sent.length
				await Promise.all([1, 2, 3].map(async () => ops.dstGainAdjust(dstN, -10)))
				expect(sentSince(since, 'DST')).toEqual([`DST ${dstN} OUGN:-30`])
				expect(gainOf('dst', dstN)).toBe('-30')
				await ops.dstGainSet(dstN, 0)
			}, 30_000)

			it('handles a destination gain below -72 dB (xNode2 floor -72, legacy mutes)', async () => {
				await a.ops.dstGainSet(dstN, -800)
				expect(gainOf('dst', dstN)).toBe(xnode2 ? '-720' : '-1000')
				await a.ops.dstGainSet(dstN, -720)
				expect(gainOf('dst', dstN)).toBe('-720')
				await a.ops.dstGainSet(dstN, 0)
			}, 30_000)

			it('refuses bad addresses and objects without sending', async () => {
				const { ops } = a
				const since = sent.length
				await expect(ops.dstConnectAddress(dstN, 'not-an-ip')).rejects.toThrow(/multicast/)
				await expect(ops.dstConnectAddress(dstN, '10.1.2.3')).rejects.toThrow(/multicast/)
				await expect(ops.dstConnectChannel(dstN, 0)).rejects.toThrow(/Invalid Livewire channel/)
				await expect(ops.dstConnectChannel(dstN, 40000)).rejects.toThrow(/Invalid Livewire channel/)
				await expect(ops.dstConnectChannel(st().ndst + 1, 22302)).rejects.toThrow(/does not exist/)
				await expect(ops.dstGainSet(dstN, 1.5)).rejects.toThrow(/integer/)
				expect(sentSince(since, 'DST')).toEqual([])
			}, 30_000)
		})

		describe('sources', () => {
			it('sets gain, clamps it and coalesces an adjust burst', async () => {
				const { ops } = a
				await ops.srcGainSet(srcN, -50)
				expect(gainOf('src', srcN)).toBe('-50')
				await ops.srcGainSet(srcN, 300)
				expect(gainOf('src', srcN)).toBe('240')
				await ops.srcGainSet(srcN, 0)
				const since = sent.length
				await Promise.all([1, 2, 3, 4].map(async () => ops.srcGainAdjust(srcN, 5)))
				expect(sentSince(since, 'SRC')).toEqual([`SRC ${srcN} INGN:20`])
				await ops.srcGainSet(srcN, 0)
			}, 30_000)

			it('handles a source gain below -72 dB (xNode2 floor -72, legacy mutes)', async () => {
				await a.ops.srcGainSet(srcN, -800)
				expect(gainOf('src', srcN)).toBe(xnode2 ? '-720' : '-1000')
				await a.ops.srcGainSet(srcN, -720)
				expect(gainOf('src', srcN)).toBe('-720')
				await a.ops.srcGainSet(srcN, 0)
			}, 30_000)

			it('enables, disables and toggles the stream', async () => {
				const { ops } = a
				await ops.srcEnable(srcN, 'off')
				expect(st().src.get(srcN)?.RTPE).toBe('0')
				await ops.srcEnable(srcN, 'toggle')
				expect(st().src.get(srcN)?.RTPE).toBe('1')
				await ops.srcEnable(srcN, 'toggle')
				expect(st().src.get(srcN)?.RTPE).toBe('0')
				await ops.srcEnable(srcN, 'on')
				expect(st().src.get(srcN)?.RTPE).toBe('1')
			}, 30_000)

			it('changes address (channel or multicast IP), mode and name', async () => {
				const { ops } = a
				await ops.srcSetAddress(srcN, 22399)
				expect(normaliseAddr(st().src.get(srcN)?.RTPA ?? '')).toBe('239.192.87.127')
				await ops.srcSetAddress(srcN, '239.192.55.9')
				expect(normaliseAddr(st().src.get(srcN)?.RTPA ?? '')).toBe('239.192.55.9')
				for (const mode of [240, 48, 12]) {
					await ops.srcSetMode(srcN, mode)
					expect(st().src.get(srcN)?.RTPP).toBe(String(mode))
				}
				await ops.srcRename(srcN, 'T5 live')
				expect(st().src.get(srcN)?.PSNM).toBe('T5 live')
				await ops.srcRename(srcN, 'a"b')
				expect(st().src.get(srcN)?.PSNM).toBe('ab')
			}, 30_000)

			it('refuses invalid source writes without sending', async () => {
				const { ops } = a
				const since = sent.length
				await expect(ops.srcSetAddress(srcN, 'not-an-ip')).rejects.toThrow(/neither a Livewire channel/)
				await expect(ops.srcSetAddress(srcN, '10.1.2.3')).rejects.toThrow(/neither a Livewire channel/)
				await expect(ops.srcSetAddress(srcN, 99999)).rejects.toThrow(/Invalid Livewire channel/)
				await expect(ops.srcSetMode(srcN, 7)).rejects.toThrow(/Unknown stream mode/)
				await expect(ops.srcRename(srcN, 'x'.repeat(17))).rejects.toThrow(/too long/)
				await expect(ops.srcRename(srcN, '""')).rejects.toThrow(/empty/)
				await expect(ops.srcEnable(st().nsrc + 1, 'on')).rejects.toThrow(/does not exist/)
				const denied = new XNodeOperations(
					a.ctrl,
					() => ({ ...a.config, allowSourceWrites: false }),
					() => undefined,
				)
				await expect(denied.srcGainSet(srcN, 0)).rejects.toThrow(/disabled/)
				await expect(denied.srcEnable(srcN, 'off')).rejects.toThrow(/disabled/)
				await denied.destroy()
				expect(sentSince(since, 'SRC')).toEqual([])
			}, 30_000)

			it.runIf(xnode2)(
				'the xNode2 itself rejects gains below -72 dB with ERROR 1001',
				async () => {
					await a.ops.srcGainSet(srcN, 0)
					await a.ops.dstGainSet(dstN, 0)
					await expect(
						a.ctrl.writeAndVerify(`SRC ${srcN} INGN:-730`, { verb: 'SRC', index: srcN }),
					).rejects.toBeInstanceOf(LwrpError)
					await expect(
						a.ctrl.writeAndVerify(`DST ${dstN} OUGN:-730`, { verb: 'DST', index: dstN }),
					).rejects.toBeInstanceOf(LwrpError)
					expect(gainOf('src', srcN)).toBe('0')
					expect(gainOf('dst', dstN)).toBe('0')
				},
				30_000,
			)
		})

		describe('subscriptions (second connection)', () => {
			it('pushes SRC, DST and MIX changes to another connection without it asking', async (ctx) => {
				const { ops } = a
				const other = b.ctrl.state
				await ops.srcGainSet(srcN, -70)
				await waitFor(() => other.src.get(srcN)?.INGN === '-70', {
					timeoutMs: 3000,
					message: 'SRC push to 2nd connection',
				})
				await ops.dstGainSet(dstN, -60)
				await waitFor(() => other.dst.get(dstN)?.OUGN === '-60', {
					timeoutMs: 3000,
					message: 'DST push to 2nd connection',
				})
				await ops.srcRename(srcN, 'T5 push')
				await waitFor(() => other.src.get(srcN)?.PSNM === 'T5 push', { timeoutMs: 3000, message: 'SRC name push' })
				if (mixerOk) {
					await ops.mixSet([[outRow, 3]], -123)
					await waitFor(() => other.getXpoint(outRow, 3) === -123, {
						timeoutMs: 3000,
						message: 'MIX push to 2nd connection',
					})
					await ops.mixClear([[outRow, 3]])
					await waitFor(() => other.getXpoint(outRow, 3) === undefined, { timeoutMs: 3000, message: 'MIX clear push' })
				} else ctx.skip()
				await ops.srcGainSet(srcN, 0)
				await ops.dstGainSet(dstN, 0)
				await waitFor(() => other.src.get(srcN)?.INGN === '0' && other.dst.get(dstN)?.OUGN === '0', { timeoutMs: 3000 })
			}, 30_000)
		})

		describe.runIf(xnode2)('xNode2 GPO and microphone gain', () => {
			let port = 0
			let mic = 0

			it('finds an idle, unlinked GPO port and a microphone input', () => {
				const state = st()
				for (let n = state.ngpo; n >= 1 && port === 0; n--) {
					if (state.gpo.get(n) === 'hhhhh' && (state.cfgGpo.get(n)?.SRCA ?? '') === '') port = n
				}
				for (const [n, attrs] of state.inp) if (attrs.TYPE === 'MIC' && mic === 0) mic = n
				expect(port, 'idle GPO port').toBeGreaterThan(0)
				expect(mic, 'mic input').toBeGreaterThan(0)
			})

			it('sets, toggles and pulses GPO pins; the 2nd connection follows through ADD GPO', async (ctx) => {
				if (port === 0) return ctx.skip()
				const { ops } = a
				const other = b.ctrl.state
				const pins = (): string | undefined => st().gpo.get(port)
				const since = sent.length
				await ops.gpoSet(port, [1], true)
				expect(pins()).toBe('lhhhh')
				expect(sentSince(since, 'GPO')).toEqual([`GPO ${port} lhhhh`])
				await waitFor(() => other.gpo.get(port) === 'lhhhh', { timeoutMs: 3000, message: 'GPO push to 2nd connection' })
				await ops.gpoSet(port, [1], true) // no change: no write
				expect(sentSince(since, 'GPO')).toHaveLength(1)
				await ops.gpoSet(port, [1, 3], true)
				expect(pins()).toBe('lhlhh')
				await ops.gpoToggle(port, [1, 2])
				expect(pins()).toBe('hllhh')
				await ops.gpoSet(port, [2, 3], false)
				expect(pins()).toBe('hhhhh')
				await waitFor(() => other.gpo.get(port) === 'hhhhh', { timeoutMs: 3000, message: 'GPO release push' })

				await ops.gpoPulse(port, [4], 300)
				expect(pins()).toBe('hhhlh')
				await waitFor(() => pins() === 'hhhhh', { timeoutMs: 4000, message: 'pulse restore' })
				await waitFor(() => other.gpo.get(port) === 'hhhhh', { timeoutMs: 3000 })
			}, 30_000)

			it('refuses invalid GPO operations without sending', async (ctx) => {
				if (port === 0) return ctx.skip()
				const { ops } = a
				const since = sent.length
				await expect(ops.gpoSet(port, [6], true)).rejects.toThrow(/pin 6 does not exist/)
				await expect(ops.gpoSet(port, [], true)).rejects.toThrow(/No GPO pin/)
				await expect(ops.gpoSet(st().ngpo + 1, [1], true)).rejects.toThrow(/does not exist/)
				await expect(ops.gpoPulse(port, [1], 5)).rejects.toThrow(/Pulse length/)
				const denied = new XNodeOperations(
					a.ctrl,
					() => ({ ...a.config, allowGpoWrites: false }),
					() => undefined,
				)
				await expect(denied.gpoSet(port, [1], true)).rejects.toThrow(/disabled/)
				await denied.destroy()
				expect(sentSince(since, 'GPO')).toEqual([])
			}, 30_000)

			it('sets mic gain, applying the node snap rules (0 or 140...690)', async (ctx) => {
				if (mic === 0) return ctx.skip()
				const { ops } = a
				const gain = (): string | undefined => st().inp.get(mic)?.GAIN
				await ops.micGainSet(mic, 210)
				expect(gain()).toBe('210')
				await waitFor(() => b.ctrl.state.inp.get(mic)?.GAIN === '210', {
					timeoutMs: 3000,
					message: 'INP push to 2nd connection',
				})
				await ops.micGainSet(mic, 100) // 70...139 snap up to 140
				expect(gain()).toBe('140')
				await ops.micGainSet(mic, 60) // below 70: 0
				expect(gain()).toBe('0')
				await ops.micGainSet(mic, 5000) // clamp
				expect(gain()).toBe('690')
				await ops.micGainSet(mic, 200)
				const since = sent.length
				await Promise.all([1, 2, 3].map(async () => ops.micGainAdjust(mic, 10)))
				expect(sentSince(since, 'INP')).toEqual([`INP ${mic} GAIN:230`])
				expect(gain()).toBe('230')
				await ops.micGainSet(mic, 0)
				expect(gain()).toBe('0')
				await ops.micGainAdjust(mic, 10) // from 0 the first step jumps to the minimum
				expect(gain()).toBe('140')
				await ops.micGainSet(mic, 0)
			}, 30_000)

			it('the node itself resets mic gains below 140 to 0 and clamps above 690', async (ctx) => {
				if (mic === 0) return ctx.skip()
				await a.ctrl.writeAndVerify(`INP ${mic} GAIN:100`, { verb: 'INP', index: mic })
				expect(st().inp.get(mic)?.GAIN).toBe('0')
				await a.ctrl.writeAndVerify(`INP ${mic} GAIN:800`, { verb: 'INP', index: mic })
				expect(st().inp.get(mic)?.GAIN).toBe('690')
				await a.ctrl.writeAndVerify(`INP ${mic} GAIN:0`, { verb: 'INP', index: mic })
				expect(st().inp.get(mic)?.GAIN).toBe('0')
			}, 30_000)

			it('refuses mic gain on a non-mic input and without permission', async (ctx) => {
				if (mic === 0) return ctx.skip()
				const { ops } = a
				const since = sent.length
				await expect(ops.micGainSet(1, 200)).rejects.toThrow(/not a microphone input/)
				const denied = new XNodeOperations(
					a.ctrl,
					() => ({ ...a.config, allowSourceWrites: false }),
					() => undefined,
				)
				await expect(denied.micGainSet(mic, 200)).rejects.toThrow(/disabled/)
				await denied.destroy()
				expect(sentSince(since, 'INP')).toEqual([])
			}, 30_000)
		})

		describe.runIf(!xnode2)('legacy node specifics', () => {
			it('has no mic input and refuses mic gain; no INP command is ever sent', async () => {
				await expect(a.ops.micGainSet(5, 200)).rejects.toThrow(/not a microphone input/)
				await expect(a.ops.gpoSet(1, [1], true)).rejects.toThrow(/no GPO objects/)
				expect(sent.filter((c) => /\bINP\b/i.test(c))).toEqual([])
			})
		})

		it('restores the start state: a fresh read equals the snapshot taken at the start', async () => {
			await sleep(700)
			await restoreDevice(a, original)
			const final = await freshSnapshot(host as string)
			expect(final).toEqual(original)
			if (!xnode2) expect(sent.filter((c) => /\bINP\b/i.test(c))).toEqual([])
		}, 30_000)
	})
}
