/**
 * AMD's MaterialX Library (https://matlib.gpuopen.com, MIT): MaterialX documents with their textures, read from the
 * copy on the asset host (`npm run materialx:mirror`), since AMD's servers answer only their own site.
 */

import { ASSETS_BASE_URL } from '@/Constants';
import { listSource } from '@/lib/catalog';
import { applyMaterialFile, SEVERAL_MATERIALS } from '@/lib/materialDrop';

export const MATERIALX_LIBRARY_URL = `${ASSETS_BASE_URL}/MaterialXLibrary`;

/** The catalogue's materials as CatalogBrowser items, their files resolved against `base`. */
export function libraryItems( catalog, base = MATERIALX_LIBRARY_URL ) {

	return ( catalog?.materials ?? [] ).map( ( m ) => ( {
		id: m.id,
		name: m.name,
		preview: m.preview ? `${base}/${m.preview}` : null,
		categories: [ m.category ],
		tags: m.tags ?? [],
		redirection: m.page,
		packages: Object.fromEntries( Object.entries( m.packages ?? {} ).map( ( [ size, p ] ) => [ size, { url: `${base}/${p.path}`, bytes: p.bytes } ] ) ),
		source: 'materialx',
	} ) );

}

/** The package at `size`, else the largest below it, else the smallest there is. */
export function packageFor( item, size ) {

	const sizes = Object.keys( item.packages ).sort( ( a, b ) => parseInt( a ) - parseInt( b ) );
	const chosen = sizes.filter( ( s ) => parseInt( s ) <= parseInt( size ) ).at( - 1 ) ?? sizes[ 0 ];
	return chosen ? { size: chosen, ...item.packages[ chosen ] } : null;

}

let sizes = [];

export const MaterialXMaterials = listSource( {
	NAME: 'AMD MaterialX',
	CATALOG: 'materialx-materials',
	CATEGORY_CATALOG: 'materialx-categories',
	noun: 'materials',
	load: async () => {

		const response = await fetch( `${MATERIALX_LIBRARY_URL}/catalog.json` );
		if ( ! response.ok ) throw new Error( `MaterialX library: ${response.status}` );
		const catalog = await response.json();
		sizes = catalog.sizes ?? [];
		return libraryItems( catalog );

	},
} );

/** The size menu: only when the copy holds more than one size. */
export const sizeMenu = ( list ) => ( list.length > 1 ? list.map( ( s ) => ( { value: s, label: s.toUpperCase() } ) ) : undefined );

Object.defineProperty( MaterialXMaterials, 'VARIANTS', { get: () => sizeMenu( sizes ) } );

/**
 * Downloads `item` at `size` (or the nearest there is) and puts its first material on `mesh` and every part sharing
 * its material. Resolves to the materials applied; throws when the part has several materials (before downloading),
 * the download fails or the file holds no MaterialX material.
 */
export async function applyLibraryMaterial( item, size, mesh ) {

	if ( Array.isArray( mesh?.material ) ) throw new Error( SEVERAL_MATERIALS );
	const pkg = packageFor( item, size );
	if ( ! pkg ) throw new Error( `${item.name} has no files` );
	const response = await fetch( pkg.url );
	if ( ! response.ok ) throw new Error( `${item.name}: ${response.status}` );
	const file = new File( [ await response.blob() ], `${item.name}.zip`, { type: 'application/zip' } );
	const materials = await applyMaterialFile( file, mesh );
	if ( ! materials ) throw new Error( `${item.name} holds no MaterialX material` );
	return materials;

}
