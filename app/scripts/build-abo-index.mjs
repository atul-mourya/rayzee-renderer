/**
 * Build app/public/abo-index.json, the Models tab's list of the Amazon Berkeley Objects models: the dataset is a
 * static bucket with no search API, and its own listings are 84 MB. Joins the model metadata (ids, triangles,
 * textures) with the product listings (names, types, photos) and each file's size.
 *
 *   npm run abo:index
 */

import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUCKET = 'https://amazon-berkeley-objects.s3.amazonaws.com';
const OUT = fileURLToPath( new URL( '../public/abo-index.json', import.meta.url ) );
const MIN_CATEGORY = 15;

// Product type → category; anything else goes to Other.
const TYPE_CATEGORY = {
	CHAIR: 'Chairs', BEAN_BAG_CHAIR: 'Chairs', SOFA: 'Sofas', RUG: 'Rugs', WALL_ART: 'Wall art', PICTURE_FRAME: 'Wall art',
	TABLE: 'Tables', DESK: 'Desks', LAMP: 'Lamps', LIGHT_FIXTURE: 'Ceiling lights', HOME_LIGHTING_AND_LAMPS: 'Lamps',
	STOOL_SEATING: 'Stools', OTTOMAN: 'Ottomans', BENCH: 'Benches', PILLOW: 'Cushions', HEADBOARD: 'Headboards',
	BED: 'Beds', BED_FRAME: 'Beds', MATTRESS: 'Beds', PLANTER: 'Planters', CABINET: 'Cabinets', DRESSER: 'Dressers',
	HOME_MIRROR: 'Mirrors', SHELF: 'Shelves', STORAGE_RACK: 'Shelves', CLOTHES_RACK: 'Shelves', VASE: 'Vases',
	STORAGE_BOX: 'Storage', STORAGE_DRAWER: 'Storage', CURTAIN: 'Curtains', FURNITURE_COVER: 'Furniture covers',
	ELECTRIC_FAN: 'Fans', FREESTANDING_SHELTER: 'Outdoor', OUTDOOR_LIVING: 'Outdoor',
};

// Types that say nothing ("HOME") are sorted by the English name, first match wins.
const VAGUE_TYPES = new Set( [ 'HOME', 'HOME_FURNITURE_AND_DECOR', 'FURNITURE', 'HOME_BED_AND_BATH' ] );
const NAME_CATEGORY = [
	[ /\blamps?\b/, 'Lamps' ], [ /\brugs?\b|\brunner\b/, 'Rugs' ], [ /\bmirrors?\b/, 'Mirrors' ],
	[ /\bpillows?\b|\bcushions?\b/, 'Cushions' ], [ /\bwall art\b|\bprints?\b|\bcanvas\b|\bposter\b/, 'Wall art' ],
	[ /\bottomans?\b|\bpouf\b/, 'Ottomans' ], [ /\bstools?\b/, 'Stools' ], [ /\bbench\b/, 'Benches' ],
	[ /\btables?\b/, 'Tables' ], [ /\bdesks?\b/, 'Desks' ], [ /\bchairs?\b/, 'Chairs' ], [ /\bsofas?\b|\bcouch\b/, 'Sofas' ],
	[ /\bheadboards?\b/, 'Headboards' ], [ /\bbeds?\b/, 'Beds' ], [ /\bshel(f|ves)\b|\bbookcase\b/, 'Shelves' ],
	[ /\bcabinets?\b|\bsideboard\b/, 'Cabinets' ], [ /\bdressers?\b/, 'Dressers' ], [ /\bvases?\b/, 'Vases' ],
	[ /\bplanters?\b/, 'Planters' ],
];

// "Amazon Brand – Rivet …" → "Rivet …"
const BRAND_PREFIX = /^(an )?(amazon brand|marque amazon|marca amazon|marchio amazon|amazon marke|amazon merk)\s*[-–—:]\s*|^amazon ?basics\s*[-–—:]?\s*/i;

const englishFirst = tag => tag === 'en_US' ? 0 : tag.startsWith( 'en_' ) ? 1 : 2;

