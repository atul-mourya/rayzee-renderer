import { MATERIAL_DATA_LAYOUT as M, MATERIAL_DEFAULTS as D, normalizeAttenuationDistance } from '../EngineDefaults.js';

// The first 8 Matrix3 elements; the GPU rebuilds the 9th (always 1).
const IDENTITY_UV = [ 1, 0, 0, 0, 1, 0, 0, 0 ];

const TRANSFORMS = [
	[ 'mapMatrix', M.ALBEDO_TRANSFORM ],
	[ 'normalMapMatrices', M.NORMAL_TRANSFORM ],
	[ 'roughnessMapMatrices', M.ROUGHNESS_TRANSFORM ],
	[ 'metalnessMapMatrices', M.METALNESS_TRANSFORM ],
	[ 'emissiveMapMatrices', M.EMISSIVE_TRANSFORM ],
	[ 'bumpMapMatrices', M.BUMP_TRANSFORM ],
	[ 'displacementMapMatrices', M.DISPLACEMENT_TRANSFORM ],
];

/** Floats no field writes; the packer gives them fixed values. */
export const MATERIAL_RESERVED_FLOATS = Object.freeze( [
	M.VISIBLE, M.SHEEN_COLOR + 3, M.DISPLACEMENT_MAP_INDEX + 1,
	M.SPECULAR_COLOR_MAP_INDEX + 1, M.SPECULAR_COLOR_MAP_INDEX + 2, M.SPECULAR_COLOR_MAP_INDEX + 3,
] );

/**
 * Weights and roughnesses, [0, 1] in glTF and three.js. Past 1 an energy split like
 * 1 − clearcoat·E goes negative: a glTF chrome with clearcoatFactor 4 added negative light.
 */
export const UNIT_RANGE_PROPERTIES = Object.freeze( new Set( [
	'metalness', 'roughness', 'transmission', 'opacity', 'clearcoat', 'clearcoatRoughness',
	'sheen', 'sheenRoughness', 'specularIntensity', 'iridescence', 'subsurface', 'anisotropy',
] ) );

export const clampUnit = ( value ) => Math.min( Math.max( value, 0 ), 1 );

function num( value, fallback ) {

	const n = typeof value === 'boolean' ? + value : value;
	return Number.isFinite( n ) ? n : fallback;

}

function mapIndex( value ) {

	return Number.isInteger( value ) ? value : - 1;

}

function writeTriple( data, at, value, fallback ) {

	const r = value?.r ?? value?.[ 0 ] ?? value?.x;
	const g = value?.g ?? value?.[ 1 ] ?? value?.y;
	const b = value?.b ?? value?.[ 2 ] ?? value?.z;
	data[ at ] = num( r, fallback[ 0 ] );
	data[ at + 1 ] = num( g, fallback[ 1 ] );
	data[ at + 2 ] = num( b, fallback[ 2 ] );

}

/**
 * The one writer of a material block, for the scene upload and runtime edits alike. A missing or
 * non-finite field gets MATERIAL_DEFAULTS.
 * @param {Float32Array} data
 * @param {number} base - float offset of the material's block
 * @param {Object} mat - a GeometryExtractor.createMaterialObject() result, or any subset of it
 */
