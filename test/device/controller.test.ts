import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { LwrpConnectionError, LwrpError } from '../../src/device/connection.js'
import {
	XNodeController,
	type ControllerConfig,
	type ControllerStatus,
	type ControllerTimings,
} from '../../src/device/controller.js'
import type { StateChange } from '../../src/model/state.js'
import { MockXNode, makeDump, type Dialect, type MockOptions } from '../helpers/mock-xnode.js'
import { sleep, stays, waitFor } from '../helpers/wait-for.js'

const FAST: Partial<ControllerTimings> = {
	queryTimeoutMs: 400,
	heartbeatMs: 60_000,
	resyncMs: 60_000,
	levelsReadyMs: 150,
	lvlPaceMs: 1,
	backoffMs: [30, 60],
	connectTimeoutMs: 500,
	listQuietMs: 50,
}

const BASE_CONFIG: ControllerConfig = {
	host: '127.0.0.1',
	port: 93,
	password: '',
	allowMixerWrites: false,
	allowSourceWrites: false,
	allowLeaveFactoryMode: false,
	allowGpoWrites: false,
	meterMode: 'off',
	meterInterval: 500,
	levelAlerts: true,
}

interface Rig {
	mock: MockXNode
	ctrl: XNodeController
	statuses: Array<{ status: ControllerStatus; message: string | undefined; at: number }>
	changes: StateChange[]
	synced: boolean[]
	logs: string[]
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

async function startMock(options: MockOptions = {}): Promise<MockXNode> {
	const mock = await MockXNode.start({ lvlDelayMs: 5, lowDelayMs: 60, ...options })
	cleanups.push(async () => mock.stop())
	return mock
}

function makeCtrl(
	mock: MockXNode,
	config: Partial<ControllerConfig> = {},
	timings: Partial<ControllerTimings> = {},
): Rig {
	const statuses: Rig['statuses'] = []
	const changes: StateChange[] = []
	const synced: boolean[] = []
	const logs: string[] = []
	const ctrl = new XNodeController({ ...BASE_CONFIG, port: mock.port, ...config }, (l, m) => logs.push(`${l}: ${m}`), {
		...FAST,
		...timings,
	})
	ctrl.on('status', (status, message) => statuses.push({ status, message, at: Date.now() }))
	ctrl.on('change', (c) => changes.push(c))
	ctrl.on('synced', (c) => synced.push(c))
	cleanups.push(() => ctrl.destroy())
	return { mock, ctrl, statuses, changes, synced, logs }
}

async function started(
	dialect: Dialect,
	config: Partial<ControllerConfig> = {},
	timings: Partial<ControllerTimings> = {},
	mockOptions: MockOptions = {},
): Promise<Rig> {
	const mock = await startMock({ dialect, ...mockOptions })
	const rig = makeCtrl(mock, config, timings)
	rig.ctrl.start()
	await waitFor(() => rig.synced.length >= 1, { message: 'initial sync' })
	return rig
}

const statusNames = (r: Rig): ControllerStatus[] => r.statuses.map((s) => s.status)

describe('full sync', () => {
	it('xNode2: loads everything, subscribes, sends no LOGIN and nothing forbidden', async () => {
		const { mock, ctrl, statuses, synced } = await started('xnode2')
		const st = ctrl.state
		expect(synced).toEqual([true])
		expect(ctrl.status).toBe('ok')
		expect(statuses.map((s) => s.status)).toEqual(['connecting', 'ok'])
		expect(ctrl.isSynced).toBe(true)
		expect(st.isXNode2).toBe(true)
		expect([st.src.size, st.dst.size, st.mix.size, st.inp.size]).toEqual([8, 8, 24, 5])
		expect([st.gpi.size, st.gpo.size, st.cfgGpo.size]).toEqual([2, 2, 2])
		expect(st.mixcfgMode).toBe(5)
		expect(st.ip).toMatchObject({ addr: '192.0.2.25', link: true, hostname: 'xnode2-000001' })
		expect(st.getXpoint(1, 17)).toBe(0)
		expect(st.mix.get(11)?.size).toBe(0)
		expect(st.srcName(3)).toBe('Sender3')
		expect(st.inpName(5)).toBe('Microphone 5')
		expect(st.gpo.get(1)).toBe('hhhhh')

		const sync = mock.lines().filter((l) => !l.startsWith('LVL'))
		expect(sync).toEqual(['VER', 'IP', 'SET', 'SRC', 'DST', 'MIXCFG', 'MIX', 'INP', 'CFG GPO', 'ADD GPO', 'ADD GPI'])
		expect(mock.lines('LOGIN')).toEqual([])
		expect(mock.violations()).toEqual([])
		// subscribed to everything it needs
		for (const key of ['SRC 1', 'DST 8', 'MIX 24', 'MIXCFG', 'INP 5']) expect(mock.subscribers(key)).toBe(1)
	})

	it('legacy: loads the unwrapped MIX list, never sends INP (despite VER INP:1) nor GPIO', async () => {
		const { mock, ctrl, synced } = await started('legacy')
		const st = ctrl.state
		expect(mock.ver.INP).toBe('1') // the bogus attribute is really there
		expect(synced).toEqual([true])
		expect(st.isXNode2).toBe(false)
		expect(st.ninp).toBe(0)
		expect([st.src.size, st.dst.size, st.mix.size, st.inp.size]).toEqual([8, 8, 24, 0])
		expect(st.mix.get(12)?.get(10)).toBe(-100)
		expect(st.mix.get(9)?.size).toBe(0)
		expect(st.mixcfgMode).toBe(0)
		expect(st.set.NID).toBe('23/0')
		expect(mock.lines().filter((l) => !l.startsWith('LVL'))).toEqual([
			'VER',
			'IP',
			'SET',
			'SRC',
			'DST',
			'MIXCFG',
			'MIX',
		])
		expect(mock.lines('INP')).toEqual([])
		expect(mock.violations()).toEqual([])
		expect(mock.lines('MIX')).toEqual(['MIX']) // no per-row re-query: all 24 arrived
	})

	it('sends GPIO commands only when NGPI/NGPO > 0', async () => {
		const dump = makeDump('xnode2').replace('NGPI:2 NGPO:2', 'NGPI:0 NGPO:2')
		const { mock } = await started('xnode2', {}, {}, { dump })
		expect(mock.lines('ADD')).toEqual(['ADD GPO'])
		expect(mock.lines('CFG')).toEqual(['CFG GPO'])
		const none = makeDump('xnode2').replace('NGPI:2 NGPO:2', 'NGPI:0 NGPO:0')
		const b = await started('xnode2', {}, {}, { dump: none })
		expect(b.mock.lines('ADD')).toEqual([])
		expect(b.mock.lines('CFG')).toEqual([])
		expect(b.mock.lines('GPO')).toEqual([])
	})

	it('has one command in flight at a time during the sync', async () => {
		const mock = await startMock({ dialect: 'xnode2', answerDelayMs: 25 })
		const rig = makeCtrl(mock)
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		const sync = mock.commands.filter((c) => !c.line.startsWith('LVL'))
		for (let i = 1; i < sync.length; i++) expect(sync[i].at - sync[i - 1].at).toBeGreaterThanOrEqual(20)
	})

	it('a mixer-less device (no VER MIX) skips MIXCFG and MIX', async () => {
		const dump = makeDump('legacy').replace(' MIXCFG:1 MIX:24', '')
		const { mock, ctrl } = await started('legacy', {}, {}, { dump })
		expect(mock.lines('MIX')).toEqual([])
		expect(mock.lines('MIXCFG')).toEqual([])
		expect(ctrl.state.hasMixer).toBe(false)
	})
})

describe('LOGIN', () => {
	it.each(['allowMixerWrites', 'allowSourceWrites', 'allowLeaveFactoryMode', 'allowGpoWrites'] as const)(
		'is the first command when %s is on',
		async (toggle) => {
			const { mock } = await started('xnode2', { [toggle]: true, password: 'secret' })
			expect(mock.lines().slice(0, 2)).toEqual(['LOGIN secret', 'VER'])
			expect(mock.lines('LOGIN')).toHaveLength(1)
		},
	)

	it('sends an empty-password LOGIN as `LOGIN `-less line and never embeds line breaks of the password', async () => {
		const { mock } = await started('legacy', { allowMixerWrites: true, password: 'a\r\nSET NID:1' })
		const login = mock.commands.filter((c) => c.verb === 'LOGIN')
		expect(login).toHaveLength(1)
		expect(mock.commands.filter((c) => c.verb === 'SET' && c.line !== 'SET')).toEqual([])
		expect(mock.violations()).toEqual([])
	})

	it('does not send LOGIN when all toggles are off, even with a password', async () => {
		const { mock } = await started('legacy', { password: 'secret' })
		expect(mock.lines('LOGIN')).toEqual([])
	})
})

describe('completeness', () => {
	it('xNode2: re-queries SRC/DST/MIX/INP rows dropped from the lists', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		mock.dropLines('SRC 2')
		mock.dropLines('DST 5')
		mock.dropLines('MIX 7')
		mock.dropLines('MIX 24')
		mock.dropLines('INP 3')
		const rig = makeCtrl(mock)
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		expect(rig.synced).toEqual([true])
		const st = rig.ctrl.state
		expect([st.src.size, st.dst.size, st.mix.size, st.inp.size]).toEqual([8, 8, 24, 5])
		expect(mock.lines()).toEqual(expect.arrayContaining(['SRC 2', 'DST 5', 'MIX 7', 'MIX 24', 'INP 3']))
		expect(mock.lines('SRC')).toEqual(['SRC', 'SRC 2']) // only the missing one
		expect(rig.ctrl.status).toBe('ok')
	})

	it('legacy: a missing unwrapped MIX row is found by the quiet gap and re-queried', async () => {
		const mock = await startMock({ dialect: 'legacy' })
		mock.dropLines('MIX 7')
		const rig = makeCtrl(mock)
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		expect(rig.synced).toEqual([true])
		expect(rig.ctrl.state.getXpoint(7, 23)).toBe(0)
		expect(mock.lines('MIX')).toEqual(['MIX', 'MIX 7'])
	})

	it('an item that can never be read yields a partial sync: synced(false) and status warning, not a failure', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		mock.dropLines('SRC 4', Infinity, true)
		const rig = makeCtrl(mock, {}, { queryTimeoutMs: 120 })
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		expect(rig.synced).toEqual([false])
		expect(rig.ctrl.status).toBe('warning')
		expect(rig.ctrl.syncState.partial).toBe(true)
		expect(rig.ctrl.isSynced).toBe(true)
		expect(mock.lines('SRC').filter((l) => l === 'SRC 4')).toHaveLength(2) // bounded retries
		expect(rig.ctrl.state.src.size).toBe(7)
	})

