import type ModuleInstance from './main.js'
import type { StateChange } from './model/state.js'

// Later agents add entries here (keep the exported names): `mix_xpoint_active: { type: 'boolean', options: { ... } }`
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type FeedbacksSchema = {}

export function UpdateFeedbacks(self: ModuleInstance): void {
	self.setFeedbackDefinitions({})
}

/** Re-check the feedbacks affected by these state changes (called batched from main.ts). */
export function CheckFeedbacksForChanges(_self: ModuleInstance, _changes: StateChange[]): void {
	// TODO (agent D)
}
