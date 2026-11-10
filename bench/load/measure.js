/**
 * One timed model load, with no Node API so a browser page can share it. It ends at the first frame finished on the GPU:
 * kernels compile in the background.
 */

function instrument( target, method, marks, key ) {

	if ( typeof target?.[ method ] !== 'function' ) return () => {};

	const own = Object.prototype.hasOwnProperty.call( target, method );
	const original = target[ method ];
	target[ method ] = function ( ...args ) {

		const start = performance.now();
		marks[ `${key}Start` ] ??= start;
		const done = () => {

			marks[ `${key}End` ] = performance.now();
			marks[ key ] = ( marks[ key ] ?? 0 ) + marks[ `${key}End` ] - start;

		};

		const out = original.apply( this, args );
		if ( typeof out?.then === 'function' ) return out.finally( done );
		done();
		return out;

	};

	return () => {

		if ( own ) target[ method ] = original;
		else delete target[ method ];

	};

}

const finite = ( value ) => ( Number.isFinite( value ) ? value : undefined );

/**
 * @param {Object} app - a PathTracerApp, opened headless
 * @param {{ id: string, file: string, options?: Object }} model - `options` go to `loadFile` (an archive's `element`, …)
 * @param {Object} runtime - openInput( model ), decodeBusy(), resetDecode(), startSampling(), stopSampling(), collect(),
 *   and optionally settle(), which waits out the load's storage writes and says whether there were any
 * @returns {Promise<Object>} `{ phases, counts, memory, issues, error? }`, times in ms and sizes in bytes
 */
export async function measureLoad( app, model, runtime ) {

	const input = await runtime.openInput( model );
	const issuesBefore = app.issues.length;
	const marks = {};
	const archives = app.assetLoader?.archives;
	if ( archives ) archives.lastPBRTStats = null;

	runtime.collect();
	runtime.resetDecode();
	app.vram?.measure();
	app.vram?.resetPeak?.();
	runtime.startSampling();

	const restore = [
		instrument( app._sdf, 'buildBVH', marks, 'scene' ),
		instrument( app.stages.pathTracer, 'setupMaterial', marks, 'setup' ),
		instrument( app.stages.pathTracer, '_buildWavefrontKernels', marks, 'kernels' ),
	];

	let error = null;
	const t0 = performance.now();
	let t1 = t0;

	try {

		await app.loadFile( input, model.options ?? {} );
		t1 = performance.now();
		await app.renderFrames( 1, { reset: true } );
		await app.renderer.backend.device.queue.onSubmittedWorkDone();

	} catch ( caught ) {

		error = caught;

	} finally {

		for ( const undo of restore ) undo();

	}

	const t2 = performance.now();
	// Storage writes run on after the load; the unload below would abandon them.
	let stored = false;
	if ( ! error && runtime.settle ) {

		try {

			stored = await runtime.settle();

		} catch ( caught ) {

			error = caught;

		}

	}

	const t3 = performance.now();
	const sampled = runtime.stopSampling();

	const metrics = app._sdf?.performanceMetrics ?? {};
	const pbrt = app.assetLoader?.archives?.lastPBRTStats;
	const decoded = runtime.decodeBusy();
	const host = app.getHostMemoryInfo?.();
	const vram = app.getMemoryInfo?.();
	const stage = app.stages.pathTracer;

	const result = {
		phases: error ? {} : {
			ready: t2 - t0,
			load: t1 - t0,
			parse: finite( marks.sceneStart - t0 ),
			pbrtParse: finite( pbrt?.parseMs ),
			pbrtBuild: finite( pbrt?.buildMs ),
			decode: decoded.calls > 0 ? decoded.ms : undefined,
			scene: finite( metrics.totalProcessingTime ),
			extraction: finite( metrics.geometryExtractionTime ),
			blas: finite( metrics.blasBuildTime ),
			tlas: finite( metrics.tlasBuildTime ),
			assemble: finite( metrics.bvhAssembleTime ),
			textures: finite( metrics.textureCreationTime ),
			upload: finite( marks.setupStart - marks.sceneEnd ),
			kernels: finite( marks.kernels ),
			finish: finite( t1 - marks.setupEnd ),
			firstFrame: t2 - t1,
			store: stored ? t3 - t2 : undefined,
		},
		counts: error ? {} : {
			triangles: stage?.triangleCount ?? null,
			meshes: app.sceneMeshes?.length ?? null,
			materials: stage?.materialData?.materialCount ?? null,
			images: decoded.calls,
		},
		memory: {
			hostPeakLiveBytes: host?.peakLiveBytes ?? null,
			hostAllocatedBytes: host?.allocatedBytes ?? null,
			preflightBytes: host?.preflight?.estimate?.total ?? null,
			vramPeakBytes: vram?.peak ?? null,
			...sampled,
		},
		issues: app.issues.slice( issuesBefore ).map( ( { code, severity, message } ) => ( { code, severity, message } ) ),
	};

	if ( error ) result.error = String( error?.stack ?? error );

	try {

		app.unloadScene();

	} catch ( unloadError ) {

		result.error ??= `unload failed: ${unloadError?.message ?? unloadError}`;

	}

	runtime.collect();
	return result;

}
