import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { StoredConfig, ModuleSecrets } from './config.js'

type UpgradeScript = CompanionStaticUpgradeScript<StoredConfig, ModuleSecrets | undefined>

/** Source discovery: existing instances get the new options at their defaults (discovery on, default interface). */
export const addDiscoveryOptions: UpgradeScript = (_context, props) => {
	const config = props.config
	const result = { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
	if (!config) return result
	const missingToggle = typeof config.discoverSources !== 'boolean'
	const missingInterface = typeof config.partylineInterface !== 'string'
	if (!missingToggle && !missingInterface) return result
	return {
		...result,
		updatedConfig: {
			...config,
			...(missingToggle ? { discoverSources: true } : {}),
			...(missingInterface ? { partylineInterface: '' } : {}),
		},
	}
}

export const UpgradeScripts: UpgradeScript[] = [
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 */
	addDiscoveryOptions,
]
