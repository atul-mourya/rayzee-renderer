import { describe, it, expect } from 'vitest';
import { WebGPUBackend } from 'three/webgpu';
import '@/core/shaders/ThreePatches.js';

// The WGSL a compute program reaches the device with.
function compactFunctionVariables( code ) {

	let sent = null;
	const backend = { get: () => ( {} ), device: { createShaderModule: ( descriptor ) => ( sent = descriptor.code, {} ) } };
	WebGPUBackend.prototype.createProgram.call( backend, { stage: 'compute', name: '', code } );
	return sent;

}

const fn = ( body ) => compactFunctionVariables( `fn main( @builtin( global_invocation_id ) id : vec3<u32> ) {\n${body}\n}\n` );
const declares = ( code, name ) => new RegExp( `var ${name} :` ).test( code );

describe( 'a compute program\'s function variables', () => {

	it( 'turns a variable written once and read after it into a typed let', () => {

		const out = fn( `	var nodeVar0 : f32;
	nodeVar0 = 1;
	let a = nodeVar0 * 2.0;` );
		expect( declares( out, 'nodeVar0' ) ).toBe( false );
		expect( out ).toContain( 'let nodeVar0 : f32 = 1;' );

	} );

	it( 'keeps a variable read in its own definition, written twice, or written through a member', () => {

		const out = fn( `	var nodeVar0 : f32;
	var nodeVar1 : f32;
	var nodeVar2 : vec3<f32>;
	nodeVar0 = nodeVar0 + 1.0;
	nodeVar1 = 1.0;
	nodeVar1 = 2.0;
	nodeVar2 = vec3<f32>( 0.0 );
	nodeVar2.x = 1.0;
	let a = nodeVar0 + nodeVar1 + nodeVar2.y;` );
		expect( out ).not.toMatch( /let nodeVar/ );

	} );

	it( 'keeps a variable read past the block it is written in', () => {

		const out = fn( `	var nodeVar0 : f32;
	if ( id.x > 0u ) {
		nodeVar0 = 1.0;
	}
	let a = nodeVar0;` );
		expect( out ).not.toContain( 'let nodeVar0' );
		expect( declares( out, 'nodeVar0' ) ).toBe( true );

	} );

	it( 'drops variables that are never used', () => {

		expect( declares( fn( '	var nodeVar0 : vec4<f32>;' ), 'nodeVar0' ) ).toBe( false );

	} );

	it( 'shares a slot between variables of one type whose uses do not overlap', () => {

		const out = fn( `	var nodeVar0 : f32;
	var nodeVar1 : f32;
	nodeVar0 = 1.0;
	nodeVar0 = nodeVar0 * 2.0;
	o = nodeVar0;
	nodeVar1 = 3.0;
	nodeVar1 = nodeVar1 * 2.0;
	o = nodeVar1;` );
		expect( declares( out, 'nodeVar1' ) ).toBe( false );
		expect( out.match( /nodeVar0 = 3\.0;\n\tnodeVar0 = nodeVar0 \* 2\.0;\n\to = nodeVar0;/ ) ).not.toBeNull();

	} );

	it( 'keeps overlapping variables, and variables of other types, apart', () => {

		const out = fn( `	var nodeVar0 : f32;
	var nodeVar1 : f32;
	var nodeVar2 : i32;
	nodeVar0 = 1.0;
	nodeVar0 = nodeVar0 * 2.0;
	nodeVar1 = 3.0;
	nodeVar1 = nodeVar1 + nodeVar0;
	nodeVar2 = 1;
	nodeVar2 = nodeVar2 + 1;
	o = nodeVar1 + f32( nodeVar2 );` );
		for ( const name of [ 'nodeVar0', 'nodeVar1', 'nodeVar2' ] ) expect( declares( out, name ) ).toBe( true );

	} );

	it( 'keeps a value carried round a loop apart from variables used later in the loop', () => {

		const out = fn( `	var nodeVar0 : f32;
	var nodeVar1 : f32;
	nodeVar0 = 1.0;
	nodeVar0 = nodeVar0 * 2.0;
	for ( var i : i32 = 0; i < 4; i ++ ) {
		o = nodeVar0;
		nodeVar1 = 2.0;
		nodeVar1 = nodeVar1 * 3.0;
		o = nodeVar1;
	}` );
		expect( declares( out, 'nodeVar0' ) ).toBe( true );
		expect( declares( out, 'nodeVar1' ) ).toBe( true );

	} );

	it( 'counts a use in a loop header as inside the loop', () => {

		const out = fn( `	var nodeVar0 : i32;
	var nodeVar1 : i32;
	nodeVar0 = 4;
	nodeVar0 = nodeVar0 + 1;
	for ( var i : i32 = 0; i < nodeVar0; i ++ ) {
		nodeVar1 = i;
		nodeVar1 = nodeVar1 * 2;
		o = f32( nodeVar1 );
	}` );
		expect( declares( out, 'nodeVar1' ) ).toBe( true );

	} );

	it( 'zeroes a branch-written variable where its uses begin before it takes a used slot', () => {

		const out = fn( `	var nodeVar0 : vec3<f32>;
	var nodeVar1 : vec3<f32>;
	nodeVar0 = vec3<f32>( 1.0 );
	nodeVar0 = nodeVar0 * 2.0;
	o = nodeVar0.x;
	if ( id.y > 0u ) {
		if ( id.x > 0u ) {
			nodeVar1 = vec3<f32>( 3.0 );
		}
		o = nodeVar1.x;
	}` );
		expect( declares( out, 'nodeVar1' ) ).toBe( false );
		expect( out ).toMatch( /if \( id\.y > 0u \) \{\nnodeVar0 = vec3<f32>\(\);/ );

	} );

	it( 'keeps a branch-written variable inside a loop apart', () => {

		const out = fn( `	var nodeVar0 : f32;
	var nodeVar1 : f32;
	nodeVar0 = 1.0;
	nodeVar0 = nodeVar0 * 2.0;
	o = nodeVar0;
	loop {
		if ( id.x > 0u ) {
			nodeVar1 = 3.0;
		}
		o = nodeVar1;
	}` );
		expect( declares( out, 'nodeVar1' ) ).toBe( true );

	} );

	it( 'leaves a variable whose address is taken, and names that are not TSL\'s own', () => {

		const out = fn( `	var nodeVar0 : u32;
	var counter : u32;
	nodeVar0 = 1u;
	counter = 2u;
	o = f32( atomicAdd( &nodeVar0, counter ) );` );
		expect( declares( out, 'nodeVar0' ) ).toBe( true );
		expect( out ).toContain( 'var counter : u32;' );

	} );

	it( 'rewrites each function on its own', () => {

		const out = compactFunctionVariables( `fn helper( x : f32 ) -> f32 {
	var nodeVar0 : f32;
	nodeVar0 = x;
	return nodeVar0;
}
fn main() {
	var nodeVar0 : f32;
	nodeVar0 = 1.0;
	nodeVar0 = nodeVar0 + helper( 2.0 );
	o = nodeVar0;
}
` );
		expect( out ).toContain( 'let nodeVar0 : f32 = x;' );
		expect( out ).toMatch( /fn main\(\) \{\n\tvar nodeVar0 : f32;/ );

	} );

} );
