/**
 * USD scene loader for multi-file scenes in a folder or archive: layers are read only as composition reaches them, and
 * the stage is built by the pbrt importer's builder, so instancing, budgets and curve tessellation are shared.
 *
 *   const files = new USDFiles( paths, read );
 *   const { group, environment, cameras } = await loadUSDScene( { files, entryPath, resolveImage, resolveEnvironment } );
 */

import { PBRTSceneBuilder } from '../pbrt/PBRTSceneBuilder.js';
import { USDStage } from './USDStage.js';
import { USDSceneReader } from './USDScene.js';
import { materialXNames } from './MaterialX.js';

export { USDFiles, USDStage } from './USDStage.js';

/** Bumped whenever the same USD files translate to a different graph, so a stored one is not reused (the builder's own
 * changes bump PBRT_BUILD_REVISION). */
export const USD_BUILD_REVISION = 3;

export const USD_LAYER = /\.(usd|usda|usdc)$/i;

/** MaterialX documents, read as USD layers (MaterialX.js). */
export const MATERIALX = /\.mtlx$/i;

// Where materialXPreview's root layer sits among a load's files.
const MATERIALX_PREVIEW = '__materialx_preview__.usda';

const PREVIEW_SPACING = 1.25;

/**
 * A root layer showing each material of the MaterialX documents among `paths` on a sphere of its own (1 m across, Y up),
 * in a grid in document order; null when no document holds a material.
 * @param {string[]} paths
 * @param {function(string): Promise<?Uint8Array>} read
 * @param {function(string): void} [warn]
 */
export async function materialXPreview( paths, read, warn = () => {} ) {

	const docs = paths.filter( p => MATERIALX.test( p ) && ! p.split( '/' ).pop().startsWith( '._' ) );
	const placed = [];
	for ( const [ d, doc ] of docs.entries() ) {

		const bytes = await read( doc );
		if ( ! bytes ) continue;
		try {

			for ( const name of materialXNames( new TextDecoder().decode( bytes ) ) ) placed.push( { name, scope: `D${d}`, doc } );

		} catch ( error ) {

			warn( `MaterialX document "${doc}" could not be read: ${error.message}` );

		}

	}

	if ( placed.length === 0 ) return null;
	const columns = Math.ceil( Math.sqrt( placed.length ) ), rows = Math.ceil( placed.length / columns );
	const used = new Set();
	const spheres = placed.map( ( { name, scope }, i ) => {

		let prim = name;
		for ( let n = 1; used.has( prim ); n ++ ) prim = `${name}_${n}`;
		used.add( prim );
		const x = ( i % columns - ( columns - 1 ) / 2 ) * PREVIEW_SPACING, z = ( Math.floor( i / columns ) - ( rows - 1 ) / 2 ) * PREVIEW_SPACING;
		// UsdGeomSphere's poles are on z: turned onto y, so a texture's seam and poles face away from a level view.
		return `        def Sphere "${prim}" (
            prepend apiSchemas = ["MaterialBindingAPI"]
        )
        {
            double radius = 0.5
            double3 xformOp:translate = (${x}, 0.5, ${z})
            float xformOp:rotateX = -90
            uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateX"]
            rel material:binding = </MaterialX/Documents/${scope}/${name}>
        }`;

	} );
	const scopes = [ ...new Map( placed.map( p => [ p.scope, p.doc ] ) ) ].map( ( [ scope, doc ] ) => `        def "${scope}" (
            prepend references = ${doc.includes( '@' ) ? `@@@${doc}@@@` : `@${doc}@`}</MaterialX/Materials>
        )
        {
        }` );
	const text = `#usda 1.0
(
    defaultPrim = "MaterialX"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "MaterialX"
{
    def "Documents"
    {
${scopes.join( '\n' )}
    }
    def Xform "Spheres"
    {
${spheres.join( '\n' )}
    }
}
`;
	return { path: MATERIALX_PREVIEW, text, documents: [ ...new Set( placed.map( p => p.doc ) ) ], materials: placed.length };

}

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
		curveSteps: args.curveSteps, curveSides: args.curveSides, curveTolerance: args.curveTolerance, pause: args.pauseBuild,
		ptexMemory: args.ptexMemory, ptexPageSize: args.ptexPageSize, resolvePtex: args.resolvePtex, missingUV: 'zero',
	} );

	const parseStart = performance.now();
	const stage = new USDStage( args.files, { warn } );
	await stage.open( args.entryPath );
	const openMs = performance.now() - parseStart;
	const reader = new USDSceneReader( stage, {
		maxTriangles: builder.maxTriangles, maxPlacements: builder.maxPlacements, curveSteps: builder.curveSteps,
		resolveImage: args.resolveImage, warn, pause: args.pauseRead, bakes: builder,
	} );
	let read, built, parseMs, buildStart;
	try {

		read = await reader.read();
		if ( stage.omittedArcs > 0 ) warn( `${stage.omittedArcs} reference(s) into the parts left out of this load skipped` );
		parseMs = performance.now() - parseStart;
		buildStart = performance.now();
		built = await builder.build( read.ir );

	} finally {

		builder.closePools();
		builder.releaseImages();

	}

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
		render: read.render,
		cost: read.cost,
		fitNote: reader.fitNote,
		warnings: [ ...warnings, ...built.warnings ],
		parseMs,
		readTimings: { openMs, ...reader.timings },
		buildMs: performance.now() - buildStart,
	};

}
