/**
 * The real SourceDiscovery (decoder, directory, debounce) inside the real ModuleInstance. Only the multicast socket
 * (the partyline listener module), the device controller and the operations are fakes: captured datagrams go in
 * through the listener, the definitions and values given to Companion come out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredConfig } from '../src/config.js'
import ModuleInstance from '../src/main.js'
import { partylineFixture, type PartylineFixtureName } from './fixtures/partyline/load.js'

type Any = any

const fakes = vi.hoisted(() => ({
	listeners: [] as Any[],
}))

vi.mock('../src/device/partyline-listener.js', async () => {
	const { EventEmitter } = await import('node:events')
	class FakeListener extends EventEmitter {
		start = vi.fn()
		stop = vi.fn(async () => Promise.resolve())
		constructor(readonly options: unknown) {
			super()
			fakes.listeners.push(this)
		}
	}
	return { PartylineListener: FakeListener }
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

function makeInstance(): { instance: ModuleInstance; context: Any } {
	;(globalThis as Any).COMPANION_LOGGER = () => undefined
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
	return { instance: new ModuleInstance(context), context }
}

/** A captured datagram as the socket would deliver it */
function receive(listener: Any, name: PartylineFixtureName, sender: string): void {
	const buf = partylineFixture(name)
	listener.emit('message', buf, { address: sender, family: 'IPv4', port: 48763, size: buf.length })
}

type Choices = Array<{ id: string; label: string }>

const actionSources = (context: Any): Choices => {
	const [defs] = context.setActionDefinitions.mock.calls.at(-1) as [Any]
	return defs.dst_connect_channel.options.find((o: Any) => o.id === 'source').choices
}

const feedbackSources = (context: Any): Choices => {
	const [defs] = context.setFeedbackDefinitions.mock.calls.at(-1) as [Any]
	return defs.dst_connected_to.options.find((o: Any) => o.id === 'known').choices
}

/** The variable values as Companion has them: every update merged in order */
const variables = (context: Any): Record<string, string> =>
	Object.assign({}, ...context.setVariableValues.mock.calls.map(([values]: [Record<string, string>]) => values))

beforeEach(() => {
	fakes.listeners.length = 0
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('the module with its real source discovery', () => {
	it('shows the sources heard on the partyline once the debounce is over', async () => {
		const { instance, context } = makeInstance()
		await instance.init(CONFIG, true, undefined)
		expect(fakes.listeners).toHaveLength(1)
		const listener = fakes.listeners[0]
		expect(listener.start).toHaveBeenCalledTimes(1)
		expect(listener.options).toEqual({ interfaceIp: '' })
		listener.emit('listening')
		expect(actionSources(context)).toEqual([{ id: 'custom', label: 'Custom channel number' }])

		receive(listener, 'full-xnode-223', '10.96.30.223')
		receive(listener, 'full-xnode-224', '10.96.30.224')
		await vi.advanceTimersByTimeAsync(4999)
		expect(actionSources(context)).toHaveLength(1) // names are not time critical: they wait for the debounce
		await vi.advanceTimersByTimeAsync(1)

		const choices = actionSources(context)
		expect(choices).toHaveLength(16 + 1)
		expect(choices).toContainEqual({ id: '239.192.87.29', label: '22301 · MIC 1 (Node-223-0)' })
		expect(choices).toContainEqual({ id: '239.192.87.129', label: '22401 · MIX ANIM (Node-224-0)' })
		expect(choices.at(-1)).toEqual({ id: 'custom', label: 'Custom channel number' })
		expect(feedbackSources(context)).toContainEqual({ id: '239.192.87.29', label: '22301 · MIC 1 (Node-223-0)' })
		const names = variables(context)
		expect(names.dst_1_source_name).toBe('To: MIC 1')
		expect(names.dst_2_source_name).toBe('To: SRC 2')
		expect(names.src_1_used_by).toBe('')

		// Who uses a source follows within a moment
		receive(listener, 'usage-xnode-fader11', '10.96.30.223')
		await vi.advanceTimersByTimeAsync(100)
		const values = variables(context)
		expect(values.src_1_used_by).toBe('10.96.30.235/11')
		expect(values.src_2_used_by).toBe('')
		expect(values.dst_1_source_name).toBe('To: MIC 1')

		// One more datagram of the same, and a keepalive: nothing to rebuild
		const definitions = context.setActionDefinitions.mock.calls.length
		receive(listener, 'full-xnode-223', '10.96.30.223')
		receive(listener, 'keepalive-xnode', '10.96.30.223')
		await vi.advanceTimersByTimeAsync(10_000)
		expect(context.setActionDefinitions.mock.calls.length).toBe(definitions)

		await instance.destroy()
		expect(listener.stop).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('keeps what it heard when the config is saved, and starts over when the interface changes', async () => {
		const { instance, context } = makeInstance()
		await instance.init(CONFIG, true, undefined)
		const listener = fakes.listeners[0]
		receive(listener, 'full-xnode-223', '10.96.30.223')
		await vi.advanceTimersByTimeAsync(5000)
		expect(actionSources(context)).toHaveLength(8 + 1)

		await instance.configUpdated({ ...CONFIG, allowMixerWrites: true }, undefined)
		expect(fakes.listeners).toHaveLength(1)
		expect(listener.stop).not.toHaveBeenCalled()
		expect(actionSources(context)).toHaveLength(8 + 1)
		expect(feedbackSources(context)).toHaveLength(8)

		await instance.configUpdated({ ...CONFIG, partylineInterface: '10.96.30.50' }, undefined)
		expect(listener.stop).toHaveBeenCalledTimes(1)
		expect(fakes.listeners).toHaveLength(2)
		expect(fakes.listeners[1].options).toEqual({ interfaceIp: '10.96.30.50' })
		expect(actionSources(context)).toHaveLength(1)
		// the old socket is out of the way: what it still delivers is not heard
		receive(listener, 'full-xnode-224', '10.96.30.224')
		await vi.advanceTimersByTimeAsync(5000)
		expect(actionSources(context)).toHaveLength(1)

		await instance.destroy()
	})
})