export function packMaterial( data, base, mat ) {

	const s = ( offset, value, fallback ) => {

		data[ base + offset ] = num( value, fallback );

	};

	const u = ( offset, value, fallback ) => {

		data[ base + offset ] = clampUnit( num( value, fallback ) );

	};

	s( M.IOR, mat.ior, D.ior );
	u( M.TRANSMISSION, mat.transmission, D.transmission );
	s( M.THICKNESS, mat.thickness, D.thickness );
	s( M.EMISSIVE_INTENSITY, mat.emissiveIntensity, D.emissiveIntensity );

	writeTriple( data, base + M.ATTENUATION_COLOR, mat.attenuationColor, D.attenuationColor );
	data[ base + M.ATTENUATION_DISTANCE ] = normalizeAttenuationDistance( mat.attenuationDistance ?? D.attenuationDistance );

	u( M.OPACITY, mat.opacity, D.opacity );
	s( M.SIDE, mat.side, D.side );
	s( M.TRANSPARENT, mat.transparent, D.transparent );
	s( M.ALPHA_TEST, mat.alphaTest, D.alphaTest );

	s( M.ALPHA_MODE, mat.alphaMode, D.alphaMode );
	s( M.DEPTH_WRITE, mat.depthWrite, D.depthWrite );
	const normalScale = mat.normalScale;
	const uniformScale = typeof normalScale === 'number' ? normalScale : undefined;
	s( M.NORMAL_SCALE, uniformScale ?? normalScale?.x ?? normalScale?.[ 0 ], D.normalScale[ 0 ] );
	s( M.NORMAL_SCALE + 1, uniformScale ?? normalScale?.y ?? normalScale?.[ 1 ], D.normalScale[ 1 ] );

	writeTriple( data, base + M.COLOR, mat.color, D.color );
	u( M.METALNESS, mat.metalness, D.metalness );

	writeTriple( data, base + M.EMISSIVE, mat.emissive, D.emissive );
	u( M.ROUGHNESS, mat.roughness, D.roughness );

	data[ base + M.ALBEDO_MAP_INDEX ] = mapIndex( mat.map );
	data[ base + M.NORMAL_MAP_INDEX ] = mapIndex( mat.normalMap );
	data[ base + M.ROUGHNESS_MAP_INDEX ] = mapIndex( mat.roughnessMap );
	data[ base + M.METALNESS_MAP_INDEX ] = mapIndex( mat.metalnessMap );

	data[ base + M.EMISSIVE_MAP_INDEX ] = mapIndex( mat.emissiveMap );
	data[ base + M.BUMP_MAP_INDEX ] = mapIndex( mat.bumpMap );
	u( M.CLEARCOAT, mat.clearcoat, D.clearcoat );
	u( M.CLEARCOAT_ROUGHNESS, mat.clearcoatRoughness, D.clearcoatRoughness );

	s( M.DISPERSION, mat.dispersion, D.dispersion );
	u( M.SHEEN, mat.sheen, D.sheen );
	u( M.SHEEN_ROUGHNESS, mat.sheenRoughness, D.sheenRoughness );

	writeTriple( data, base + M.SHEEN_COLOR, mat.sheenColor, D.sheenColor );

	u( M.SPECULAR_INTENSITY, mat.specularIntensity, D.specularIntensity );
	writeTriple( data, base + M.SPECULAR_COLOR, mat.specularColor, D.specularColor );

	u( M.IRIDESCENCE, mat.iridescence, D.iridescence );
	s( M.IRIDESCENCE_IOR, mat.iridescenceIOR, D.iridescenceIOR );
	s( M.IRIDESCENCE_THICKNESS_RANGE, mat.iridescenceThicknessRange?.[ 0 ], D.iridescenceThicknessRange[ 0 ] );
	s( M.IRIDESCENCE_THICKNESS_RANGE + 1, mat.iridescenceThicknessRange?.[ 1 ], D.iridescenceThicknessRange[ 1 ] );

	s( M.BUMP_SCALE, mat.bumpScale, D.bumpScale );
	s( M.DISPLACEMENT_SCALE, mat.displacementScale, D.displacementScale );
	data[ base + M.DISPLACEMENT_MAP_INDEX ] = mapIndex( mat.displacementMap );

	for ( const [ key, offset ] of TRANSFORMS ) {

		const matrix = mat[ key ];
		for ( let i = 0; i < 8; i ++ ) data[ base + offset + i ] = num( matrix?.[ i ], IDENTITY_UV[ i ] );

	}

	writeTriple( data, base + M.SUBSURFACE_COLOR, mat.subsurfaceColor, D.subsurfaceColor );
	u( M.SUBSURFACE, mat.subsurface, D.subsurface );
	writeTriple( data, base + M.SUBSURFACE_RADIUS, mat.subsurfaceRadius, D.subsurfaceRadius );
	s( M.SUBSURFACE_RADIUS_SCALE, mat.subsurfaceRadiusScale, D.subsurfaceRadiusScale );

	s( M.SUBSURFACE_ANISOTROPY, mat.subsurfaceAnisotropy, D.subsurfaceAnisotropy );
	u( M.ANISOTROPY, mat.anisotropy, D.anisotropy );
	s( M.ANISOTROPY_ROTATION, mat.anisotropyRotation, D.anisotropyRotation );
	data[ base + M.ANISOTROPY_MAP_INDEX ] = mapIndex( mat.anisotropyMap );

	data[ base + M.TRANSMISSION_MAP_INDEX ] = mapIndex( mat.transmissionMap );
	data[ base + M.CLEARCOAT_MAP_INDEX ] = mapIndex( mat.clearcoatMap );
	data[ base + M.CLEARCOAT_ROUGHNESS_MAP_INDEX ] = mapIndex( mat.clearcoatRoughnessMap );
	data[ base + M.SHEEN_COLOR_MAP_INDEX ] = mapIndex( mat.sheenColorMap );

	data[ base + M.SHEEN_ROUGHNESS_MAP_INDEX ] = mapIndex( mat.sheenRoughnessMap );
	data[ base + M.IRIDESCENCE_MAP_INDEX ] = mapIndex( mat.iridescenceMap );
	data[ base + M.IRIDESCENCE_THICKNESS_MAP_INDEX ] = mapIndex( mat.iridescenceThicknessMap );
	data[ base + M.SPECULAR_INTENSITY_MAP_INDEX ] = mapIndex( mat.specularIntensityMap );

	data[ base + M.SPECULAR_COLOR_MAP_INDEX ] = mapIndex( mat.specularColorMap );

	data[ base + M.VISIBLE ] = 1;
	data[ base + M.SHEEN_COLOR + 3 ] = 1;
	data[ base + M.DISPLACEMENT_MAP_INDEX + 1 ] = 0;
	data[ base + M.SPECULAR_COLOR_MAP_INDEX + 1 ] = 0;
	data[ base + M.SPECULAR_COLOR_MAP_INDEX + 2 ] = 0;
	data[ base + M.SPECULAR_COLOR_MAP_INDEX + 3 ] = 0;

}