async function lines( path ) {

	const response = await fetch( `${BUCKET}/${path}` );
	if ( ! response.ok ) throw new Error( `${path}: HTTP ${response.status}` );
	return createInterface( { input: Readable.fromWeb( response.body ).pipe( createGunzip() ), crlfDelay: Infinity } );

}

const models = new Map();
let header;
for await ( const line of await lines( '3dmodels/metadata/3dmodels.csv.gz' ) ) {

	const cells = line.split( ',' );
	if ( ! header ) {

		header = cells;
		continue;

	}

	const row = Object.fromEntries( header.map( ( key, i ) => [ key, cells[ i ] ] ) );
	models.set( row[ '3dmodel_id' ], { row, name: null, rank: 3, type: '', image: '' } );

}

console.log( `${models.size} models` );

for await ( const line of await lines( 'listings/listings.json.gz' ) ) {

	const listing = JSON.parse( line );
	const model = models.get( listing[ '3dmodel_id' ] );
	if ( ! model ) continue;
	for ( const { language_tag: tag, value } of listing.item_name ?? [] ) {

		if ( englishFirst( tag ) < model.rank ) {

			model.rank = englishFirst( tag );
			model.name = value;

		}

	}

	model.type ||= listing.product_type?.[ 0 ]?.value ?? '';
	model.image ||= listing.main_image_id ?? '';

}

async function fileSize( id ) {

	for ( let attempt = 0; attempt < 3; attempt ++ ) {

		const response = await fetch( `${BUCKET}/3dmodels/original/${id.at( - 1 )}/${id}.glb`, { method: 'HEAD' } ).catch( () => null );
		if ( response?.ok ) return Number( response.headers.get( 'content-length' ) );

	}

	throw new Error( `${id}: no size` );

}

const ids = [ ...models.keys() ];
let next = 0;
await Promise.all( Array.from( { length: 32 }, async () => {

	while ( next < ids.length ) {

		const id = ids[ next ++ ];
		models.get( id ).bytes = await fileSize( id );

	}

} ) );

const entries = [ ...models ].map( ( [ id, { row, name, type, image, bytes } ] ) => {

	const english = ( name ?? '' ).toLowerCase();
	let category = TYPE_CATEGORY[ type ] ?? 'Other';
	if ( VAGUE_TYPES.has( type ) ) category = NAME_CATEGORY.find( ( [ re ] ) => re.test( english ) )?.[ 1 ] ?? 'Home decor';
	return {
		id, category, image, bytes,
		name: ( name ?? id ).replace( BRAND_PREFIX, '' ).trim(),
		triangles: Number( row.faces ),
		texture: Number( row.image_width_max ) || 0,
	};

} );

const counts = new Map();
for ( const e of entries ) counts.set( e.category, ( counts.get( e.category ) ?? 0 ) + 1 );
for ( const e of entries ) if ( counts.get( e.category ) < MIN_CATEGORY ) e.category = 'Other';
counts.clear();
for ( const e of entries ) counts.set( e.category, ( counts.get( e.category ) ?? 0 ) + 1 );

const categories = [ ...counts.keys() ].sort( ( a, b ) => ( a === 'Other' ) - ( b === 'Other' ) || counts.get( b ) - counts.get( a ) );
const order = new Map( categories.map( ( c, i ) => [ c, i ] ) );
entries.sort( ( a, b ) => order.get( a.category ) - order.get( b.category ) || a.name.localeCompare( b.name ) );

const index = {
	source: `${BUCKET}/index.html`,
	license: 'CC BY 4.0, credit Amazon.com',
	columns: [ 'id', 'category', 'name', 'image', 'triangles', 'texture', 'bytes' ],
	categories,
	items: entries.map( e => [ e.id, order.get( e.category ), e.name, e.image, e.triangles, e.texture, e.bytes ] ),
};

const json = JSON.stringify( index );
writeFileSync( OUT, json );
console.log( categories.map( c => `${c} ${counts.get( c )}` ).join( ', ' ) );
console.log( `${OUT}: ${entries.length} models, ${( json.length / 1024 ).toFixed( 0 )} KB` );
