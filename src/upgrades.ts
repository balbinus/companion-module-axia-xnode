import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { StoredConfig, ModuleSecrets } from './config.js'

export const UpgradeScripts: CompanionStaticUpgradeScript<StoredConfig, ModuleSecrets | undefined>[] = [
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 */
	// function (context, props) {
	// 	return {
	// 		updatedConfig: null,
	// 		updatedActions: [],
	// 		updatedFeedbacks: [],
	// 	}
	// },
]
