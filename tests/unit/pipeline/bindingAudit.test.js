import { describe, it, expect, vi, afterEach } from 'vitest';
import { Texture } from 'three';
import { setBindingAudit, auditStageRender, getBindingAuditFindings, clearBindingAuditFindings } from '@/core/pipeline/BindingAudit.js';

class Renderer {

	compute( node ) {

		this.computed = node;
		return 'dispatched';

	}

}

const unbound = () => ( { isTextureNode: true, value: new Texture() } );
const real = () => ( { image: { width: 4, height: 4 } } );
const storage = () => ( { isStorageTexture: true, image: { width: 4, height: 4 } } );

// A frame whose kernel compiles at its first dispatch; `before` runs ahead of it, `after` behind it.
function frame( stage, renderer, { before = () => {}, after = () => {} } = {} ) {

	auditStageRender( stage, renderer, () => {

		before();
		renderer.compute( 'kernel' );
		after();

	} );

}

describe( 'the texture binding audit', () => {

	afterEach( () => {

		setBindingAudit( false );
		clearBindingAuditFindings();

	} );

	it( 'is a plain render while off', () => {

		const stage = { name: 'Off', a: unbound(), b: unbound() };
		const renderer = new Renderer();
		frame( stage, renderer, { after: () => {

			stage.a.value = real();
			stage.b.value = real();

		} } );
		frame( stage, renderer );

		expect( renderer.computed ).toBe( 'kernel' );
		expect( getBindingAuditFindings() ).toEqual( [] );

	} );

	it( 'names two nodes that were empty at the first dispatch and got ordinary textures later', () => {

		setBindingAudit( true );
		const stage = { name: 'Denoise', history: unbound(), moments: unbound(), other: 3 };
		const renderer = new Renderer();
		frame( stage, renderer, { after: () => {

			stage.history.value = real();
			stage.moments.value = real();

		} } );
		frame( stage, renderer );

		const [ finding ] = getBindingAuditFindings();
		expect( finding.stage ).toBe( 'Denoise' );
		expect( finding.nodes ).toEqual( [ 'history', 'moments' ] );
		expect( finding.unboundAtCompile ).toEqual( [ 'history', 'moments' ] );
		expect( finding.message ).toMatch( /history, moments were still holding EmptyTexture/ );

	} );

	it( 'snapshots at the first dispatch, not after the render', () => {

		setBindingAudit( true );
		const stage = { name: 'Early', a: unbound(), b: unbound() };
		const renderer = new Renderer();
		frame( stage, renderer, { before: () => {

			stage.a.value = real();
			stage.b.value = real();

		} } );
		frame( stage, renderer );

		expect( getBindingAuditFindings() ).toEqual( [] );

	} );

	it( 'accepts storage textures bound after the compile', () => {

		setBindingAudit( true );
		const stage = { name: 'Storage', a: unbound(), b: unbound() };
		const renderer = new Renderer();
		frame( stage, renderer, { after: () => {

			stage.a.value = storage();
			stage.b.value = storage();

		} } );
		frame( stage, renderer );

		expect( getBindingAuditFindings() ).toEqual( [] );

	} );

	it( 'names only the late ordinary texture beside a storage one', () => {

		setBindingAudit( true );
		const stage = { name: 'Mixed', a: unbound(), b: unbound() };
		const renderer = new Renderer();
		frame( stage, renderer, { after: () => {

			stage.a.value = real();
			stage.b.value = storage();

		} } );
		frame( stage, renderer );

		const [ finding ] = getBindingAuditFindings();
		expect( finding.nodes ).toEqual( [ 'a' ] );
		expect( finding.message ).toMatch( /a was still holding EmptyTexture .* alongside 1 other/ );

	} );

	it( 'ignores a single unbound node, which has nothing to alias with', () => {

		setBindingAudit( true );
		const stage = { name: 'Single', a: unbound(), b: { isTextureNode: true, value: real() } };
		const renderer = new Renderer();
		frame( stage, renderer, { after: () => void ( stage.a.value = real() ) } );
		frame( stage, renderer );

		expect( getBindingAuditFindings() ).toEqual( [] );

	} );

	it( 'waits while a node is still unbound, then reports once', () => {

		setBindingAudit( true );
		const stage = { name: 'Slow', a: unbound(), b: unbound() };
		const renderer = new Renderer();
		frame( stage, renderer, { after: () => void ( stage.a.value = real() ) } );
		frame( stage, renderer );
		expect( getBindingAuditFindings() ).toEqual( [] );

		stage.b.value = real();
		frame( stage, renderer );
		frame( stage, renderer );
		expect( getBindingAuditFindings() ).toHaveLength( 1 );

	} );

	it( 'puts the renderer\'s compute back, even when the render throws', () => {

		setBindingAudit( true );
		const renderer = new Renderer();
		expect( () => auditStageRender( { name: 'Throws' }, renderer, () => {

			throw new Error( 'kernel failed' );

		} ) ).toThrow( 'kernel failed' );
		expect( Object.hasOwn( renderer, 'compute' ) ).toBe( false );

		const own = vi.fn();
		const patched = Object.assign( new Renderer(), { compute: own } );
		auditStageRender( { name: 'Own' }, patched, () => patched.compute( 'k' ) );
		expect( patched.compute ).toBe( own );
		expect( own ).toHaveBeenCalledWith( 'k' );

	} );

	it( 'hands out a copy of its findings', () => {

		setBindingAudit( true );
		const stage = { name: 'Copy', a: unbound(), b: unbound() };
		const renderer = new Renderer();
		frame( stage, renderer, { after: () => {

			stage.a.value = real();
			stage.b.value = real();

		} } );
		frame( stage, renderer );

		getBindingAuditFindings().length = 0;
		expect( getBindingAuditFindings() ).toHaveLength( 1 );
		clearBindingAuditFindings();
		expect( getBindingAuditFindings() ).toEqual( [] );

	} );

} );
