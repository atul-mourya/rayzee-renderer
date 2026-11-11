import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crateSourceHash } from '../../../rayzee/wasm/build.mjs';

const generated = readFileSync( fileURLToPath( new URL( '../../../rayzee/src/bvh/BVHCoreWasm.js', import.meta.url ) ), 'utf8' );

describe( 'bvh/BVHCoreWasm.js', () => {

	it( 'was generated from the Rust sources as they are: after editing rayzee/wasm/bvh, run npm run build:wasm', () => {

		expect( generated.match( /\(source ([0-9a-f]{16}),/ )?.[ 1 ] ).toBe( crateSourceHash() );

	} );

} );
