import { SRGBColorSpace, LinearSRGBColorSpace } from 'three/webgpu';
import { ISSUE_CODES } from '../EngineIssues.js';
import { TRIANGLE_PATCH_PROPERTIES } from '../materials/MaterialDataManager.js';
import { usesTextureCoordinates } from './GeometryExtractor.js';
import { scheduleRespill } from '../memory/SceneSpill.js';

export async function refitBVH( app, newPositions, newNormals ) {

	await app.ensureSceneResident();
	const { triRanges, bvhRanges, ...result } = await app._sdf.refitBVH( newPositions, newNormals );

	app.stages.pathTracer.updateTriangleData( app._sdf.triangles, triRanges );
	app.stages.pathTracer.updateBVHData( app._sdf.bvh, bvhRanges );
	app.reset( false, { motion: true } );

	return result;

}

export function refitBLASes( app, affectedMeshIndices, newPositions, newNormals ) {

	if ( app._sdf?.spilled ) throw new Error( 'refitBLASes: the scene is spilled to disk — await app.ensureSceneResident() first' );
	const result = app._sdf.refitBLASes( affectedMeshIndices, newPositions, newNormals );

	const { triRanges, bvhRanges } = app._sdf.computeBLASDirtyRanges( affectedMeshIndices );
	app.stages.pathTracer.updateBufferRanges( triRanges, bvhRanges );
	app.reset( false, { motion: true } );

	// Kick off background rebuild for optimal SAH quality
	app._sdf.scheduleBackgroundRebuild( affectedMeshIndices, ( meshIndex ) => {

		// Swap complete — upload just that mesh's triangles and nodes, plus the TLAS. A whole
		// re-upload here is gigabytes on a large scene, for one mesh's worth of change.
		const dirty = app._sdf.computeBLASDirtyRanges( [ meshIndex ] );
		app.stages.pathTracer.updateBufferRanges( dirty.triRanges, dirty.bvhRanges );
		app.reset( false, { motion: true } );

	} );

	return result;

}

export function updateMeshTransforms( app, meshIndices ) {

	// A spilled scene's matrix lists, TLAS or copy records are on disk: the move lands once they are back.
	if ( app._sdf?.needsPageInForMove( meshIndices ) ) {

		app._sdf.ensureMovable( meshIndices )
			.then( () => app.updateMeshTransforms( meshIndices ) )
			.catch( error => app._issues.warn( ISSUE_CODES.STORAGE_READ_FAILED, `reading instance matrices back failed: ${error.message}` ) );
		return null;

	}

	app._notePlacementsMoving( meshIndices );
	const result = app._sdf.updateMeshTransforms( meshIndices );

	app.stages.pathTracer.updateBufferRanges( [], app._sdf.takeMoveRanges() );
	app.reset( false, { motion: true } );
	scheduleRespill( app );

	return result;

}

export function getMaterialProperty( app, materialIndex, property ) {

	return app.stages.pathTracer?.materialData.getMaterialProperty( materialIndex, property );

}

export function getMaterialPropertySource( app, materialIndex, property ) {

	return app.stages.pathTracer?.materialData.getMaterialPropertySource( materialIndex, property );

}

export function setMaterialProperty( app, materialIndex, property, value ) {

	// These rewrite triangle records, which a spilled scene has to read back first.
	if ( app._sdf?.spilled && TRIANGLE_PATCH_PROPERTIES.has( property ) ) {

		app.ensureSceneResident().then( () => app.setMaterialProperty( materialIndex, property, value ) );
		return;

	}

	app.stages.pathTracer?.materialData.updateMaterialProperty( materialIndex, property, value );

	// Keep the emissive-NEE structure in sync unconditionally (not gated on the
	// sampling toggle) so edits made while NEE is off aren't lost on re-enable.
	const emissiveAffectingProps = [ 'emissive', 'emissiveIntensity' ];
	if ( emissiveAffectingProps.includes( property ) && app._sdf ) {

		app._uploadEmissivePayload( app._sdf.updateMaterialEmissive( materialIndex, property, value ) );

	}

	app.reset();

}

/**
 * Upload a rebuilt emissive-NEE payload (sorted emissive data + Light BVH +
 * bit-trail map) to the path tracer stage. No-op for a null payload.
 * @param {object|null} payload
 */
export function uploadEmissivePayload( app, payload ) {

	if ( ! payload || ! app.stages.pathTracer ) return;

	app.stages.pathTracer.setEmissiveTriangleData(
		payload.rawData, payload.emissiveCount, payload.totalPower, payload.bitTrailMap,
	);
	if ( payload.lightBVHNodeData ) {

		app.stages.pathTracer.setLightBVHData( payload.lightBVHNodeData, payload.lightBVHNodeCount );

	}

}

