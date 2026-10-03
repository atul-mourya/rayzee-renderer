import {
	RGBAFormat, FloatType, LinearFilter, RepeatWrapping, ClampToEdgeWrapping,
	EquirectangularReflectionMapping, LinearSRGBColorSpace, DataTexture, Vector3, Vector4,
} from 'three';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { storage, uniform } from 'three/tsl';

import { gpuOnlyStorageAttribute } from '../TSL/patches.js';
import { freeStorageAttribute } from './PackedRayBuffer.js';
import {
	TRANSMITTANCE_W, TRANSMITTANCE_H, MS_MU_S, MS_H, MS_BANDS, MS_SECTORS, MS_CELLS, MS_VIEW_MU, MS_VIEW_PHI, MS_VIEWS, IRRADIANCE_SIZE, SKY_COLUMNS,
	buildTransmittanceKernel, buildIncomingKernel, buildScatterKernel, buildIrradianceKernel, buildSkyViewKernels,
} from '../TSL/Atmosphere.js';
import { buildEnvironmentCDFKernels, cdfRowStride } from '../TSL/EnvironmentCDF.js';
import { getWorkingMatrix } from '../Color/WorkingMatrix.js';
import {
	LAMBDA_COUNT, MIE_PHASE_G, SKY_RADIANCE_SCALE, SOLAR_SPECTRUM,
	atmosphereCoefficients, spectrumToRec709, sunLight, horizonDipSin, phaseCellWeights,
} from './AtmosphereModel.js';

// Filled on the GPU only: created without pixels, so three.js never uploads any.
function gpuTexture( width, height, format ) {

	const texture = new DataTexture( null, width, height, format, FloatType );
	texture.source.dataReady = false;
	texture.needsUpdate = true;
	texture._isPhysicalSky = true;
	return texture;

}

/**
 * Physically based clear sky, baked on the GPU into an equirect and its importance-sampling
 * table. The sun disc is not in the texture: `bake()` returns it as a light.
 */
export class PhysicalSky {

	constructor( width = 1024, height = 512, quality = {} ) {

		this.width = width;
		this.height = height;
		this._quality = quality;
		this.lastRenderTime = 0;

		this._texture = gpuTexture( width, height, RGBAFormat );
		this._texture.mapping = EquirectangularReflectionMapping;
		this._texture.colorSpace = LinearSRGBColorSpace;
		this._texture.minFilter = LinearFilter;
		this._texture.magFilter = LinearFilter;
		this._texture.wrapS = RepeatWrapping;
		this._texture.wrapT = ClampToEdgeWrapping;
		this._texture.generateMipmaps = false;
		// packExactTable's layout (EnvironmentExactTable.js): running sums and guides, RGBA.
		this._cdfTexture = gpuTexture( width + 1, height, RGBAFormat );
		this._rec709Weights = spectrumToRec709( SKY_RADIANCE_SCALE );

		this._attrs = null;
		this._kernels = null;
		this._airKey = null;
		this._transmittanceBuilt = false;

	}

