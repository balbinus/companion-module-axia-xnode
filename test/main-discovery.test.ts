/**
 * How main.ts runs the source discovery: created with the device, stopped (awaited) with it, and its events
 * turned into definition and value updates. The device, the operations and the discovery are fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredConfig } from '../src/config.js'
import { decodeAdvert } from '../src/lwrp/partyline.js'
import ModuleInstance from '../src/main.js'
import { partylineFixture } from './fixtures/partyline/load.js'

type Any = any

const fakes = vi.hoisted(() => ({
	discoveries: [] as Any[],
}))

vi.mock('../src/device/discovery.js', async () => {
	const { EventEmitter } = await import('node:events')
	const { LivewireDirectory } = await import('../src/model/directory.js')
	class FakeDiscovery extends EventEmitter {
		directory = new LivewireDirectory()
		start = vi.fn()
		stop = vi.fn(async () => Promise.resolve())
		constructor(readonly options: unknown) {
			super()
			fakes.discoveries.push(this)
		}
	}
	return { SourceDiscovery: FakeDiscovery }
})

vi.mock('../src/device/controller.js', async (importOriginal) => {
	const { EventEmitter } = await import('node:events')
	const { loadedState } = await import('./fixtures/load.js')
	class FakeController extends EventEmitter {
		// Node .223 of the captures: SRC n is channel 22300+n, DST n listens to the backfeed of SRC n
		state = loadedState('legacy-analog4x4-a')
		levelsReady = false
		start = vi.fn()
		destroy = vi.fn()
	}
	return { ...(await importOriginal<object>()), XNodeController: FakeController }
})

vi.mock('../src/device/operations.js', async (importOriginal) => {
	class FakeOperations {
		destroy = vi.fn(async () => Promise.resolve())
	}
	return { ...(await importOriginal<object>()), XNodeOperations: FakeOperations }
})

const CONFIG: StoredConfig = {
	host: '10.96.30.223',
	port: 93,
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
	discoverSources: true,
	partylineInterface: '',
}

interface Rig {
	instance: ModuleInstance
	context: Any
	logs: Array<[string, string]>
}

function makeInstance(): Rig {
	const logs: Array<[string, string]> = []
	;(globalThis as Any).COMPANION_LOGGER = (_source: unknown, level: string, message: string) =>
		logs.push([level, message])
	const context = {
		id: 'xnode-1',
		label: 'xnode',
		_isInstanceContext: true,
		updateStatus: vi.fn(),
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		setPresetDefinitions: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkFeedbacks: vi.fn(),
	}
	return { instance: new ModuleInstance(context), context, logs }
}

const start = async (config: Partial<StoredConfig> = {}): Promise<Rig> => {
	const rig = makeInstance()
	await rig.instance.init({ ...CONFIG, ...config }, true, undefined)
	return rig
}

const lastDiscovery = (): Any => fakes.discoveries[fakes.discoveries.length - 1]

function hear(discovery: Any, name: Parameters<typeof partylineFixture>[0], sender: string): void {
	const advert = decodeAdvert(partylineFixture(name), sender)
	if (!advert) throw new Error(`${name} does not decode`)
	discovery.directory.ingest(advert)
}

/** How many definition calls so far */
const calls = (r: Rig): Record<string, number> => ({
	actions: r.context.setActionDefinitions.mock.calls.length,
	feedbacks: r.context.setFeedbackDefinitions.mock.calls.length,
	presets: r.context.setPresetDefinitions.mock.calls.length,
	variables: r.context.setVariableDefinitions.mock.calls.length,
	values: r.context.setVariableValues.mock.calls.length,
	checks: r.context.checkFeedbacks.mock.calls.length,
})

beforeEach(() => {
	fakes.discoveries.length = 0
})

