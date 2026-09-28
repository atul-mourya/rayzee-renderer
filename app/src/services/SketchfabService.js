/**
 * Service class for the Sketchfab Data + Download API (v3).
 *
 * Search is public (a token, if present, only raises rate limits). Downloading
 * requires a token — set VITE_SKETCHFAB_TOKEN in the repo-root .env. The download
 * endpoint returns short-lived signed URLs, so callers must fetch immediately.
 */
export class SketchfabService {

	static API_BASE = 'https://api.sketchfab.com/v3';
	static VIEWER_BASE = 'https://sketchfab.com/models';

	/** @returns {string|null} the configured API token, or null. */
	static getToken() {

		return import.meta.env.VITE_SKETCHFAB_TOKEN || null;

	}

	static _authHeaders() {

		const token = this.getToken();
		return token ? { Authorization: `Token ${token}` } : {};

	}

	/** Pick the thumbnail nearest ~448px wide (good for a 2-col grid card). */
	static _pickThumb( thumbnails ) {

		const images = thumbnails?.images;
		if ( ! Array.isArray( images ) || images.length === 0 ) return null;
		const TARGET = 448;
		let best = images[ 0 ];
		let bestDist = Math.abs( ( best.width || 0 ) - TARGET );
		for ( const img of images ) {

			const dist = Math.abs( ( img.width || 0 ) - TARGET );
			if ( dist < bestDist ) {

				best = img;
				bestDist = dist;

			}

		}

		return best?.url || null;

	}

	/** Map a raw Sketchfab search result to the shape ItemsCatalog expects. */
	static _mapResult( m ) {

		return {
			id: m.uid,
			uid: m.uid,
			name: m.name || 'Untitled',
			preview: this._pickThumb( m.thumbnails ),
			label: m.user?.displayName || m.user?.username || '',
			tags: m.license?.slug ? [ m.license.slug ] : [],
			redirection: m.viewerUrl || `${this.VIEWER_BASE}/${m.uid}`,
			isDownloadable: !! m.isDownloadable,
			license: m.license || null,
		};

	}

	/**
	 * Fetch the list of model categories (the primary browse listing).
	 * @returns {Promise<Array<{id:string, slug:string, name:string, preview:string|null}>>}
	 */
	static async getCategories() {

		try {

			const response = await fetch( `${this.API_BASE}/categories`, { headers: this._authHeaders() } );
			if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );

			const json = await response.json();
			return ( json.results || [] ).map( c => ( {
				id: c.slug,
				slug: c.slug,
				name: c.name,
				// Smallest ready-made category thumbnail (512x288); fall back to any.
				preview: c.thumbnails?.[ 0 ]?.url || c.thumbnails?.[ 1 ]?.url || null,
				tags: [ c.slug ],
			} ) );

		} catch ( error ) {

			console.error( 'Sketchfab categories fetch failed:', error );
			throw new Error( `Failed to fetch Sketchfab categories: ${error.message}` );

		}

	}

	/**
	 * Search downloadable models.
	 * @param {Object} opts
	 * @param {string} opts.query - Full-text query.
	 * @param {string} [opts.category] - Category slug to filter by.
	 * @param {string} [opts.cursor] - Cursor from a prior response for pagination.
	 * @returns {Promise<{items: Array, nextCursor: string|null}>}
	 */
	static async search( { query = '', category = null, cursor = null } = {} ) {

		try {

			const params = new URLSearchParams( {
				type: 'models',
				downloadable: 'true',
				archives_flavours: 'false',
				count: '24',
			} );
			if ( query ) params.set( 'q', query );
			if ( category ) params.set( 'categories', category );
			if ( cursor ) params.set( 'cursor', cursor );

			const response = await fetch( `${this.API_BASE}/search?${params.toString()}`, {
				headers: this._authHeaders(),
			} );
			if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );

			const json = await response.json();
			const items = ( json.results || [] ).map( m => this._mapResult( m ) );
			return { items, nextCursor: json.cursors?.next ?? null };

		} catch ( error ) {

			console.error( 'Sketchfab search failed:', error );
			throw new Error( `Failed to search Sketchfab: ${error.message}` );

		}

	}

	/**
	 * Request download URLs for a model. Requires a token.
	 * @param {string} uid
	 * @returns {Promise<{gltf?:Object, glb?:Object, usdz?:Object, source?:Object}>}
	 */
	static async getDownload( uid ) {

		if ( ! this.getToken() ) {

			const err = new Error( 'A Sketchfab API token is required to download models.' );
			err.code = 'SKETCHFAB_NO_TOKEN';
			throw err;

		}

		try {

			const response = await fetch( `${this.API_BASE}/models/${uid}/download`, {
				headers: this._authHeaders(),
			} );
			if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );
			return await response.json();

		} catch ( error ) {

			if ( error.code === 'SKETCHFAB_NO_TOKEN' ) throw error;
			console.error( 'Sketchfab download request failed:', error );
			throw new Error( `Failed to get Sketchfab download: ${error.message}` );

		}

	}

	/**
	 * Choose a loadable URL from a download response: the GLB when there is one, else the glTF
	 * archive (.zip). The links are signed and expire, so callers key caches by model uid.
	 * @param {Object} download - result of getDownload()
	 * @returns {{url: string, format: 'glb'|'zip'} | {url: null}}
	 */
	static pickDownloadUrl( download ) {

		if ( download?.glb?.url ) return { url: download.glb.url, format: 'glb' };
		if ( download?.gltf?.url ) return { url: download.gltf.url, format: 'zip' };
		return { url: null };

	}

}