	it('tolerates a late answer to an optional query (it arrives during the next query)', async () => {
		const mock = await startMock({ dialect: 'legacy' })
		mock.delay('SET', 250, 1)
		const rig = makeCtrl(mock, {}, { queryTimeoutMs: 120 })
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		expect(rig.synced).toEqual([true])
		await waitFor(() => rig.ctrl.state.set.NID === '23/0') // the late line was still merged
		expect(rig.ctrl.state.src.size).toBe(8)
	})

	it('copes with an xNode2 that reorders pipelined answers (reorder knob on)', async () => {
		const { ctrl, mock } = await started('xnode2', {}, {}, { reorder: true })
		expect([ctrl.state.src.size, ctrl.state.mix.size, ctrl.state.inp.size]).toEqual([8, 24, 5])
		mock.externalWrite('DST 1 NAME:"x"')
	})

	it('optional query errors (SET unsupported) do not fail the sync', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		mock.injectError('SET', 'ERROR 1000 bad command', Infinity)
		mock.injectError('IP', 'ERROR 1000 bad command', Infinity)
		const rig = makeCtrl(mock)
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		expect(rig.synced).toEqual([true])
		expect(rig.ctrl.status).toBe('ok')
	})

	it('a failed VER (ERROR) fails the attempt and the controller retries', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		mock.injectError('VER', 'ERROR 1000 bad command', 1)
		const rig = makeCtrl(mock)
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		expect(statusNames(rig)).toEqual(['connecting', 'connection_failure', 'connecting', 'ok'])
	})
})

