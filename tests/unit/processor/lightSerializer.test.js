import { describe, it, expect, vi } from 'vitest';

// Mock Three.js (LightSerializer imports Vector3, Quaternion)
vi.mock( 'three', () => ( {
	Vector3: class {

		constructor( x = 0, y = 0, z = 0 ) {

			this.x = x; this.y = y; this.z = z;

		}

	},
	Quaternion: class {

		constructor() {

			this.x = 0; this.y = 0; this.z = 0; this.w = 1;

		}

	}
} ) );

import { LightSerializer } from '@/core/Processor/LightSerializer.js';

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

		it( 'adds light to cache with 9 floats (pos, color, intensity, distance, decay)', () => {

			const serializer = new LightSerializer();
			serializer.addPointLight( makePointLight() );
			expect( serializer.pointLightCache ).toHaveLength( 1 );
			expect( serializer.pointLightCache[ 0 ].data ).toHaveLength( 9 );

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
			serializer.lightData.point = new Array( 18 ).fill( 0 ); // 2 lights * 9
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
			expect( material.defines.MAX_POINT_LIGHTS ).toBe( 2 );
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
