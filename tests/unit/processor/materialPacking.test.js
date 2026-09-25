/**
 * The material block is the contract between the parser and the shader. Every value in it has
 * to be something the model said or MATERIAL_DEFAULTS, never a guess, and the scene upload and
 * a runtime edit have to write the same bytes.
 */
import { describe, it, expect, vi } from 'vitest';
import {
	Color, Texture, MeshStandardMaterial, MeshPhysicalMaterial, MeshBasicMaterial, MeshPhongMaterial,
} from 'three';

vi.mock( 'three/webgpu', () => ( {
	StorageInstancedBufferAttribute: class {

		constructor( array ) {

			this.array = array;

		}

	},
} ) );
vi.mock( 'three/tsl', () => ( { storage: () => ( { toReadOnly() {

	return this;

} } ) } ) );

import {
	MATERIAL_DATA_LAYOUT as M, MATERIAL_DEFAULTS, TRIANGLE_DATA_LAYOUT as T, TRI_BLOCKER_SHIFT, shadowBlockerBits,
} from '@/core/EngineDefaults.js';
import { packMaterial, MATERIAL_RESERVED_FLOATS } from '@/core/Processor/MaterialPacking.js';
import { GeometryExtractor, MATERIAL_VALUE_SOURCE } from '@/core/Processor/GeometryExtractor.js';
import { TextureCreator } from '@/core/Processor/TextureCreator.js';
import { MaterialDataManager } from '@/core/managers/MaterialDataManager.js';
import { setWorkingMatrix } from '@/core/Color/WorkingMatrix.js';

const F = M.FLOATS_PER_MATERIAL;

function packed( mat ) {

	const data = new Float32Array( F ).fill( Number.NaN );
	packMaterial( data, 0, mat );
	return data;

}

/** Every input packMaterial reads, each a distinct value driven by `k`. */
function sentinel( k ) {

	let next = k * 1000;
	const v = () => ( next += 1 );
	const rgb = () => [ v(), v(), v() ];
	const matrix = () => Array.from( { length: 9 }, v );
	return {
		ior: v(), transmission: v(), thickness: v(), emissiveIntensity: v(),
		attenuationColor: rgb(), attenuationDistance: v(),
		opacity: v(), side: v(), transparent: v(), alphaTest: v(),
		alphaMode: v(), depthWrite: v(), normalScale: { x: v(), y: v() },
		color: rgb(), metalness: v(), emissive: rgb(), roughness: v(),
		map: v(), normalMap: v(), roughnessMap: v(), metalnessMap: v(), emissiveMap: v(), bumpMap: v(),
		clearcoat: v(), clearcoatRoughness: v(),
		dispersion: v(), sheen: v(), sheenRoughness: v(), sheenColor: rgb(),
		specularIntensity: v(), specularColor: rgb(),
		iridescence: v(), iridescenceIOR: v(), iridescenceThicknessRange: [ v(), v() ],
		bumpScale: v(), displacementScale: v(), displacementMap: v(),
		mapMatrix: matrix(), normalMapMatrices: matrix(), roughnessMapMatrices: matrix(), metalnessMapMatrices: matrix(),
		emissiveMapMatrices: matrix(), bumpMapMatrices: matrix(), displacementMapMatrices: matrix(),
		subsurfaceColor: rgb(), subsurface: v(), subsurfaceRadius: rgb(), subsurfaceRadiusScale: v(),
		subsurfaceAnisotropy: v(), anisotropy: v(), anisotropyRotation: v(), anisotropyMap: v(),
		transmissionMap: v(), clearcoatMap: v(), clearcoatRoughnessMap: v(), sheenColorMap: v(),
		sheenRoughnessMap: v(), iridescenceMap: v(), iridescenceThicknessMap: v(), specularIntensityMap: v(),
		specularColorMap: v(),
	};

}