describe('level alerts', () => {
	it('xNode2: subscribes ICH/OCH/HWI/HWO one by one, without thresholds, and reports levelsReady after the provisional window', async () => {
		const rig = await started('xnode2', {}, { levelsReadyMs: 200 })
		const { mock, ctrl } = rig
		await waitFor(() => mock.lines('LVL').length === 8 + 8 + 5 + 4)
		const lvl = mock.lines('LVL')
		expect(lvl).toEqual([
			...Array.from({ length: 8 }, (_, i) => `LVL ICH ${i + 1}`),
			...Array.from({ length: 8 }, (_, i) => `LVL OCH ${i + 1}`),
			...Array.from({ length: 5 }, (_, i) => `LVL HWI ${i + 1}`),
			...Array.from({ length: 4 }, (_, i) => `LVL HWO ${i + 1}`),
		])
		expect(mock.violations()).toEqual([])
		expect(ctrl.levelsReady).toBe(false)
		await waitFor(() => ctrl.levelsReady, { message: 'levelsReady' })
		// provisional NO-LOW was followed by LOW (no audio)
		await waitFor(() => ctrl.state.lvl.ICH.get(1)?.L?.low === true)
		expect(ctrl.state.lvl.HWI.get(5)?.mono?.low).toBe(true) // mono mic uses .1
		expect(ctrl.state.lvl.HWO.get(4)?.R?.clip).toBe(false)
		expect(rig.changes.filter((c) => c.kind === 'lvl' && c.group === 'HWI').length).toBeGreaterThan(5)
	})

	it('levelsReady is only raised after the window and transitions then arrive as change events', async () => {
		const { mock, ctrl, changes } = await started('xnode2', {}, { levelsReadyMs: 120 })
		const before = Date.now()
		await waitFor(() => ctrl.levelsReady)
		expect(Date.now() - before).toBeLessThan(2000)
		changes.length = 0
		mock.setLevel('ICH', 2, 'L', { low: false })
		mock.setLevel('OCH', 3, 'R', { clip: true })
		await waitFor(() => changes.some((c) => c.kind === 'lvl' && c.group === 'OCH' && c.index === 3))
		expect(ctrl.state.lvl.ICH.get(2)?.L?.low).toBe(false)
		expect(ctrl.state.lvl.OCH.get(3)?.R?.clip).toBe(true)
	})

	it('legacy: ICH/OCH only (HWI/HWO are errors there), no thresholds', async () => {
		const { mock, ctrl } = await started('legacy')
		await waitFor(() => mock.lines('LVL').length === 16)
		expect(mock.lines('LVL').every((l) => /^LVL (ICH|OCH) \d$/.test(l))).toBe(true)
		await waitFor(() => ctrl.levelsReady)
		expect(ctrl.state.lvl.ICH.get(1)?.L?.low).toBe(true) // legacy reports the real state at once
		expect(mock.violations()).toEqual([])
	})

	// BUG: LVL subscriptions are sent outside the queue, so an ERROR answering one of them while a write is in flight rejects that write
	it.fails('an ERROR answering an LVL subscription is not attributed to a write that is in flight', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		mock.noEcho = true
		mock.injectError(/^LVL ICH 3$/, 'ERROR 1000 bad command', 1)
		const rig = makeCtrl(mock, { allowSourceWrites: true })
		let write: Promise<unknown> = Promise.resolve()
		rig.ctrl.on('synced', () => {
			write = rig.ctrl.writeAndVerify('DST 8 OUGN:-100', { verb: 'DST', index: 8 })
		})
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		await expect(write).resolves.toBeDefined()
	})

	it('levelAlerts off: no LVL commands, levelsReady never set', async () => {
		const { mock, ctrl } = await started('xnode2', { levelAlerts: false })
		await sleep(80)
		expect(mock.lines('LVL')).toEqual([])
		expect(ctrl.levelsReady).toBe(false)
	})

	it('levelsReady drops to false when the connection is lost', async () => {
		const { mock, ctrl } = await started('xnode2')
		await waitFor(() => ctrl.levelsReady)
		await mock.down()
		await waitFor(() => !ctrl.isConnected)
		expect(ctrl.levelsReady).toBe(false)
	})
})

