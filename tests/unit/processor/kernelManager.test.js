import { describe, it, expect } from 'vitest';
import { KernelManager } from '@/core/Processor/KernelManager.js';

const managerWith = ( workgroupSize, limit = 65535 ) => {

	const km = new KernelManager( { backend: { device: { limits: { maxComputeWorkgroupsPerDimension: limit } } } } );
	const node = { workgroupSize };
	km.kernels.set( 'k', node );
	return { km, node };

};

describe( 'KernelManager.setDispatchForCount', () => {

	it( 'keeps a grid within the limit in one row', () => {

		const { km, node } = managerWith( [ 256, 1, 1 ] );
		km.setDispatchForCount( 'k', 2048 * 2048 );
		expect( node.dispatchSize ).toEqual( [ 16384, 1, 1 ] );

	} );

	it( 'spills a 4096² full-frame grid into rows instead of passing the per-dimension limit', () => {

		const { km, node } = managerWith( [ 256, 1, 1 ] );
		km.setDispatchForCount( 'k', 4096 * 4096 );
		const [ x, y ] = node.dispatchSize;
		expect( x ).toBeLessThanOrEqual( 65535 );
		expect( x * y * 256 ).toBeGreaterThanOrEqual( 4096 * 4096 );

	} );

	it( 'reads the limit from the device', () => {

		const { km, node } = managerWith( [ 64, 1, 1 ], 1000 );
		km.setDispatchForCount( 'k', 64 * 2500 );
		expect( node.dispatchSize ).toEqual( [ 1000, 3, 1 ] );

	} );

} );
