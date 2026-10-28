import { describe, it, expect, vi } from 'vitest';
import { DirectionalLight, Group, PointLight, RectAreaLight, Scene, SpotLight } from 'three';
import { LightSerializer } from '@/core/lights/LightSerializer.js';

describe( 'LightSerializer', () => {

	describe( 'calculateLightImportance', () => {

		it( 'directional light: importance = intensity * luminance', () => {

			const transfer = new LightSerializer();
			const light = {
				color: { r: 1, g: 1, b: 1 }, // pure white
				intensity: 5.0
			};

			const importance = transfer.calculateLightImportance( light, 'directional' );
			// luminance of white = 0.2126 + 0.7152 + 0.0722 = 1.0
			expect( importance ).toBeCloseTo( 5.0 );

		} );

		it( 'directional light: colored light has lower importance', () => {

			const transfer = new LightSerializer();
			const red = { color: { r: 1, g: 0, b: 0 }, intensity: 5.0 };
			const white = { color: { r: 1, g: 1, b: 1 }, intensity: 5.0 };

			const redImportance = transfer.calculateLightImportance( red, 'directional' );
			const whiteImportance = transfer.calculateLightImportance( white, 'directional' );
			expect( redImportance ).toBeLessThan( whiteImportance );

		} );

		it( 'area light: factors in sqrt(area)', () => {

			const transfer = new LightSerializer();
			const light = {
				color: { r: 1, g: 1, b: 1 },
				intensity: 1.0,
				width: 4,
				height: 4
			};

			const importance = transfer.calculateLightImportance( light, 'area' );
			// luminance=1, intensity=1, sqrt(16) = 4
			expect( importance ).toBeCloseTo( 4.0 );

		} );

		it( 'point light: factors in sqrt(distance)', () => {

			const transfer = new LightSerializer();
			const light = {
				color: { r: 1, g: 1, b: 1 },
				intensity: 1.0,
				distance: 100
			};

			const importance = transfer.calculateLightImportance( light, 'point' );
			// luminance=1, intensity=1, sqrt(100) = 10
			expect( importance ).toBeCloseTo( 10.0 );

		} );

		it( 'spot light: factors in distance and cone angle', () => {

			const transfer = new LightSerializer();
			const light = {
				color: { r: 1, g: 1, b: 1 },
				intensity: 1.0,
				distance: 100,
				angle: Math.PI / 4
			};

			const importance = transfer.calculateLightImportance( light, 'spot' );
			// luminance=1, intensity=1, sqrt(100)=10, sin(PI/4)=~0.707
			expect( importance ).toBeCloseTo( 10 * Math.sin( Math.PI / 4 ) );

		} );

		it( 'zero intensity produces zero importance', () => {

			const transfer = new LightSerializer();
			const light = { color: { r: 1, g: 1, b: 1 }, intensity: 0 };
			expect( transfer.calculateLightImportance( light ) ).toBe( 0 );

		} );

	} );

	describe( 'clear', () => {

		it( 'resets all caches and lightData', () => {

			const transfer = new LightSerializer();
			transfer.directionalLightCache.push( {} );
			transfer.areaLightCache.push( {} );
			transfer.pointLightCache.push( {} );
			transfer.spotLightCache.push( {} );
			transfer.lightData.directional.push( 1 );
			transfer.lightData.rectArea.push( 1 );
			transfer.lightData.point.push( 1 );
			transfer.lightData.spot.push( 1 );

			transfer.clear();

			expect( transfer.directionalLightCache ).toHaveLength( 0 );
			expect( transfer.areaLightCache ).toHaveLength( 0 );
			expect( transfer.pointLightCache ).toHaveLength( 0 );
			expect( transfer.spotLightCache ).toHaveLength( 0 );
			expect( transfer.lightData.directional ).toHaveLength( 0 );
			expect( transfer.lightData.rectArea ).toHaveLength( 0 );
			expect( transfer.lightData.point ).toHaveLength( 0 );
			expect( transfer.lightData.spot ).toHaveLength( 0 );

		} );

	} );

	// ── addDirectionalLight ──────────────────────────────────

	describe( 'addDirectionalLight', () => {

		function makeDirectionalLight( intensity = 1, color = { r: 1, g: 1, b: 1 } ) {

			return {
				intensity,
				color,
				visible: true,
				userData: {},
				updateMatrixWorld: vi.fn(),
				getWorldPosition: vi.fn( () => ( {
					x: 0, y: 10, z: 0,
					sub( other ) {

						this.x -= other.x; this.y -= other.y; this.z -= other.z; return this;

					},
					normalize() {

						const l = Math.sqrt( this.x ** 2 + this.y ** 2 + this.z ** 2 ); this.x /= l; this.y /= l; this.z /= l; return this;

					}
				} ) ),
				target: {
					updateMatrixWorld: vi.fn(),
					getWorldPosition: vi.fn( () => ( { x: 0, y: 0, z: 0 } ) ),
				},
			};

		}

		it( 'adds light to cache', () => {

			const serializer = new LightSerializer();
			serializer.addDirectionalLight( makeDirectionalLight( 5 ) );
			expect( serializer.directionalLightCache ).toHaveLength( 1 );

		} );

		it( 'stores 12 floats per light (direction, color, intensity, angle, gobo fields)', () => {

			const serializer = new LightSerializer();
			serializer.addDirectionalLight( makeDirectionalLight() );
			expect( serializer.directionalLightCache[ 0 ].data ).toHaveLength( 12 );

		} );

		it( 'skips zero intensity lights', () => {

			const serializer = new LightSerializer();
			serializer.addDirectionalLight( makeDirectionalLight( 0 ) );
			expect( serializer.directionalLightCache ).toHaveLength( 0 );

		} );

		it( 'reads angle from userData.angle', () => {

			const serializer = new LightSerializer();
			const light = makeDirectionalLight();
			light.userData.angle = 0.1;
			serializer.addDirectionalLight( light );
			expect( serializer.directionalLightCache[ 0 ].data[ 7 ] ).toBe( 0.1 );

		} );

	} );

	// ── addPointLight ────────────────────────────────────────

	describe( 'addPointLight', () => {

		function makePointLight( intensity = 1, distance = 50 ) {

			return {
				intensity,
				color: { r: 1, g: 1, b: 1 },
				visible: true,
				distance,
				updateMatrixWorld: vi.fn(),
				getWorldPosition: vi.fn( () => ( { x: 5, y: 5, z: 5 } ) ),
			};

		}

		it( 'adds light to cache with 10 floats (pos, color, intensity, distance, decay, radius)', () => {

			const serializer = new LightSerializer();
			serializer.addPointLight( makePointLight() );
			expect( serializer.pointLightCache ).toHaveLength( 1 );
			expect( serializer.pointLightCache[ 0 ].data ).toHaveLength( 10 );
			expect( serializer.pointLightCache[ 0 ].data[ 9 ] ).toBe( 0 );

		} );

		it( 'carries a light\'s radius from userData, a point\'s last and a spot\'s in its slot 18', () => {

			const serializer = new LightSerializer();
			const down = { sub: () => ( { normalize: () => ( { x: 0, y: - 1, z: 0 } ) } ) };
			serializer.addPointLight( { ...makePointLight(), userData: { radius: 0.25 } } );
			serializer.addSpotLight( { ...makePointLight(), angle: 0.5, penumbra: 0.1, userData: { radius: 0.1 }, target: { getWorldPosition: () => down } } );
			expect( serializer.pointLightCache[ 0 ].data[ 9 ] ).toBe( 0.25 );
			expect( serializer.spotLightCache[ 0 ].data ).toHaveLength( 20 );
			expect( serializer.spotLightCache[ 0 ].data[ 18 ] ).toBe( 0.1 );

		} );

		it( 'skips zero intensity', () => {

			const serializer = new LightSerializer();
			serializer.addPointLight( makePointLight( 0 ) );
			expect( serializer.pointLightCache ).toHaveLength( 0 );

		} );

		it( 'converts Power (W) to radiant intensity via ÷4π', () => {

			const serializer = new LightSerializer();
			serializer.addPointLight( makePointLight( 1000 ) );
			expect( serializer.pointLightCache[ 0 ].data[ 6 ] ).toBeCloseTo( 1000 / ( 4 * Math.PI ), 4 );

		} );

		it( 'folds per-light exposure (EV stops) into power', () => {

			const serializer = new LightSerializer();
			const light = makePointLight( 1000 );
			light.userData = { exposure: 1 }; // +1 stop → ×2
			serializer.addPointLight( light );
			expect( serializer.pointLightCache[ 0 ].data[ 6 ] ).toBeCloseTo( 2000 / ( 4 * Math.PI ), 4 );

		} );

		it( 'tints colour warm when temperature is enabled', () => {

			const serializer = new LightSerializer();
			const light = makePointLight( 1000 );
			light.userData = { useTemperature: true, temperature: 3200 };
			serializer.addPointLight( light );
			const [ r, g, b ] = serializer.pointLightCache[ 0 ].data.slice( 3, 6 );
			expect( r ).toBeGreaterThan( g );
			expect( g ).toBeGreaterThan( b );

		} );

	} );

	// ── addSpotLight ─────────────────────────────────────────

	describe( 'addSpotLight', () => {

		function makeSpotLight( intensity = 1 ) {

			const pos = { x: 0, y: 5, z: 0 };
			const targetPos = { x: 0, y: 0, z: 0 };
			return {
				intensity,
				color: { r: 1, g: 1, b: 1 },
				visible: true,
				angle: Math.PI / 6,
				distance: 100,
				updateMatrixWorld: vi.fn(),
				getWorldPosition: vi.fn( () => ( { ...pos } ) ),
				target: {
					getWorldPosition: vi.fn( () => ( {
						...targetPos,
						sub: vi.fn( function () {

							return { x: 0, y: - 5, z: 0, normalize: vi.fn( function () {

								return this;

							} ) };

						} )
					} ) ),
				},
			};

		}

		it( 'adds light to cache with 20 floats', () => {

			const serializer = new LightSerializer();
			serializer.addSpotLight( makeSpotLight() );
			expect( serializer.spotLightCache ).toHaveLength( 1 );
			expect( serializer.spotLightCache[ 0 ].data ).toHaveLength( 20 );

		} );

		it( 'skips zero intensity', () => {

			const serializer = new LightSerializer();
			serializer.addSpotLight( makeSpotLight( 0 ) );
			expect( serializer.spotLightCache ).toHaveLength( 0 );

		} );

		it( 'converts Power (W) to radiant intensity via ÷4π', () => {

			const serializer = new LightSerializer();
			serializer.addSpotLight( makeSpotLight( 1000 ) );
			expect( serializer.spotLightCache[ 0 ].data[ 9 ] ).toBeCloseTo( 1000 / ( 4 * Math.PI ), 4 );

		} );

	} );

	// ── preprocessLights ─────────────────────────────────────

	describe( 'preprocessLights', () => {

		function makeDirectionalLight( intensity ) {

			return {
				intensity,
				color: { r: 1, g: 1, b: 1 },
				visible: true,
				userData: {},
				updateMatrixWorld: vi.fn(),
				getWorldPosition: vi.fn( () => ( {
					x: 0, y: 1, z: 0,
					sub( other ) {

						this.x -= other.x; this.y -= other.y; this.z -= other.z; return this;

					},
					normalize() {

						const l = Math.sqrt( this.x ** 2 + this.y ** 2 + this.z ** 2 ); this.x /= l; this.y /= l; this.z /= l; return this;

					}
				} ) ),
				target: {
					updateMatrixWorld: vi.fn(),
					getWorldPosition: vi.fn( () => ( { x: 0, y: 0, z: 0 } ) ),
				},
			};

		}

		it( 'sorts directional lights by importance (highest first)', () => {

			const serializer = new LightSerializer();
			serializer.addDirectionalLight( makeDirectionalLight( 1 ) );
			serializer.addDirectionalLight( makeDirectionalLight( 10 ) );
			serializer.addDirectionalLight( makeDirectionalLight( 5 ) );

			serializer.preprocessLights();

			// After sorting and flattening: intensity is at index 6 of each 12-float stride
			expect( serializer.lightData.directional[ 6 ] ).toBe( 10 );
			expect( serializer.lightData.directional[ 18 ] ).toBe( 5 );
			expect( serializer.lightData.directional[ 30 ] ).toBe( 1 );

		} );

		it( 'flattens cache into lightData arrays', () => {

			const serializer = new LightSerializer();
			serializer.addDirectionalLight( makeDirectionalLight( 3 ) );
			serializer.addDirectionalLight( makeDirectionalLight( 7 ) );

			serializer.preprocessLights();

			expect( serializer.lightData.directional ).toHaveLength( 24 ); // 2 lights * 12 floats

		} );

	} );

	// ── updateShaderUniforms ─────────────────────────────────

	describe( 'updateShaderUniforms', () => {

		it( 'sets correct light counts and uniform arrays', () => {

			const serializer = new LightSerializer();
			// Manually populate lightData to test uniform update
			serializer.lightData.directional = new Array( 24 ).fill( 0 ); // 2 lights * 12
			serializer.lightData.rectArea = new Array( 16 ).fill( 0 ); // 1 light * 16
			serializer.lightData.point = new Array( 90 ).fill( 0 ); // 9 lights * 10, which 9 a light would count as 10
			serializer.lightData.spot = new Array( 40 ).fill( 0 ); // 2 lights * 20

			const material = {
				defines: {},
				uniforms: {
					directionalLights: { value: null },
					areaLights: { value: null },
					pointLights: { value: null },
					spotLights: { value: null },
				},
				needsUpdate: false,
			};

			serializer.updateShaderUniforms( material );

			expect( material.defines.MAX_DIRECTIONAL_LIGHTS ).toBe( 2 );
			expect( material.defines.MAX_AREA_LIGHTS ).toBe( 1 );
			expect( material.defines.MAX_POINT_LIGHTS ).toBe( 9 );
			expect( material.defines.MAX_SPOT_LIGHTS ).toBe( 2 );
			expect( material.needsUpdate ).toBe( true );
			expect( material.uniforms.directionalLights.value ).toBeInstanceOf( Float32Array );

		} );

	} );

	// ── getLightStatistics ────────────────────────────────────

	describe( 'getLightStatistics', () => {

		it( 'returns stats for directional and area lights', () => {

			const serializer = new LightSerializer();
			serializer.directionalLightCache.push( {
				light: { intensity: 5, color: { r: 1, g: 1, b: 1 } },
				importance: 5,
				data: [],
			} );
			serializer.areaLightCache.push( {
				light: { intensity: 2, color: { r: 1, g: 0, b: 0 }, width: 4, height: 4 },
				importance: 8,
				data: [],
			} );

			const stats = serializer.getLightStatistics();
			expect( stats.directionalLights ).toHaveLength( 1 );
			expect( stats.directionalLights[ 0 ].intensity ).toBe( 5 );
			expect( stats.areaLights ).toHaveLength( 1 );
			expect( stats.areaLights[ 0 ].size ).toBe( 16 );

		} );

	} );

} );

