import { describe, it, expect } from 'vitest';
import { OIDNDenoiser } from '@/core/Passes/OIDNDenoiser.js';
import { OIDNTemporalHistory } from '@/core/Passes/OIDNTemporalHistory.js';

describe( 'denoiser GPU memory', () => {

	it( 'counts OIDN\'s input buffers and its half-float output', () => {

		const pass = Object.assign( Object.create( OIDNDenoiser.prototype ), {
			_gpuInputBuffers: { color: { size: 1000 }, albedo: { size: 1000 }, normal: { size: 1000 } },
			_gpuInputPadBuffer: { size: 24 },
			_outGPUTexture: {},
			_outTexSize: { width: 10, height: 5 },
		} );

		expect( pass.gpuBytes() ).toBe( 3024 + 10 * 5 * 8 );

	} );

	it( 'counts nothing before a denoise has allocated', () => {

		const pass = Object.assign( Object.create( OIDNDenoiser.prototype ), {
			_gpuInputBuffers: { color: null, albedo: null, normal: null },
			_gpuInputPadBuffer: null,
			_outGPUTexture: null,
			_outTexSize: { width: 0, height: 0 },
		} );

		expect( pass.gpuBytes() ).toBe( 0 );

	} );

	it( 'counts both history sets and the pick buffers', () => {

		const history = Object.assign( Object.create( OIDNTemporalHistory.prototype ), {
			_sets: [ {}, {} ], width: 4, height: 2, _picked: { size: 32 }, _copies: { size: 32 },
		} );

		expect( history.gpuBytes() ).toBe( 2 * 3 * 4 * 2 * 16 + 64 );
		expect( Object.assign( Object.create( OIDNTemporalHistory.prototype ), { _sets: null } ).gpuBytes() ).toBe( 0 );

	} );

} );
