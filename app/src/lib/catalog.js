export const PAGE_SIZE = 24;

/** An item's identity in a catalog: its id, else its name (names repeat on Sketchfab). */
export const itemKey = item => item.id || item.name;

/**
 * The page after `cursor`: null for the first, else the page before's `nextCursor`, opaque to callers.
 * `pinned` keys come first; pass the same ones for every page of a listing.
 */
export function pageAfter( list, cursor, pinned = [] ) {

	if ( pinned.length > 0 ) {

		const first = new Set( pinned );
		const isPinned = item => first.has( itemKey( item ) );
		list = [ ...list.filter( isPinned ), ...list.filter( item => ! isPinned( item ) ) ];

	}

	const start = cursor ? Number( cursor ) : 0;
	const end = start + PAGE_SIZE;
	return { items: list.slice( start, end ), nextCursor: end < list.length ? String( end ) : null };

}

const wordsIn = text => String( text ).normalize( 'NFD' ).replace( /\p{M}/gu, '' ).toLowerCase()
	.split( /[^\p{L}\p{N}]+/u ).filter( Boolean );

const ENDINGS = [ 's', 'es', 'y', 'en', 'ed', 'ing' ];

// One word, give or take an ending: bricks, skies, snowy, sunny, wooden, painted, tiled.
function sameWord( a, b ) {

	if ( a.length > b.length ) [ a, b ] = [ b, a ];
	if ( a === b || ( a.endsWith( 'y' ) && b === a.slice( 0, - 1 ) + 'ies' ) ) return true;
	if ( a.length < 3 || ! b.startsWith( a ) ) return false;
	const ending = b.slice( a.length );
	return ENDINGS.includes( ending ) || ( ending === 'd' && a.endsWith( 'e' ) ) || ending === a.at( - 1 ) + 'y';

}

// Optimal string alignment distance; anything past `max` reads max + 1.
function editDistance( a, b, max ) {

	if ( Math.abs( a.length - b.length ) > max ) return max + 1;
	let before = null;
	let previous = Array.from( { length: b.length + 1 }, ( _, j ) => j );
	for ( let i = 1; i <= a.length; i ++ ) {

		const row = [ i ];
		for ( let j = 1; j <= b.length; j ++ ) {

			let d = Math.min( previous[ j ] + 1, row[ j - 1 ] + 1, previous[ j - 1 ] + ( a[ i - 1 ] === b[ j - 1 ] ? 0 : 1 ) );
			if ( before && j > 1 && a[ i - 1 ] === b[ j - 2 ] && a[ i - 2 ] === b[ j - 1 ] ) d = Math.min( d, before[ j - 2 ] + 1 );
			row.push( d );

		}

		if ( Math.min( ...row ) > max ) return max + 1;
		before = previous;
		previous = row;

	}

	return previous[ b.length ];

}

// 3 a whole word, 2 a word's start, 1 inside a word, 0.5 a near miss (only when `nearMisses`).
function wordMatch( query, word, nearMisses ) {

	if ( sameWord( query, word ) ) return 3;
	if ( word.startsWith( query ) ) return 2;
	if ( query.length >= 3 && word.includes( query ) ) return 1;
	if ( ! nearMisses || query.length < 4 ) return 0;
	const max = query.length >= 8 ? 2 : 1;
	return editDistance( query, word, max ) <= max ? 0.5 : 0;

}

/** Items made searchable: `fieldsOf( item )` gives [ text or texts, weight ] pairs, the name first (4, tags 2, the rest 1). */
export function searchEntries( items, fieldsOf ) {

	return items.map( item => ( {
		item,
		fields: fieldsOf( item ).map( ( [ value, weight ] ) => {

			const words = [ value ].flat().flatMap( text => text ? wordsIn( text ) : [] );
			return { words, weight, text: words.join( ' ' ) };

		} ),
	} ) );

}

function scoreOf( { fields }, queryWords, phrase, nearMisses ) {

	let total = 0;
	for ( const query of queryWords ) {

		// Each field adds its best match: a word in the name and the category beats one in the name alone.
		let sum = 0;
		for ( const { words, weight } of fields ) {

			let best = 0;
			for ( const word of words ) best = Math.max( best, wordMatch( query, word, nearMisses ) );
			sum += best * weight;

		}

		if ( sum === 0 ) return 0;
		total += sum;

	}

	return phrase && fields[ 0 ].text.includes( phrase ) ? total + 4 : total;

}

/**
 * The items holding every word of the query, best first, then shorter names (closer to the query);
 * equals keep their order. Near misses (a typo or two) count only when nothing matches outright.
 */
export function rankSearch( entries, query ) {

	const queryWords = wordsIn( query );
	if ( queryWords.length === 0 ) return entries.map( entry => entry.item );
	const phrase = queryWords.length > 1 ? queryWords.join( ' ' ) : null;

	let scored = [];
	for ( const nearMisses of [ false, true ] ) {

		scored = entries
			.map( ( entry, order ) => ( { item: entry.item, score: scoreOf( entry, queryWords, phrase, nearMisses ), length: entry.fields[ 0 ].words.length, order } ) )
			.filter( match => match.score > 0 );
		if ( scored.length > 0 ) break;

	}

	return scored.sort( ( a, b ) => b.score - a.score || a.length - b.length || a.order - b.order ).map( match => match.item );

}

/**
 * A catalog source (CatalogBrowser's contract) over a list that arrives whole: `load()` runs once and
 * resolves items carrying `categories`; categories, search and pages are worked out here.
 */
export function listSource( { load, noun, ...fields } ) {

	let entries = null;
	const loadEntries = () => entries ??= Promise.resolve()
		.then( load )
		.then( items => searchEntries( items, item => [[ item.name, 4 ], [ item.tags ?? [], 2 ], [ item.categories, 1 ]] ) )
		.catch( error => {

			entries = null;
			throw error;

		} );

	return {
		...fields,

		/** Every category, largest first, each with its first item's preview and the next ones' should it not load. */
		async getCategories() {

			const found = new Map();
			for ( const { item } of await loadEntries() ) {

				for ( const name of item.categories ) {

					const category = found.get( name ) ?? found.set( name, { count: 0, previews: [] } ).get( name );
					category.count ++;
					if ( item.preview && category.previews.length < 4 ) category.previews.push( item.preview );

				}

			}

			return [ ...found ]
				.sort( ( a, b ) => b[ 1 ].count - a[ 1 ].count )
				.map( ( [ name, { count, previews } ] ) => ( {
					id: name,
					slug: name,
					name: name.charAt( 0 ).toUpperCase() + name.slice( 1 ),
					label: `${count} ${noun}`,
					preview: previews[ 0 ] ?? null,
					fallbackPreviews: previews.slice( 1 ),
					tags: [],
				} ) );

		},

		/** Items in a category (null: every one) matching the query (rankSearch), a page at a time. */
		async search( { query = '', category = null, cursor = null, pinned } = {} ) {

			const inCategory = ( await loadEntries() ).filter( ( { item } ) => category === null || item.categories.includes( category ) );
			return pageAfter( rankSearch( inCategory, query ), cursor, pinned );

		},
	};

}
