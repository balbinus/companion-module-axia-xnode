/**
 * Shared helpers for the live tests (real nodes, env-gated). Hosts always come from env vars.
 * Not a test file: it is only imported by the *.test.ts files in this folder.
 */
import type net from 'node:net'
import { vi } from 'vitest'
import type { ModuleConfig } from '../../src/config.js'
import { LwrpConnection } from '../../src/device/connection.js'
import { XNodeController, type ControllerTimings } from '../../src/device/controller.js'
import { XNodeOperations } from '../../src/device/operations.js'
import { formatCommand, mixCommand } from '../../src/lwrp/parser.js'
import type { Attrs, XNodeState } from '../../src/model/state.js'
import { sleep, waitFor } from '../helpers/wait-for.js'

export const LEGACY_HOST = process.env.XNODE_LEGACY_HOST?.trim() || undefined
export const LEGACY_RO_HOST = process.env.XNODE_LEGACY_RO_HOST?.trim() || undefined
export const XNODE2_HOST = process.env.XNODE2_HOST?.trim() || undefined

export const READ_ONLY: ModuleConfig = {
	host: '',
	port: 93,
	password: '',
	allowMixerWrites: false,
	allowSourceWrites: false,
	allowLeaveFactoryMode: false,
	allowGpoWrites: false,
	meterMode: 'off',
	meterInterval: 500,
	levelAlerts: true,
	xpointMinDb: -80,
	xpointMaxDb: 24,
	exposeXpointVariables: false,
	knownSources: '',
	discoverSources: false,
	partylineInterface: '',
}

/** Every write toggle on except "leave factory mode", which the live tests never use. */
export const PERMISSIVE: ModuleConfig = {
	...READ_ONLY,
	allowMixerWrites: true,
	allowSourceWrites: true,
	allowGpoWrites: true,
	levelAlerts: false,
}

export interface Rig {
	ctrl: XNodeController
	ops: XNodeOperations
	config: ModuleConfig
	logs: string[]
	close(): Promise<void>
}

/** Controller + operations against a real node; resolves once the first sync finished. */
export async function connectRig(
	host: string,
	overrides: Partial<ModuleConfig> = {},
	timings: Partial<ControllerTimings> = {},
): Promise<Rig> {
	const config: ModuleConfig = { ...PERMISSIVE, ...overrides, host }
	const logs: string[] = []
	const ctrl = new XNodeController(config, (level, msg) => logs.push(`${level}: ${msg}`), {
		backoffMs: [200],
		...timings,
	})
	const ops = new XNodeOperations(
		ctrl,
		() => config,
		(level, msg) => logs.push(`ops ${level}: ${msg}`),
	)
	ctrl.start()
	await waitFor(() => ctrl.isSynced, { timeoutMs: 20_000, message: `sync of ${host} (${logs.join(' | ')})` })
	return {
		ctrl,
		ops,
		config,
		logs,
		async close() {
			try {
				await ops.destroy()
			} finally {
				ctrl.destroy()
			}
		},
	}
}

/** Record every command written to any LwrpConnection (spy on `send`, which every write path uses). */
export function recordSends(): { sent: string[]; restore: () => void } {
	const sent: string[] = []
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const original = LwrpConnection.prototype.send
	const spy = vi.spyOn(LwrpConnection.prototype, 'send').mockImplementation(function (
		this: LwrpConnection,
		cmd: string,
	) {
		sent.push(cmd)
		original.call(this, cmd)
	})
	return { sent, restore: () => spy.mockRestore() }
}

/** Force a socket drop, as a cable pull would (the controller must notice and reconnect). */
export function dropSocket(ctrl: XNodeController): void {
	const session = (ctrl as unknown as { session: { conn: { socket: net.Socket | null } } | null }).session
	const socket = session?.conn.socket
	if (!socket) throw new Error('no open socket to drop')
	socket.destroy()
}

export interface DeviceSnapshot {
	mixcfg: number | undefined
	src: Record<string, Attrs>
	dst: Record<string, Attrs>
	mix: Record<string, Record<string, number>>
	gpo: Record<string, string>
	inp: Record<string, Attrs>
}

