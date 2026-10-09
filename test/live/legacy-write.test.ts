/** Live write checks on the writable legacy node (XNODE_LEGACY_HOST). The read-only legacy node never appears here. */
import { LEGACY_HOST } from './helpers.js'
import { registerWriteSuite } from './write-suite.js'

registerWriteSuite({ host: LEGACY_HOST, label: 'legacy node', xnode2: false })