describe( 'packMaterial', () => {

	it( 'puts each field where the layout says the shader reads it', () => {

		const mat = sentinel( 1 );
		const d = packed( mat );
		const expectAt = ( offset, value ) => expect( d[ offset ] ).toBe( Math.fround( value ) );

		expectAt( M.IOR, mat.ior );
		expectAt( M.EMISSIVE_INTENSITY, mat.emissiveIntensity );
		expectAt( M.ATTENUATION_COLOR + 2, mat.attenuationColor[ 2 ] );
		expectAt( M.ATTENUATION_DISTANCE, mat.attenuationDistance );
		expectAt( M.SIDE, mat.side );
		expectAt( M.NORMAL_SCALE + 1, mat.normalScale.y );
		expectAt( M.COLOR, mat.color[ 0 ] );
		expectAt( M.METALNESS, mat.metalness );
		expectAt( M.EMISSIVE + 1, mat.emissive[ 1 ] );
		expectAt( M.ROUGHNESS, mat.roughness );
		expectAt( M.ALBEDO_MAP_INDEX, mat.map );
		expectAt( M.METALNESS_MAP_INDEX, mat.metalnessMap );
		expectAt( M.CLEARCOAT_ROUGHNESS, mat.clearcoatRoughness );
		expectAt( M.SHEEN_ROUGHNESS, mat.sheenRoughness );
		expectAt( M.SHEEN_COLOR + 2, mat.sheenColor[ 2 ] );
		expectAt( M.SPECULAR_INTENSITY, mat.specularIntensity );
		expectAt( M.SPECULAR_COLOR, mat.specularColor[ 0 ] );
		expectAt( M.IRIDESCENCE_THICKNESS_RANGE + 1, mat.iridescenceThicknessRange[ 1 ] );
		expectAt( M.DISPLACEMENT_MAP_INDEX, mat.displacementMap );
		expectAt( M.ALBEDO_TRANSFORM, mat.mapMatrix[ 0 ] );
		expectAt( M.DISPLACEMENT_TRANSFORM + 7, mat.displacementMapMatrices[ 7 ] );
		expectAt( M.SUBSURFACE, mat.subsurface );
		expectAt( M.SUBSURFACE_RADIUS + 2, mat.subsurfaceRadius[ 2 ] );
		expectAt( M.ANISOTROPY_MAP_INDEX, mat.anisotropyMap );
		expectAt( M.SHEEN_COLOR_MAP_INDEX, mat.sheenColorMap );
		expectAt( M.SPECULAR_INTENSITY_MAP_INDEX, mat.specularIntensityMap );
		expectAt( M.SPECULAR_COLOR_MAP_INDEX, mat.specularColorMap );

	} );

	it( 'writes every float from an input except the declared reserved ones', () => {

		const a = packed( sentinel( 1 ) );
		const b = packed( sentinel( 2 ) );
		const reserved = new Set( MATERIAL_RESERVED_FLOATS );

		for ( let i = 0; i < F; i ++ ) {

			if ( reserved.has( i ) ) expect( a[ i ], `reserved float ${i}` ).toBe( b[ i ] );
			else expect( a[ i ], `float ${i} ignores its input` ).not.toBe( b[ i ] );

		}

	} );

	it( 'fills a material that says nothing from MATERIAL_DEFAULTS, with no NaN and identity UV transforms', () => {

		const d = packed( {} );
		expect( d.some( Number.isNaN ) ).toBe( false );

		expect( d[ M.IOR ] ).toBe( MATERIAL_DEFAULTS.ior );
		expect( d[ M.SPECULAR_INTENSITY ] ).toBe( MATERIAL_DEFAULTS.specularIntensity );
		expect( [ ...d.subarray( M.SPECULAR_COLOR, M.SPECULAR_COLOR + 3 ) ] ).toEqual( [ ...MATERIAL_DEFAULTS.specularColor ] );
		expect( d[ M.ROUGHNESS ] ).toBe( MATERIAL_DEFAULTS.roughness );
		expect( d[ M.ATTENUATION_DISTANCE ] ).toBe( 0 );
		expect( d[ M.ALBEDO_MAP_INDEX ] ).toBe( - 1 );
		expect( [ ...d.subarray( M.ALBEDO_TRANSFORM, M.ALBEDO_TRANSFORM + 8 ) ] ).toEqual( [ 1, 0, 0, 0, 1, 0, 0, 0 ] );

	} );

	it( 'replaces a non-finite value instead of passing it to the GPU', () => {

		const d = packed( { ior: Number.NaN, roughness: undefined, transparent: true, color: { r: 0.5 } } );
		expect( d[ M.IOR ] ).toBe( MATERIAL_DEFAULTS.ior );
		expect( d[ M.ROUGHNESS ] ).toBe( MATERIAL_DEFAULTS.roughness );
		expect( d[ M.TRANSPARENT ] ).toBe( 1 );
		expect( [ ...d.subarray( M.COLOR, M.COLOR + 3 ) ] ).toEqual( [ 0.5, 1, 1 ] );

	} );

} );

