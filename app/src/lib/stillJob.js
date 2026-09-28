import { EngineEvents } from 'rayzee';
import { APP_AREAS } from '@/lib/storage';
import { captureSession } from '@/lib/session';
import { restorePanels } from '@/lib/panelState';
import { useStore, usePathTracerStore } from '@/store';

/** When a running final render is written to disk. Mutable so a test can shorten it. */
export const STILL_CHECKPOINT_TIMING = { firstAfterMs: 120_000, everyMs: 120_000, checkEveryMs: 15_000 };

const JOB = 'job.json';
const FILES = {
	color: [ 'color.f32', Float32Array ],
	normalDepth: [ 'normalDepth.f32', Float32Array ],
	albedo: [ 'albedo.f32', Float32Array ],
	m2: [ 'm2.f32', Float32Array ],
	streak: [ 'streak.u32', Uint32Array ],
	frozenMask: [ 'frozen.u32', Uint32Array ],
};

const jobsArea = storage => storage?.area( APP_AREAS.JOBS ) ?? null;
const entryKey = ( id, slot ) => `still:${id}:${slot}`;
const newId = () => crypto.randomUUID?.() ?? `${Date.now().toString( 36 )}${Math.random().toString( 36 ).slice( 2 )}`;

/** The newest still-render checkpoint on disk: `{ key, job }`, or null. */
export async function unfinishedStill( storage ) {

	const area = jobsArea( storage );
	if ( ! area ) return null;
	const metas = ( await area.list() ).filter( m => m.extra?.kind === 'still' ).sort( ( a, b ) => b.extra.savedAt - a.extra.savedAt );
	for ( const meta of metas ) {

		const entry = await area.open( meta.key );
		const job = await entry?.json( JOB );
		entry?.release();
		if ( job?.session ) return { key: meta.key, job };

	}

	return null;

}

/** Reads a checkpoint's pixels and buffers back into what `app.restoreRenderCheckpoint` takes. */
export async function readStillCheckpoint( storage, key ) {

	const entry = await jobsArea( storage )?.open( key, { wait: true } );
	if ( ! entry ) return null;

	try {

		const job = await entry.json( JOB );
		const checkpoint = { ...job.checkpoint };
		for ( const [ field, [ name, Type ]] of Object.entries( FILES ) ) {

			const file = entry.meta.files[ name ] !== undefined ? await entry.file( name ) : null;
			checkpoint[ field ] = file ? new Type( await file.arrayBuffer() ) : null;

		}

		return { job, checkpoint };

	} finally {

		entry.release();

	}

}

export async function discardStill( storage, id ) {

	const area = jobsArea( storage );
	if ( ! area || ! id ) return;
	await area.remove( entryKey( id, 0 ) );
	await area.remove( entryKey( id, 1 ) );

}

/**
 * Writes a running final render to disk every couple of minutes, so a reload or a crash can carry
 * on from its last checkpoint instead of sample zero. The newest checkpoint is kept and the one
 * before it deleted once the new one is in; a new render, a finished one or leaving Final Render
 * drops them.
 */
export class StillCheckpointer {

	constructor( app ) {

		this.app = app;
		this.id = null;
		this._slot = 0;
		this._startedAt = 0;
		this._lastAt = 0;
		this._busy = false;
		this._off = [];

	}

	start() {

		const app = this.app;
		const onReset = e => {

			if ( e.restored ) return;
			this._drop();
			this.id = useStore.getState().appMode === 'final-render' ? newId() : null;
			this._startedAt = this._lastAt = performance.now();

		};

		const onComplete = () => this._drop();
		app.addEventListener( EngineEvents.RENDER_RESET, onReset );
		app.addEventListener( EngineEvents.RENDER_COMPLETE, onComplete );
		this._off.push( () => app.removeEventListener( EngineEvents.RENDER_RESET, onReset ), () => app.removeEventListener( EngineEvents.RENDER_COMPLETE, onComplete ) );

		this._off.push( useStore.subscribe( ( state, prev ) => {

			if ( state.appMode !== prev.appMode && state.appMode !== 'final-render' ) this._drop();

		} ) );

		const timer = setInterval( () => this.tick(), STILL_CHECKPOINT_TIMING.checkEveryMs );
		this._off.push( () => clearInterval( timer ) );

	}

