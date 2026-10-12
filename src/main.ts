import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import {
	GetConfigFields,
	isValidInterfaceIp,
	type ModuleConfig,
	type ModuleSecrets,
	type StoredConfig,
} from './config.js'
import { XNodeController, type ControllerStatus, type LogFn } from './device/controller.js'
import { SourceDiscovery } from './device/discovery.js'
import { XNodeOperations } from './device/operations.js'
import { sourceChoices } from './choices.js'
import { parseKnownSources } from './lwrp/livewire.js'
import type { LivewireDirectory } from './model/directory.js'
import type { StateChange } from './model/state.js'
import { UpdateVariableDefinitions, UpdateVariableValues, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { CheckFeedbacksForChanges, UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'

export type ModuleSchema = {
	config: StoredConfig
	secrets: ModuleSecrets | undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

/** Runs async tasks strictly one after the other; a failing task never blocks the following ones. */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve()

	async run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task, task)
		this.tail = result.catch(() => undefined)
		return result
	}
}

const FLUSH_DEBOUNCE_MS = 100
const REBUILD_DEBOUNCE_MS = 300

/** Where the discovery listens: its interface IP ('' = system default) and the configured value if it was unusable */
interface DiscoveryTarget {
	interfaceIp: string
	invalid?: string
}

/** What the config asks of the discovery; undefined when it is off. Two equal targets need the same discovery. */
function discoveryTarget(
	config: Pick<ModuleConfig, 'discoverSources' | 'partylineInterface'>,
): DiscoveryTarget | undefined {
	if (config.discoverSources === false) return undefined
	const configured = (config.partylineInterface ?? '').trim()
	return isValidInterfaceIp(configured) ? { interfaceIp: configured } : { interfaceIp: '', invalid: configured }
}