/**
 * Re-derive the emissive-NEE sampled set from current per-mesh world-visibility
 * (InstanceTable is the source of truth — patched by the stage's visibility API).
 * Hidden meshes' triangles are dropped from the Light BVH so they stop casting
 * NEE light; the shadow ray can't do it (a hidden mesh no longer self-occludes).
 */
export function refreshEmissiveForVisibility( app ) {

	const table = app._sdf?.instanceTable;
	if ( ! table ) return;

	// The emitter list names meshes, the table placements.
	const hidden = new Set();
	for ( let i = 0; i < table.count; i ++ ) {

		if ( table.isSet[ i ] && ! table.visible[ i ] ) hidden.add( table.sourceMesh[ i ] );

	}

	app._uploadEmissivePayload( app._sdf.rebuildEmissiveForVisibility( hidden ) );

}

export function setEmissiveTriangleSampling( app, enabled ) {

	app._emissiveSamplingUserSet = true;
	app.settings.set( 'enableEmissiveTriangleSampling', enabled );

}

export function hasEmissiveGeometry( app ) {

	return ( app._sdf?.emissiveTriangleBuilder?.emissiveTriangles?.length
		?? app._sdf?.emissiveTriangleCount ?? 0 ) > 0;

}

export function setMeshVisibility( app, meshIndex, visible ) {

	whenTLASEditable( app, () => app.stages.pathTracer?.updateMeshVisibility( meshIndex, visible ) );

}

export function updateAllMeshVisibility( app ) {

	whenTLASEditable( app, () => app.stages.pathTracer?.updateAllMeshVisibility() );

}

/** Applies a visibility edit, then resets — once a spilled TLAS is back in memory. @private */
function whenTLASEditable( app, edit ) {

	const apply = () => {

		edit();
		app._refreshEmissiveForVisibility();
		app.reset();
		scheduleRespill( app );

	};

	const ready = app._sdf?.whenTLASEditable();
	if ( ! ready ) return apply();
	ready.then( apply ).catch( error => app._issues.warn( ISSUE_CODES.STORAGE_READ_FAILED, `reading the TLAS back failed: ${error.message}` ) );

}

export function setMeshVisibilityByUuid( app, uuid, visible ) {

	const object = app.getScene()?.getObjectByProperty( 'uuid', uuid );
	if ( ! object ) return null;
	const next = typeof visible === 'function' ? !! visible( object.visible ) : !! visible;
	object.visible = next;
	app.updateAllMeshVisibility();
	return next;

}

export function setTextureTransform( app, materialIndex, textureName, transform ) {

	app.stages.pathTracer?.materialData.updateTextureTransform( materialIndex, textureName, transform );
	app.reset();

}

export async function setTextureColorSpace( app, texture, choice ) {

	if ( ! texture?.isTexture ) throw new Error( 'setTextureColorSpace wants a three.js texture' );

	const ud = texture.userData ?? ( texture.userData = {} );
	if ( ud.__rayzeeOriginalColorSpace === undefined ) ud.__rayzeeOriginalColorSpace = texture.colorSpace;
	const original = ud.__rayzeeOriginalColorSpace;

	delete ud.ocioColorSpace;
	delete ud.__rayzeeColorSpaceChoice;

	if ( choice === null || choice === undefined ) {

		texture.colorSpace = original;
		delete ud.__rayzeeOriginalColorSpace;

	} else if ( choice === 'srgb' || choice === 'linear' ) {

		texture.colorSpace = choice === 'srgb' ? SRGBColorSpace : LinearSRGBColorSpace;
		ud.__rayzeeColorSpaceChoice = choice;

	} else {

		if ( ! app.color?.hasConfig ) throw new Error( `"${choice}" needs a colour config loaded` );
		ud.ocioColorSpace = choice;
		texture.colorSpace = SRGBColorSpace;

	}

	texture.needsUpdate = true;
	if ( app.stages.pathTracer?.sdfs ) await app.rebuildMaterials();

}

export async function rebuildMaterials( app, scene ) {

	await app.ensureSceneResident();
	const stage = app.stages.pathTracer;
	await stage?.rebuildMaterials( scene || app.meshScene );

	// Loaded without texture coordinates, and a material has a texture now: they go up again from the records.
	if ( stage?.triangleStorageNode?.withoutUV && app._sdf?.triangles && usesTextureCoordinates( scene || app.meshScene ) ) {

		app._sdf.textureCoordinates = true;
		stage.setTriangleData( app._sdf.triangles, app._sdf.triangleCount, { textureCoordinates: true } );
		stage.setupMaterial();

	}

	app.reset();

}