	_init() {

		const vec4s = n => Array.from( { length: n }, () => uniform( new Vector4() ) );
		const coefficient = vec4s( 6 * 4 );
		this._uniforms = {
			coefficient,
			rgb: vec4s( 12 ),
			sunDirection: uniform( new Vector3( 0, 1, 0 ) ),
			altitude: uniform( 0.05 ),
			sunSinRadius: uniform( 0.0046 ),
		};

		const attr = count => gpuOnlyStorageAttribute( count, 4 );
		this._attrs = {
			transmittance: attr( TRANSMITTANCE_W * TRANSMITTANCE_H ),
			incomingA: attr( MS_MU_S * MS_H * MS_CELLS * 4 ),
			incomingB: attr( MS_MU_S * MS_H * MS_CELLS * 4 ),
			transfer: attr( MS_MU_S * MS_H * MS_CELLS * 4 ),
			multipleScattering: attr( MS_MU_S * MS_H * MS_VIEWS * 8 ),
			psiSum: attr( MS_MU_S * MS_H * MS_VIEWS * 8 ),
			groundE: attr( MS_MU_S * 4 ),
			irradiance: attr( IRRADIANCE_SIZE * 4 ),
			sky: attr( this.width * this.height ),
			skyRows: attr( SKY_COLUMNS * this.height ),
			cdfRows: attr( this.height ),
			cdfPrefix: gpuOnlyStorageAttribute( this.width * this.height, 2 ),
			cdfStats: attr( 2 ),
			cdf: gpuOnlyStorageAttribute( cdfRowStride( this.width ) * this.height, 1 ),
			phaseCells: new StorageInstancedBufferAttribute( phaseCellWeights( MS_VIEW_MU, MS_VIEW_PHI, MS_BANDS, MS_SECTORS ), 4 ),
		};
		const node = ( key, type = 'vec4' ) => storage( this._attrs[ key ], type, this._attrs[ key ].count );

		const slice = i => coefficient.slice( i * 4, i * 4 + 4 );
		const io = {
			transmittance: node( 'transmittance' ),
			transfer: node( 'transfer' ),
			psiSum: node( 'psiSum' ),
			groundE: node( 'groundE' ),
			phaseCells: node( 'phaseCells' ),
			multipleScattering: node( 'multipleScattering' ),
			irradiance: node( 'irradiance' ),
			sky: node( 'sky' ),
			skyRows: node( 'skyRows' ),
			coefficients: {
				rayleigh: slice( 0 ), mieScattering: slice( 1 ), mieExtinction: slice( 2 ),
				ozone: slice( 3 ), solar: slice( 4 ), albedo: slice( 5 ),
			},
			rgb: this._uniforms.rgb,
			sunDirection: this._uniforms.sunDirection,
			altitude: this._uniforms.altitude,
			sunSinRadius: this._uniforms.sunSinRadius,
			mieG: MIE_PHASE_G,
		};

		const q = this._quality;
		const incomingA = node( 'incomingA' ), incomingB = node( 'incomingB' );
		this._kernels = {
			transmittance: buildTransmittanceKernel( io ),
			air: [
				buildIncomingKernel( io, { first: true, out: incomingA, ...q.incoming } ),
				buildScatterKernel( io, { incoming: incomingA, stage: 'first' } ),
				buildIncomingKernel( io, { first: false, out: incomingB, ...q.incoming } ),
				buildScatterKernel( io, { incoming: incomingB, stage: 'middle' } ),
				buildIncomingKernel( io, { first: false, out: incomingA, ...q.incoming } ),
				buildScatterKernel( io, { incoming: incomingA, stage: 'last' } ),
				buildIrradianceKernel( io, q.irradiance ),
			],
			sky: buildSkyViewKernels( io, { width: this.width, height: this.height, ...q.sky } ),
			cdf: buildEnvironmentCDFKernels( {
				pixels: io.sky, rows: node( 'cdfRows' ), prefix: node( 'cdfPrefix', 'vec2' ), stats: node( 'cdfStats' ),
				cdf: node( 'cdf', 'float' ), width: this.width, height: this.height,
			} ),
		};

		this._setSpectrum( 4, SOLAR_SPECTRUM );

	}

	// Straight into the working space: pixels on the GPU cannot be converted afterwards.
	_setColorWeights() {

		const w = this._rec709Weights;
		const m = getWorkingMatrix();
		const out = [ 0, 0, 0, 0 ];
		for ( let row = 0; row < 3; row ++ ) {

			for ( let g = 0; g < 4; g ++ ) {

				for ( let j = 0; j < 4; j ++ ) {

					const k = g * 4 + j;
					out[ j ] = m
						? m[ row * 3 ] * w[ k ] + m[ row * 3 + 1 ] * w[ LAMBDA_COUNT + k ] + m[ row * 3 + 2 ] * w[ 2 * LAMBDA_COUNT + k ]
						: w[ row * LAMBDA_COUNT + k ];

				}

				this._uniforms.rgb[ row * 4 + g ].value.fromArray( out );

			}

		}

	}

	_copyToTextures( renderer ) {

		const backend = renderer.backend;
		renderer.initTexture( this._texture );
		renderer.initTexture( this._cdfTexture );
		const encoder = backend.device.createCommandEncoder( { label: 'PhysicalSky' } );
		encoder.copyBufferToTexture(
			{ buffer: backend.get( this._attrs.sky ).buffer, bytesPerRow: this.width * 16, rowsPerImage: this.height },
			{ texture: backend.get( this._texture ).texture },
			[ this.width, this.height ],
		);
		encoder.copyBufferToTexture(
			{ buffer: backend.get( this._attrs.cdf ).buffer, bytesPerRow: cdfRowStride( this.width ) * 4, rowsPerImage: this.height },
			{ texture: backend.get( this._cdfTexture ).texture },
			[ this.width + 1, this.height ],
		);
		backend.device.queue.submit( [ encoder.finish() ] );

	}

