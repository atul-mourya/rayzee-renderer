/**
 * One RGBA8 layer into its slot of a packed array: bilinear with texel centres aligned, a plain copy
 * when the sizes match. flipY puts the last row first. Shared by the main thread and PackWorker.
 */
export function resampleRGBA8( { data: src, width: sw, height: sh, flipY }, dst, offset, dw, dh ) {

	const rowBytes = dw * 4;

	if ( sw === dw && sh === dh ) {

		if ( ! flipY ) {

			dst.set( src.subarray( 0, dh * rowBytes ), offset );
			return;

		}

		for ( let y = 0; y < dh; y ++ ) dst.set( src.subarray( y * rowBytes, ( y + 1 ) * rowBytes ), offset + ( dh - 1 - y ) * rowBytes );
		return;

	}

	// Every row samples the same columns. Enlarged, neighbouring rows also share source rows, so each
	// source row is blended across once, and the slot holding the other row of a pair is never evicted.
	const left = new Int32Array( dw ), right = new Int32Array( dw ), weight = new Float64Array( dw );

	for ( let x = 0; x < dw; x ++ ) {

		const fx = Math.min( Math.max( ( x + 0.5 ) * sw / dw - 0.5, 0 ), sw - 1 );
		const x0 = Math.floor( fx );
		left[ x ] = x0 * 4;
		right[ x ] = Math.min( x0 + 1, sw - 1 ) * 4;
		weight[ x ] = fx - x0;

	}

	if ( dh <= sh ) {

		for ( let y = 0; y < dh; y ++ ) {

			const fy = Math.min( Math.max( ( y + 0.5 ) * sh / dh - 0.5, 0 ), sh - 1 );
			const y0 = Math.floor( fy ), y1 = Math.min( y0 + 1, sh - 1 ), ty = fy - y0;
			const top = y0 * sw * 4, bottom = y1 * sw * 4;
			let out = offset + ( flipY ? dh - 1 - y : y ) * rowBytes;

			for ( let x = 0; x < dw; x ++, out += 4 ) {

				const a = top + left[ x ], b = top + right[ x ], c = bottom + left[ x ], d = bottom + right[ x ], tx = weight[ x ];

				for ( let ch = 0; ch < 4; ch ++ ) {

					const t = src[ a + ch ] + ( src[ b + ch ] - src[ a + ch ] ) * tx;
					const u = src[ c + ch ] + ( src[ d + ch ] - src[ c + ch ] ) * tx;
					dst[ out + ch ] = Math.round( t + ( u - t ) * ty );

				}

			}

		}

		return;

	}

	const slots = [ { row: - 1, data: new Float64Array( rowBytes ) }, { row: - 1, data: new Float64Array( rowBytes ) } ];

	const across = ( sy, keep ) => {

		for ( const slot of slots ) if ( slot.row === sy ) return slot.data;

		const slot = slots[ 0 ].row === keep ? slots[ 1 ] : slots[ 0 ];
		const base = sy * sw * 4, row = slot.data;

		for ( let x = 0, o = 0; x < dw; x ++, o += 4 ) {

			const a = base + left[ x ], b = base + right[ x ], tx = weight[ x ];
			row[ o ] = src[ a ] + ( src[ b ] - src[ a ] ) * tx;
			row[ o + 1 ] = src[ a + 1 ] + ( src[ b + 1 ] - src[ a + 1 ] ) * tx;
			row[ o + 2 ] = src[ a + 2 ] + ( src[ b + 2 ] - src[ a + 2 ] ) * tx;
			row[ o + 3 ] = src[ a + 3 ] + ( src[ b + 3 ] - src[ a + 3 ] ) * tx;

		}

		slot.row = sy;
		return row;

	};

	for ( let y = 0; y < dh; y ++ ) {

		const fy = Math.min( Math.max( ( y + 0.5 ) * sh / dh - 0.5, 0 ), sh - 1 );
		const y0 = Math.floor( fy ), y1 = Math.min( y0 + 1, sh - 1 ), ty = fy - y0;
		const top = across( y0, y1 );
		const bottom = y1 === y0 ? top : across( y1, y0 );
		const out = offset + ( flipY ? dh - 1 - y : y ) * rowBytes;

		for ( let i = 0; i < rowBytes; i ++ ) dst[ out + i ] = Math.round( top[ i ] + ( bottom[ i ] - top[ i ] ) * ty );

	}

}
