/**
 * USD scene loader for multi-file scenes in a folder or archive: layers are read only as composition reaches them, and
 * the stage is built by the pbrt importer's builder, so instancing, budgets and curve tessellation are shared.
 *
 *   const files = new USDFiles( paths, read );
 *   const { group, environment, cameras } = await loadUSDScene( { files, entryPath, resolveImage, resolveEnvironment } );
 */

import { PBRTSceneBuilder } from '../PBRT/PBRTSceneBuilder.js';
import { USDStage } from './USDStage.js';
import { USDSceneReader } from './USDScene.js';

export { USDFiles, USDStage } from './USDStage.js';

export const USD_LAYER = /\.(usd|usda|usdc)$/i;

/** USD layers that could be a scene's root, best first: the shallowest, then the shortest name. */
export function listUSDRootLayers( paths ) {

	const layers = paths.filter( p => USD_LAYER.test( p ) && ! p.split( '/' ).pop().startsWith( '._' ) );
	if ( layers.length === 0 ) return [];
	const depth = p => p.split( '/' ).length;
	const top = Math.min( ...layers.map( depth ) );
	return layers.filter( p => depth( p ) === top ).sort( ( a, b ) => {

		const na = a.split( '/' ).pop(), nb = b.split( '/' ).pop();
		return na.length - nb.length || ( na < nb ? - 1 : na > nb ? 1 : 0 );

	} );

}

/** The parts a large scene loads by: prims under the root's top prims that bring in sibling directories (Moana's elements/). */
export async function listUSDParts( stage, listing ) {

	const parts = new Map();
	const root = stage.pseudoRoot;
	const rootDir = stage.root.id.includes( '/' ) ? stage.root.id.slice( 0, stage.root.id.lastIndexOf( '/' ) ) : '';
	for ( const top of root.childNames() ) {

		for ( const [ , spec, layer ] of ( await stage.child( root, top ) )?.sites ?? [] ) {

			for ( const [ name, child ] of spec.children ?? [] ) {

				for ( const key of [ 'references', 'payload' ] ) {

					const op = child.arcs?.[ key ];
					for ( const ref of [ ...( op?.explicit ?? [] ), ...( op?.prepend ?? [] ), ...( op?.append ?? [] ), ...( op?.add ?? [] ) ] ) {

						const file = stage.files.resolve( ref.asset, layer.path );
						if ( ! file?.includes( '/' ) ) continue;
						const prefix = file.slice( 0, file.lastIndexOf( '/' ) );
						if ( prefix === rootDir || ! prefix.startsWith( rootDir ) ) continue;
						if ( ! parts.has( prefix ) ) parts.set( prefix, { name, prefix, files: 0, bytes: 0, scenes: 1 } );

					}

				}

			}

		}

	}

	// A library referenced on its own beside the parts is not one.
	const byParent = new Map();
	for ( const part of parts.values() ) {

		const parent = part.prefix.slice( 0, part.prefix.lastIndexOf( '/' ) );
		if ( ! byParent.has( parent ) ) byParent.set( parent, [] );
		byParent.get( parent ).push( part );

	}

	const siblings = [ ...byParent.values() ].sort( ( a, b ) => b.length - a.length )[ 0 ] ?? [];
	for ( const part of siblings ) {

		for ( const entry of listing ) {

			if ( ! entry.path.startsWith( `${part.prefix}/` ) || ! USD_LAYER.test( entry.path ) ) continue;
			part.files ++;
			part.bytes += entry.size;

		}

	}

	return siblings.sort( ( a, b ) => a.bytes - b.bytes );

}

export async function loadUSDScene( args ) {

	const warnings = [];
	const warn = message => warnings.push( message );
	const builder = new PBRTSceneBuilder( {
		maxTriangles: args.maxTriangles, maxPlacements: args.maxPlacements, mergeShapesAbove: args.mergeShapesAbove,
		curveSteps: args.curveSteps, curveSides: args.curveSides, curveTolerance: args.curveTolerance,
	} );

	const parseStart = performance.now();
	const stage = new USDStage( args.files, { warn } );
	await stage.open( args.entryPath );
	const reader = new USDSceneReader( stage, {
		maxTriangles: builder.maxTriangles, maxPlacements: builder.maxPlacements, curveSteps: builder.curveSteps,
		resolveImage: args.resolveImage, warn,
	} );
	const read = await reader.read();
	if ( stage.omittedArcs > 0 ) warn( `${stage.omittedArcs} reference(s) into the parts left out of this load skipped` );
	const parseMs = performance.now() - parseStart;

	const buildStart = performance.now();
	const built = await builder.build( read.ir );
	for ( const object of [ ...read.cameras, ...read.lights ] ) built.group.add( object );

	let environment = null;
	if ( read.dome ) {

		const texture = await args.resolveEnvironment( read.dome.file );
		if ( texture ) environment = { texture, intensity: read.dome.intensity, rotation: read.dome.rotation };
		else warn( `USD dome light texture "${read.dome.file}" could not be read` );

	}

	return {
		...built,
		environment,
		cameras: read.cameras,
		lights: read.lights,
		cost: read.cost,
		fitNote: reader.fitNote,
		warnings: [ ...warnings, ...built.warnings ],
		parseMs,
		buildMs: performance.now() - buildStart,
	};

}
