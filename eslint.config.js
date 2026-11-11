import js from '@eslint/js';
import mdcs from 'eslint-config-mdcs';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// console.log(mdcs)
export default [
	// mdcs,
	{ ignores: [ 'node_modules', '**/dist', 'coverage', '.claude', '.agents', '.cdn-upload', 'app/public', 'docs/internal' ] },
	{
		files: [ '**/*.{js,jsx}' ],
		languageOptions: {
			// 2021 for WeakRef / FinalizationRegistry. Widens the known-globals set only —
			// parsing is already on 'latest' via parserOptions below.
			ecmaVersion: 2021,
			globals: globals.browser,
			parserOptions: {
				ecmaVersion: 'latest',
				ecmaFeatures: { jsx: true },
				sourceType: 'module',
			},
		},
		plugins: {
			'react-hooks': reactHooks,
			'react-refresh': reactRefresh,
		},
		rules: {
			...js.configs.recommended.rules,
			...mdcs.rules,
			...reactHooks.configs.recommended.rules,
			// The code does not meet these yet: warn until each site is fixed.
			'react-hooks/set-state-in-effect': 'warn',
			'react-hooks/refs': 'warn',
			'react-hooks/static-components': 'warn',
			'preserve-caught-error': 'warn',
			// Also flags a deliberate `x = null` that frees a large buffer early.
			'no-useless-assignment': 'warn',
			indent: [ "error", "tab", { "SwitchCase": 1 } ],
			'react-refresh/only-export-components': [
				'warn',
				{ allowConstantExport: true },
			],
			// `_` marks a deliberately unused name, e.g. a positional TSL input or a forwardRef ref.
			'no-unused-vars': [ 'warn', {
				ignoreRestSiblings: true,
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				destructuredArrayIgnorePattern: '^_',
			} ],
		},
	},
	{
		files: [ '**/*.config.js' ],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	{
		// Node-side regression tooling: the runner and its pure libraries execute under
		// Node, not the browser, so they need Node globals rather than `globals.browser`.
		// bench/harness/** is deliberately excluded — that code runs in the page.
		files: [ 'bench/runner/**/*.js', 'bench/lib/**/*.js', 'bench/node/**/*.js', 'bench/load/**/*.js', 'rayzee/src/node/**/*.js' ],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	{
		// Tests run under Node (WebGPU ones with the browser's GPU globals installed), with
		// vitest's `globals: true`.
		files: [ 'tests/**/*.js' ],
		languageOptions: {
			globals: { ...globals.node, ...globals.vitest },
		},
	},
];