const STATUS_MAP: Record<ControllerStatus, InstanceStatus> = {
	connecting: InstanceStatus.Connecting,
	ok: InstanceStatus.Ok,
	connection_failure: InstanceStatus.ConnectionFailure,
	bad_config: InstanceStatus.BadConfig,
	warning: InstanceStatus.UnknownWarning,
}

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig // Setup in init()
	controller!: XNodeController
	ops!: XNodeOperations
	/** Livewire source discovery; absent while it is off in the config. Outlives device restarts. */
	discovery: SourceDiscovery | undefined

	/** The interface IP the running discovery was started with */
	private discoveryInterface: string | undefined
	/** The source dropdown choices (ids and labels) the action and feedback definitions were last built with */
	private renderedSources = ''

	private readonly lifecycle = new SerialQueue()
	/** Set synchronously by destroy(): queued init/configUpdated work then does nothing */
	private destroying = false
	/** False while no device is running: late changes are dropped */
	private running = false
	private pending: StateChange[] = []
	private flushTimer: NodeJS.Timeout | undefined
	private rebuildTimer: NodeJS.Timeout | undefined

	constructor(internal: unknown) {
		super(internal)
	}

	/** The Livewire directory (names of the sources on the network), when discovery is on */
	get directory(): LivewireDirectory | undefined {
		return this.discovery?.directory
	}

	async init(config: StoredConfig, _isFirstInit: boolean, secrets: ModuleSecrets | undefined): Promise<void> {
		this.config = { ...config, password: secrets?.password ?? '' }
		await this.lifecycle.run(async () => {
			if (this.destroying) return
			this.startDevice()
			await this.syncDiscovery(discoveryTarget(this.config))
			this.rebuildDefinitions()
		})
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		this.destroying = true
		await this.lifecycle.run(async () => {
			try {
				await this.stopDevice()
			} finally {
				await this.stopDiscovery()
			}
		})
	}

	async configUpdated(config: StoredConfig, secrets: ModuleSecrets | undefined): Promise<void> {
		await this.lifecycle.run(async () => {
			if (this.destroying) return
			const next: ModuleConfig = { ...config, password: secrets?.password ?? '' }
			try {
				await this.stopDevice()
			} finally {
				// The discovery (and its directory, which takes minutes to fill) only restarts when its settings change
				await this.syncDiscovery(discoveryTarget(next))
			}
			if (this.destroying) return // destroy() arrived while stopping: it wins
			this.config = next
			this.startDevice()
			this.rebuildDefinitions()
		})
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	private startDevice(): void {
		const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string): void => this.log(level, msg)
		const controller = new XNodeController(this.config, log)
		this.controller = controller
		this.ops = new XNodeOperations(controller, () => this.config, log)
		controller.on('status', (status, message) => {
			this.updateStatus(STATUS_MAP[status], message ?? null)
		})
		controller.on('change', (change) => this.queueChange(change))
		this.running = true
		controller.start()
	}

	/** Make the discovery match the target: keep the running one if it already does, else replace it */
	private async syncDiscovery(target: DiscoveryTarget | undefined): Promise<void> {
		if (this.destroying) target = undefined
		if (this.discovery && target?.interfaceIp === this.discoveryInterface) return
		await this.stopDiscovery()
		this.startDiscovery(target)
	}

	private startDiscovery(target: DiscoveryTarget | undefined): void {
		if (!target) return
		const log: LogFn = (level, msg) => this.log(level, msg)
		if (target.invalid !== undefined) {
			log('warn', `Invalid Livewire network interface "${target.invalid}": using the system default`)
		}
		const discovery = new SourceDiscovery({ interfaceIp: target.interfaceIp, log })
		// Read lazily: the discovery outlives the device, which may be stopped or restarting when an event comes
		const live = (): boolean => this.running && !this.destroying && this.discovery === discovery
		discovery.on('sources', () => {
			if (!live()) return
			// The variable definitions do not depend on the sources; the dropdowns and routing presets only if the
			// source choices changed
			const rendered = this.renderSourceChoices()
			if (rendered !== this.renderedSources) {
				this.renderedSources = rendered
				this.updateActions()
				this.updateFeedbacks()
				this.updatePresets()
			}
			UpdateVariableValues(this, 'all')
		})
		discovery.on('usage', () => {
			if (!live()) return
			UpdateVariableValues(this, 'all')
			this.checkFeedbacks('src_in_use')
		})
		this.discovery = discovery
		this.discoveryInterface = target.interfaceIp
		discovery.start()
	}

	private async stopDiscovery(): Promise<void> {
		const discovery = this.discovery
		this.discovery = undefined
		this.discoveryInterface = undefined
		try {
			await discovery?.stop()
		} catch (e) {
			this.log('warn', `Discovery shutdown: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	/** The source dropdown choices as the definitions are built from the known sources and the directory now */
	private renderSourceChoices(): string {
		return JSON.stringify(sourceChoices(parseKnownSources(this.config.knownSources ?? ''), this.directory))
	}

	private async stopDevice(): Promise<void> {
		this.running = false
		this.clearTimers()
		// Let the operations restore running GPO pulses while the connection is still open (bounded).
		try {
			await this.ops?.destroy()
		} catch (e) {
			this.log('warn', `Shutdown: ${e instanceof Error ? e.message : String(e)}`)
		}
		try {
			this.controller?.destroy()
		} finally {
			this.clearTimers()
		}
	}

	private clearTimers(): void {
		clearTimeout(this.flushTimer)
		clearTimeout(this.rebuildTimer)
		this.flushTimer = this.rebuildTimer = undefined
		this.pending = []
	}

	private queueChange(change: StateChange): void {
		if (!this.running) return
		this.pending.push(change)
		if (change.rebuild) {
			clearTimeout(this.rebuildTimer)
			this.rebuildTimer = setTimeout(() => this.rebuildDefinitions(), REBUILD_DEBOUNCE_MS)
		}
		this.flushTimer ??= setTimeout(() => this.flushChanges(), FLUSH_DEBOUNCE_MS)
	}

	private flushChanges(): void {
		this.flushTimer = undefined
		if (!this.running) return
		const changes = this.pending
		this.pending = []
		if (changes.length === 0) return
		UpdateVariableValues(this, changes)
		CheckFeedbacksForChanges(this, changes)
	}

	private rebuildDefinitions(): void {
		this.rebuildTimer = undefined
		if (this.destroying) return
		this.renderedSources = this.renderSourceChoices()
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updatePresets()
		UpdateVariableValues(this, 'all')
	}
}
