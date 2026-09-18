import { describe, it, expect } from 'vitest';
import { tokenize, TokenType } from '@/core/Processor/PBRT/PBRTTokenizer.js';
import { PBRTParser, parsePBRT } from '@/core/Processor/PBRT/PBRTParser.js';

describe( 'PBRT tokenizer', () => {

	it( 'tokenizes numbers, strings, brackets and skips comments', async () => {

		const toks = tokenize( `# a comment
			Shape "trianglemesh" "float v" [ -1 .5 1e-3 -2.5e2 ] true` );

		expect( toks[ 0 ] ).toEqual( { type: TokenType.WORD, value: 'Shape' } );
		expect( toks[ 1 ] ).toEqual( { type: TokenType.STRING, value: 'trianglemesh' } );
		expect( toks[ 2 ] ).toEqual( { type: TokenType.STRING, value: 'float v' } );
		expect( toks[ 3 ].type ).toBe( TokenType.LBRACKET );
		expect( toks.slice( 4, 8 ).map( t => t.value ) ).toEqual( [ - 1, 0.5, 1e-3, - 250 ] );
		expect( toks[ 8 ].type ).toBe( TokenType.RBRACKET );
		expect( toks[ 9 ] ).toEqual( { type: TokenType.WORD, value: 'true' } );

	} );

	it( 'throws on an unterminated string', async () => {

		expect( () => tokenize( 'Shape "oops' ) ).toThrow( /unterminated/ );

	} );

	it( 'tokenizes signed + leading-dot numbers (-.55, +.5, .25)', async () => {

		const toks = tokenize( 'Transform [ -.55 +.5 .25 -0.5 +0.5 ]' );
		expect( toks.slice( 2, 7 ).map( t => t.value ) ).toEqual( [ - 0.55, 0.5, 0.25, - 0.5, 0.5 ] );

	} );

} );

