import { create } from 'zustand';
import { updateRender } from '@/lib/database';
import { DEFAULT_EDITS, hasEdits, normaliseEdits, pasteEdits, readEdits, sameEdits } from '@/lib/edits';

const SAVE_DELAY = 300;
// A run of changes to one control this close together is one undo step: a slider drag.
const MERGE_MS = 600;
const HISTORY = 100;

const pending = new Map();
let saveTimer = null;
let last = { key: null, at: 0 };

async function saveNow() {

	clearTimeout( saveTimer );
	saveTimer = null;
	const jobs = [ ...pending ];
	pending.clear();
	for ( const [ id, edits ] of jobs ) {

		try {

			// `colorCorrection` too: an older build reads only that.
			await updateRender( id, { edits, colorCorrection: edits.adjust, isEdited: hasEdits( edits ) } );

		} catch ( error ) {

			console.warn( `The edits of render ${id} could not be saved:`, error );

		}

	}

}

function save( id, edits ) {

	pending.set( id, edits );
	clearTimeout( saveTimer );
	saveTimer = setTimeout( saveNow, SAVE_DELAY );

}

const emptyHistory = { past: [], future: [] };

/**
 * The Results page's edits: the open render's stack and picture size, the undo history and edits of every render
 * touched this session (the library's records are read once), the crop being edited and the copied edits. Every
 * change saves to its render 300 ms after the last.
 */
export const useEditStore = create( ( set, get ) => {

	// Makes `next` the open render's edits, one undo step unless it continues the last change under `key`.
	const commit = ( next, key = null ) => {

		const { renderId, edits, history } = get();
		if ( renderId == null || sameEdits( next, edits ) ) return;
		const now = performance.now();
		const h = history[ renderId ] ?? emptyHistory;
		const merge = key !== null && key === last.key && now - last.at < MERGE_MS && h.past.length > 0;
		last = { key, at: now };
		const settled = normaliseEdits( next );
		set( s => ( {
			edits: settled,
			byRender: { ...s.byRender, [ renderId ]: settled },
			history: { ...s.history, [ renderId ]: { past: merge ? h.past : [ ...h.past, edits ].slice( - HISTORY ), future: [] } },
		} ) );
		save( renderId, settled );

	};

	const step = from => {

		const { renderId, edits, history, cropping } = get();
		const h = history[ renderId ];
		if ( ! h?.[ from ].length ) return;
		if ( cropping ) set( { cropping: null } );
		const target = h[ from ].at( from === 'past' ? - 1 : 0 );
		const rest = from === 'past' ? h.past.slice( 0, - 1 ) : h.future.slice( 1 );
		const moved = from === 'past' ? [ edits, ...h.future ] : [ ...h.past, edits ];
		last = { key: null, at: 0 };
		set( s => ( {
			edits: target,
			byRender: { ...s.byRender, [ renderId ]: target },
			history: { ...s.history, [ renderId ]: from === 'past' ? { past: rest, future: moved } : { past: moved, future: rest } },
		} ) );
		save( renderId, target );

	};

	return {
		renderId: null,
		picture: null,
		edits: normaliseEdits(),
		byRender: {},
		history: {},
		// While the crop is edited: { before: the edits when it began, past: the undo steps then }.
		cropping: null,
		copied: null,

		/** Shows `render`'s edits: this session's if it has any, else its record's. */
		open: render => {

			if ( get().cropping ) get().finishCrop();
			last = { key: null, at: 0 };
			set( s => ( {
				renderId: render?.id ?? null,
				picture: null,
				edits: render ? s.byRender[ render.id ] ?? readEdits( render ) : normaliseEdits(),
			} ) );

		},

		/** The open render's picture size, once its picture has loaded. */
		setPicture: picture => set( { picture } ),

		/** One section changed: `change( 'adjust', { brightness: 10 } )`. A slider drag is one undo step. */
		change: ( section, patch, key = `${section}:${Object.keys( patch ).join()}` ) => {

			const edits = get().edits;
			commit( { ...edits, [ section ]: { ...edits[ section ], ...patch } }, key );

		},

		setEffect: ( effect, patch, key = `effects.${effect}:${Object.keys( patch ).join()}` ) => {

			const edits = get().edits;
			commit( { ...edits, effects: { ...edits.effects, [ effect ]: { ...edits.effects[ effect ], ...patch } } }, key );

		},

		setGeometry: ( geometry, key = null ) => commit( { ...get().edits, geometry }, key ),

		/** The watermark's text and style; null removes it. */
		setOverlay: ( overlay, key = null ) => commit( { ...get().edits, overlay }, key ),

		/** Sections back to their defaults. */
		reset: sections => {

			const next = { ...get().edits };
			for ( const section of sections ) next[ section ] = DEFAULT_EDITS[ section ];
			commit( next );

		},

		undo: () => step( 'past' ),
		redo: () => step( 'future' ),

		startCrop: () => {

			const { cropping, edits, renderId, history } = get();
			if ( cropping || renderId == null ) return;
			set( { cropping: { before: edits, past: ( history[ renderId ] ?? emptyHistory ).past } } );

		},

		/** Keeps the crop: everything done since it began is one undo step. */
		finishCrop: () => {

			const { cropping, edits, renderId } = get();
			if ( ! cropping ) return;
			const changed = ! sameEdits( cropping.before, edits );
			set( s => ( {
				cropping: null,
				history: changed ? { ...s.history, [ renderId ]: { past: [ ...cropping.past, cropping.before ].slice( - HISTORY ), future: [] } } : s.history,
			} ) );

		},

		cancelCrop: () => {

			const { cropping, renderId } = get();
			if ( ! cropping ) return;
			set( s => ( {
				cropping: null,
				edits: cropping.before,
				byRender: { ...s.byRender, [ renderId ]: cropping.before },
				history: { ...s.history, [ renderId ]: { past: cropping.past, future: [] } },
			} ) );
			save( renderId, cropping.before );

		},

		copy: render => {

			const { renderId, edits, byRender } = get();
			set( { copied: render.id === renderId ? edits : byRender[ render.id ] ?? readEdits( render ) } );

		},

		/** The copied edits on `render`, its own geometry kept. */
		paste: render => {

			const { copied, renderId, byRender, history } = get();
			if ( ! copied ) return;
			if ( render.id === renderId ) {

				commit( pasteEdits( get().edits, copied ) );
				return;

			}

			const current = byRender[ render.id ] ?? readEdits( render );
			const next = normaliseEdits( pasteEdits( current, copied ) );
			const h = history[ render.id ] ?? emptyHistory;
			set( s => ( {
				byRender: { ...s.byRender, [ render.id ]: next },
				history: { ...s.history, [ render.id ]: { past: [ ...h.past, current ].slice( - HISTORY ), future: [] } },
			} ) );
			save( render.id, next );

		},

		/** Writes waiting changes now. */
		flush: saveNow,
	};

} );

export const canUndo = s => !! s.history[ s.renderId ]?.past.length;
export const canRedo = s => !! s.history[ s.renderId ]?.future.length;