describe('start', () => {
	it('creates and starts the discovery with the device', async () => {
		const { instance } = await start()
		expect(fakes.discoveries).toHaveLength(1)
		expect(lastDiscovery().start).toHaveBeenCalledTimes(1)
		expect(instance.discovery).toBe(lastDiscovery())
		expect(instance.directory).toBe(lastDiscovery().directory)
	})

	it('hands the log and the interface to the discovery', async () => {
		const { logs } = await start({ partylineInterface: ' 10.96.30.50 ' })
		const options = lastDiscovery().options
		expect(options.interfaceIp).toBe('10.96.30.50')
		options.log('info', 'hello')
		expect(logs).toContainEqual(['info', 'hello'])
	})

	it('uses the system default interface when none is configured', async () => {
		await start({ partylineInterface: '' })
		expect(lastDiscovery().options.interfaceIp).toBe('')
	})

	it('warns about an interface that is not an IPv4 address, and uses the default', async () => {
		const { logs } = await start({ partylineInterface: 'eth0' })
		expect(lastDiscovery().options.interfaceIp).toBe('')
		expect(logs).toContainEqual(['warn', 'Invalid Livewire network interface "eth0": using the system default'])
	})

	it('does nothing when discovery is off', async () => {
		const { instance } = await start({ discoverSources: false })
		expect(fakes.discoveries).toHaveLength(0)
		expect(instance.discovery).toBeUndefined()
		expect(instance.directory).toBeUndefined()
	})

	it('treats a config without the option as on (not upgraded yet)', async () => {
		const config: Partial<StoredConfig> = { ...CONFIG }
		delete config.discoverSources
		delete config.partylineInterface
		const rig = makeInstance()
		await rig.instance.init(config as StoredConfig, true, undefined)
		expect(fakes.discoveries).toHaveLength(1)
		expect(lastDiscovery().options.interfaceIp).toBe('')
	})

	it('gives the definitions an empty directory to start with', async () => {
		const r = await start()
		const [defs] = r.context.setActionDefinitions.mock.calls.at(-1) as [Any]
		const source = defs.dst_connect_channel.options.find((o: Any) => o.id === 'source')
		expect(source.choices).toEqual([{ id: 'custom', label: 'Custom channel number' }])
	})
})

describe('events', () => {
	it('sources: rebuilds the actions and feedbacks and refreshes the values, not presets or variable definitions', async () => {
		const r = await start()
		const discovery = lastDiscovery()
		const before = calls(r)
		hear(discovery, 'full-xnode-223', '10.96.30.223')
		hear(discovery, 'full-xnode-224', '10.96.30.224')
		discovery.emit('sources')
		const after = calls(r)
		expect(after.actions).toBe(before.actions + 1)
		expect(after.feedbacks).toBe(before.feedbacks + 1)
		expect(after.presets).toBe(before.presets)
		expect(after.variables).toBe(before.variables)
		expect(after.values).toBe(before.values + 1)

		const [actions] = r.context.setActionDefinitions.mock.calls.at(-1) as [Any]
		const choices = actions.dst_connect_channel.options.find((o: Any) => o.id === 'source').choices
		expect(choices).toContainEqual({ id: '239.192.87.29', label: '22301 · MIC 1 (Node-223-0)' })
		expect(choices.at(-1).id).toBe('custom')
		const [feedbacks] = r.context.setFeedbackDefinitions.mock.calls.at(-1) as [Any]
		const known = feedbacks.dst_connected_to.options.find((o: Any) => o.id === 'known').choices
		expect(known).toContainEqual({ id: '239.192.87.129', label: '22401 · MIX ANIM (Node-224-0)' })

		const [values] = r.context.setVariableValues.mock.calls.at(-1) as [Record<string, string>]
		expect(values.dst_1_source_name).toBe('To: MIC 1')
		expect(values.dst_2_source_name).toBe('To: SRC 2')
	})

	it('sources: only the values that changed are sent', async () => {
		const r = await start()
		const discovery = lastDiscovery()
		hear(discovery, 'full-xnode-223', '10.96.30.223')
		discovery.emit('sources')
		r.context.setVariableValues.mockClear()
		discovery.emit('sources')
		expect(r.context.setVariableValues).not.toHaveBeenCalled()
	})

	it('usage: refreshes the values and checks src_in_use, nothing else', async () => {
		const r = await start()
		const discovery = lastDiscovery()
		hear(discovery, 'full-xnode-223', '10.96.30.223')
		discovery.emit('sources')
		const before = calls(r)
		hear(discovery, 'usage-xnode-fader11', '10.96.30.223')
		discovery.emit('usage')
		const after = calls(r)
		expect(after.actions).toBe(before.actions)
		expect(after.feedbacks).toBe(before.feedbacks)
		expect(after.values).toBe(before.values + 1)
		expect(r.context.setVariableValues.mock.calls.at(-1)?.[0]).toEqual({ src_1_used_by: '10.96.30.235/11' })
		expect(r.context.checkFeedbacks).toHaveBeenCalledTimes(1)
		expect(r.context.checkFeedbacks).toHaveBeenCalledWith(['src_in_use'])
	})

	it('are ignored by an instance that has no discovery', async () => {
		const r = await start({ discoverSources: false })
		expect(calls(r).checks).toBe(0)
	})
})

