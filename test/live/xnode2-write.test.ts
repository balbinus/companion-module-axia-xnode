/** Live write checks on the writable xNode2 (XNODE2_HOST). */
import { XNODE2_HOST } from './helpers.js'
import { registerWriteSuite } from './write-suite.js'

registerWriteSuite({ host: XNODE2_HOST, label: 'xNode2', xnode2: true })
