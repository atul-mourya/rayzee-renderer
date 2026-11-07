import { pageAfter, rankSearch, searchEntries } from '@/lib/catalog';

/**
 * Amazon Berkeley Objects (GLB, metres, Y up; CC BY 4.0, credit Amazon.com). The bucket has no search API, so browsing
 * and search run over abo-index.json (`npm run abo:index`). Each model comes as CodePawl's compressed copy or Amazon's
 * original file.
 */
export class AboService {

	static NAME = 'Amazon';
	static CATALOG = 'abo';
	static SOURCE_URL = 'https://amazon-berkeley-objects.s3.amazonaws.com/index.html';
	static MODEL_BASE = 'https://amazon-berkeley-objects.s3.amazonaws.com/3dmodels/original';
	static IMAGE_BASE = 'https://m.media-amazon.com/images/I';
	static INDEX_URL = `${import.meta.env.BASE_URL}abo-index.json`;
	static CODEPAWL_URL = 'https://huggingface.co/datasets/codepawl/abo-glb';
	static ALL = 'all';
	static VARIANTS = [ { value: 'compressed', label: 'Compressed' }, { value: 'original', label: 'Original' } ];
	static COMPRESSED_TEXTURE_PX = 2048;

	static _index = null;

	static modelUrl( id ) {

		return `${this.MODEL_BASE}/${id.at( - 1 )}/${id}.glb`;

	}

	static imageUrl( imageId ) {

		return imageId ? `${this.IMAGE_BASE}/${encodeURIComponent( imageId )}._AC_US256_.jpg` : null;

	}

	/** Index rows as catalog items, grouped by category; fetched once. */
	static loadIndex() {

		this._index ??= fetch( this.INDEX_URL )
			.then( response => {

				if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );
				return response.json();

			} )
			.then( json => this._parseIndex( json ) )
			.catch( error => {

				this._index = null;
				throw new Error( `Failed to load the Amazon model list: ${error.message}` );

			} );
		return this._index;

	}

	static _parseIndex( { categories, items, pack } ) {

		const models = items.map( ( [ id, category, name, image, triangles, bytes, packBytes, texturePx ] ) => ( {
			id,
			name,
			preview: this.imageUrl( image ),
			label: `${categories[ category ]} · ${formatCount( triangles )} triangles`,
			details: [
				[ 'Compressed', fileSummary( Math.min( texturePx, this.COMPRESSED_TEXTURE_PX ), packBytes ) ],
				[ 'Original', fileSummary( texturePx, bytes ) ],
			],
			tags: [],
			isDownloadable: true,
			categoryIndex: category,
		} ) );
		const entries = searchEntries( models, m => [[ m.name, 4 ], [ categories[ m.categoryIndex ], 1 ]] );
		return { categories, models, entries, pack };

	}

	/** Every category, "All models" first, each with its first model's photo. */
	static async getCategories() {

		const { categories, models } = await this.loadIndex();
		const counts = categories.map( () => 0 );
		const previews = categories.map( () => null );
		for ( const m of models ) {

			counts[ m.categoryIndex ] ++;
			previews[ m.categoryIndex ] ??= m.preview;

		}

		return [
			{ id: this.ALL, slug: this.ALL, name: 'All models', label: `${models.length} models`, preview: models[ 0 ]?.preview ?? null, tags: [] },
			...categories.map( ( name, i ) => ( { id: String( i ), slug: String( i ), name, label: `${counts[ i ]} models`, preview: previews[ i ], tags: [] } ) ),
		];

	}

	/**
	 * Models in a category matching the query by name or category (rankSearch), a page at a time.
	 * @param {{query?: string, category?: string, cursor?: string|null, pinned?: string[]}} opts
	 * @returns {Promise<{items: Array, nextCursor: string|null}>}
	 */
	static async search( { query = '', category = this.ALL, cursor = null, pinned } = {} ) {

		const { entries } = await this.loadIndex();
		const only = category === this.ALL || category === null ? null : Number( category );
		const inCategory = only === null ? entries : entries.filter( ( { item } ) => item.categoryIndex === only );
		return pageAfter( rankSearch( inCategory, query ), cursor, pinned );

	}

	static canDownload() {

		return true;

	}

	/** The model's GLB, compressed or original; the links are stable, so the download cache keys them by URL. */
	static async resolveDownload( item, { variant = 'compressed' } = {} ) {

		if ( variant === 'original' ) return { url: this.modelUrl( item.id ), format: 'glb' };
		const { pack } = await this.loadIndex();
		return { url: `${pack}/${item.id}/${item.id}.glb`, format: 'glb' };

	}

}

function formatCount( n ) {

	return n >= 1e6 ? `${( n / 1e6 ).toFixed( 1 )}M` : n >= 1e3 ? `${Math.round( n / 1e3 )}k` : String( n );

}

// "4K textures · 43.6 MB"; a model without textures gives its size alone.
function fileSummary( texturePx, bytes ) {

	if ( ! texturePx ) return formatBytes( bytes );
	const side = texturePx >= 1024 ? `${Math.round( texturePx / 1024 )}K` : `${texturePx} px`;
	return `${side} textures · ${formatBytes( bytes )}`;

}

function formatBytes( bytes ) {

	return bytes >= 1048576 ? `${( bytes / 1048576 ).toFixed( 1 )} MB` : `${Math.max( 1, Math.round( bytes / 1024 ) )} KB`;

}