describe('pushes become change events', () => {
	it('SRC/DST/MIX/MIXCFG pushes from other clients update the state and are emitted once', async () => {
		const { mock, ctrl, changes } = await started('xnode2')
		changes.length = 0
		mock.externalWrite('DST 3 NAME:"Studio A"')
		await waitFor(() => ctrl.state.dstName(3) === 'Studio A')
		expect(changes).toContainEqual({ kind: 'dst', index: 3, rebuild: true })
		mock.externalWrite('SRC 2 INGN:-50')
		await waitFor(() => ctrl.state.src.get(2)?.INGN === '-50')
		expect(changes).toContainEqual({ kind: 'src', index: 2, rebuild: false })
		mock.externalWrite('MIX 9 1:-60')
		await waitFor(() => ctrl.state.getXpoint(9, 1) === -60)
		expect(ctrl.state.mixcfgMode).toBe(0) // factory mode left, MIXCFG push arrived
		expect(changes.map((c) => c.kind)).toEqual(expect.arrayContaining(['mix', 'mixcfg']))
		mock.externalWrite('MIX 9 1:-')
		await waitFor(() => ctrl.state.getXpoint(9, 1) === undefined)
		expect(ctrl.state.mix.get(9)?.size).toBe(0)
	})

	it('GPO/GPI pushes (uppercase changed pin) are lower-cased into the state', async () => {
		const { mock, ctrl, changes } = await started('xnode2')
		changes.length = 0
		mock.externalWrite('GPO 2 hhlhh')
		await waitFor(() => ctrl.state.gpo.get(2) === 'hhlhh')
		expect(changes).toContainEqual({ kind: 'gpo', index: 2, rebuild: false })
		mock.externalWrite('GPO 2 hhhhh')
		await waitFor(() => ctrl.state.gpo.get(2) === 'hhhhh')
		mock.setGpi(1, 'lhhhh')
		await waitFor(() => ctrl.state.gpi.get(1) === 'lhhhh')
		expect(ctrl.state.gpo.get(1)).toBe('hhhhh') // other ports untouched
	})

	it('legacy pushes reach us because the sync queried the objects', async () => {
		const { mock, ctrl } = await started('legacy')
		mock.externalWrite('MIX 9 3:-25')
		await waitFor(() => ctrl.state.getXpoint(9, 3) === -250 + 225)
	})

	it('an interleaved push inside a list answer is not lost', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		mock.injectIntoNextList(['DST 1 NAME:"during-list"'])
		const rig = makeCtrl(mock)
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		// the push arrived inside the SRC list; the following DST list then overwrote the name with the device value
		expect(rig.changes.some((c) => c.kind === 'dst' && c.index === 1)).toBe(true)
	})
})

