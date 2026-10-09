/**
 * Live, read-only checks against real nodes. Skipped unless the env vars are set:
 *   XNODE_LEGACY_HOST, XNODE_LEGACY_RO_HOST (never written to), XNODE2_HOST
 * No write toggle is ever on here, so the module never sends LOGIN or any write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ControllerStatus } from '../../src/device/controller.js'
import {
	computeVariableValues,
	evaluateDstConnected,
	evaluateFactoryMode,
	evaluateGpioActive,
	evaluateSrcEnabled,
	evaluateXpointActive,
	evaluateXpointBudget,
} from '../../src/model/derived.js'
import { waitFor } from '../helpers/wait-for.js'
import {
	connectRig,
	dropSocket,
	LEGACY_HOST,
	LEGACY_RO_HOST,
	READ_ONLY,
	recordSends,
	XNODE2_HOST,
	type Rig,
} from './helpers.js'

/** Queries the module may send in read-only mode (anything else, in particular a write verb, fails the test). */
const READ_ONLY_COMMANDS =
	/^(VER|IP|SET|SRC( \d+)?|DST( \d+)?|MIXCFG|MIX( \d+)?|INP( \d+)?|CFG GPO|ADD GPO|ADD GPI|GPO( \d+)?|GPI( \d+)?|MTR|LVL (ICH|OCH|HWI|HWO) \d+)$/

const targets: Array<[string, string | undefined, boolean]> = [
	['legacy node (writable one, read-only use)', LEGACY_HOST, false],
	['legacy node (read-only unit)', LEGACY_RO_HOST, false],
	['xNode2 (read-only use)', XNODE2_HOST, true],
]

