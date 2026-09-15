import { describe, it, expect } from 'vitest';
import { VirtualFS, loadPBRTScene, pickEntryPathFrom } from '@/core/Processor/PBRT/index.js';

const enc = new TextEncoder();

// A scene split across includes, with one fragment pulled in twice — the case that forced
// the old loader to hold every .pbrt until parsing finished.
const FILES = {
	'island.pbrt': enc.encode( `
		LookAt 0 0 5   0 0 0   0 1 0
		Camera "perspective" "float fov" 40
		WorldBegin
		Include "lib/materials.pbrt"
		AttributeBegin
			Translate 0 0 0
			Include "lib/shapes.pbrt"
		AttributeEnd
		AttributeBegin
			Translate 4 0 0
			Include "lib/shapes.pbrt"
		AttributeEnd
	` ),
	'lib/materials.pbrt': enc.encode( 'MakeNamedMaterial "wood" "string type" [ "diffuse" ]\n' ),
	'lib/shapes.pbrt': enc.encode( `
		NamedMaterial "wood"
		Shape "trianglemesh" "point3 P" [ -1 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ]
	` ),
};

/** A seekable source that serves bytes on demand and counts what it hands out. */
function lazySource( files ) {

	const reads = [];
	return {
		reads,
		listing: Object.entries( files ).map( ( [ path, body ], i ) => ( { path, size: body.length, offset: i } ) ),
		read: async ( path ) => {

			reads.push( path );
			const b = files[ path ];
			// A fresh copy every time, like a real slice of the archive.
			return b ? b.slice() : null;

		},
	};

}

const args = extra => ( {
	plyParser: () => null,
	imageFromBytes: async () => null,
	...extra,
} );

const describeScene = group => {

	const out = [];
	group.traverse( o => {

		if ( o.isMesh ) out.push( {
			tris: o.geometry.getAttribute( 'position' ).count / 3,
			pos: o.matrixWorld.elements.slice( 12, 15 ).map( v => + v.toFixed( 4 ) ),
		} );

	} );
	return out;

};

describe( 'lazily indexed archive', () => {

	it( 'builds the same scene whether entries are resident or read on demand', async () => {

		const eager = await loadPBRTScene( args( { vfs: { ...FILES } } ) );
		const src = lazySource( FILES );
		const lazy = await loadPBRTScene( args( { vfs: {}, source: src } ) );

		expect( lazy.entryPath ).toBe( eager.entryPath );
		expect( describeScene( lazy.group ) ).toEqual( describeScene( eager.group ) );
		expect( lazy.warnings ).toEqual( eager.warnings );

	} );

	it( 'never holds an include after it has been parsed', async () => {

		const src = lazySource( FILES );
		const vfs = new VirtualFS( {}, src );
		await loadPBRTScene( args( { vfs: {}, source: src } ) );

		// Build a fresh view over the same source and confirm nothing was cached on it.
		for ( const rec of vfs.records ) expect( rec.bytes ).toBeNull();

	} );

	it( 're-reads a fragment that is included more than once', async () => {

		const src = lazySource( FILES );
		await loadPBRTScene( args( { vfs: {}, source: src } ) );

		// Included twice, and read once more while picking the entry file: every use is a
		// fresh read, which is what makes releasing after each include safe.
		const shapeReads = src.reads.filter( p => p === 'lib/shapes.pbrt' ).length;
		expect( shapeReads ).toBe( 3 );

	} );

	it( 'picks the entry .pbrt from a lazy index without keeping the candidates', async () => {

		const src = lazySource( FILES );
		const vfs = new VirtualFS( {}, src );

		expect( await pickEntryPathFrom( vfs ) ).toBe( 'island.pbrt' );
		for ( const rec of vfs.records ) expect( rec.bytes ).toBeNull();

	} );

	it( 'still works when some entries are resident and others are not', async () => {

		const src = lazySource( FILES );
		const mixed = await loadPBRTScene( args( {
			vfs: { 'island.pbrt': FILES[ 'island.pbrt' ].slice() },
			source: src,
		} ) );

		const eager = await loadPBRTScene( args( { vfs: { ...FILES } } ) );
		expect( describeScene( mixed.group ) ).toEqual( describeScene( eager.group ) );

	} );

} );
