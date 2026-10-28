import { describe, it, expect } from 'vitest';
import {
	BufferAttribute, DataArrayTexture, DataTexture, FloatType, HalfFloatType, RedFormat, RGBAFormat, RGFormat,
	ShortType, UnsignedByteType, WebGLRenderTarget,
} from 'three';
import { VRAMTracker, bufferBytes, textureBytes } from '@/core/memory/VRAMTracker.js';

const MB = 1048576;

const texture = ( width, height, format, type ) => new DataTexture( null, width, height, format, type );

// As three's backend: `get` makes an entry for anything it is asked about.
const backendHolding = ( ...resident ) => {

	const data = new Map( resident.map( t => [ t, { texture: {} } ] ) );
	const get = t => {

		if ( ! data.has( t ) ) data.set( t, {} );
		return data.get( t );

	};

	return { data, backend: { has: t => data.has( t ), get } };

};

describe( 'bufferBytes / textureBytes', () => {

	it( 'sizes a buffer by its array, or by the GPU length when it has none', () => {

		expect( bufferBytes( new BufferAttribute( new Float32Array( 10 ), 1 ) ) ).toBe( 40 );
		expect( bufferBytes( { gpuByteLength: 4096 } ) ).toBe( 4096 );
		expect( bufferBytes( { gpuByteLength: 8, array: new Float32Array( 100 ) } ) ).toBe( 8 );
		expect( bufferBytes( null ) ).toBe( 0 );
		expect( bufferBytes( {} ) ).toBe( 0 );

	} );

	it( 'sizes a texture by dimensions, channels and type', () => {

		expect( textureBytes( texture( 4, 2, RGBAFormat, FloatType ) ) ).toBe( 4 * 2 * 16 );
		expect( textureBytes( texture( 4, 2, RGBAFormat, HalfFloatType ) ) ).toBe( 4 * 2 * 8 );
		expect( textureBytes( texture( 4, 2, RGFormat, UnsignedByteType ) ) ).toBe( 4 * 2 * 2 );
		expect( textureBytes( texture( 4, 2, RedFormat, ShortType ) ) ).toBe( 4 * 2 * 2 );
		expect( textureBytes( new DataArrayTexture( null, 8, 8, 3 ) ) ).toBe( 8 * 8 * 3 * 4 );
		expect( textureBytes( { format: 'unknown', type: 'unknown', width: 2, height: 2 } ) ).toBe( 2 * 2 * 16 );
		expect( textureBytes( null ) ).toBe( 0 );

	} );

	it( 'sizes a render target over each of its textures and its depth', () => {

		const target = new WebGLRenderTarget( 8, 4, { count: 2, type: FloatType } );
		expect( textureBytes( target ) ).toBe( 2 * 8 * 4 * 16 );
		expect( textureBytes( { isRenderTarget: true, width: 2, height: 2, depth: 3, texture: { format: RGBAFormat, type: UnsignedByteType } } ) ).toBe( 2 * 2 * 3 * 4 );
		expect( textureBytes( { isRenderTarget: true, texture: { format: RGBAFormat, type: FloatType } } ) ).toBe( 0 );

	} );

} );

describe( 'VRAMTracker', () => {

	it( 'adds every provider up by category and keeps the peak', () => {

		const tracker = new VRAMTracker();
		let size = 100;
		tracker.register( 'buffers', () => new BufferAttribute( new Uint8Array( size ), 1 ) );
		tracker.register( 'textures', () => [ texture( 2, 2, RGBAFormat, FloatType ), null, { name: 'not a resource' } ] );
		tracker.register( 'synthetic', () => ( { bytes: 7 } ) );
		tracker.register( 'skipped', () => null );
		tracker.register( 'broken', () => {

			throw new Error( 'gone' );

		} );

		expect( tracker.measure() ).toEqual( { current: 100 + 64 + 7, peak: 171, byCategory: { buffers: 100, textures: 64, synthetic: 7 } } );

		size = 10;
		const after = tracker.measure();
		expect( after.current ).toBe( 81 );
		expect( after.peak ).toBe( 171 );
		tracker.resetPeak();
		expect( tracker.peak ).toBe( 81 );

	} );

	it( 'counts a resource shared between providers once', () => {

		const tracker = new VRAMTracker();
		const array = new Float32Array( 256 );
		const tex = texture( 4, 4, RGBAFormat, UnsignedByteType );
		const gpuOnly = { gpuByteLength: 512 };
		tracker.register( 'a', () => [ new BufferAttribute( array, 4 ), tex, gpuOnly ] );
		tracker.register( 'b', () => [ new BufferAttribute( array, 1 ), tex, gpuOnly, { isTexture: true, bytes: 5, format: RGBAFormat, type: UnsignedByteType, image: { width: 1, height: 1 } } ] );

		const { byCategory, current } = tracker.measure();
		expect( byCategory ).toEqual( { a: 1024 + 64 + 512, b: 4 } );
		expect( current ).toBe( 1604 );

	} );

	it( 'counts only textures the backend holds once a renderer is bound', () => {

		const used = texture( 4, 4, RGBAFormat, FloatType );
		const unused = texture( 64, 64, RGBAFormat, FloatType );
		const target = new WebGLRenderTarget( 2, 2, { count: 2, type: FloatType } );
		const tracker = new VRAMTracker();
		tracker.register( 'stage', () => [ used, unused, target ] );

		expect( tracker.measure().current ).toBe( 256 + 65536 + 128 );

		const renderer = backendHolding( used, target.textures[ 1 ] );
		tracker.setRenderer( renderer );
		expect( tracker.measure().current ).toBe( 256 + 64 );
		expect( renderer.data.has( unused ) ).toBe( false );

		tracker.setRenderer( { backend: { get: t => ( t === unused ? { gpuTexture: {} } : null ) } } );
		expect( tracker.measure().current ).toBe( 65536 );

		tracker.setRenderer( { backend: {} } );
		expect( tracker.measure().current ).toBe( 256 + 65536 + 128 );

	} );

	it( 'reports in megabytes by category', () => {

		const tracker = new VRAMTracker();
		tracker.register( 'bvh', () => ( { bytes: 3 * MB } ) );
		tracker.register( 'env', () => ( { bytes: MB / 2 } ) );
		tracker.measure();
		tracker.register( 'late', () => ( { bytes: 10 } ) );
		expect( tracker.getReport() ).toBe( 'VRAM current=3.5MB peak=3.5MB [bvh=3.0 env=0.5]' );

	} );

} );
