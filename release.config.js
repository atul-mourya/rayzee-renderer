const config = {
	branches: [ 'main' ],
	plugins: [
		[ '@semantic-release/commit-analyzer', {
			preset: 'angular',
			releaseRules: [
				// Scope matching is case-sensitive and every docs commit in this repo writes
				// it lowercase, so 'README' never matched anything.
				{ type: 'docs', scope: 'readme', release: 'patch' },
				{ type: 'feat', release: 'minor' },
				{ type: 'fix', release: 'patch' },
				{ type: 'perf', release: 'patch' },
				// build/ changes the published artifact, so it has to be able to ship one.
				// 7.20.0 went out with worker side-chunks that broke the package on
				// bundlephobia; the fix was typed build(engine) and silently never released.
				{ type: 'build', release: 'patch' },
			],
			parserOpts: {
				noteKeywords: [ 'BREAKING CHANGE', 'BREAKING CHANGES' ]
			}
		} ],
		[ '@semantic-release/release-notes-generator', {
			// The default `angular` preset's writer discards every type except feat/fix/perf/revert,
			// but commit-analyzer above releases on docs(readme) and build too — so 7.23.2 and 7.23.3
			// both shipped, and published to npm, with a body containing only the compare link.
			// Listing the types here keeps "every release has notes" true by construction.
			preset: 'conventionalcommits',
			presetConfig: {
				// Held on the preset's v9 line deliberately. v10 hard-errors with "requires
				// conventional-changelog-writer@9 or newer", and release-notes-generator pins that
				// writer to ^8 — and v10 renames this visibility key from `hidden` to `effect`, so
				// the two majors are not drop-in for each other.
				types: [
					{ type: 'feat', section: 'Features' },
					{ type: 'fix', section: 'Bug Fixes' },
					{ type: 'perf', section: 'Performance Improvements' },
					{ type: 'revert', section: 'Reverts' },
					{ type: 'docs', section: 'Documentation' },
					{ type: 'build', section: 'Build System' },
					{ type: 'style', hidden: true },
					{ type: 'chore', hidden: true },
					{ type: 'refactor', hidden: true },
					{ type: 'test', hidden: true },
					{ type: 'ci', hidden: true },
				]
			}
		} ],
		'semantic-release-export-data',
		[ '@semantic-release/npm', {
			npmPublish: true,
			pkgRoot: 'rayzee',
		} ],
		[ '@semantic-release/git', {
			assets: [ 'rayzee/package.json', 'rayzee/README.md', 'README.md' ],
			message: 'chore(release): ${nextRelease.version}\n\n${nextRelease.notes}'
		} ],
		// successComment/failComment disabled: commit bodies reference internal
		// parity-gap numbers (#4, #11, ...) that aren't real issues/PRs, which
		// 404s the post-publish comment step.
		[ '@semantic-release/github', {
			successComment: false,
			failComment: false,
		} ]
	],
	debug: true
};

export default config;