describe( 'MATERIAL_DEFAULTS', () => {

	it( 'matches MeshPhysicalMaterial wherever three.js has the property', () => {

		const physical = new MeshPhysicalMaterial();
		const asArray = v => ( v?.isColor ? [ v.r, v.g, v.b ] : v?.isVector2 ? [ v.x, v.y ] : v );
		const checked = [];

		for ( const [ key, value ] of Object.entries( MATERIAL_DEFAULTS ) ) {

			if ( ! ( key in physical ) || [ 'transparent', 'side', 'depthWrite' ].includes( key ) ) continue;
			expect( asArray( physical[ key ] ), key ).toEqual( Array.isArray( value ) ? [ ...value ] : value );
			checked.push( key );

		}

		expect( checked ).toEqual( expect.arrayContaining( [ 'ior', 'specularIntensity', 'specularColor', 'thickness', 'sheenRoughness' ] ) );

	} );

} );

describe( 'createMaterialObject', () => {

	it( 'gives a glTF metallic-roughness material IOR 1.5 however metallic its factor', () => {

		const extractor = new GeometryExtractor();
		const mat = extractor.createMaterialObject( new MeshStandardMaterial( { metalness: 1, roughness: 1 } ) );

		expect( mat.ior ).toBe( 1.5 );
		expect( mat.sources.ior ).toBe( MATERIAL_VALUE_SOURCE.DEFAULT );
		expect( mat.sources.metalness ).toBe( MATERIAL_VALUE_SOURCE.MATERIAL );

	} );

	it( 'keeps an IOR the material carries', () => {

		const mat = new GeometryExtractor().createMaterialObject( new MeshPhysicalMaterial( { ior: 2, metalness: 1 } ) );
		expect( mat.ior ).toBe( 2 );
		expect( mat.sources.ior ).toBe( MATERIAL_VALUE_SOURCE.MATERIAL );

	} );

	it( 'shows an unlit texture as emission rather than lit colour plus a flat glow', () => {

		const extractor = new GeometryExtractor();
		const texture = new Texture();
		const tint = new Color( 0.5, 0.25, 1 );
		const mat = extractor.createMaterialObject( new MeshBasicMaterial( { color: tint, map: texture } ) );

		expect( [ mat.color.r, mat.color.g, mat.color.b ] ).toEqual( [ 0, 0, 0 ] );
		expect( mat.emissive.equals( tint ) ).toBe( true );
		expect( extractor.emissiveMaps[ mat.emissiveMap ] ).toBe( texture );
		expect( extractor.maps[ mat.map ] ).toBe( texture );
		expect( mat.specularIntensity ).toBe( 0 );
		expect( mat.sources.color ).toBe( MATERIAL_VALUE_SOURCE.MAPPED );

	} );

	it( 'leaves an untextured unlit material with no emission map', () => {

		const mat = new GeometryExtractor().createMaterialObject( new MeshBasicMaterial( { color: 0xff0000 } ) );
		expect( mat.emissiveMap ).toBe( - 1 );
		expect( mat.emissive.r ).toBe( 1 );

	} );

	it( 'carries Phong specular strength once, not squared through the colour too', () => {

		const extractor = new GeometryExtractor();
		const phong = ( specular ) => extractor.createMaterialObject( new MeshPhongMaterial( { specular } ) );

		const white = phong( new Color( 1, 1, 1 ) );
		expect( white.specularIntensity ).toBe( 1 );
		expect( white.specularColor.toArray() ).toEqual( [ 1, 1, 1 ] );

		const grey = phong( new Color( 0.25, 0.25, 0.25 ) );
		expect( grey.specularIntensity ).toBeCloseTo( 0.5, 6 );
		expect( grey.specularColor.toArray() ).toEqual( [ 1, 1, 1 ] );

		const tinted = phong( new Color( 0.5, 0.25, 0 ) );
		expect( tinted.specularColor.toArray() ).toEqual( [ 1, 0.5, 0 ] );

	} );

} );