/** Plain, comparable copy of the persistent state. A missing INGN/OUGN counts as 0 (legacy nodes omit it until set). */
export function snapshotDevice(st: XNodeState): DeviceSnapshot {
	const objects = (map: Map<number, Attrs>, gainKey?: string): Record<string, Attrs> => {
		const out: Record<string, Attrs> = {}
		for (const [n, attrs] of [...map].sort(([a], [b]) => a - b)) {
			out[String(n)] = { ...(gainKey ? { [gainKey]: '0' } : {}), ...attrs }
		}
		return out
	}
	const mix: DeviceSnapshot['mix'] = {}
	for (const [o, row] of [...st.mix].sort(([a], [b]) => a - b)) {
		mix[String(o)] = Object.fromEntries([...row].sort(([a], [b]) => a - b).map(([i, g]) => [String(i), g]))
	}
	return {
		mixcfg: st.mixcfgMode,
		src: objects(st.src, 'INGN'),
		dst: objects(st.dst, 'OUGN'),
		mix,
		gpo: Object.fromEntries([...st.gpo].map(([n, p]) => [String(n), p])),
		inp: objects(st.inp),
	}
}

const BARE_KEYS = new Set(['RTPE', 'RTPP', 'INGN', 'OUGN', 'GAIN'])

/**
 * Put the node back to `original` with raw writes (no validation layer, so it works even when a test left something
 * odd behind). Only touches keys the live tests may change. Returns the commands it sent.
 */
export async function restoreDevice(rig: Rig, original: DeviceSnapshot): Promise<string[]> {
	const { ctrl } = rig
	const st = ctrl.state
	const cmds: string[] = []
	const now = snapshotDevice(st)
	const send = async (cmd: string, verb: 'SRC' | 'DST' | 'MIX' | 'GPO' | 'INP', index: number): Promise<void> => {
		cmds.push(cmd)
		await ctrl.writeAndVerify(cmd, { verb, index }).catch(() => undefined)
	}
	const objectKeys: Record<'src' | 'dst' | 'inp', string[]> = {
		src: ['RTPE', 'RTPP', 'RTPA', 'INGN', 'PSNM'],
		dst: ['ADDR', 'OUGN'],
		inp: ['GAIN'],
	}
	for (const [kind, verb] of [
		['src', 'SRC'],
		['dst', 'DST'],
		['inp', 'INP'],
	] as const) {
		for (const [n, attrs] of Object.entries(original[kind])) {
			const have = now[kind][n] ?? {}
			if (verb === 'INP' && !st.isXNode2) continue
			const diff = objectKeys[kind].filter((k) => attrs[k] !== undefined && attrs[k] !== have[k])
			if (diff.length === 0) continue
			const body = diff.map((k) => (BARE_KEYS.has(k) ? `${k}:${attrs[k]}` : `${k}:"${attrs[k].replace(/["\\]/g, '')}"`))
			await send(`${verb} ${n} ${body.join(' ')}`, verb, Number(n))
		}
	}
	for (const out of new Set([...Object.keys(original.mix), ...Object.keys(now.mix)])) {
		const want = original.mix[out] ?? {}
		const have = now.mix[out] ?? {}
		const entries: Array<[number, number | null]> = []
		for (const i of new Set([...Object.keys(want), ...Object.keys(have)])) {
			if (want[i] !== have[i]) entries.push([Number(i), want[i] ?? null])
		}
		if (entries.length > 0) await send(mixCommand(Number(out), entries), 'MIX', Number(out))
	}
	for (const [n, pins] of Object.entries(original.gpo)) {
		if (now.gpo[n] !== pins) await send(formatCommand('GPO', [Number(n), pins]), 'GPO', Number(n))
	}
	if (cmds.length > 0) await sleep(150)
	return cmds
}

/** Read the node again from scratch on a new read-only connection. */
export async function freshSnapshot(host: string): Promise<DeviceSnapshot> {
	const rig = await connectRig(host, { ...READ_ONLY, levelAlerts: false })
	try {
		return snapshotDevice(rig.ctrl.state)
	} finally {
		await rig.close()
	}
}