for (const [label, host, xnode2] of targets) {
	describe.skipIf(!host)(`live read-only: ${label}`, () => {
		let rig: Rig
		let sent: string[]
		let restoreSpy: () => void
		const statuses: ControllerStatus[] = []
		let syncedEvents = 0

		beforeAll(async () => {
			const rec = recordSends()
			sent = rec.sent
			restoreSpy = rec.restore
			const cfg = { ...READ_ONLY, host: host as string }
			rig = await connectRig(host as string, cfg, { heartbeatMs: 400 })
			rig.ctrl.on('status', (s) => statuses.push(s))
			rig.ctrl.on('synced', () => syncedEvents++)
		}, 30_000)

		afterAll(async () => {
			await rig?.close()
			restoreSpy?.()
		})

		it('completes the sync without a partial model and detects the generation', () => {
			const { ctrl } = rig
			const st = ctrl.state
			expect(ctrl.status).toBe('ok')
			expect(ctrl.syncState.partial).toBe(false)
			expect(st.isXNode2).toBe(xnode2)
			expect(st.ver.DEVN).toMatch(xnode2 ? /^axiaxnode2\./i : /^axiaxnode\./i)
			expect(st.ver.LWRP).toMatch(xnode2 ? /^1\.[4-9]/ : /^1\.[0-3]/)
			expect(st.ip.addr).toBe(host)
			expect(st.ip.hostname).toBeTruthy()
		})

		it('has SRC / DST / MIX rows matching the VER counts', () => {
			const st = rig.ctrl.state
			expect(st.nsrc).toBeGreaterThan(0)
			expect(st.src.size).toBe(st.nsrc)
			expect(st.dst.size).toBe(st.ndst)
			expect(st.hasMixer).toBe(true)
			expect(st.mix.size).toBe(st.nmix)
			for (let n = 1; n <= st.nmix; n++) expect(st.mix.has(n)).toBe(true)
			expect(st.mixcfgMode).toBeTypeOf('number')
			expect(st.xpointsUsed()).toBeGreaterThan(0)
			expect(st.xpointsUsed()).toBeLessThanOrEqual(220)
			for (let n = 1; n <= st.nsrc; n++) {
				expect(st.src.get(n)?.PSNM, `SRC ${n} PSNM`).toBeDefined()
				expect(st.src.get(n)?.RTPE, `SRC ${n} RTPE`).toMatch(/^[01]$/)
			}
			for (let n = 1; n <= st.ndst; n++) expect(st.dst.get(n)?.NAME, `DST ${n} NAME`).toBeDefined()
		})

		it(xnode2 ? 'reads INP, GPI, GPO and CFG GPO on the xNode2' : 'has no INP / GPIO on a legacy analog node', () => {
			const st = rig.ctrl.state
			if (xnode2) {
				expect(st.ninp).toBeGreaterThan(0)
				expect(st.inp.size).toBe(st.ninp)
				expect(st.ngpo).toBeGreaterThan(0)
				for (let n = 1; n <= st.ngpo; n++) {
					expect(st.gpo.get(n), `GPO ${n}`).toMatch(/^[hl]{5}$/)
					expect(st.cfgGpo.has(n)).toBe(true)
				}
				for (let n = 1; n <= st.ngpi; n++) expect(st.gpi.get(n), `GPI ${n}`).toMatch(/^[hl]{5}$/)
				expect([...st.inp.values()].some((a) => a.TYPE === 'MIC' && a.GAIN !== undefined)).toBe(true)
			} else {
				expect(st.ninp).toBe(0)
				expect(st.inp.size).toBe(0)
				expect(st.ngpi + st.ngpo).toBe(0)
			}
		})

		it('derives sane variables and feedback values', () => {
			const { ctrl } = rig
			const st = ctrl.state
			const vars = computeVariableValues(st, READ_ONLY, ctrl.levelsReady)
			expect(vars.model).toBe(st.ver.MODEL)
			expect(vars.devn).toBe(st.ver.DEVN)
			expect(vars.ip).toBe(host)
			expect(vars.link).toBe('up')
			expect(vars.xpoints_used).toBe(st.xpointsUsed())
			expect(vars.mixer_mode).toBeTypeOf('string')
			for (let n = 1; n <= st.nsrc; n++) {
				expect(vars[`src_${n}_name`]).toBe(st.src.get(n)?.PSNM)
				expect(vars[`src_${n}_enabled`]).toBe(st.src.get(n)?.RTPE === '1' ? 'on' : 'off')
				expect(vars[`src_${n}_mode`]).toBeTruthy()
			}
			for (let n = 1; n <= st.ndst; n++) expect(vars[`dst_${n}_name`]).toBe(st.dst.get(n)?.NAME)
			for (const out of st.ioMap.outputs) expect(vars[`mix_out_${out.number}_inputs`]).toBeTypeOf('string')
			if (xnode2) {
				for (const [n, attrs] of st.inp) expect(vars[`inp_${n}_name`]).toBe(attrs.NAME)
				expect(vars.gpo_1).toBe(st.gpo.get(1))
			} else {
				expect(vars.set_nid).toBeTypeOf('string')
				expect(Object.keys(vars).some((k) => k.startsWith('inp_'))).toBe(false)
			}

			// Feedback evaluators agree with the raw state
			expect(evaluateFactoryMode(st)).toBe(st.mixcfgMode !== 0)
			expect(evaluateXpointBudget(st, 220)).toBe(false)
			expect(evaluateXpointBudget(st, 1)).toBe(true)
			let checkedOn = 0
			let checkedOff = 0
			for (const [out, row] of st.mix) {
				for (const input of st.ioMap.inputs) {
					const on = (row.get(input.number) ?? -1000) > -1000
					expect(evaluateXpointActive(st, [[out, input.number]], 'any', 0)).toBe(on)
					if (on) checkedOn++
					else checkedOff++
				}
			}
			expect(checkedOn).toBe(st.xpointsUsed())
			expect(checkedOff).toBeGreaterThan(0)
			for (let n = 1; n <= st.nsrc; n++) expect(evaluateSrcEnabled(st, n)).toBe(st.src.get(n)?.RTPE === '1')
			for (let n = 1; n <= st.ndst; n++)
				expect(evaluateDstConnected(st, n)).toBe((st.dst.get(n)?.ADDR ?? '').trim() !== '')
			if (xnode2) expect(evaluateGpioActive(st.gpo.get(1), 1)).toBe(st.gpo.get(1)?.[0] === 'l')
		})

		it('shows 0.0 as the source gain when INGN was never set', () => {
			const st = rig.ctrl.state
			const vars = computeVariableValues(st, READ_ONLY, true)
			for (let n = 1; n <= st.nsrc; n++) expect(vars[`src_${n}_gain`], `SRC ${n}`).toMatch(/^(0\.0|[+-]\d+\.\d)$/)
		})

		it('becomes levelsReady about 3 s after the LVL subscriptions, with signal states', async () => {
			const { ctrl } = rig
			await waitFor(() => ctrl.levelsReady, { timeoutMs: 8000, message: 'levelsReady' })
			const st = ctrl.state
			// LVL answers are pushed asynchronously; wait until every channel has reported at least once
			await waitFor(
				() => {
					for (let n = 1; n <= st.nsrc; n++) if (!st.lvl.ICH.get(n)) return false
					for (let n = 1; n <= st.ndst; n++) if (!st.lvl.OCH.get(n)) return false
					return true
				},
				{ timeoutMs: 8000, message: 'LVL ICH/OCH reports' },
			)
			const vars = computeVariableValues(st, READ_ONLY, true)
			for (let n = 1; n <= st.nsrc; n++)
				expect(['ok', 'low', 'clip'], `src_${n}_signal`).toContain(vars[`src_${n}_signal`])
			for (let n = 1; n <= st.ndst; n++)
				expect(['ok', 'low', 'clip'], `dst_${n}_signal`).toContain(vars[`dst_${n}_signal`])
			if (xnode2) {
				await waitFor(() => st.lvl.HWI.size > 0 && st.lvl.HWO.size > 0, { timeoutMs: 8000, message: 'HWI/HWO LVL' })
				expect(['ok', 'low', 'clip']).toContain(vars.hwi_1_signal)
				expect(['ok', 'low', 'clip']).toContain(vars.hwo_1_signal)
			}
		})

		it('sends heartbeat VER queries', async () => {
			const before = sent.filter((c) => c === 'VER').length
			await waitFor(() => sent.filter((c) => c === 'VER').length >= before + 2, {
				timeoutMs: 5000,
				message: 'two heartbeat VER queries',
			})
		})

		it('reconnects and resyncs after a forced socket drop', async () => {
			const { ctrl } = rig
			const syncedBefore = syncedEvents
			const statusBefore = statuses.length
			const snapshot = JSON.stringify([...ctrl.state.mix])
			dropSocket(ctrl)
			await waitFor(() => statuses.slice(statusBefore).includes('connection_failure'), {
				timeoutMs: 3000,
				message: 'connection_failure status',
			})
			await waitFor(() => ctrl.isSynced && syncedEvents > syncedBefore, {
				timeoutMs: 15_000,
				message: 'resync after reconnect',
			})
			expect(ctrl.status).toBe('ok')
			expect(ctrl.syncState.partial).toBe(false)
			expect(JSON.stringify([...ctrl.state.mix])).toBe(snapshot)
			await waitFor(() => ctrl.levelsReady, { timeoutMs: 8000, message: 'levelsReady after reconnect' })
		}, 40_000)

		it('only ever sent read queries (no LOGIN, no write verbs)', () => {
			const unexpected = sent.filter((c) => !READ_ONLY_COMMANDS.test(c))
			expect(unexpected).toEqual([])
		})

		it.runIf(!xnode2)('never sent INP or PROXY INP to the legacy node', () => {
			expect(sent.filter((c) => /\bINP\b/i.test(c))).toEqual([])
		})
	})
}
