import type { ModuleConfig } from '../config.js'
import type { LogFn, XNodeController } from './controller.js'

/** TODO (agent C): validated, permission-gated, coalesced write operations on top of the controller. */
export class XNodeOperations {
	constructor(
		readonly controller: XNodeController,
		readonly getConfig: () => ModuleConfig,
		readonly log: LogFn,
	) {}

	destroy(): void {
		// TODO: clear pending timers (pulses, coalescing)
	}
}
