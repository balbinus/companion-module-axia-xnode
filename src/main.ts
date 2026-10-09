import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets, type StoredConfig } from './config.js'
import { XNodeController, type ControllerStatus } from './device/controller.js'
import { XNodeOperations } from './device/operations.js'
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

	async init(config: StoredConfig, _isFirstInit: boolean, secrets: ModuleSecrets | undefined): Promise<void> {
		this.config = { ...config, password: secrets?.password ?? '' }
		await this.lifecycle.run(async () => {
			if (this.destroying) return
			this.startDevice()
			this.rebuildDefinitions()
		})
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		this.destroying = true
		await this.lifecycle.run(async () => this.stopDevice())
	}

	async configUpdated(config: StoredConfig, secrets: ModuleSecrets | undefined): Promise<void> {
		await this.lifecycle.run(async () => {
			if (this.destroying) return
			await this.stopDevice()
			if (this.destroying) return // destroy() arrived while stopping: it wins
			this.config = { ...config, password: secrets?.password ?? '' }
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

	private async stopDevice(): Promise<void> {
		this.running = false
		clearTimeout(this.flushTimer)
		clearTimeout(this.rebuildTimer)
		this.flushTimer = this.rebuildTimer = undefined
		this.pending = []
		// Let the operations restore running GPO pulses while the connection is still open (bounded).
		try {
			await this.ops?.destroy()
		} catch (e) {
			this.log('warn', `Shutdown: ${e instanceof Error ? e.message : String(e)}`)
		}
		this.controller?.destroy()
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
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updatePresets()
		UpdateVariableValues(this, 'all')
	}
}
