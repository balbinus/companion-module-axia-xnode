import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import { isIpv4 } from './lwrp/livewire.js'

export type MeterMode = 'off' | 'poll' | 'http'

/** Stored in the Companion secrets store, not in the config. */
export type ModuleSecrets = {
	password: string
}

/** Config as stored by Companion (the password lives in the secrets) */
export type StoredConfig = Omit<ModuleConfig, 'password'>

/** Runtime configuration: the stored config plus the password from the secrets */
export type ModuleConfig = {
	host: string
	port: number
	password: string
	allowMixerWrites: boolean
	allowSourceWrites: boolean
	allowLeaveFactoryMode: boolean
	allowGpoWrites: boolean
	meterMode: MeterMode
	meterInterval: number
	levelAlerts: boolean
	xpointMinDb: number
	xpointMaxDb: number
	exposeXpointVariables: boolean
	knownSources: string
	/** Listen to the Livewire partyline to name sources. Treated as on unless explicitly false. */
	discoverSources: boolean
	/** Local interface IP for the partyline multicast group; '' = system default */
	partylineInterface: string
}

export const DEFAULT_PORT = 93

/** Regex.IP that also accepts an empty value */
const OPTIONAL_IP_REGEX = `/^$|${Regex.IP.slice(1)}`

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

export function isValidHost(host: unknown): host is string {
	return typeof host === 'string' && host.length <= 253 && HOST_RE.test(host.trim())
}

/** The partyline interface option: empty (system default) or an IPv4 address */
export function isValidInterfaceIp(value: unknown): value is string {
	return typeof value === 'string' && (value.trim() === '' || isIpv4(value.trim()))
}

export function isValidPort(port: unknown): port is number {
	return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
}

/** True when any write permission is on (then the module sends LOGIN) */
export function anyWriteEnabled(
	config: Pick<ModuleConfig, 'allowMixerWrites' | 'allowSourceWrites' | 'allowLeaveFactoryMode' | 'allowGpoWrites'>,
): boolean {
	return config.allowMixerWrites || config.allowSourceWrites || config.allowLeaveFactoryMode || config.allowGpoWrites
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'warning',
			label: 'Production warning',
			width: 12,
			value:
				'Axia xNodes usually carry on-air audio. The module is read-only by default: it only monitors the node. ' +
				'Every write permission below can change live routing, levels or stream settings, so enable only what you need.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Node IP or hostname',
			tooltip: 'Address of the xNode or xNode2 (LWRP is spoken on TCP port 93).',
			width: 8,
			regex: Regex.HOSTNAME,
		},
		{
			type: 'number',
			id: 'port',
			label: 'LWRP port',
			width: 4,
			min: 1,
			max: 65535,
			default: DEFAULT_PORT,
		},
		{
			type: 'secret-text',
			id: 'password',
			label: 'LWRP password',
			tooltip:
				'Sent (LOGIN) when a write permission below is enabled, and as HTTP Basic auth for the HTTP meter stream. Leave empty if the node has no password.',
			width: 6,
			default: '',
		},
		{
			type: 'checkbox',
			id: 'allowMixerWrites',
			label: 'Allow mixer & routing changes',
			tooltip: 'Permits MIX crosspoint changes and DST changes (connect, disconnect, gain).',
			width: 6,
			default: false,
		},
		{
			type: 'checkbox',
			id: 'allowSourceWrites',
			label: 'Allow source (stream) changes',
			tooltip:
				'Permits SRC changes (enable, address, mode, gain, name) and microphone input gain. They change what goes on the network.',
			width: 6,
			default: false,
		},
		{
			type: 'checkbox',
			id: 'allowLeaveFactoryMode',
			label: 'Allow leaving factory mixer mode',
			tooltip:
				'A crosspoint write while the node is in a factory mixer mode silently switches it to custom mode. Off: such writes are refused.',
			width: 6,
			default: false,
		},
		{
			type: 'checkbox',
			id: 'allowGpoWrites',
			label: 'Allow GPO control',
			tooltip: 'Permits setting GPO pins. GPOs often drive on-air lights, tally and machine starts.',
			width: 6,
			default: false,
		},
		{
			type: 'dropdown',
			id: 'meterMode',
			label: 'Meters',
			tooltip:
				'Poll: LWRP MTR snapshots at the interval below. HTTP stream: the node web meter stream, which also provides hardware input/output meters on legacy xNodes.',
			width: 6,
			default: 'off',
			choices: [
				{ id: 'off', label: 'Off' },
				{ id: 'poll', label: 'LWRP poll' },
				{ id: 'http', label: 'HTTP stream' },
			],
		},
		{
			type: 'number',
			id: 'meterInterval',
			label: 'Meter interval (ms)',
			tooltip: 'Poll period or HTTP stream interval, minimum 100 ms.',
			width: 6,
			min: 100,
			max: 10000,
			default: 500,
		},
		{
			type: 'checkbox',
			id: 'levelAlerts',
			label: 'Level alerts (silence / clip)',
			tooltip: 'Subscribes to LVL alerts of all channels. The node default thresholds are used and never modified.',
			width: 6,
			default: true,
		},
		{
			type: 'checkbox',
			id: 'exposeXpointVariables',
			label: 'Expose crosspoint variables',
			tooltip: 'One variable per crosspoint (up to 600). Off by default to keep the variable list small.',
			width: 6,
			default: false,
		},
		{
			type: 'number',
			id: 'xpointMinDb',
			label: 'Crosspoint gain minimum (dB)',
			tooltip: 'The node does not clamp crosspoint gains, so the module does.',
			width: 6,
			min: -100,
			max: 24,
			default: -80,
		},
		{
			type: 'number',
			id: 'xpointMaxDb',
			label: 'Crosspoint gain maximum (dB)',
			width: 6,
			min: -100,
			max: 24,
			default: 24,
		},
		{
			type: 'textinput',
			id: 'knownSources',
			label: 'Known Livewire sources (optional)',
			tooltip: 'One per line: 22301=Studio Mic 1 (a Livewire channel or a multicast address like 239.192.87.29=Name).',
			description: 'Used for destination connect dropdowns. One per line, for example 22301=Studio Mic 1',
			width: 12,
			multiline: true,
			default: '',
		},
		{
			type: 'checkbox',
			id: 'discoverSources',
			label: 'Discover Livewire sources',
			tooltip:
				'Listens to the Livewire source advertisements (multicast 239.192.255.3, UDP 4001) to name sources. Receive-only: nothing is sent. In Docker, Companion needs host networking.',
			width: 6,
			default: true,
		},
		{
			type: 'textinput',
			id: 'partylineInterface',
			label: 'Livewire network interface IP (optional)',
			tooltip: 'Local IP address of the network interface connected to the Livewire network. Blank = system default.',
			width: 6,
			regex: OPTIONAL_IP_REGEX,
			default: '',
			isVisibleExpression: '$(options:discoverSources)',
		},
	]
}