describe('heartbeat, reconnect, resync', () => {
	it('detects a dead link (socket open, no answers), reconnects with backoff and resyncs', async () => {
		const { mock, ctrl, statuses, synced } = await started(
			'xnode2',
			{},
			{ heartbeatMs: 40, queryTimeoutMs: 80, backoffMs: [30, 60] },
		)
		expect(synced).toHaveLength(1)
		mock.mute = true
		await waitFor(() => statuses.some((s) => s.status === 'connection_failure'))
		expect(statuses.find((s) => s.status === 'connection_failure')?.message).toMatch(/heartbeat failed/)
		await waitFor(() => mock.commands.some((c) => c.muted && c.verb === 'VER'))
		mock.mute = false
		mock.externalWrite('DST 4 NAME:"changed while dead"') // no push while the link was dead
		await waitFor(() => synced.length >= 2, { message: 'resync after reconnect' })
		expect(ctrl.status).toBe('ok')
		expect(ctrl.state.dstName(4)).toBe('changed while dead')
		await waitFor(() => mock.connectionCount === 1) // the dead socket was closed
	})

	it('reconnects when the node closes the socket', async () => {
		const { mock, ctrl, statuses, synced } = await started('legacy')
		mock.closeConnections()
		await waitFor(() => synced.length === 2)
		expect(statusNames({ statuses } as Rig)).toEqual(['connecting', 'ok', 'connection_failure', 'connecting', 'ok'])
		expect(ctrl.status).toBe('ok')
		expect(mock.lines('LOGIN')).toEqual([])
		expect(mock.lines('VER')).toHaveLength(2)
	})

	it('after a reconnect LVL, GPIO subscriptions and meters are set up again', async () => {
		const { mock, synced } = await started('xnode2')
		await waitFor(() => mock.lines('LVL').length === 25)
		mock.clearCommands()
		mock.closeConnections()
		await waitFor(() => synced.length === 2)
		await waitFor(() => mock.lines('LVL').length === 25)
		expect(mock.lines('ADD')).toEqual(['ADD GPO', 'ADD GPI'])
	})

	it('backs off with growing delays while the node is down, then recovers', async () => {
		const { mock, ctrl, statuses, synced } = await started('xnode2', {}, { backoffMs: [40, 90] })
		await mock.down()
		await waitFor(() => statuses.filter((s) => s.status === 'connecting').length >= 4, { timeoutMs: 5000 })
		await waitFor(() => ctrl.status === 'connection_failure')
		const attempts = statuses.filter((s) => s.status === 'connecting').map((s) => s.at)
		expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(35) // 40 ms
		expect(attempts[3] - attempts[2]).toBeGreaterThanOrEqual(80) // 90 ms, repeats
		expect(ctrl.status).toBe('connection_failure')
		await mock.up()
		await waitFor(() => ctrl.status === 'ok', { timeoutMs: 5000 })
		expect(synced).toHaveLength(2)
	})

	it('a device that answers heartbeat VER with an ERROR is still considered alive', async () => {
		const { mock, statuses } = await started('xnode2', {}, { heartbeatMs: 30 })
		mock.injectError('VER', 'ERROR 1000 bad command', Infinity)
		await waitFor(() => mock.lines('VER').length >= 4)
		expect(statuses.map((s) => s.status)).toEqual(['connecting', 'ok'])
	})

	it('periodic resync repairs changes that were never pushed, without re-subscribing GPIO', async () => {
		const { mock, ctrl, synced } = await started('xnode2', {}, { resyncMs: 80 })
		mock.src.get(3)!.PSNM = 'Silent change' // changed behind the back of the subscription
		await waitFor(() => synced.length >= 2)
		await waitFor(() => ctrl.state.srcName(3) === 'Silent change')
		expect(mock.lines('ADD')).toEqual(['ADD GPO', 'ADD GPI'])
		expect(mock.lines('GPO')).toContain('GPO')
		expect(synced.every(Boolean)).toBe(true)
	})

	it('a changed VER signature on a live session triggers a reconnect and a fresh model', async () => {
		const { mock, ctrl, statuses, synced } = await started('xnode2')
		mock.loadDump(
			makeDump('xnode2')
				.replace('NSRC:8', 'NSRC:4')
				.split('\n')
				.filter((l) => !/^SRC [5-8] /.test(l))
				.join('\n'),
		)
		mock.push(
			`VER ${Object.entries(mock.ver)
				.map(([k, v]) => `${k}:"${v}"`)
				.join(' ')}`,
		)
		await waitFor(() => synced.length >= 2)
		expect(statuses.some((s) => s.message === 'device identity changed')).toBe(true)
		expect(ctrl.state.nsrc).toBe(4)
		expect(ctrl.state.src.size).toBe(4)
	})

	it('after reconnecting to a different model the old model is discarded', async () => {
		const { mock, ctrl, synced } = await started('xnode2')
		mock.loadDump(
			makeDump('xnode2')
				.replace('NSRC:8', 'NSRC:4')
				.split('\n')
				.filter((l) => !/^SRC [5-8] /.test(l))
				.join('\n'),
		)
		mock.closeConnections()
		await waitFor(() => synced.length >= 2)
		expect(ctrl.state.src.size).toBe(4)
		expect(ctrl.state.nsrc).toBe(4)
	})

	// BUG: a link that dies during the sync is only noticed after every remaining query has timed out one after the other (the heartbeat is queued behind the sync)
	it.fails('a link that dies in the middle of the initial sync is dropped after about one query timeout', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		const rig = makeCtrl(mock, {}, { queryTimeoutMs: 150 })
		rig.ctrl.start()
		await waitFor(() => mock.lines('SRC').length >= 1)
		mock.mute = true
		const t0 = Date.now()
		await waitFor(() => rig.statuses.some((s) => s.status === 'connection_failure'), { timeoutMs: 1000 })
		expect(Date.now() - t0).toBeLessThan(150 * 3)
	})

	it('startup against a closed port ends in connection_failure and keeps retrying', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		await mock.down()
		const rig = makeCtrl(mock)
		rig.ctrl.start()
		await waitFor(() => rig.statuses.filter((s) => s.status === 'connecting').length >= 3)
		await waitFor(() => rig.ctrl.status === 'connection_failure')
		expect(rig.statuses[1].status).toBe('connection_failure')
		expect(rig.synced).toEqual([])
	})
})

