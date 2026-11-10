import { create } from 'zustand';
import { checkKey, GeminiError } from '@/services/geminiApi';
import { runEdit, MAX_REFERENCES } from '@/lib/aiEdit';
import { addAIVersion, deleteAIVersion, getAIVersionFile } from '@/lib/database';
import { useStore } from './ui.js';

const KEY_STORAGE = 'gemini_api_key';
const REFERENCE_TYPES = [ 'image/png', 'image/jpeg', 'image/webp' ];

function readKey() {

	try {

		return localStorage.getItem( KEY_STORAGE ) ?? '';

	} catch {

		return '';

	}

}

function writeKey( key ) {

	try {

		if ( key ) localStorage.setItem( KEY_STORAGE, key );
		else localStorage.removeItem( KEY_STORAGE );

	} catch {

		// No storage in this window: the key lasts until the page closes.

	}

}

/** The number the next AI version of `render` gets. */
export const nextVersionOf = render => render?.aiNext ?? ( render?.aiVersions ?? [] ).reduce( ( m, v ) => Math.max( m, v.n ), 0 ) + 1;

/** The picture an edit starts from: the render as shown, Adjust edits included, or one of its versions. */
async function baseFor( render, from ) {

	if ( from !== 'render' ) {

		const file = await getAIVersionFile( render.id, from );
		if ( ! file ) throw new Error( `Version ${from} is no longer there` );
		return createImageBitmap( file );

	}

	const viewport = useStore.getState().resultsViewportRef?.current;
	if ( viewport?.getLoadedId?.() === render.id ) return createImageBitmap( viewport.getEditedCanvas() );
	return createImageBitmap( await ( await fetch( render.image ) ).blob() );

}

const without = ( map, id ) => {

	const next = { ...map };
	delete next[ id ];
	return next;

};

let referenceCount = 0;

/**
 * The Results page's AI edits: the panel's choices, the edits in flight (one per render, kept when the panel or the
 * page closes) and what each render shows.
 */
export const useAIStore = create( ( set, get ) => ( {

	key: readKey(),
	// The key form: null, or { pending: the render whose Generate waits on it, checking, error }.
	connect: null,

	prompt: '',
	scope: 'only',
	where: 'whole',
	size: '2K',
	references: [],
	areas: {},
	// The picture each render shows, which is also what its next edit starts from: 'render' or a version number.
	shown: {},
	compare: 'slider',
	split: 0.5,
	jobs: {},
	notices: {},

	setPrompt: prompt => set( { prompt } ),
	setScope: scope => set( { scope } ),
	setWhere: where => set( { where } ),
	setSize: size => set( { size } ),
	setCompare: compare => set( { compare } ),
	setSplit: split => set( { split: Math.min( 1, Math.max( 0, split ) ) } ),
	setArea: ( id, area ) => set( s => ( { areas: area ? { ...s.areas, [ id ]: area } : without( s.areas, id ) } ) ),
	show: ( id, which ) => set( s => ( { shown: { ...s.shown, [ id ]: which } } ) ),
	dismissNotice: id => set( s => ( { notices: without( s.notices, id ) } ) ),

	addReferences: files => set( s => {

		const added = [ ...files ].filter( f => REFERENCE_TYPES.includes( f.type ) ).slice( 0, MAX_REFERENCES - s.references.length )
			.map( blob => ( { id: ++ referenceCount, name: blob.name ?? 'image', blob, url: URL.createObjectURL( blob ) } ) );
		return { references: [ ...s.references, ...added ] };

	} ),

	removeReference: id => set( s => {

		const gone = s.references.find( r => r.id === id );
		if ( gone ) URL.revokeObjectURL( gone.url );
		return { references: s.references.filter( r => r.id !== id ) };

	} ),

	openConnect: ( pending = null ) => set( { connect: { pending } } ),
	closeConnect: () => set( { connect: null } ),

	saveKey: async ( key ) => {

		const value = key.trim();
		if ( ! value ) return;
		const pending = get().connect?.pending ?? null;
		set( { connect: { pending, checking: true } } );

		try {

			await checkKey( value );

		} catch ( error ) {

			set( { connect: { pending, error: error instanceof GeminiError ? error.kind : 'other' } } );
			return;

		}

		writeKey( value );
		set( s => ( { key: value, connect: null, notices: Object.fromEntries( Object.entries( s.notices ).filter( ( [ , n ] ) => n?.kind !== 'key' ) ) } ) );
		if ( pending ) get().generate( pending );

	},

	removeKey: () => {

		writeKey( '' );
		set( { key: '' } );

	},

	generate: async ( render ) => {

		const s = get();
		const area = s.where === 'part' ? s.areas[ render?.id ] : null;
		if ( ! render || s.jobs[ render.id ] || ! s.prompt.trim() || ( s.where === 'part' && ! area ) ) return;
		if ( ! s.key ) {

			set( { connect: { pending: render } } );
			return;

		}

		const id = render.id;
		const from = s.shown[ id ] ?? 'render';
		const prompt = s.prompt.trim();
		const job = { n: nextVersionOf( render ), startedAt: Date.now(), prompt, part: !! area, controller: new AbortController() };
		set( st => ( { jobs: { ...st.jobs, [ id ]: job }, notices: without( st.notices, id ) } ) );

		let base = null;
		try {

			base = await baseFor( render, from );
			const result = await runEdit( {
				base, prompt, area, scope: s.scope, size: s.size, key: s.key, signal: job.controller.signal,
				references: s.references.map( r => r.blob ),
			} );
			const n = await addAIVersion( id, {
				blob: result.blob, prompt, scope: s.scope, part: !! area, from, size: s.size, width: result.width, height: result.height,
				seconds: Math.round( ( Date.now() - job.startedAt ) / 1000 ), note: result.text,
			} );
			set( st => ( { shown: { ...st.shown, [ id ]: n } } ) );
			window.dispatchEvent( new Event( 'render-saved' ) );

		} catch ( error ) {

			const kind = error instanceof GeminiError ? error.kind : 'other';
			if ( kind !== 'aborted' ) {

				const notice = { kind, message: error.message, text: error.text ?? '', retryAt: error.retryAfter ? Date.now() + error.retryAfter * 1000 : null };
				set( st => ( { notices: { ...st.notices, [ id ]: notice } } ) );

			}

		} finally {

			base?.close();
			set( st => ( { jobs: without( st.jobs, id ) } ) );

		}

	},

	cancel: id => get().jobs[ id ]?.controller.abort(),

	deleteVersion: async ( render, n ) => {

		await deleteAIVersion( render.id, n );
		const back = which => which === n ? 'render' : which;
		set( s => ( { shown: { ...s.shown, [ render.id ]: back( s.shown[ render.id ] ) } } ) );
		window.dispatchEvent( new Event( 'render-saved' ) );

	},

} ) );
