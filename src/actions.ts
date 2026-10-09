import type ModuleInstance from './main.js'

// Later agents add entries here (keep the exported names): `mix_set: { options: { ... } }`
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type ActionsSchema = {}

export function UpdateActions(self: ModuleInstance): void {
	self.setActionDefinitions({})
}
