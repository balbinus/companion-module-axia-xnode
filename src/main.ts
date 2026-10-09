import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { XNodeController, type ControllerStatus } from './device/controller.js'
import { XNodeOperations } from './device/operations.js'
import type { StateChange } from './model/state.js'
import { UpdateVariableDefinitions, UpdateVariableValues, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { CheckFeedbacksForChanges, UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

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

	private pending: StateChange[] = []
	private flushTimer: NodeJS.Timeout | undefined
	private rebuildTimer: NodeJS.Timeout | undefined

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		this.startDevice()
		this.rebuildDefinitions()
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		this.stopDevice()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.stopDevice()
		this.config = config
		this.startDevice()
		this.rebuildDefinitions()
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
		controller.start()
	}

	private stopDevice(): void {
		clearTimeout(this.flushTimer)
		clearTimeout(this.rebuildTimer)
		this.flushTimer = this.rebuildTimer = undefined
		this.pending = []
		this.ops?.destroy()
		this.controller?.destroy()
	}

	private queueChange(change: StateChange): void {
		this.pending.push(change)
		if (change.rebuild) {
			clearTimeout(this.rebuildTimer)
			this.rebuildTimer = setTimeout(() => this.rebuildDefinitions(), REBUILD_DEBOUNCE_MS)
		}
		this.flushTimer ??= setTimeout(() => this.flushChanges(), FLUSH_DEBOUNCE_MS)
	}

	private flushChanges(): void {
		this.flushTimer = undefined
		const changes = this.pending
		this.pending = []
		if (changes.length === 0) return
		UpdateVariableValues(this, changes)
		CheckFeedbacksForChanges(this, changes)
	}

	private rebuildDefinitions(): void {
		this.rebuildTimer = undefined
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updatePresets()
		UpdateVariableValues(this, 'all')
	}
}
