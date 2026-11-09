/**
 * A solid colour's sampling table is the same at any brightness, so a new colour of the solid sky keeps the table and
 * only its integral changes (EnvironmentManager._reuseSolidTable).
 */
import { describe, it, expect, vi } from 'vitest';
import { Color, Texture, FloatType } from 'three';

const builds = vi.hoisted( () => ( { count: 0, delay: 0 } ) );

vi.mock( '@/core/environment/CDFWorker.js?worker&inline', async () => {

	const { buildExactEnvironmentTable } = await import( '@/core/environment/EnvironmentExactTable.js' );
	return { default: class {

		// As a real worker: ended, it answers nothing.
		terminate() {

			this.ended = true;

		}

		postMessage( { floatData, width, height } ) {

			builds.count ++;
			const data = { width, height, ...buildExactEnvironmentTable( floatData, width, height ) };
			setTimeout( () => this.ended || this.onmessage( { data } ), builds.delay );

		}

	} };

} );

const { buildExactEnvironmentTable, environmentRadianceIntegral, packExactTable } = await import( '@/core/environment/EnvironmentExactTable.js' );
const { EnvironmentManager } = await import( '@/core/environment/EnvironmentManager.js' );
const { EquirectHDRInfo } = await import( '@/core/environment/EquirectHDRInfo.js' );

const uniform = ( width, height, [ r, g, b ] ) => {

	const data = new Float32Array( width * height * 4 );
	for ( let i = 0; i < data.length; i += 4 ) data.set( [ r, g, b, 1 ], i );
	return data;

};

