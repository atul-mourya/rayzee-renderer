import { Color } from 'three';

/**
 * Materials the Physically Based database lacks, in its format, from pbrt-v4's measured tables as the pbrt importer reads
 * them: a translucent medium as the colour the classical dipole gives it (IOR 1.33) and its diffuse mean free path
 * 1 / σtr in centimetres, an optical glass as its IOR at the d line and its Abbe number. A medium's roughness is a
 * starting finish, not measured. tests/unit/app/measuredMaterials.test.js holds them to the importer.
 */

const JENSEN = 'Jensen et al. 2001, "A Practical Model for Subsurface Light Transport"';
const NARASIMHAN = 'Narasimhan et al. 2006, "Acquiring Scattering Properties of Participating Media by Dilution"';
const PBRT_MEDIA = 'https://github.com/mmp/pbrt-v4/blob/master/src/pbrt/media.cpp';
const PBRT_SPECTRA = 'https://github.com/mmp/pbrt-v4/blob/master/src/pbrt/util/spectrum.cpp';

// A ball in the colour, for the catalogue's thumbnail; a clear one is drawn as a ring.
function swatch( color, clear = false ) {

	const hex = `#${new Color().setRGB( ...color ).getHexString()}`;
	const ball = clear
		? `<circle cx='50' cy='50' r='38' fill='${hex}' fill-opacity='0.15' stroke='${hex}' stroke-width='3'/>`
		: `<circle cx='50' cy='50' r='38' fill='${hex}'/>`;
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><radialGradient id='s' cx='38%' cy='32%' r='70%'>`
		+ `<stop offset='0' stop-color='#fff' stop-opacity='0.6'/><stop offset='0.4' stop-color='#fff' stop-opacity='0'/>`
		+ `<stop offset='1' stop-color='#000' stop-opacity='0.55'/></radialGradient></defs>`
		+ `<rect width='100' height='100' fill='#3a3a3a'/>${ball}<circle cx='50' cy='50' r='38' fill='url(#s)'/></svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent( svg )}`;

}

const medium = ( name, pbrt, category, color, subsurfaceRadius, roughness, source, tags ) => ( {
	name, pbrt, color, metalness: 0, roughness, ior: 1.33, subsurfaceRadius,
	category: [ category ], tags, description: `Measured by ${source}; pbrt's "${pbrt}" medium.`,
	sources: [ PBRT_MEDIA ], reference: [], preview: swatch( color ),
} );

const glass = ( name, pbrt, ior, abbe, tags ) => ( {
	name, pbrt, color: [ 1, 1, 1 ], metalness: 0, roughness: 0, ior, transmission: 1, transmissionDispersion: abbe,
	category: [ 'Crystal' ], tags, description: `Schott's catalogue glass, from refractiveindex.info; pbrt's "${pbrt}" table.`,
	sources: [ PBRT_SPECTRA ], reference: [], preview: swatch( [ 0.7, 0.8, 0.95 ], true ),
} );

