/**
 * The registry's whole job is that the CPU curve, the WGSL curve and the host's menu cannot fall
 * out of step. These tests assert that coupling directly, so adding a transform and forgetting one
 * of its consumers fails here rather than as a wrong image at readback.
 */

import { describe, it, expect } from 'vitest';
import {
	VIEW_TRANSFORMS, getViewTransform, listViewTransforms, buildToneMapWGSL,
	addViewTransform, removeViewTransform, countTableTransforms, MAX_TABLE_TRANSFORMS,
	getRegistryVersion, onRegistryChange, nextOcioId, OCIO_VIEW_BASE,
} from '@/core/Color/ViewTransforms.js';
import { TONE_MAP_FNS } from '@/core/Processor/ToneMapCPU.js';

const stub = ( i, { table = false } = {} ) => ( {
	id: 800000 + i,
	name: `Filler ${i}`,
	wgslConst: `TM_FILLER_${i}`,
	cpu: ( r, g, b, e, out ) => {

		out[ 0 ] = r; out[ 1 ] = g; out[ 2 ] = b;

	},
	wgsl: `fn filler_${i}( c: vec3<f32> ) -> vec3<f32> { return c; }`,
	call: `filler_${i}( c )`,
	...( table ? { table: { data: new Uint16Array( 8 ), size: 1 } } : {} ),
} );

describe( 'the registry', () => {

	it( 'gives every transform a unique id, name and shader constant', () => {

		const ids = [ ...VIEW_TRANSFORMS.values() ].map( t => t.id );
		const names = [ ...VIEW_TRANSFORMS.values() ].map( t => t.name );
		const consts = [ ...VIEW_TRANSFORMS.values() ].map( t => t.wgslConst );

		expect( new Set( ids ).size ).toBe( ids.length );
		expect( new Set( names ).size ).toBe( names.length );
		expect( new Set( consts ).size ).toBe( consts.length );
		expect( consts.every( c => /^TM_[A-Z0-9_]+$/.test( c ) ) ).toBe( true );

	} );

	it( 'is exactly what the CPU readback offers', () => {

		expect( [ ...TONE_MAP_FNS.keys() ].sort( ( a, b ) => a - b ) )
			.toEqual( [ ...VIEW_TRANSFORMS.keys() ].sort( ( a, b ) => a - b ) );

	} );

	it( 'is exactly what a host menu would show', () => {

		expect( listViewTransforms().map( t => t.id ) ).toEqual( [ ...VIEW_TRANSFORMS.keys() ] );

	} );

	it( 'reports an unknown id as null rather than guessing', () => {

		expect( getViewTransform( 987654 ) ).toBeNull();

	} );

	it( 'refuses a transform missing anything a consumer needs', () => {

		expect( () => addViewTransform( { name: 'x', wgslConst: 'TM_X', cpu: () => {} } ) ).toThrow( /numeric id/ );
		expect( () => addViewTransform( { id: 9001, name: 'x', wgslConst: 'TM_X' } ) ).toThrow( /cpu function/ );
		expect( () => addViewTransform( { id: 9001, wgslConst: 'TM_X', cpu: () => {} } ) ).toThrow( /needs a name/ );
		expect( () => addViewTransform( { id: 9001, name: 'x', cpu: () => {} } ) ).toThrow( /wgslConst/ );
		expect( () => addViewTransform( { id: 9001, name: 'x', wgslConst: 'bad', cpu: () => {} } ) ).toThrow( /wgslConst/ );

	} );

	it( 'tells its consumers when it changes', () => {

		let fired = 0;
		const off = onRegistryChange( () => fired ++ );
		const before = getRegistryVersion();

		addViewTransform( stub( 1 ) );
		expect( fired ).toBe( 1 );
		expect( getRegistryVersion() ).toBeGreaterThan( before );
		expect( TONE_MAP_FNS.has( 800001 ) ).toBe( true );

		removeViewTransform( 800001 );
		expect( fired ).toBe( 2 );
		expect( TONE_MAP_FNS.has( 800001 ) ).toBe( false );

		off();
		addViewTransform( stub( 2 ) );
		expect( fired ).toBe( 2 );
		removeViewTransform( 800002 );

	} );

	it( 'hands out OCIO ids above the reserved base, without collisions', () => {

		const a = nextOcioId();
		expect( a ).toBeGreaterThanOrEqual( OCIO_VIEW_BASE );

		addViewTransform( { ...stub( 3 ), id: a } );
		expect( nextOcioId() ).not.toBe( a );
		removeViewTransform( a );

	} );

} );

