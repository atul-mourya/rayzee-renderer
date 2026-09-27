import { describe, it, expect, vi } from 'vitest';
import { Mesh, Scene } from 'three';
import { OutlineHelper } from '@/core/managers/helpers/OutlineHelper.js';
import { ViewCamera } from '@/core/managers/ViewCamera.js';

const renderer = () => ( { autoClear: true, setRenderTarget: vi.fn(), render: vi.fn() } );

describe( 'OutlineHelper', () => {

	it( 'rebuilds for a camera turned orthographic, keeping what is selected', () => {

		const camera = new ViewCamera( 60, 1, 0.1, 100 );
		const helper = new OutlineHelper( new Scene(), camera );
		const selected = new Mesh();
		helper.setSelectedObjects( [ selected ] );
		const built = helper._outlineNode;

		camera.orthographic = true;
		helper.render( renderer() );

		expect( helper._outlineNode ).not.toBe( built );
		expect( helper._outlineNode.selectedObjects ).toEqual( [ selected ] );
		expect( helper.visible ).toBe( true );

		const rebuilt = helper._outlineNode;
		helper.render( renderer() );
		expect( helper._outlineNode ).toBe( rebuilt );

	} );

} );