describe( 'LightSerializer with three.js lights', () => {

	const at = ( light, x, y, z ) => {

		light.position.set( x, y, z );
		return light;

	};

	it( 'skips hidden lights of every kind', () => {

		const serializer = new LightSerializer();
		for ( const light of [ new DirectionalLight(), new RectAreaLight( 0xffffff, 1, 1, 1 ), new PointLight( 0xffffff, 1 ), new SpotLight( 0xffffff, 1 ) ] ) {

			light.visible = false;
			serializer.addDirectionalLight( light );
			serializer.addRectAreaLight( light );
			serializer.addPointLight( light );
			serializer.addSpotLight( light );

		}

		expect( [ serializer.directionalLightCache, serializer.areaLightCache, serializer.pointLightCache, serializer.spotLightCache ].map( c => c.length ) ).toEqual( [ 0, 0, 0, 0 ] );

	} );

	it( 'aims a sun from its target, or from the origin when it has none', () => {

		const serializer = new LightSerializer();
		const aimed = at( new DirectionalLight(), 0, 3, 4 );
		aimed.target.position.set( 0, 3, 0 );
		const loose = at( new DirectionalLight(), 0, 3, 4 );
		loose.target = null;

		serializer.addDirectionalLight( aimed );
		serializer.addDirectionalLight( loose );

		const [ a, b ] = serializer.directionalLightCache.map( c => c.data.slice( 0, 3 ) );
		expect( a.map( v => v + 0 ) ).toEqual( [ 0, 0, 1 ] );
		expect( b[ 1 ] ).toBeCloseTo( 0.6, 6 );
		expect( b[ 2 ] ).toBeCloseTo( 0.8, 6 );

	} );

	it( 'packs a sun\'s gobo as its layer, a strength whose sign is the inversion, and its scale', () => {

		const serializer = new LightSerializer();
		const plain = new DirectionalLight( 0xffffff, 1 );
		const inverted = new DirectionalLight( 0xffffff, 1 );
		inverted.userData.gobo = { index: 2, intensity: 0.5, inverted: true, scale: 3 };
		const loose = new DirectionalLight( 0xffffff, 1 );
		loose.userData.gobo = { index: 1.5, intensity: '0.5' };

		[ plain, inverted, loose ].forEach( light => serializer.addDirectionalLight( light ) );

		expect( serializer.directionalLightCache.map( c => c.data.slice( 8, 12 ) ) ).toEqual( [
			[ - 1, 1, 5, 0 ],
			[ 2, - 0.5, 3, 0 ],
			[ - 1, 1, 5, 0 ],
		] );

	} );

	it( 'packs a spot light\'s cone, falloff, gobo and IES profile, with defaults for what it lacks', () => {

		const serializer = new LightSerializer();
		const shaped = at( new SpotLight( 0xffffff, 4 * Math.PI, 7, 0.4, 0.3, 1 ), 0, 2, 0 );
		shaped.userData.gobo = { index: 3, intensity: 0.8, inverted: true };
		shaped.userData.ies = { index: 1, intensity: 0.25 };
		const bare = at( new SpotLight( 0xffffff, 4 * Math.PI ), 0, 0, 0 );
		Object.assign( bare, { angle: 0, penumbra: undefined, decay: undefined, target: null } );

		serializer.addSpotLight( shaped );
		serializer.addSpotLight( bare );

		const [ a, b ] = serializer.spotLightCache.map( c => c.data );
		expect( a.slice( 3, 6 ).map( v => v + 0 ) ).toEqual( [ 0, - 1, 0 ] );
		expect( a.slice( 9 ) ).toEqual( [ expect.closeTo( 1, 9 ), 0.4, 0.3, 7, 1, 3, - 0.8, 1, 0.25, 0, 0 ] );
		expect( b.slice( 3, 6 ).map( v => v + 0 ) ).toEqual( [ 0, 0, - 1 ] );
		expect( b.slice( 10 ) ).toEqual( [ Math.PI / 4, 0, 0, 2, - 1, 1, - 1, 1, 0, 0 ] );

	} );

	it( 'leaves a light white when its temperature is off, and takes 6500 K when it gives none', () => {

		const serializer = new LightSerializer();
		const off = new PointLight( 0xffffff, 1 );
		off.userData = { useTemperature: false, temperature: 2000 };
		const unset = new PointLight( 0xffffff, 1 );
		unset.userData = { useTemperature: true };
		const daylight = new PointLight( 0xffffff, 1 );
		daylight.userData = { useTemperature: true, temperature: 6500 };

		[ off, unset, daylight ].forEach( light => serializer.addPointLight( light ) );

		const [ a, b, c ] = serializer.pointLightCache.map( cache => cache.data.slice( 3, 6 ) );
		expect( a ).toEqual( [ 1, 1, 1 ] );
		expect( b ).toEqual( c );
		expect( b[ 2 ] ).not.toBe( 1 );

	} );

	it( 'gathers a whole scene, nested lights too, each list brightest first', () => {

		const log = vi.spyOn( console, 'log' ).mockImplementation( () => {} );
		const scene = new Scene();
		const group = new Group();
		scene.add( group );
		group.add( at( new PointLight( 0xffffff, 10 ), 1, 0, 0 ) );
		scene.add( at( new PointLight( 0xffffff, 1000 ), 2, 0, 0 ) );
		scene.add( new SpotLight( 0xffffff, 1 ), new SpotLight( 0xffffff, 50 ) );
		scene.add( new RectAreaLight( 0xffffff, 1, 1, 1 ), new RectAreaLight( 0xffffff, 1, 4, 4 ) );
		scene.add( new DirectionalLight( 0xffffff, 2 ) );
		const material = { defines: {}, uniforms: { directionalLights: {}, areaLights: {}, pointLights: {}, spotLights: {} } };
		const serializer = new LightSerializer();

		serializer.processSceneLights( scene, material );
		serializer.processSceneLights( scene, material );

		expect( material.defines ).toMatchObject( { MAX_DIRECTIONAL_LIGHTS: 1, MAX_AREA_LIGHTS: 2, MAX_SPOT_LIGHTS: 2 } );
		expect( material.uniforms.directionalLights.value ).toHaveLength( 12 );
		expect( material.uniforms.areaLights.value ).toHaveLength( 32 );
		expect( material.uniforms.pointLights.value ).toHaveLength( 20 );
		expect( material.uniforms.spotLights.value ).toHaveLength( 40 );
		expect( material.uniforms.pointLights.value[ 0 ] ).toBe( 2 );
		expect( material.uniforms.pointLights.value[ 10 ] ).toBe( 1 );
		expect( material.uniforms.spotLights.value[ 9 ] ).toBeCloseTo( 50 / ( 4 * Math.PI ), 5 );
		expect( material.uniforms.areaLights.value[ 3 ] ).toBeCloseTo( 2, 6 );
		expect( material.needsUpdate ).toBe( true );
		expect( log ).toHaveBeenCalledWith( 'Preprocessed 2 point lights by importance' );
		log.mockRestore();

	} );

} );