describe( 'the table-binding ceiling', () => {

	// The readback binds every table in ONE shader, and WebGPU only guarantees 16 sampled textures
	// per stage. Without this the failure is a shader that will not compile, at the moment someone
	// bakes one view too many.
	it( 'refuses the transform that would exceed it, and says why', () => {

		const added = [];

		try {

			let i = 100;
			while ( countTableTransforms() < MAX_TABLE_TRANSFORMS ) {

				addViewTransform( stub( i, { table: true } ) );
				added.push( 800000 + i ++ );

			}

			expect( () => addViewTransform( stub( i, { table: true } ) ) ).toThrow( /16 sampled textures/ );

			// Replacing one already registered is still fine — that is how a rebake works.
			expect( () => addViewTransform( stub( i - 1, { table: true } ) ) ).not.toThrow();

		} finally {

			for ( const id of added ) removeViewTransform( id );

		}

		expect( countTableTransforms() ).toBeLessThan( MAX_TABLE_TRANSFORMS );

	} );

} );

describe( 'the generated shader', () => {

	it( 'declares a mode constant for every transform', () => {

		const { wgsl } = buildToneMapWGSL();
		for ( const t of VIEW_TRANSFORMS.values() ) {

			expect( wgsl ).toContain( `const ${t.wgslConst}: u32 = ${t.id}u;` );

		}

	} );

	it( 'dispatches to every transform that has a curve, and defines what it calls', () => {

		const { wgsl } = buildToneMapWGSL();
		for ( const t of VIEW_TRANSFORMS.values() ) {

			// A transform without a `call` falls through to the clamp on purpose — that IS None.
			if ( ! t.call ) continue;

			expect( wgsl, `${t.name} declared but never dispatched` )
				.toContain( `if ( mode == ${t.wgslConst} ) { return ${t.call}; }` );

			const fnName = t.call.slice( 0, t.call.indexOf( '(' ) ).trim();
			expect( wgsl, `${t.call} has no definition` ).toContain( `fn ${fnName}(` );

		}

	} );

	it( 'allocates a binding for every table-backed transform and nothing for the rest', () => {

		const added = [];
		try {

			addViewTransform( stub( 200, { table: true } ) );
			added.push( 800200 );

			const { wgsl, bindings } = buildToneMapWGSL();
			const needy = [ ...VIEW_TRANSFORMS.values() ].filter( t => t.table );
			expect( bindings.map( b => b.transform ) ).toEqual( needy );

			// Sequential from the first free index, so the caller's own bindings survive.
			let expected = 3;
			for ( const b of bindings ) {

				expect( b.index ).toBe( expected ++ );
				expect( wgsl ).toContain( `@binding(${b.index}) var ${b.texName}: texture_3d<f32>` );

			}

		} finally {

			for ( const id of added ) removeViewTransform( id );

		}

	} );

	it( 'honours a caller that owns more bindings of its own', () => {

		const added = [];
		try {

			addViewTransform( stub( 201, { table: true } ) );
			added.push( 800201 );

			const shifted = buildToneMapWGSL( { group: 2, firstBinding: 9 } );
			expect( shifted.bindings[ 0 ].index ).toBe( 9 );
			expect( shifted.wgsl ).toContain( '@group(2) @binding(9)' );

		} finally {

			for ( const id of added ) removeViewTransform( id );

		}

	} );

	it( 'skips the transfer only for transforms that encoded their own output', () => {

		const added = [];
		try {

			addViewTransform( { ...stub( 300 ), outputEncoded: true } );
			added.push( 800300 );

			const { wgsl } = buildToneMapWGSL();
			expect( wgsl ).toContain( 'fn rayzee_output_encoded( mode: u32 ) -> bool' );
			expect( wgsl ).toContain( 'mode == TM_FILLER_300' );
			expect( wgsl ).not.toContain( 'mode == TM_AGX ||' );

		} finally {

			for ( const id of added ) removeViewTransform( id );

		}

	} );

	it( 'keeps the half-level rounding the CPU readback has always had', () => {

		expect( buildToneMapWGSL().wgsl ).toContain( 'round( srgb * 255.0 + vec3<f32>( 0.5 ) )' );

	} );

} );