describe('restart and stop', () => {
	it('configUpdated stops the discovery, awaiting it, then starts a new one', async () => {
		const r = await start()
		const first = lastDiscovery()
		let release = (): void => undefined
		first.stop.mockImplementation(async () => new Promise<void>((resolve) => (release = resolve)))
		let done = false
		const updating = r.instance.configUpdated({ ...CONFIG, partylineInterface: '10.96.30.50' }, undefined).then(() => {
			done = true
		})
		await vi.waitFor(() => expect(first.stop).toHaveBeenCalledTimes(1))
		await Promise.resolve()
		expect(done).toBe(false)
		expect(fakes.discoveries).toHaveLength(1) // the new one waits for the old one to be closed
		release()
		await updating
		expect(fakes.discoveries).toHaveLength(2)
		expect(lastDiscovery().start).toHaveBeenCalledTimes(1)
		expect(lastDiscovery().options.interfaceIp).toBe('10.96.30.50')
		expect(r.instance.discovery).toBe(lastDiscovery())
	})

	it('a late event of the stopped discovery does nothing', async () => {
		const r = await start()
		const first = lastDiscovery()
		await r.instance.configUpdated({ ...CONFIG }, undefined)
		const before = calls(r)
		first.emit('sources')
		first.emit('usage')
		expect(calls(r)).toEqual(before)
		// the new one is live
		lastDiscovery().emit('usage')
		expect(calls(r).checks).toBe(before.checks + 1)
	})

	it('configUpdated with discovery switched off stops it and starts none', async () => {
		const r = await start()
		const first = lastDiscovery()
		await r.instance.configUpdated({ ...CONFIG, discoverSources: false }, undefined)
		expect(first.stop).toHaveBeenCalledTimes(1)
		expect(fakes.discoveries).toHaveLength(1)
		expect(r.instance.discovery).toBeUndefined()
		expect(r.instance.directory).toBeUndefined()
	})

	it('configUpdated with discovery switched on starts it', async () => {
		const r = await start({ discoverSources: false })
		await r.instance.configUpdated({ ...CONFIG, discoverSources: true }, undefined)
		expect(fakes.discoveries).toHaveLength(1)
		expect(lastDiscovery().start).toHaveBeenCalledTimes(1)
		const [actions] = r.context.setActionDefinitions.mock.calls.at(-1) as [Any]
		expect(actions.dst_connect_channel).toBeDefined()
	})

	it('destroy stops the discovery, awaited', async () => {
		const r = await start()
		const discovery = lastDiscovery()
		let release = (): void => undefined
		discovery.stop.mockImplementation(async () => new Promise<void>((resolve) => (release = resolve)))
		let done = false
		const destroying = r.instance.destroy().then(() => {
			done = true
		})
		await vi.waitFor(() => expect(discovery.stop).toHaveBeenCalledTimes(1))
		await Promise.resolve()
		expect(done).toBe(false)
		release()
		await destroying
		expect(done).toBe(true)
		expect(r.instance.discovery).toBeUndefined()
	})

	it('nothing runs after destroy: no new discovery from a queued configUpdated, no work from late events', async () => {
		const r = await start()
		const discovery = lastDiscovery()
		const destroying = r.instance.destroy()
		const updating = r.instance.configUpdated({ ...CONFIG }, undefined)
		await Promise.all([destroying, updating])
		expect(fakes.discoveries).toHaveLength(1)
		const before = calls(r)
		discovery.emit('sources')
		discovery.emit('usage')
		expect(calls(r)).toEqual(before)
	})

	it('destroy before init finishes starts no discovery', async () => {
		const rig = makeInstance()
		const destroying = rig.instance.destroy()
		await rig.instance.init(CONFIG, true, undefined)
		await destroying
		expect(fakes.discoveries).toHaveLength(0)
	})

	it('destroy without discovery is fine', async () => {
		const r = await start({ discoverSources: false })
		await expect(r.instance.destroy()).resolves.toBeUndefined()
	})

	it('an event that comes while the old discovery is closing is dropped', async () => {
		const r = await start()
		const first = lastDiscovery()
		let release = (): void => undefined
		first.stop.mockImplementation(async () => new Promise<void>((resolve) => (release = resolve)))
		const updating = r.instance.configUpdated({ ...CONFIG }, undefined)
		await vi.waitFor(() => expect(first.stop).toHaveBeenCalled())
		const before = calls(r)
		first.emit('sources')
		expect(calls(r)).toEqual(before)
		release()
		await updating
	})
})

describe('the directory seen by the module', () => {
	it('follows the discovery of the running device', async () => {
		const r = await start()
		const first = lastDiscovery()
		expect(r.instance.directory).toBe(first.directory)
		await r.instance.configUpdated({ ...CONFIG }, undefined)
		expect(r.instance.directory).toBe(lastDiscovery().directory)
		expect(r.instance.directory).not.toBe(first.directory)
	})
})
