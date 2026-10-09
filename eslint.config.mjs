import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
	ignores: ['_research/**'],
})

export default [
	...baseConfig,
	{
		// Test tooling is a dev dependency, which is fine outside the published module
		files: ['test/**/*.ts', 'vitest.config.ts'],
		rules: {
			'n/no-unpublished-import': 'off',
		},
	},
]
