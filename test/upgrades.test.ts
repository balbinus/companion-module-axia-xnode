import { describe, expect, it } from 'vitest'
import type { StoredConfig } from '../src/config.js'
import { addDiscoveryOptions, UpgradeScripts } from '../src/upgrades.js'

/** A config from before source discovery */
const OLD: Omit<StoredConfig, 'discoverSources' | 'partylineInterface'> = {
	host: '10.96.30.223',
	port: 93,
	allowMixerWrites: true,
	allowSourceWrites: false,
	allowLeaveFactoryMode: false,
	allowGpoWrites: false,
	meterMode: 'poll',
	meterInterval: 500,
	levelAlerts: true,
	xpointMinDb: -80,
	xpointMaxDb: 24,
	exposeXpointVariables: false,
	knownSources: '22301=Studio Mic 1',
}

function run(config: unknown) {
	const props = { config: config as StoredConfig | null, secrets: null, actions: [], feedbacks: [] }
	return addDiscoveryOptions({ currentConfig: (config ?? {}) as StoredConfig }, props)
}

describe('addDiscoveryOptions', () => {
	it('is the (only) upgrade script', () => {
		expect(UpgradeScripts).toEqual([addDiscoveryOptions])
	})

	it('turns discovery on and leaves the interface at the default for an existing instance', () => {
		const result = run(OLD)
		expect(result.updatedConfig).toEqual({ ...OLD, discoverSources: true, partylineInterface: '' })
		expect(result.updatedActions).toEqual([])
		expect(result.updatedFeedbacks).toEqual([])
	})

	it('keeps every other option', () => {
		expect(run(OLD).updatedConfig).toMatchObject(OLD)
	})

	it('does not modify the config it is given', () => {
		const config = { ...OLD }
		run(config)
		expect(config).toEqual(OLD)
	})

	it('returns no config when there is nothing to add', () => {
		expect(run({ ...OLD, discoverSources: true, partylineInterface: '' }).updatedConfig).toBeNull()
		expect(run({ ...OLD, discoverSources: false, partylineInterface: '10.96.30.50' }).updatedConfig).toBeNull()
	})

	it('adds only what is missing, and never overrides a choice', () => {
		expect(run({ ...OLD, discoverSources: false }).updatedConfig).toEqual({
			...OLD,
			discoverSources: false,
			partylineInterface: '',
		})
		expect(run({ ...OLD, partylineInterface: '10.96.30.50' }).updatedConfig).toEqual({
			...OLD,
			discoverSources: true,
			partylineInterface: '10.96.30.50',
		})
	})

	it('replaces values of the wrong type', () => {
		expect(run({ ...OLD, discoverSources: 'yes', partylineInterface: 5 }).updatedConfig).toMatchObject({
			discoverSources: true,
			partylineInterface: '',
		})
	})

	it('has nothing to do without a config', () => {
		expect(run(null)).toEqual({ updatedConfig: null, updatedActions: [], updatedFeedbacks: [] })
	})

	it('is idempotent', () => {
		const once = run(OLD).updatedConfig
		expect(run(once).updatedConfig).toBeNull()
	})
})