describe( 'MaterialDataManager', () => {

	function managerWith( extractor, triangleFlags ) {

		const manager = new MaterialDataManager( { geometryExtractor: extractor } );
		manager.setMaterialData( new Float32Array( F ) );
		if ( triangleFlags ) manager.callbacks.getTriangleData = () => ( { array: triangleFlags, count: 1 } );
		return manager;

	}

	it( 'writes the same block on an edit as the scene upload does', () => {

		const extractor = new GeometryExtractor();
		const material = new MeshPhysicalMaterial( {
			color: 0x336699, roughness: 0.4, metalness: 0.3, ior: 1.7, sheen: 0.5, clearcoat: 0.2,
			transmission: 0.1, attenuationDistance: 2, specularIntensity: 0.8,
		} );

		const upload = new TextureCreator().createMaterialRawData( [ extractor.createMaterialObject( material ) ] );
		const manager = managerWith( extractor );
		manager.updateMaterial( 0, material );

		expect( [ ...manager.materialStorageAttr.array ] ).toEqual( [ ...upload ] );

	} );

	it( 'moves an edited material into the working space exactly once, as an upload does', () => {

		setWorkingMatrix( [ 0.6, 0.3, 0.1, 0.05, 0.9, 0.05, 0.02, 0.1, 0.88 ], 'test' );
		try {

			const extractor = new GeometryExtractor();
			const material = new MeshPhysicalMaterial( {
				color: 0x336699, emissive: 0x112233, sheen: 1, sheenColor: 0x445566,
				specularColor: 0xaabbcc, attenuationColor: 0x884422,
			} );

			const loaded = managerWith( extractor );
			loaded.setMaterialData( new TextureCreator().createMaterialRawData( [ extractor.createMaterialObject( material ) ] ) );
			const edited = managerWith( extractor );
			edited.updateMaterial( 0, material );

			expect( [ ...edited.materialStorageAttr.array ] ).toEqual( [ ...loaded.materialStorageAttr.array ] );
			expect( edited.materialStorageAttr.array[ M.COLOR ] ).not.toBeCloseTo( new Color( 0x336699 ).r, 4 );

		} finally {

			setWorkingMatrix( null );

		}

	} );

	it( 'derives the shadow-blocker bits from the alpha mode it just wrote', () => {

		const flags = new Uint32Array( T.FLOATS_PER_TRIANGLE );
		const manager = managerWith( new GeometryExtractor(), flags );
		manager.updateMaterial( 0, new MeshStandardMaterial( { alphaTest: 0.5 } ) );

		const bits = ( flags[ T.MATERIAL_FLAGS_OFFSET ] >>> TRI_BLOCKER_SHIFT ) & 3;
		expect( bits ).toBe( shadowBlockerBits( { alphaMode: 1, transparent: 0, transmission: 0, opacity: 1 } ) );

	} );

	it( 'reports where each value came from, and a host edit as host', () => {

		const manager = managerWith( new GeometryExtractor() );
		manager.updateMaterial( 0, new MeshStandardMaterial( { metalness: 1 } ) );

		expect( manager.getMaterialPropertySource( 0, 'ior' ) ).toBe( MATERIAL_VALUE_SOURCE.DEFAULT );
		expect( manager.getMaterialPropertySource( 0, 'metalness' ) ).toBe( MATERIAL_VALUE_SOURCE.MATERIAL );

		manager.updateMaterialProperty( 0, 'ior', 1.33 );
		expect( manager.getMaterialPropertySource( 0, 'ior' ) ).toBe( MATERIAL_VALUE_SOURCE.HOST );

		manager.updateMaterial( 0, new MeshStandardMaterial() );
		expect( manager.getMaterialPropertySource( 0, 'ior' ) ).toBe( MATERIAL_VALUE_SOURCE.DEFAULT );
		expect( manager.getMaterialPropertySource( 0, 'noSuchProperty' ) ).toBeUndefined();

		const extractor = new GeometryExtractor();
		const loaded = [ extractor.createMaterialObject( new MeshPhysicalMaterial( { ior: 1.6 } ) ) ];
		manager.setMaterialData( new TextureCreator().createMaterialRawData( loaded ), loaded.map( m => m.sources ) );
		expect( manager.getMaterialPropertySource( 0, 'ior' ) ).toBe( MATERIAL_VALUE_SOURCE.MATERIAL );

	} );

} );
