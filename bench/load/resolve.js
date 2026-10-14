/**
 * Module hooks for a `bench:load` worker: `rayzee` resolves to one checkout's engine, so one runner can drive two.
 * The build sits outside that checkout, so a bare specifier it imports (three) resolves from the checkout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let exportsMap = null;
let distURL = '';
let anchorURL = '';

export function initialize( { tree, dist } ) {

	const pkg = JSON.parse( fs.readFileSync( path.join( tree, 'rayzee', 'package.json' ), 'utf8' ) );
	exportsMap = new Map();
	for ( const [ subpath, target ] of Object.entries( pkg.exports ?? {} ) ) {

		const file = typeof target === 'string' ? target : target.import ?? target.default;
		if ( ! file ) continue;
		const resolved = file.startsWith( './dist/' ) ? path.join( dist, file.slice( './dist/'.length ) ) : path.join( tree, 'rayzee', file );
		exportsMap.set( subpath === '.' ? 'rayzee' : `rayzee/${subpath.slice( 2 )}`, pathToFileURL( resolved ).href );

	}

	distURL = pathToFileURL( dist ).href + '/';
	anchorURL = pathToFileURL( path.join( tree, 'rayzee', 'package.json' ) ).href;

}

const isBare = ( specifier ) => ! /^(\.|\/|[a-z][a-z0-9+.-]*:)/i.test( specifier );

export async function resolve( specifier, context, next ) {

	const mapped = exportsMap?.get( specifier );
	if ( mapped ) return { url: mapped, shortCircuit: true };
	if ( isBare( specifier ) && context.parentURL?.startsWith( distURL ) ) return next( specifier, { ...context, parentURL: anchorURL } );
	return next( specifier, context );

}