describe('status', () => {
	it.each([
		['empty host', { host: '' }],
		['port 0', { port: 0 }],
		['port too high', { port: 70000 }],
		['host with spaces inside', { host: 'a b' }],
	])('bad config (%s): status bad_config and no connection attempt', async (_name, cfg) => {
		const mock = await startMock({ dialect: 'xnode2' })
		const rig = makeCtrl(mock, cfg)
		rig.ctrl.start()
		expect(rig.ctrl.status).toBe('bad_config')
		expect(rig.statuses.map((s) => s.status)).toEqual(['bad_config'])
		await sleep(40)
		expect(mock.connectionCount).toBe(0)
		expect(mock.commands).toEqual([])
		await expect(rig.ctrl.writeAndVerify('DST 1 OUGN:0', { verb: 'DST', index: 1 })).rejects.toBeInstanceOf(
			LwrpConnectionError,
		)
	})

	it('start() is idempotent', async () => {
		const mock = await startMock({ dialect: 'legacy' })
		const rig = makeCtrl(mock)
		rig.ctrl.start()
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		expect(mock.lines('VER')).toHaveLength(1)
	})

	it('connecting -> ok, with isConnected/isSynced reflecting it', async () => {
		const mock = await startMock({ dialect: 'xnode2', answerDelayMs: 30 })
		const rig = makeCtrl(mock)
		expect(rig.ctrl.status).toBe('connecting')
		rig.ctrl.start()
		await waitFor(() => rig.ctrl.isConnected)
		expect(rig.ctrl.isSynced).toBe(false)
		await waitFor(() => rig.ctrl.isSynced)
		expect(statusNames(rig)).toEqual(['connecting', 'ok'])
	})
})