describe( 'PBRT parser', () => {

	it( 'derives camera-to-world from LookAt (inverse-of-inverse round trip)', async () => {

		const ir = await parsePBRT( `
			LookAt 0 0 5   0 0 0   0 1 0
			Camera "perspective" "float fov" 45
			Film "rgb" "integer xresolution" 800 "integer yresolution" 600
			WorldBegin
		` );

		expect( ir.camera.type ).toBe( 'perspective' );
		expect( ir.camera.params.fov.value[ 0 ] ).toBe( 45 );

		const m = ir.camera.cameraToWorld;
		// translation column == eye
		expect( m[ 12 ] ).toBeCloseTo( 0, 5 );
		expect( m[ 13 ] ).toBeCloseTo( 0, 5 );
		expect( m[ 14 ] ).toBeCloseTo( 5, 5 );
		// viewing direction column (dir) == -z
		expect( m[ 8 ] ).toBeCloseTo( 0, 5 );
		expect( m[ 10 ] ).toBeCloseTo( - 1, 5 );

		expect( ir.film.xresolution ).toBe( 800 );
		expect( ir.film.yresolution ).toBe( 600 );

	} );

	it( 'accumulates the CTM and captures it per-shape', async () => {

		const ir = await parsePBRT( `
			WorldBegin
			AttributeBegin
				Translate 1 2 3
				Shape "sphere" "float radius" 0.25
			AttributeEnd
			Shape "sphere" "float radius" 1
		` );

		expect( ir.shapes ).toHaveLength( 2 );
		// first shape carries the translate
		expect( ir.shapes[ 0 ].ctm.slice( 12, 15 ) ).toEqual( [ 1, 2, 3 ] );
		expect( ir.shapes[ 0 ].params.radius.value[ 0 ] ).toBe( 0.25 );
		// AttributeEnd restored CTM → second shape is at the origin
		expect( ir.shapes[ 1 ].ctm.slice( 12, 15 ) ).toEqual( [ 0, 0, 0 ] );

	} );

	it( 'resolves named materials and attaches them to shapes', async () => {

		const ir = await parsePBRT( `
			WorldBegin
			MakeNamedMaterial "glass" "string type" "dielectric" "float eta" 1.5
			NamedMaterial "glass"
			Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [ 0 1 2 ]
		` );

		expect( ir.namedMaterials.get( 'glass' ).type ).toBe( 'dielectric' );
		const shape = ir.shapes[ 0 ];
		expect( shape.material.type ).toBe( 'dielectric' );
		expect( shape.material.params.eta.value[ 0 ] ).toBe( 1.5 );
		// A long list comes back typed, at the width the consumer needs; a short one stays a
		// plain array, where an ArrayBuffer plus its view would cost more than the numbers.
		expect( shape.params.P.value ).toBeInstanceOf( Float32Array );
		expect( Array.isArray( shape.params.indices.value ) ).toBe( true );
		expect( Array.from( shape.params.P.value ) ).toEqual( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
		expect( Array.from( shape.params.indices.value ) ).toEqual( [ 0, 1, 2 ] );

	} );

	it( 'attaches area-light emission to shapes within the attribute block', async () => {

		const ir = await parsePBRT( `
			WorldBegin
			AttributeBegin
				AreaLightSource "diffuse" "rgb L" [ 4 4 4 ]
				Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [ 0 1 2 ]
			AttributeEnd
			Shape "sphere" "float radius" 1
		` );

		expect( Array.from( ir.shapes[ 0 ].areaLight.params.L.value ) ).toEqual( [ 4, 4, 4 ] );
		expect( ir.shapes[ 1 ].areaLight ).toBeNull();

	} );

	it( 'follows Include directives via the resolver', async () => {

		const files = {
			'geometry/tri.pbrt': `Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [ 0 1 2 ]`
		};
		const parser = new PBRTParser( { resolveInclude: ( p ) => files[ p ] ?? null } );
		const ir = await parser.parse( `
			WorldBegin
			Include "geometry/tri.pbrt"
			Shape "sphere" "float radius" 1
		` );

		expect( ir.shapes ).toHaveLength( 2 );
		expect( ir.shapes[ 0 ].type ).toBe( 'trianglemesh' );
		expect( ir.shapes[ 1 ].type ).toBe( 'sphere' );

	} );

	it( 'parses Transform matrices column-major', async () => {

		const ir = await parsePBRT( `
			WorldBegin
			Transform [ 1 0 0 0  0 1 0 0  0 0 1 0  5 6 7 1 ]
			Shape "sphere" "float radius" 1
		` );
		expect( ir.shapes[ 0 ].ctm.slice( 12, 15 ) ).toEqual( [ 5, 6, 7 ] );

	} );

	it( 'records instances and object templates', async () => {

		const ir = await parsePBRT( `
			WorldBegin
			ObjectBegin "leaf"
				Shape "sphere" "float radius" 1
			ObjectEnd
			Translate 10 0 0
			ObjectInstance "leaf"
		` );

		expect( ir.objects.get( 'leaf' ) ).toHaveLength( 1 );
		// Placements are packed per template: a name, a count, and the transforms end to end.
		expect( ir.instanceCount ).toBe( 1 );
		const leaf = ir.instances.get( 'leaf' );
		expect( leaf.count ).toBe( 1 );
		expect( leaf.matrices ).toBeInstanceOf( Float32Array );
		expect( Array.from( leaf.matrices.slice( 12, 15 ) ) ).toEqual( [ 10, 0, 0 ] );

	} );

	it( 'warns on unknown directives without desyncing', async () => {

		const ir = await parsePBRT( `
			Integrator "volpath" "integer maxdepth" 64
			Sampler "halton" "integer pixelsamples" 16
			WorldBegin
			Shape "sphere" "float radius" 1
		` );
		expect( ir.shapes ).toHaveLength( 1 );

	} );


	it( 'switches a long numeric list to a typed array and keeps a short one plain', async () => {

		const n = 40;
		const P = [], idx = [];
		for ( let i = 0; i < n; i ++ ) P.push( i, 0, 0 );
		for ( let i = 0; i + 2 < n; i ++ ) idx.push( i, i + 1, i + 2 );

		const ir = await new PBRTParser( {} ).parse( `WorldBegin
			Shape "trianglemesh" "point3 P" [ ${P.join( ' ' )} ] "integer indices" [ ${idx.join( ' ' )} ]
			  "float alpha" [ 0.5 ] "rgb tint" [ 1 0 0 ]` );

		const params = ir.shapes[ 0 ].params;
		expect( params.P.value ).toBeInstanceOf( Float32Array );
		expect( params.P.value.length ).toBe( n * 3 );
		expect( params.indices.value ).toBeInstanceOf( Int32Array );
		expect( Array.isArray( params.alpha.value ) ).toBe( true );
		expect( Array.isArray( params.tint.value ) ).toBe( true );

	} );

	it( 'shares one CTM array across shapes emitted under the same transform', async () => {

		const ir = await new PBRTParser( {} ).parse( `WorldBegin
			Translate 1 2 3
			Shape "sphere" "float radius" 1
			Shape "sphere" "float radius" 2
			Translate 1 0 0
			Shape "sphere" "float radius" 3` );

		expect( ir.shapes[ 1 ].ctm ).toBe( ir.shapes[ 0 ].ctm );
		expect( ir.shapes[ 2 ].ctm ).not.toBe( ir.shapes[ 0 ].ctm );
		expect( ir.shapes[ 2 ].ctm[ 12 ] ).toBe( 2 );

	} );


	it( 'drops placements past the limit while parsing, and counts them', async () => {

		const body = Array.from( { length: 40 }, ( _, i ) => `AttributeBegin Translate ${i} 0 0 ObjectInstance "leaf" AttributeEnd` ).join( '\n' );
		const ir = await new PBRTParser( { maxPlacements: 12 } ).parse( `WorldBegin
			AttributeBegin ObjectBegin "leaf" Shape "sphere" "float radius" 1 ObjectEnd AttributeEnd
			${body}` );

		// The peak cost is the parse itself, so the limit has to bite here rather than later.
		expect( ir.instanceCount ).toBe( 12 );
		expect( ir.skippedInstances ).toBe( 28 );
		expect( ir.instances.get( 'leaf' ).count ).toBe( 12 );

	} );

	it( 'packs one template\'s placements contiguously', async () => {

		const ir = await new PBRTParser( {} ).parse( `WorldBegin
			AttributeBegin ObjectBegin "a" Shape "sphere" "float radius" 1 ObjectEnd AttributeEnd
			AttributeBegin Translate 1 0 0 ObjectInstance "a" AttributeEnd
			AttributeBegin Translate 2 0 0 ObjectInstance "a" AttributeEnd
			AttributeBegin Translate 3 0 0 ObjectInstance "a" AttributeEnd` );

		const a = ir.instances.get( 'a' );
		expect( a.count ).toBe( 3 );
		expect( [ 0, 1, 2 ].map( i => a.matrices[ i * 16 + 12 ] ) ).toEqual( [ 1, 2, 3 ] );

	} );

} );