export const MEASURED_MATERIALS = [
	medium( 'Apple', 'Apple', 'Organic', [ 0.840524, 0.83461, 0.518204 ], [ 0.69611, 0.64002, 0.18959 ], 0.3, JENSEN, [ 'fruit' ] ),
	medium( 'Potato', 'Potato', 'Organic', [ 0.756403, 0.602629, 0.210099 ], [ 1.4266, 0.72276, 0.20362 ], 0.5, JENSEN, [ 'vegetable' ] ),
	medium( 'Raw chicken', 'Chicken1', 'Organic', [ 0.308265, 0.154467, 0.125596 ], [ 1.1605, 0.38838, 0.17544 ], 0.35, JENSEN, [ 'meat' ] ),
	medium( 'Cream', 'Cream', 'Liquid', [ 0.97465, 0.895908, 0.71596 ], [ 1.5028, 0.4664, 0.25414 ], 0, JENSEN, [ 'dairy' ] ),
	medium( 'Whole milk', 'Wholemilk', 'Liquid', [ 0.903871, 0.876089, 0.751289 ], [ 1.0899, 0.65754, 0.25084 ], 0, JENSEN, [ 'dairy', 'milk' ] ),
	medium( 'Low-fat milk', 'Lowfat Milk', 'Liquid', [ 0.765322, 0.748977, 0.730252 ], [ 1.1383, 0.6177, 0.33758 ], 0, NARASIMHAN, [ 'dairy', 'milk' ] ),
	medium( 'Reduced-fat milk', 'Reduced Milk', 'Liquid', [ 0.856866, 0.825193, 0.777818 ], [ 0.724, 0.45343, 0.23986 ], 0, NARASIMHAN, [ 'dairy', 'milk' ] ),
	medium( 'Regular milk', 'Regular Milk', 'Liquid', [ 0.914382, 0.873005, 0.778902 ], [ 0.69101, 0.35243, 0.15287 ], 0, NARASIMHAN, [ 'dairy', 'milk' ] ),
	medium( 'Low-fat soy milk', 'Lowfat Soy Milk', 'Liquid', [ 0.72652, 0.533625, 0.38402 ], [ 2.7474, 1.1519, 0.37701 ], 0, NARASIMHAN, [ 'milk' ] ),
	medium( 'Soy milk', 'Regular Soy Milk', 'Liquid', [ 0.764936, 0.601398, 0.423834 ], [ 1.7109, 0.68181, 0.18258 ], 0, NARASIMHAN, [ 'milk' ] ),
	medium( 'Low-fat chocolate milk', 'Lowfat Chocolate Milk', 'Liquid', [ 0.558003, 0.425496, 0.262708 ], [ 0.66233, 0.32157, 0.12995 ], 0, NARASIMHAN, [ 'dairy', 'milk' ] ),
	medium( 'Chocolate milk', 'Regular Chocolate Milk', 'Liquid', [ 0.682619, 0.538794, 0.410175 ], [ 0.47493, 0.18864, 0.086537 ], 0, NARASIMHAN, [ 'dairy', 'milk' ] ),
	medium( 'Espresso', 'Espresso', 'Liquid', [ 0.0130719, 0.0111845, 0.0100908 ], [ 0.011216, 0.0082655, 0.0061764 ], 0, NARASIMHAN, [ 'coffee' ] ),
	medium( 'Mint mocha coffee', 'Mint Mocha Coffee', 'Liquid', [ 0.00733669, 0.00581087, 0.00540747 ], [ 0.014703, 0.0096027, 0.0071658 ], 0, NARASIMHAN, [ 'coffee' ] ),
	medium( 'Cola', 'Coke', 'Liquid', [ 0.0000787827, 0.0000449446, 0 ], [ 0.57629, 0.34976, 0.23393 ], 0, NARASIMHAN, [ 'soda', 'soft drink' ] ),
	medium( 'Lemon-lime soda', 'Sprite', 'Liquid', [ 0.000283191, 0.000310259, 0.000289702 ], [ 30.564, 31.48, 28.784 ], 0, NARASIMHAN, [ 'soda', 'soft drink' ] ),
	medium( 'Sports drink', 'Gatorade', 'Liquid', [ 0.00865929, 0.0134989, 0.0347556 ], [ 2.2211, 2.784, 5.4565 ], 0, NARASIMHAN, [ 'soft drink' ] ),
	medium( 'White wine', 'Chardonnay', 'Liquid', [ 0.000147736, 0.000102808, 0.0000443882 ], [ 5.3503, 4.8673, 2.4053 ], 0, NARASIMHAN, [ 'wine', 'chardonnay' ] ),
	medium( 'Rosé wine', 'White Zinfandel', 'Liquid', [ 0.000128423, 0.00010438, 0.0000575058 ], [ 4.7791, 3.5653, 2.9086 ], 0, NARASIMHAN, [ 'wine', 'white zinfandel' ] ),
	medium( 'Red wine', 'Merlot', 'Liquid', [ 0.0000160936, 0, 0 ], [ 0.4963, 0.22919, 0.19615 ], 0, NARASIMHAN, [ 'wine', 'merlot' ] ),
	medium( 'Lager', 'Budweiser Beer', 'Liquid', [ 0.000187729, 0.0000856314, 0.000016197 ], [ 5.0186, 2.3165, 0.99903 ], 0, NARASIMHAN, [ 'beer' ] ),
	medium( 'Light beer', 'Coors Light Beer', 'Liquid', [ 0.000731166, 0.000272399, 0 ], [ 9.328, 4.1223, 1.6504 ], 0, NARASIMHAN, [ 'beer' ] ),
	medium( 'Apple juice', 'Apple Juice', 'Liquid', [ 0.000929528, 0.000590487, 0.000385198 ], [ 4.4327, 2.4238, 1.104 ], 0, NARASIMHAN, [ 'juice' ] ),
	medium( 'Cranberry juice', 'Cranberry Juice', 'Liquid', [ 0.000233617, 0.000109494, 0.000055711 ], [ 1.4621, 0.61237, 0.46448 ], 0, NARASIMHAN, [ 'juice' ] ),
	medium( 'Grape juice', 'Grape Juice', 'Liquid', [ 0.0000458304, 0, 0 ], [ 0.55479, 0.24098, 0.19688 ], 0, NARASIMHAN, [ 'juice' ] ),
	medium( 'Pink grapefruit juice', 'Ruby Grapefruit Juice', 'Liquid', [ 0.0111441, 0.00524339, 0.00384792 ], [ 0.63304, 0.30625, 0.22371 ], 0, NARASIMHAN, [ 'juice' ] ),
	medium( 'White grapefruit juice', 'White Grapefruit Juice', 'Liquid', [ 0.378726, 0.341665, 0.237352 ], [ 0.99894, 0.82701, 0.39086 ], 0, NARASIMHAN, [ 'juice' ] ),
	medium( 'Shampoo', 'Shampoo', 'Liquid', [ 0.00447599, 0.00160616, 0.00129187 ], [ 3.9924, 1.2522, 0.92872 ], 0, NARASIMHAN, [ 'soap' ] ),
	medium( 'Strawberry shampoo', 'Strawberry Shampoo', 'Liquid', [ 0.000956876, 0.000243689, 0.0000177378 ], [ 3.9631, 0.99475, 0.76137 ], 0, NARASIMHAN, [ 'soap' ] ),
	medium( 'Bleach', 'Clorox', 'Liquid', [ 0.0560521, 0.0180776, 0.0131504 ], [ 13.138, 3.5235, 2.0457 ], 0, NARASIMHAN, [ 'cleaning' ] ),
	medium( 'Sea water', 'Pacific Ocean Surface Water', 'Liquid', [ 0.000490439, 0.000906609, 0.000576052 ], [ 1.808, 1.8338, 1.9089 ], 0, NARASIMHAN, [ 'ocean', 'water' ] ),
	glass( 'Optical glass BK7', 'glass-BK7', 1.5168, 63.99, [ 'crown', 'borosilicate' ] ),
	glass( 'Optical glass BAF10', 'glass-BAF10', 1.67, 47.04, [ 'barium', 'flint' ] ),
	glass( 'Optical glass FK51A', 'glass-FK51A', 1.48656, 84.91, [ 'fluorite', 'crown' ] ),
	glass( 'Optical glass LASF9', 'glass-LASF9', 1.85027, 32.21, [ 'lanthanum', 'flint' ] ),
	glass( 'Optical glass SF5', 'glass-F5', 1.67272, 32.29, [ 'dense flint', 'crystal' ] ),
	glass( 'Optical glass SF10', 'glass-F10', 1.72828, 28.47, [ 'dense flint' ] ),
	glass( 'Optical glass SF11', 'glass-F11', 1.78474, 25.71, [ 'dense flint' ] ),
];