describe( 'the solid sky\'s table', () => {

	it( 'has its integral computed as a full build does, to the bit', () => {

		let seed = 5;
		const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
		const data = Float32Array.from( { length: 64 * 32 * 4 }, () => rand() * 4 );
		expect( environmentRadianceIntegral( data, 64, 32 ) ).toBe( buildExactEnvironmentTable( data, 64, 32 ).radianceIntegral );
		expect( environmentRadianceIntegral( uniform( 512, 256, [ 0.2, 0.5, 0.8 ] ), 512, 256 ) )
			.toBe( buildExactEnvironmentTable( uniform( 512, 256, [ 0.2, 0.5, 0.8 ] ), 512, 256 ).radianceIntegral );

	} );

	it( 'is the same table at any brightness of a solid colour', () => {

		const a = buildExactEnvironmentTable( uniform( 512, 256, [ 0.53, 0.81, 0.92 ] ), 512, 256 );
		for ( const colour of [[ 3, 1, 0.1 ], [ 0.01, 0.02, 0.005 ], [ 1, 1, 1 ]] ) {

			const b = buildExactEnvironmentTable( uniform( 512, 256, colour ), 512, 256 );
			for ( const key of [ 'exactConditional', 'exactMarginal', 'exactRowGuide', 'exactMarginalGuide' ] ) expect( b[ key ], `${key} at ${colour}` ).toEqual( a[ key ] );

		}

	} );

	it( 'is kept across colour changes, rebuilt from black or after another map', async () => {

		const set = vi.fn();
		const env = new EnvironmentManager( {}, { get: () => ( { value: { set() {} } } ), set } );
		const total = () => set.mock.calls.filter( ( [ name ] ) => name === 'envTotalSum' ).at( - 1 )[ 1 ];
		const expected = () => buildExactEnvironmentTable( env.simpleSkyRenderer._texture.image.data, 512, 256 ).radianceIntegral;
		const colour = async ( c ) => {

			env.envParams.solidSkyColor = new Color( ...c );
			await env.generateSolidColorTexture();

		};

		builds.count = 0;
		await env.setMode( 'color' );
		expect( builds.count ).toBe( 1 );
		const table = env.envCDFTexture;

		await colour( [ 1, 0.2, 0.1 ] );
		await colour( [ 0.1, 0.4, 2 ] );
		expect( builds.count ).toBe( 1 );
		expect( env.envCDFTexture ).toBe( table );
		expect( total() ).toBe( expected() );
		expect( env.exactTable.radianceIntegral ).toBe( expected() );
		expect( env.equirectHdrInfo.totalSum ).toBe( expected() );

		// Black has no table to keep, and none to give.
		await colour( [ 0, 0, 0 ] );
		expect( [ builds.count, total() ] ).toEqual( [ 2, 0 ] );
		await colour( [ 0.5, 0.5, 0.5 ] );
		expect( builds.count ).toBe( 3 );
		expect( total() ).toBe( expected() );

	} );

	const solidSky = async () => {

		const set = vi.fn();
		const env = new EnvironmentManager( {}, { get: () => ( { value: { set() {} } } ), set } );
		const colour = ( c ) => {

			env.envParams.solidSkyColor = new Color( ...c );
			return env.generateSolidColorTexture();

		};

		await env.setMode( 'color' );
		return {
			env, colour,
			total: () => set.mock.calls.filter( ( [ name ] ) => name === 'envTotalSum' ).at( - 1 )[ 1 ],
			expected: () => buildExactEnvironmentTable( env.simpleSkyRenderer._texture.image.data, 512, 256 ).radianceIntegral,
		};

	};

	it( 'is not kept once another table was bound: the physical sky\'s is freed when its mode is left', async () => {

		const { env, colour, total, expected } = await solidSky();
		builds.count = 0;
		const skyTable = { _isPhysicalSky: true, dispose: vi.fn() };
		env.envParams.mode = 'procedural';
		env._installSky( Object.assign( new Texture(), { image: { width: 1024, height: 512 }, _isPhysicalSky: true } ), skyTable );
		expect( env.envCDFTexture ).toBe( skyTable );

		env.envParams.solidSkyColor = new Color( 0.3, 0.6, 0.9 );
		await env.setMode( 'color' );
		expect( builds.count ).toBe( 1 );
		expect( env.envCDFTexture ).not.toBe( skyTable );
		expect( env.envCDFTexture.image.data ).toEqual( packExactTable( buildExactEnvironmentTable( env.simpleSkyRenderer._texture.image.data, 512, 256 ) ).data );
		expect( total() ).toBe( expected() );

		// And kept again from there.
		await colour( [ 1, 0.5, 0 ] );
		expect( builds.count ).toBe( 1 );

	} );

	it( 'drops a build that lands after a newer colour: to black and on before it is built', async () => {

		const { env, colour, total, expected } = await solidSky();
		const table = env.envCDFTexture;
		builds.count = 0;
		builds.delay = 200;
		try {

			const toBlack = colour( [ 0, 0, 0 ] );
			await vi.waitFor( () => expect( builds.count ).toBe( 1 ), { interval: 1 } );
			await colour( [ 0.2, 0.9, 0.4 ] );
			await toBlack;

		} finally {

			builds.delay = 0;

		}

		expect( builds.count ).toBe( 1 );
		expect( env.envCDFTexture ).toBe( table );
		expect( total() ).toBe( expected() );
		expect( total() ).toBeGreaterThan( 0 );

	} );

	it( 'settles two builds of one table in flight at once, each with its own worker', async () => {

		const info = new EquirectHDRInfo();
		const map = ( c ) => ( { image: { width: 64, height: 32, data: uniform( 64, 32, c ) }, type: FloatType } );
		const results = await Promise.race( [
			Promise.all( [ info.updateFromAsync( map( [ 1, 1, 1 ] ) ), info.updateFromAsync( map( [ 2, 2, 2 ] ) ) ] ),
			new Promise( resolve => setTimeout( () => resolve( 'unsettled' ), 500 ) ),
		] );
		expect( results ).toEqual( [ true, true ] );
		expect( info._worker ).toBeNull();
		expect( await info.updateFromAsync( map( [ 1, 1, 1 ] ), () => false ) ).toBe( false );
		expect( info.totalSum ).toBe( buildExactEnvironmentTable( uniform( 64, 32, [ 2, 2, 2 ] ), 64, 32 ).radianceIntegral );

	} );

} );