describe('writeAndVerify', () => {
	it('requires a connection', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		const rig = makeCtrl(mock)
		await expect(rig.ctrl.writeAndVerify('DST 1 OUGN:0', { verb: 'DST', index: 1 })).rejects.toBeInstanceOf(
			LwrpConnectionError,
		)
		expect(mock.commands).toEqual([])
	})

	it('xNode2: echo arrives, then the object is re-queried and the verified line is returned', async () => {
		const { mock, ctrl } = await started('xnode2', { allowSourceWrites: true })
		await waitFor(() => ctrl.levelsReady)
		mock.clearCommands()
		const line = await ctrl.writeAndVerify('DST 8 OUGN:-100', { verb: 'DST', index: 8 })
		expect(line?.attrs.OUGN).toBe('-100')
		expect(mock.lines()).toEqual(['DST 8 OUGN:-100', 'DST 8'])
		expect(ctrl.state.dst.get(8)?.OUGN).toBe('-100')
	})

	it('no echo (legacy behaviour): waits the echo window, then the re-query returns the new state', async () => {
		const { mock, ctrl } = await started('legacy', { allowMixerWrites: true })
		mock.noEcho = true
		const t0 = Date.now()
		const line = await ctrl.writeAndVerify('MIX 9 1:-60', { verb: 'MIX', index: 9 })
		expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
		expect(line?.attrs).toEqual({ '1': '-60' })
		expect(ctrl.state.getXpoint(9, 1)).toBe(-60)
	})

	it('GPO: never echoed, short echo window, verified by re-query', async () => {
		const { ctrl, mock } = await started('xnode2', { allowGpoWrites: true })
		const t0 = Date.now()
		const line = await ctrl.writeAndVerify('GPO 1 lhhhh', { verb: 'GPO', index: 1 })
		expect(Date.now() - t0).toBeLessThan(450)
		expect(line?.args).toEqual(['1', 'lhhhh'])
		expect(ctrl.state.gpo.get(1)).toBe('lhhhh')
		expect(mock.violations()).toEqual([])
	})

	it('rethrows a device ERROR (after logging it) and still re-queries', async () => {
		const { mock, ctrl, logs } = await started('xnode2', { allowSourceWrites: true })
		await waitFor(() => ctrl.levelsReady)
		mock.clearCommands()
		await expect(ctrl.writeAndVerify('DST 8 OUGN:500', { verb: 'DST', index: 8 })).rejects.toMatchObject({
			code: 1001,
		})
		expect(mock.lines()).toEqual(['DST 8 OUGN:500', 'DST 8'])
		expect(logs.some((l) => l.startsWith('warn: write rejected'))).toBe(true)
	})

	it('a write without LOGIN (all toggles off) is rejected by the device and the error reaches the caller', async () => {
		const { ctrl } = await started('legacy')
		await expect(ctrl.writeAndVerify('SRC 1 INGN:0', { verb: 'SRC', index: 1 })).rejects.toBeInstanceOf(LwrpError)
	})

	it('writes queue behind a running resync and complete in order', async () => {
		const { ctrl, mock } = await started('xnode2', { allowMixerWrites: true }, { resyncMs: 50 })
		const results = await Promise.all([
			ctrl.writeAndVerify('MIX 9 1:-10', { verb: 'MIX', index: 9 }),
			ctrl.writeAndVerify('MIX 9 2:-20', { verb: 'MIX', index: 9 }),
			ctrl.writeAndVerify('MIX 9 3:-30', { verb: 'MIX', index: 9 }),
		])
		expect(results[2]?.attrs).toMatchObject({ '1': '-10', '2': '-20', '3': '-30' })
		expect(mock.xpoint(9, 3)).toBe(-30)
	})

	it('fails with a connection error when the link drops during the write', async () => {
		const { ctrl, mock } = await started('xnode2', { allowMixerWrites: true })
		mock.mute = true
		const p = ctrl.writeAndVerify('MIX 9 1:-10', { verb: 'MIX', index: 9 })
		await sleep(30)
		mock.closeConnections()
		await expect(p).rejects.toBeInstanceOf(Error)
	})
})

describe('meters', () => {
	it('poll mode: MTR snapshots update the state and do not starve writes', async () => {
		const { ctrl, mock } = await started('xnode2', { meterMode: 'poll', meterInterval: 100, allowMixerWrites: true })
		mock.setMeter('ICH', 1, [-123, -456])
		mock.setMeter('HWI', 5, [-300])
		await waitFor(() => ctrl.state.mtr.ICH.get(1)?.l === -123, { message: 'MTR poll' })
		expect(ctrl.state.mtr.ICH.get(1)?.r).toBe(-456)
		expect(ctrl.state.mtr.HWI.get(5)).toMatchObject({ l: -300, r: undefined })
		mock.delay('MTR', 60)
		for (let i = 0; i < 4; i++) {
			const t0 = Date.now()
			await ctrl.writeAndVerify(`MIX 9 1:${-10 - i}`, { verb: 'MIX', index: 9 })
			expect(Date.now() - t0).toBeLessThan(600)
		}
		expect(mock.xpoint(9, 1)).toBe(-13)
	})

	it('poll mode: a slow node does not accumulate MTR requests', async () => {
		const { mock } = await started('xnode2', { meterMode: 'poll', meterInterval: 100 })
		mock.delay('MTR', 350)
		mock.clearCommands()
		await sleep(900)
		expect(mock.lines('MTR').length).toBeLessThanOrEqual(4)
	})

	it('poll interval is clamped to at least 100 ms', async () => {
		const { mock } = await started('legacy', { meterMode: 'poll', meterInterval: 1 })
		mock.clearCommands()
		await sleep(450)
		expect(mock.lines('MTR').length).toBeLessThanOrEqual(5)
		expect(mock.lines('MTR').length).toBeGreaterThanOrEqual(2)
	})

	it('off mode sends no MTR', async () => {
		const { mock } = await started('xnode2')
		await sleep(150)
		expect(mock.lines('MTR')).toEqual([])
	})

	it('http mode: legacy HWI/HWO meters come from the HTTP stream and stop with destroy()', async () => {
		let requests = 0
		const server = http.createServer((req, res) => {
			requests++
			res.writeHead(200, { 'Content-Type': 'text/plain' })
			res.write(`${' '.repeat(50)}\n\nMTR HWI 1 PEEK:-200:-210\nMTR HWO `)
			res.write('2 PEEK:-300:-310\n')
			req.on('close', () => res.end())
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const httpPort = (server.address() as { port: number }).port
		cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())))
		server.closeAllConnections?.()
		const rig = await started('legacy', { meterMode: 'http', meterInterval: 100 }, { httpMeterPort: httpPort })
		await waitFor(() => rig.ctrl.state.mtr.HWI.get(1)?.l === -200)
		expect(rig.ctrl.state.mtr.HWO.get(2)).toMatchObject({ l: -300, r: -310 })
		expect(rig.mock.lines('MTR')).toEqual([]) // no TCP polling in http mode
		rig.ctrl.destroy()
		await waitFor(() => server.listening && requests >= 1)
		await sleep(60)
		const seen = requests
		await sleep(150)
		expect(requests).toBe(seen) // no reconnects after destroy
		server.closeAllConnections()
	})
})

