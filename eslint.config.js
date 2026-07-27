import js from '@eslint/js';
import mdcs from 'eslint-config-mdcs';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import reactCompiler from 'eslint-plugin-react-compiler';

// console.log(mdcs)
export default [
	// mdcs,
	{ ignores: [ 'node_modules', '**/dist', '.claude' ] },
	{
		files: [ '**/*.{js,jsx}' ],
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
			parserOptions: {
				ecmaVersion: 'latest',
				ecmaFeatures: { jsx: true },
				sourceType: 'module',
			},
		},
		settings: { react: { version: '18.3' } },
		plugins: {
			react,
			'react-hooks': reactHooks,
			'react-refresh': reactRefresh,
			'react-compiler': reactCompiler,
		},
		rules: {
			...js.configs.recommended.rules,
			...mdcs.rules,
			...react.configs.recommended.rules,
			...react.configs[ 'jsx-runtime' ].rules,
			...reactHooks.configs.recommended.rules,
			indent: [ "error", "tab", { "SwitchCase": 1 } ],
			"react/prop-types": 0,
			'react/jsx-no-target-blank': 'off',
			'react-refresh/only-export-components': [
				'warn',
				{ allowConstantExport: true },
			],
			'react-compiler/react-compiler': 'error',
		},
	},
	{
		// Node-side regression tooling: the runner and its pure libraries execute under
		// Node, not the browser, so they need Node globals rather than `globals.browser`.
		// bench/harness/** is deliberately excluded — that code runs in the page.
		files: [ 'bench/runner/**/*.js', 'bench/lib/**/*.js' ],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
];
