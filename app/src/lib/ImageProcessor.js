import { Data3DTexture, DataUtils, HalfFloatType, LinearFilter, LinearSRGBColorSpace, NearestFilter, NoBlending, NoToneMapping, RenderTarget, Texture, Vector2, Vector3, Vector4 } from 'three';
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu';
import {
	Fn, If, abs, clamp, dot, exp2, float, floor, fract, hash, ivec3, length, max, min, mix, screenUV, select, sign, smoothstep,
	step, texture, texture3DLoad, uint, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { LOOKS, LOOK_SIZE, adjustColor, lookColor, lookTable, normaliseEdits, outputSize, sourceTransform } from '@/lib/edits';

/** The saved light stands in for the picture only at its size: an upscaled save keeps it at the render's size. */
export const hdrShowsPicture = ( hdr, picture ) => !! hdr && !! picture && hdr.width === picture.width && hdr.height === picture.height;

const LUMA = vec3( 0.2126, 0.7152, 0.0722 );
// Clarity's base is the picture's luminance halved until its long edge is this small, then blurred.
const BASE_EDGE = 128;

// The canvas's extended sRGB encoding, for light handed over decoded. mix by step: a select on a vector condition
// followed its first channel before three r187.
const encodeExtended = v => {

	const a = v.abs();
	return mix( a.pow( vec3( 1 / 2.4 ) ).mul( 1.055 ).sub( 0.055 ), a.mul( 12.92 ), step( a, vec3( 0.0031308 ) ) ).mul( sign( v ) );

};

const quadOf = node => {

	const material = new MeshBasicNodeMaterial();
	material.blending = NoBlending;
	material.outputNode = node;
	return new QuadMesh( material );

};

const target = () => {

	const rt = new RenderTarget( 1, 1, { type: HalfFloatType, depthBuffer: false } );
	rt.texture.minFilter = rt.texture.magFilter = LinearFilter;
	rt.texture.generateMipmaps = false;
	return rt;

};

const placeholder = () => {

	const t = new Texture();
	t.minFilter = t.magFilter = LinearFilter;
	return t;

};

/**
 * The Results page's edit stack (`edits.js`) on the GPU: geometry, adjust and look in one pass, clarity's base
 * from it, then detail, effects and the overlay. One per renderer: the 8-bit picture's and the HDR one's run the same
 * nodes, so the two cannot drift apart. `draw()` is a `PictureView` finish.
 */
export class EditPipeline {

	constructor() {

		this._u = {
			map0: uniform( new Vector3( 1, 0, 0 ) ), map1: uniform( new Vector3( 0, 1, 0 ) ), light: uniform( 0 ),
			brightness: uniform( 0 ), contrast: uniform( 0 ), saturation: uniform( 0 ), hue: uniform( 0 ), exposure: uniform( 0 ), gamma: uniform( 2.2 ),
			lookAmount: uniform( 0 ), sharpen: uniform( 0 ), clarity: uniform( 0 ),
			// amount, inner edge, outer edge
			vignette: uniform( new Vector3( 0, 0.45, 0.925 ) ),
			// amount, cell in pixels
			grain: uniform( new Vector2( 0, 1 ) ),
			size: uniform( new Vector2( 1, 1 ) ), texel: uniform( new Vector2( 1, 1 ) ), baseTexel: uniform( new Vector2( 1, 1 ) ),
			overlayRect: uniform( new Vector4( 0, 0, 0, 0 ) ), overlayOpacity: uniform( 0 ),
		};

		this._edits = normaliseEdits();
		this._editing = false;
		this._lookId = null;
		this._overlayKey = null;
		this._source = texture( placeholder() );
		this._table = new Data3DTexture( new Uint16Array( LOOK_SIZE ** 3 * 4 ), LOOK_SIZE, LOOK_SIZE, LOOK_SIZE );
		this._table.type = HalfFloatType;
		this._table.minFilter = this._table.magFilter = NearestFilter;
		this._table.needsUpdate = true;
		this._overlay = texture( placeholder() );
		this._edited = target();
		this._editedNode = texture( this._edited.texture );
		this._levels = [];
		this._base = texture( this._edited.texture );

		this._stage = quadOf( this._stageNode() );
		this._final = quadOf( this._finalNode() );

	}

	_stageNode() {

		const u = this._u, source = this._source, table = this._table;

		const turnHue = Fn( ( [ rgb, degrees ] ) => {

			const scale = max( float( 1 ), max( rgb.x, max( rgb.y, rgb.z ) ) ).toVar();
			const c = rgb.div( scale ).toVar();
			const hi = max( c.x, max( c.y, c.z ) ).toVar();
			const lo = min( c.x, min( c.y, c.z ) ).toVar();
			const delta = hi.sub( lo ).toVar();
			const l = hi.add( lo ).mul( 0.5 ).toVar();
			const out = c.toVar();

			If( delta.greaterThan( 0 ), () => {

				const s = select( l.lessThan( 0.5 ), delta.div( hi.add( lo ) ), delta.div( float( 2 ).sub( hi ).sub( lo ) ) ).toVar();
				const h = float( 0 ).toVar();
				If( hi.equal( c.x ), () => {

					h.assign( c.y.sub( c.z ).div( delta ).add( select( c.y.lessThan( c.z ), float( 6 ), float( 0 ) ) ) );

				} ).ElseIf( hi.equal( c.y ), () => {

					h.assign( c.z.sub( c.x ).div( delta ).add( 2 ) );

				} ).Else( () => {

					h.assign( c.x.sub( c.y ).div( delta ).add( 4 ) );

				} );

				h.assign( fract( h.div( 6 ).add( degrees.div( 360 ) ) ) );
				const q = select( l.lessThan( 0.5 ), l.mul( s.add( 1 ) ), l.add( s ).sub( l.mul( s ) ) ).toVar();
				const p = l.mul( 2 ).sub( q ).toVar();
				const channel = at => {

					const t = fract( at );
					return select( t.lessThan( 1 / 6 ), p.add( q.sub( p ).mul( 6 ).mul( t ) ),
						select( t.lessThan( 0.5 ), q, select( t.lessThan( 2 / 3 ), p.add( q.sub( p ).mul( float( 2 / 3 ).sub( t ) ).mul( 6 ) ), p ) ) );

				};

				out.assign( vec3( channel( h.add( 1 / 3 ) ), channel( h ), channel( h.sub( 1 / 3 ) ) ) );

			} );

			return out.mul( scale );

		} );

		// The Adjust sliders (`adjustColor` is the CPU twin): sign kept below 0, so a colour outside the canvas's gamut is
		// carried through, and the defaults change nothing.
		const adjust = Fn( ( [ encoded ] ) => {

			const centred = encoded.add( u.brightness ).sub( 0.5 ).toVar();
			const steeper = centred.div( float( 1 ).sub( u.contrast ) );
			const flatter = centred.mul( u.contrast.add( 1 ) );
			const contrasted = select( u.contrast.greaterThan( 0 ), steeper, flatter ).add( 0.5 ).toVar();
			const linear = sign( contrasted ).mul( abs( contrasted ).pow( vec3( 2.2 ) ) ).toVar();
			const saturated = mix( vec3( dot( linear, LUMA ) ), linear, u.saturation.add( 1 ) ).toVar();
			If( abs( u.hue ).greaterThan( 0.01 ), () => {

				saturated.assign( turnHue( saturated, u.hue ) );

			} );
			const exposed = saturated.mul( exp2( u.exposure ) );
			return sign( exposed ).mul( abs( exposed ).pow( vec3( float( 1 ).div( u.gamma ) ) ) );

		} );

		// The look's table read as `lookColor` reads it: trilinear by hand, past white scaled down to it and back.
		const look = Fn( ( [ rgb ] ) => {

			const scale = max( float( 1 ), max( rgb.x, max( rgb.y, rgb.z ) ) ).toVar();
			const p = clamp( rgb.div( scale ), vec3( 0 ), vec3( 1 ) ).mul( LOOK_SIZE - 1 ).toVar();
			const i0 = clamp( ivec3( floor( p ) ), ivec3( 0 ), ivec3( LOOK_SIZE - 2 ) ).toVar();
			const f = p.sub( vec3( i0 ) ).toVar();
			const at = ( x, y, z ) => texture3DLoad( table, i0.add( ivec3( x, y, z ) ) ).rgb;
			const row = ( y, z ) => mix( at( 0, y, z ), at( 1, y, z ), f.x );
			const looked = mix( mix( row( 0, 0 ), row( 1, 0 ), f.y ), mix( row( 0, 1 ), row( 1, 1 ), f.y ), f.z );
			return mix( rgb, looked.mul( scale ), u.lookAmount );

		} );

		return Fn( () => {

			const uvw = vec3( screenUV, 1 );
			const at = vec2( dot( u.map0, uvw ), dot( u.map1, uvw ) ).toVar();
			const texel = source.sample( at ).toVar();
			const inside = step( 0, at.x ).mul( step( at.x, 1 ) ).mul( step( 0, at.y ) ).mul( step( at.y, 1 ) );
			const shown = select( u.light.greaterThan( 0.5 ), encodeExtended( texel.rgb ), texel.rgb );
			const rgb = adjust( shown ).toVar();
			If( u.lookAmount.greaterThan( 0 ), () => {

				rgb.assign( look( rgb ) );

			} );
			return vec4( rgb, texel.a.mul( inside ) );

		} )();

	}

	_finalNode() {

		const u = this._u, edited = this._editedNode, base = this._base, overlay = this._overlay;
		const tent = [[ - 1, 1 ], [ 0, 2 ], [ 1, 1 ]];

		return Fn( () => {

			const uv = screenUV;
			const centre = edited.sample( uv ).toVar();
			const c = centre.rgb.toVar();
			const a = centre.a.toVar();

			// Sharpen: luminance only, so edges gain no colour fringes.
			If( u.sharpen.greaterThan( 0 ), () => {

				let blur = float( 0 );
				for ( const [ dx, wx ] of tent ) for ( const [ dy, wy ] of tent ) {

					blur = blur.add( dot( edited.sample( uv.add( vec2( dx, dy ).mul( u.texel ) ) ).rgb, LUMA ).mul( wx * wy / 16 ) );

				}

				c.addAssign( clamp( dot( c, LUMA ).sub( blur ), - 0.25, 0.25 ).mul( u.sharpen.mul( 2 ) ) );

			} );

			// Clarity: mid-tones pushed from (or towards) their surroundings' luminance, hue kept.
			If( u.clarity.notEqual( 0 ), () => {

				let around = float( 0 );
				for ( const [ dx, wx ] of tent ) for ( const [ dy, wy ] of tent ) {

					around = around.add( base.sample( uv.add( vec2( dx, dy ).mul( u.baseTexel ) ) ).r.mul( wx * wy / 16 ) );

				}

				const l = dot( c, LUMA ).toVar();
				const lc = clamp( l, 0, 1 );
				const towards = l.add( u.clarity.mul( 0.8 ).mul( l.sub( around ) ).mul( lc.mul( lc.oneMinus() ).mul( 4 ) ) );
				If( l.greaterThan( 1e-4 ), () => {

					c.mulAssign( max( towards, 0 ).div( l ) );

				} );

			} );

			// Vignette: below 0 darkens the edges, above 0 lightens them up to white.
			If( u.vignette.x.notEqual( 0 ), () => {

				const mask = smoothstep( u.vignette.y, u.vignette.z, length( uv.sub( 0.5 ).mul( 2 ) ).div( Math.SQRT2 ) ).mul( u.vignette.x );
				c.assign( select( u.vignette.x.lessThan( 0 ), c.mul( mask.add( 1 ) ), c.add( max( vec3( 1 ).sub( c ), vec3( 0 ) ).mul( mask ) ) ) );

			} );

			// Grain: value noise on cells of whole pixels, strongest in the mid-tones; the same pixels every draw.
			If( u.grain.x.greaterThan( 0 ), () => {

				const p = floor( uv.mul( u.size ) ).add( 0.5 ).div( u.grain.y ).toVar();
				const i = floor( p ).toVar();
				const f = fract( p ).toVar();
				const s = f.mul( f ).mul( f.mul( - 2 ).add( 3 ) ).toVar();
				const at = ( x, y ) => hash( uint( i.x.add( x ) ).mul( 1973 ).add( uint( i.y.add( y ) ).mul( 9277 ) ).add( 26699 ) );
				const noise = mix( mix( at( 0, 0 ), at( 1, 0 ), s.x ), mix( at( 0, 1 ), at( 1, 1 ), s.x ), s.y ).sub( 0.5 ).mul( 2 );
				const l = clamp( dot( c, LUMA ), 0, 1 );
				c.addAssign( noise.mul( u.grain.x ).mul( 0.16 ).mul( l.mul( l.oneMinus() ).mul( 2.6 ).add( 0.35 ) ) );

			} );

			If( u.overlayRect.z.greaterThan( 0 ), () => {

				const local = uv.sub( u.overlayRect.xy ).div( u.overlayRect.zw ).toVar();
				const inside = step( 0, local.x ).mul( step( local.x, 1 ) ).mul( step( 0, local.y ) ).mul( step( local.y, 1 ) );
				const text = overlay.sample( local ).toVar();
				const alpha = text.a.mul( u.overlayOpacity ).mul( inside ).toVar();
				c.assign( mix( c, text.rgb, alpha ) );
				a.assign( a.add( alpha.mul( a.oneMinus() ) ) );

			} );

			return vec4( c.mul( a ), a );

		} )();

	}

	_level( i ) {

		if ( ! this._levels[ i ] ) {

			const from = texture( i === 0 ? this._edited.texture : this._levels[ i - 1 ].rt.texture );
			const scale = uniform( new Vector2( 1, 1 ) );
			const weights = i === 0 ? LUMA : vec3( 1, 0, 0 );
			// Each texel averages a 2×2 block: one bilinear tap on the block's middle corner.
			const node = vec4( dot( from.sample( screenUV.mul( scale ) ).rgb, weights ), 0, 0, 1 );
			this._levels[ i ] = { rt: target(), scale, quad: quadOf( node ) };

		}

		return this._levels[ i ];

	}

	/**
	 * The edits to draw. `editing`: the crop is being edited, so the whole turned frame shows. Null shows the picture
	 * with none.
	 */
	set( edits, { editing = false } = {} ) {

		const e = this._edits = normaliseEdits( edits );
		this._editing = editing;
		const u = this._u;
		u.brightness.value = e.adjust.brightness / 100;
		u.contrast.value = e.adjust.contrast / 100;
		u.saturation.value = e.adjust.saturation / 100;
		u.hue.value = e.adjust.hue;
		u.exposure.value = e.adjust.exposure / 100;
		u.gamma.value = e.adjust.gamma;

		const lookId = e.look.id && e.look.amount > 0 ? e.look.id : null;
		u.lookAmount.value = lookId ? e.look.amount : 0;
		if ( lookId && lookId !== this._lookId ) {

			const floats = lookTable( lookId );
			const halves = this._table.image.data;
			for ( let i = 0; i < floats.length; i ++ ) halves[ i ] = DataUtils.toHalfFloat( floats[ i ] );
			this._table.needsUpdate = true;
			this._lookId = lookId;

		}

		u.sharpen.value = e.detail.sharpen;
		u.clarity.value = e.detail.clarity;
		const v = e.effects.vignette;
		const inner = v.size * 0.9;
		u.vignette.value.set( v.amount, inner, inner + 0.05 + v.softness * 0.85 );
		u.grain.value.x = e.effects.grain.amount;

	}

	/**
	 * Draws `picture` (a `PictureView` finish's: { texture, width, height, light }) through the edits into `into`, or
	 * the renderer's canvas, sized to the edited picture.
	 * @returns {{width: number, height: number}} the edited picture's size
	 */
	draw( renderer, picture, into = null ) {

		const e = this._edits, u = this._u;
		const options = { editing: this._editing };
		const size = outputSize( e.geometry, picture.width, picture.height, options );
		const m = sourceTransform( e.geometry, picture.width, picture.height, options );
		u.map0.value.set( m[ 0 ], m[ 1 ], m[ 2 ] );
		u.map1.value.set( m[ 3 ], m[ 4 ], m[ 5 ] );
		u.light.value = picture.light ? 1 : 0;
		u.size.value.set( size.width, size.height );
		u.texel.value.set( 1 / size.width, 1 / size.height );
		u.grain.value.y = Math.max( 1, Math.max( size.width, size.height ) / 1500 ) * ( 0.75 + e.effects.grain.size * 2.25 );
		this._source.value = picture.texture;
		this._placeOverlay( e.overlay, size );

		const { toneMapping, outputColorSpace } = renderer;
		renderer.toneMapping = NoToneMapping;
		renderer.outputColorSpace = LinearSRGBColorSpace;
		try {

			this._edited.setSize( size.width, size.height );
			renderer.setRenderTarget( this._edited );
			this._stage.render( renderer );

			if ( e.detail.clarity !== 0 ) this._buildBase( renderer, size );

			if ( into ) {

				renderer.setRenderTarget( into );

			} else {

				const now = renderer.getSize( new Vector2() );
				if ( now.x !== size.width || now.y !== size.height ) renderer.setSize( size.width, size.height, false );
				renderer.setRenderTarget( null );

			}

			this._final.render( renderer );

		} finally {

			renderer.toneMapping = toneMapping;
			renderer.outputColorSpace = outputColorSpace;

		}

		return size;

	}

	_buildBase( renderer, size ) {

		let w = size.width, h = size.height, i = 0, level;
		do {

			const nw = Math.ceil( w / 2 ), nh = Math.ceil( h / 2 );
			level = this._level( i );
			level.rt.setSize( nw, nh );
			level.scale.value.set( 2 * nw / w, 2 * nh / h );
			renderer.setRenderTarget( level.rt );
			level.quad.render( renderer );
			w = nw;
			h = nh;
			i ++;

		} while ( Math.max( w, h ) > BASE_EDGE );

		this._base.value = level.rt.texture;
		this._u.baseTexel.value.set( 1 / w, 1 / h );

	}

	// The overlay's text, drawn once a size and wording, as a box in a corner of the edited picture.
	_placeOverlay( overlay, size ) {

		const u = this._u;
		const text = overlay?.text.trim() ?? '';
		if ( ! text || typeof OffscreenCanvas === 'undefined' ) {

			u.overlayRect.value.set( 0, 0, 0, 0 );
			return;

		}

		u.overlayOpacity.value = overlay.opacity;
		const key = `${text}|${overlay.size}|${overlay.corner}|${size.width}×${size.height}`;
		if ( key === this._overlayKey ) return;
		this._overlayKey = key;

		const short = Math.min( size.width, size.height );
		const family = typeof document !== 'undefined' ? getComputedStyle( document.body ).fontFamily : 'sans-serif';
		const canvas = new OffscreenCanvas( 1, 1 );
		const ctx = canvas.getContext( '2d' );
		let px = Math.max( 8, Math.round( short * ( 0.025 + overlay.size * 0.075 ) ) );
		ctx.font = `600 ${px}px ${family}`;
		const fit = size.width * 0.9 / Math.max( 1, ctx.measureText( text ).width );
		if ( fit < 1 ) px = Math.max( 8, Math.floor( px * fit ) );
		ctx.font = `600 ${px}px ${family}`;
		const pad = Math.ceil( px * 0.35 );
		canvas.width = Math.ceil( ctx.measureText( text ).width ) + pad * 2;
		canvas.height = Math.ceil( px * 1.3 ) + pad * 2;
		ctx.font = `600 ${px}px ${family}`;
		ctx.textBaseline = 'middle';
		ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
		ctx.shadowBlur = px * 0.15;
		ctx.fillStyle = 'white';
		ctx.fillText( text, pad, canvas.height / 2 );

		const margin = Math.round( short * 0.03 );
		const [ vertical, horizontal ] = overlay.corner.split( '-' );
		const x = horizontal === 'right' ? size.width - margin - canvas.width + pad : margin - pad;
		const y = vertical === 'bottom' ? size.height - margin - canvas.height + pad : margin - pad;
		u.overlayRect.value.set( x / size.width, y / size.height, canvas.width / size.width, canvas.height / size.height );

		const previous = this._overlay.value;
		const raster = new Texture( canvas );
		raster.flipY = false;
		raster.minFilter = raster.magFilter = LinearFilter;
		raster.generateMipmaps = false;
		raster.needsUpdate = true;
		this._overlay.value = raster;
		previous.dispose();

	}

	dispose() {

		this._edited.dispose();
		for ( const level of this._levels ) {

			level.rt.dispose();
			level.quad.material.dispose();

		}

		this._stage.material.dispose();
		this._final.material.dispose();
		this._table.dispose();
		this._overlay.value.dispose();
		this._levels = [];

	}

}

/**
 * Small pictures of the edited render through each look, for the Filters tab: `{ none, [id]: url }`. On the CPU, from
 * the 8-bit picture, with the geometry and Adjust edits but not the look in use.
 */
export function lookThumbnails( source, edits, edge = 160 ) {

	const e = normaliseEdits( edits );
	const W = source.width, H = source.height;
	const out = outputSize( e.geometry, W, H );
	const scale = edge / Math.max( out.width, out.height );
	const tw = Math.max( 1, Math.round( out.width * scale ) ), th = Math.max( 1, Math.round( out.height * scale ) );
	const m = sourceTransform( e.geometry, W, H );

	// Thumbnail pixel → source pixel, inverted for the canvas, which maps source to thumbnail.
	const a = W * m[ 0 ] / tw, b = W * m[ 1 ] / th, c = W * m[ 2 ], d = H * m[ 3 ] / tw, f = H * m[ 4 ] / th, g = H * m[ 5 ];
	const det = a * f - b * d;
	const ia = f / det, ib = - b / det, id = - d / det, ie = a / det;

	const canvas = document.createElement( 'canvas' );
	canvas.width = tw;
	canvas.height = th;
	const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
	ctx.imageSmoothingQuality = 'high';
	ctx.setTransform( ia, id, ib, ie, - ( ia * c + ib * g ), - ( id * c + ie * g ) );
	ctx.drawImage( source, 0, 0 );
	ctx.setTransform( 1, 0, 0, 1, 0, 0 );

	const pixels = ctx.getImageData( 0, 0, tw, th );
	const adjusted = new Float32Array( tw * th * 3 );
	for ( let i = 0; i < tw * th; i ++ ) {

		const rgb = adjustColor( [ pixels.data[ i * 4 ] / 255, pixels.data[ i * 4 + 1 ] / 255, pixels.data[ i * 4 + 2 ] / 255 ], e.adjust );
		adjusted.set( rgb, i * 3 );

	}

	const urls = {};
	for ( const id of [ null, ...LOOKS.map( l => l.id ) ] ) {

		const table = id && lookTable( id );
		const image = ctx.createImageData( tw, th );
		for ( let i = 0; i < tw * th; i ++ ) {

			let rgb = [ adjusted[ i * 3 ], adjusted[ i * 3 + 1 ], adjusted[ i * 3 + 2 ] ];
			if ( table ) rgb = lookColor( rgb, table );
			for ( let k = 0; k < 3; k ++ ) image.data[ i * 4 + k ] = Math.round( Math.min( 1, Math.max( 0, rgb[ k ] ) ) * 255 );
			image.data[ i * 4 + 3 ] = 255;

		}

		ctx.putImageData( image, 0, 0 );
		urls[ id ?? 'none' ] = canvas.toDataURL( 'image/jpeg', 0.85 );

	}

	return urls;

}