describe('destroy', () => {
	it('closes the socket, stops every timer and sends nothing afterwards', async () => {
		const timeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
		const base = timeouts()
		const rig = await started('xnode2', { meterMode: 'poll', meterInterval: 100 }, { heartbeatMs: 30, resyncMs: 50 })
		await waitFor(() => rig.ctrl.levelsReady)
		const eventsBefore = rig.statuses.length
		rig.ctrl.destroy()
		await waitFor(() => rig.mock.connectionCount === 0)
		expect(rig.ctrl.isConnected).toBe(false)
		const count = rig.mock.commands.length
		await sleep(250) // several heartbeat / resync / poll periods
		expect(rig.mock.commands.length).toBe(count)
		expect(rig.mock.connectionCount).toBe(0)
		expect(rig.statuses.length).toBe(eventsBefore)
		expect(timeouts()).toBeLessThanOrEqual(base + 1)
	})

	it('during the LVL subscription burst: no further LVL after destroy', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		const rig = makeCtrl(mock, {}, { lvlPaceMs: 15 })
		rig.ctrl.start()
		await waitFor(() => mock.lines('LVL').length >= 2)
		rig.ctrl.destroy()
		const n = mock.lines('LVL').length
		await sleep(150)
		expect(mock.lines('LVL').length).toBeLessThanOrEqual(n + 1)
		expect(mock.lines('LVL').length).toBeLessThan(25)
		await waitFor(() => mock.connectionCount === 0)
	})

	it('while connecting to a node that never answers: socket closed, no reconnect', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		mock.mute = true
		const rig = makeCtrl(mock, {}, { queryTimeoutMs: 60 })
		rig.ctrl.start()
		await waitFor(() => mock.commands.length >= 1)
		rig.ctrl.destroy()
		await waitFor(() => mock.connectionCount === 0)
		const n = mock.commands.length
		await sleep(200)
		expect(mock.commands.length).toBe(n)
		expect(mock.connectionCount).toBe(0)
	})

	it('while waiting for a reconnect backoff: no reconnect afterwards', async () => {
		const mock = await startMock({ dialect: 'xnode2' })
		const rig = makeCtrl(mock, {}, { backoffMs: [80] })
		rig.ctrl.start()
		await waitFor(() => rig.synced.length === 1)
		mock.closeConnections()
		await waitFor(() => rig.ctrl.status === 'connection_failure')
		rig.ctrl.destroy()
		await sleep(250)
		expect(mock.connectionCount).toBe(0)
		expect(mock.lines('VER')).toHaveLength(1)
	})

	it('is idempotent, and start() after destroy does nothing', async () => {
		const mock = await startMock({ dialect: 'legacy' })
		const rig = makeCtrl(mock)
		rig.ctrl.destroy()
		rig.ctrl.destroy()
		rig.ctrl.start()
		await sleep(40)
		expect(mock.commands).toEqual([])
		expect(rig.statuses).toEqual([])
	})

	it('the stream of events is silent after destroy even if the node keeps pushing', async () => {
		const { mock, ctrl, changes } = await started('xnode2')
		ctrl.destroy()
		const n = changes.length
		mock.push(['DST 1 NAME:"late"', 'MIXCFG MODE:1'])
		await sleep(40)
		expect(changes.length).toBe(n)
		expect(ctrl.state.dstName(1)).not.toBe('late')
	})

	it('stays stopped through stays() helper', async () => {
		const { mock, ctrl } = await started('xnode2')
		ctrl.destroy()
		await waitFor(() => mock.connectionCount === 0)
		expect(await stays(() => mock.connectionCount > 0, 60)).toBe(true)
	})
})
