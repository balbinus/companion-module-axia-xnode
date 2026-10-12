import type { CompanionVariableValues } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { computeVariableDefinitions, computeVariableValues, type VarValue } from './model/derived.js'
import type { StateChange } from './model/state.js'

/** Variable ids are dynamic (per SRC/DST/mixer output...), hence the index signature. */
export type VariablesSchema = CompanionVariableValues

/** Per instance: the ids currently defined and the last values sent, so only differences are pushed. */
interface Sent {
	defined: Set<string>
	values: Map<string, VarValue>
}

const sent = new WeakMap<ModuleInstance, Sent>()

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const defs = computeVariableDefinitions(self.controller.state, self.config)
	sent.set(self, { defined: new Set(Object.keys(defs)), values: new Map() })
	self.setVariableDefinitions(defs)
}

/**
 * Recompute the variables and send those that differ from the last values sent.
 * Recomputing everything is cheap, so `changes` only serves to skip the work when nothing relevant happened.
 */
export function UpdateVariableValues(self: ModuleInstance, changes: StateChange[] | 'all'): void {
	if (changes !== 'all' && changes.length === 0) return
	let cache = sent.get(self)
	if (!cache) {
		cache = { defined: new Set(), values: new Map() }
		sent.set(self, cache)
	}
	const all = computeVariableValues(self.controller.state, self.config, self.controller.levelsReady, self.directory)
	const diff: Record<string, VarValue> = {}
	let count = 0
	for (const [id, value] of Object.entries(all)) {
		if (cache.defined.size > 0 && !cache.defined.has(id)) continue
		if (cache.values.get(id) === value) continue
		cache.values.set(id, value)
		diff[id] = value
		count++
	}
	if (count > 0) self.setVariableValues(diff)
}
