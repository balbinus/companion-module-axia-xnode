import type { CompanionVariableValues } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { StateChange } from './model/state.js'

/** Variable ids are dynamic (per SRC/DST/mixer output...), hence the index signature. */
export type VariablesSchema = CompanionVariableValues

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({})
}

/** Recompute the variables touched by `changes`, or all of them. */
export function UpdateVariableValues(_self: ModuleInstance, _changes: StateChange[] | 'all'): void {
	// TODO (agent D)
}