	/** Continues a restored render's checkpoints under its own id. */
	adopt( id, slot = 0 ) {

		this.id = id;
		this._slot = slot;
		this._startedAt = this._lastAt = performance.now();

	}

	async tick() {

		const now = performance.now();
		if ( this._busy || ! this.id || useStore.getState().appMode !== 'final-render' ) return;
		if ( this.app.stages.pathTracer?.isComplete ) return;
		if ( now - this._startedAt < STILL_CHECKPOINT_TIMING.firstAfterMs || now - this._lastAt < STILL_CHECKPOINT_TIMING.everyMs ) return;
		await this.checkpoint();

	}

	async checkpoint() {

		const app = this.app;
		const area = jobsArea( app.storage );
		if ( ! area || ! this.id || this._busy ) return false;
		this._busy = true;
		const id = this.id;

		try {

			const checkpoint = await app.captureRenderCheckpoint();
			if ( ! checkpoint || this.id !== id ) return false;
			const { record } = await captureSession( app );

			const { color, normalDepth, albedo, m2, streak, frozenMask, ...rest } = checkpoint;
			const arrays = { color, normalDepth, albedo, m2, streak, frozenMask };
			const bytes = Object.values( arrays ).reduce( ( n, a ) => n + ( a?.byteLength ?? 0 ), 0 );
			const slot = this._slot ^ 1;
			const job = {
				kind: 'still', id, title: record.title, samples: checkpoint.samples, target: app.settings.get( 'maxSamples' ),
				width: checkpoint.width, height: checkpoint.height, savedAt: Date.now(),
				checkpoint: rest, settings: app.settings.serialize(), session: record,
			};

			const writer = await area.create( entryKey( id, slot ), {
				label: `Final render · ${record.title} · ${checkpoint.samples} samples`, expectedBytes: bytes,
				extra: { kind: 'still', id, savedAt: job.savedAt, samples: checkpoint.samples },
			} );
			if ( ! writer ) return false;

			try {

				for ( const [ field, [ name ]] of Object.entries( FILES ) ) {

					if ( arrays[ field ] ) await writer.write( name, arrays[ field ], { transfer: true } );

				}

				await writer.writeJSON( JOB, job );
				await writer.commit();

			} catch ( error ) {

				await writer.abort();
				throw error;

			}

			if ( this.id !== id ) {

				await area.remove( entryKey( id, slot ) );
				return false;

			}

			await area.remove( entryKey( id, this._slot ) );
			this._slot = slot;
			this._lastAt = performance.now();
			return true;

		} catch ( error ) {

			console.warn( 'Final render checkpoint not written:', error );
			return false;

		} finally {

			this._busy = false;

		}

	}

	_drop() {

		const id = this.id;
		this.id = null;
		if ( id ) discardStill( this.app.storage, id );

	}

	dispose() {

		for ( const off of this._off.splice( 0 ) ) off();

	}

}

let activeCheckpointer = null;

export function startStillCheckpointer( app ) {

	activeCheckpointer?.dispose();
	activeCheckpointer = new StillCheckpointer( app );
	activeCheckpointer.start();
	return activeCheckpointer;

}

export function getStillCheckpointer() {

	return activeCheckpointer;

}

const nextFrame = () => new Promise( resolve => requestAnimationFrame( resolve ) );

/**
 * Enters Final Render with a restored session's scene and continues the checkpointed render from
 * where it stopped. Call after the session itself is restored.
 * @returns {Promise<number>} the samples it continues from
 */
export async function resumeStill( app, { key, job } ) {

	const { checkpoint } = await readStillCheckpoint( app.storage, key );

	usePathTracerStore.getState().handleModeChange( 'final-render' );
	useStore.getState().setAppMode( 'final-render' );
	// The mode's preset replaced what was changed in Final Render itself.
	app.settings.restore( job.settings );
	restorePanels( job.session.panels );

	// One frame at the final size, so every target exists and the camera is current.
	for ( let i = 0; i < 120 && ! ( app.stages.pathTracer.frameCount > 0 ); i ++ ) await nextFrame();
	app.stopAnimation();

	app.restoreRenderCheckpoint( checkpoint );
	activeCheckpointer?.adopt( job.id, Number( key.split( ':' ).pop() ) || 0 );
	app.wake();
	return checkpoint.samples;

}