	_setSpectrum( slot, values ) {

		for ( let g = 0; g < 4; g ++ ) {

			this._uniforms.coefficient[ slot * 4 + g ].value.set( values[ g * 4 ], values[ g * 4 + 1 ], values[ g * 4 + 2 ], values[ g * 4 + 3 ] );

		}

	}

	/**
	 * Queue the bake on the GPU; the textures fill ahead of any frame submitted later. Only the
	 * table's two normalisers come back, in `stats`.
	 *
	 * @param {import('three/webgpu').WebGPURenderer} renderer - initialised
	 * @param {Object} p
	 * @param {number[]} p.sunDirection - unit, y up, in the sky's own frame
	 * @param {number} p.turbidity
	 * @param {number} p.ozone - Dobson units
	 * @param {number} p.airDensity
	 * @param {number[]} p.groundAlbedo - linear Rec.709
	 * @param {number} p.altitude - metres
	 * @param {number} p.sunAngularDiameter - radians
	 * @param {number} [p.sunStrength=1]
	 * @returns {{ texture: DataTexture, cdfTexture: DataTexture, sun: Object, stats: Promise<{ totalSum: number, radianceIntegral: number }> }}
	 */
	bake( renderer, p ) {

		const start = performance.now();
		if ( ! this._kernels ) this._init();

		const air = {
			airDensity: p.airDensity, turbidity: p.turbidity, ozone: p.ozone,
			groundAlbedo: [ ...p.groundAlbedo ],
		};
		const coefficients = atmosphereCoefficients( air );
		const altitude = Math.max( p.altitude, 1 ) / 1000;
		const halfAngle = p.sunAngularDiameter / 2;

		const u = this._uniforms;
		u.sunDirection.value.fromArray( p.sunDirection ).normalize();
		u.altitude.value = altitude;
		u.sunSinRadius.value = Math.sin( halfAngle );
		this._setColorWeights();

		const dispatches = [];
		if ( ! this._transmittanceBuilt ) {

			dispatches.push( this._kernels.transmittance );
			this._transmittanceBuilt = true;

		}

		const airKey = JSON.stringify( [ air, u.sunSinRadius.value ] );
		if ( airKey !== this._airKey ) {

			this._setSpectrum( 0, coefficients.rayleigh );
			this._setSpectrum( 1, coefficients.mieScattering );
			this._setSpectrum( 2, coefficients.mieExtinction );
			this._setSpectrum( 3, coefficients.ozone );
			this._setSpectrum( 5, coefficients.albedo );
			dispatches.push( ...this._kernels.air );
			this._airKey = airKey;

		}

		dispatches.push( ...this._kernels.sky, ...this._kernels.cdf );
		renderer.compute( dispatches );
		this._copyToTextures( renderer );

		const stats = renderer.getArrayBufferAsync( this._attrs.cdfStats ).then( buffer => {

			const s = new Float32Array( buffer );
			return { totalSum: s[ 4 ], radianceIntegral: 2 * Math.PI * Math.PI * s[ 0 ] / ( this.width * this.height ) };

		} );

		const sun = sunLight( {
			direction: [ u.sunDirection.value.x, u.sunDirection.value.y, u.sunDirection.value.z ],
			altitude,
			angularDiameter: p.sunAngularDiameter,
			strength: p.sunStrength ?? 1,
			coefficients,
		} );
		sun.cosHalfAngle = Math.cos( halfAngle );
		sun.sinHalfAngle = Math.sin( halfAngle );
		sun.horizonSin = horizonDipSin( altitude );

		this.lastRenderTime = performance.now() - start;
		return { texture: this._texture, cdfTexture: this._cdfTexture, sun, stats };

	}

	/** The last bake's pixels (RGBA, row 0 first), packed table and stats — for tests and debugging. */
	async readBack( renderer ) {

		const [ pixels, cdf, stats ] = await Promise.all(
			[ 'sky', 'cdf', 'cdfStats' ].map( key => renderer.getArrayBufferAsync( this._attrs[ key ] ) )
		);
		return { pixels: new Float32Array( pixels ), cdf: new Float32Array( cdf ), cdfStride: cdfRowStride( this.width ), stats: new Float32Array( stats ) };

	}

	getLastRenderTime() {

		return this.lastRenderTime;

	}

	dispose( renderer = null ) {

		for ( const k of Object.values( this._kernels ?? {} ).flat() ) k.dispose();
		for ( const a of Object.values( this._attrs ?? {} ) ) freeStorageAttribute( renderer, a );
		this._kernels = null;
		this._attrs = null;
		this._texture.dispose();
		this._cdfTexture.dispose();

	}

}
