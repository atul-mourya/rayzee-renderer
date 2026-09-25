/**
 * Leomoon's CC0 IES Lights Pack
 * (https://leomoon.com/store/shaders/ies-lights-pack/). Files served from the
 * shared assets CDN under `iesprofiles/` — each entry has a `.ies` photometric
 * file and a matching polar-plot preview (`webp/<name>.webp`) used as the picker thumbnail.
 */

import { ASSETS_BASE_URL } from '@/Constants';

const BASE = `${ASSETS_BASE_URL}/iesprofiles/`;

const entry = ( name, label ) => ( {
	name,
	label,
	url: `${BASE}${name}.ies`,
	preview: `${BASE}webp/${name}.webp`,
} );

export const IES_LIBRARY = [
	// Beam-style
	entry( 'parallel-beam', 'Parallel Beam' ),
	entry( 'tight-focused', 'Tight Focused' ),
	entry( 'star-focused', 'Star Focused' ),
	entry( 'comet', 'Comet' ),
	entry( 'pear', 'Pear' ),
	entry( 'overhead', 'Overhead' ),

	// Cylinders / posts
	entry( 'cylinder-narrow', 'Cylinder — Narrow' ),
	entry( 'cylinder-wide', 'Cylinder — Wide' ),
	entry( 'top-post', 'Top Post' ),
	entry( 'bollard', 'Bollard' ),

	// Defined / diffuse
	entry( 'defined', 'Defined' ),
	entry( 'defined-spot', 'Defined — Spot' ),
	entry( 'defined-diffuse', 'Defined — Diffuse' ),
	entry( 'defined-diffuse-spot', 'Defined — Diffuse Spot' ),
	entry( 'display', 'Display' ),
	entry( 'soft-display', 'Soft Display' ),
	entry( 'round', 'Round' ),
	entry( 'area-light', 'Area Light' ),

	// Scatter
	entry( 'scatter-light', 'Scatter Light' ),
	entry( 'medium-scatter', 'Medium Scatter' ),

	// Decorative / shaped
	entry( 'umbrella', 'Umbrella' ),
	entry( 'three-lobe-umbrella', 'Three-Lobe Umbrella' ),
	entry( 'jelly-fish', 'Jellyfish' ),
	entry( 'star', 'Star' ),

	// Arrows / patterns
	entry( 'x-arrow', 'X-Arrow' ),
	entry( 'x-arrow-diffuse', 'X-Arrow — Diffuse' ),
	entry( 'x-arrow-soft', 'X-Arrow — Soft' ),
	entry( 'soft-arrow', 'Soft Arrow' ),
	entry( 'vee', 'Vee' ),
	entry( 'vee-up', 'Vee Up' ),
	entry( 'three-lobe-vee', 'Three-Lobe Vee' ),
	entry( 'trapezoid', 'Trapezoid' ),
];

export function getIESEntry( name ) {

	return IES_LIBRARY.find( e => e.name === name ) || null;

}
