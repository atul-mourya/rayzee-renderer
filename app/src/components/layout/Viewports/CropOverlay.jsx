import { useEffect, useRef } from 'react';
import { constrainCrop } from '@/lib/edits';

const MIN = 0.03;
const HANDLES = {
	nw: [ 0, 0, 'nwse-resize' ], n: [ 0.5, 0, 'ns-resize' ], ne: [ 1, 0, 'nesw-resize' ], e: [ 1, 0.5, 'ew-resize' ],
	se: [ 1, 1, 'nwse-resize' ], s: [ 0.5, 1, 'ns-resize' ], sw: [ 0, 1, 'nesw-resize' ], w: [ 0, 0.5, 'ew-resize' ],
};
const clamp = ( v, lo, hi ) => Math.min( hi, Math.max( lo, v ) );
const pct = v => `${v * 100}%`;
const stop = e => e.stopPropagation();

// The crop after dragging `handle` by (dx, dy), fractions of the frame; `ratio` is width over height in those fractions.
function dragged( start, handle, dx, dy, ratio ) {

	if ( handle === 'move' ) return { ...start, x: clamp( start.x + dx, 0, 1 - start.w ), y: clamp( start.y + dy, 0, 1 - start.h ) };

	let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
	if ( handle.includes( 'w' ) ) left = Math.min( left + dx, right - MIN );
	if ( handle.includes( 'e' ) ) right = Math.max( right + dx, left + MIN );
	if ( handle.includes( 'n' ) ) top = Math.min( top + dy, bottom - MIN );
	if ( handle.includes( 's' ) ) bottom = Math.max( bottom + dy, top + MIN );
	if ( ! ratio ) return { x: left, y: top, w: right - left, h: bottom - top };

	let w = right - left, h = bottom - top;
	if ( handle.length === 2 ) {

		if ( w / ratio > h ) h = w / ratio;
		else w = h * ratio;
		if ( handle.includes( 'w' ) ) left = right - w;
		if ( handle.includes( 'n' ) ) top = bottom - h;
		return { x: left, y: top, w, h };

	}

	if ( handle === 'e' || handle === 'w' ) {

		h = w / ratio;
		return { x: left, y: start.y + start.h / 2 - h / 2, w, h };

	}

	w = h * ratio;
	return { x: start.x + start.w / 2 - w / 2, y: top, w, h };

}

/**
 * The crop being edited, over the whole turned picture: drag inside to move it, a handle to size it (to `aspect`,
 * width over height in pixels, when set). It stops at the straightened picture's edge. Enter keeps it, Esc undoes it.
 */
export function CropLayer( { rect, aspect, frame, angle, onChange, onDone, onCancel } ) {

	const layerRef = useRef( null );
	const dragRef = useRef( null );
	const ratio = aspect ? aspect * frame.height / frame.width : null;

	useEffect( () => {

		const onKey = e => {

			if ( e.target?.closest?.( 'input, textarea, select, [role="slider"], [contenteditable="true"]' ) ) return;
			if ( e.key !== 'Enter' && e.key !== 'Escape' ) return;
			e.preventDefault();
			e.stopPropagation();
			( e.key === 'Enter' ? onDone : onCancel )();

		};

		window.addEventListener( 'keydown', onKey, true );
		return () => window.removeEventListener( 'keydown', onKey, true );

	}, [ onDone, onCancel ] );

	const point = e => {

		const box = layerRef.current.getBoundingClientRect();
		return { x: ( e.clientX - box.left ) / box.width, y: ( e.clientY - box.top ) / box.height };

	};

	const grab = e => {

		if ( e.button !== 0 ) return;
		const handle = e.currentTarget.dataset.handle;
		e.stopPropagation();
		e.preventDefault();
		try {

			layerRef.current.setPointerCapture( e.pointerId );

		} catch {

			// A pointer that is no longer down cannot be captured.

		}

		dragRef.current = { handle, start: rect, from: point( e ) };

	};

	const move = e => {

		const drag = dragRef.current;
		if ( ! drag ) return;
		const p = point( e );
		const wanted = dragged( drag.start, drag.handle, p.x - drag.from.x, p.y - drag.from.y, ratio );
		onChange( constrainCrop( drag.start, wanted, angle, frame.width, frame.height ) );

	};

	const end = () => {

		dragRef.current = null;

	};

	const shade = 'absolute bg-scrim/55 pointer-events-none';

	return (
		<div ref={layerRef} className="absolute inset-0 z-10 select-none touch-none" onMouseDown={stop} onPointerDown={stop}
			onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
			<div className={shade} style={{ left: 0, top: 0, right: 0, height: pct( rect.y ) }} />
			<div className={shade} style={{ left: 0, bottom: 0, right: 0, height: pct( 1 - rect.y - rect.h ) }} />
			<div className={shade} style={{ left: 0, top: pct( rect.y ), width: pct( rect.x ), height: pct( rect.h ) }} />
			<div className={shade} style={{ right: 0, top: pct( rect.y ), width: pct( 1 - rect.x - rect.w ), height: pct( rect.h ) }} />

			<div aria-label="Crop" className="absolute border border-handle shadow-md" data-handle="move" onPointerDown={grab}
				style={{ left: pct( rect.x ), top: pct( rect.y ), width: pct( rect.w ), height: pct( rect.h ), cursor: 'move' }}>
				{[ 1, 2 ].map( i => (
					<div key={`v${i}`} className="absolute inset-y-0 border-l border-handle/40 pointer-events-none" style={{ left: pct( i / 3 ) }} />
				) )}
				{[ 1, 2 ].map( i => (
					<div key={`h${i}`} className="absolute inset-x-0 border-t border-handle/40 pointer-events-none" style={{ top: pct( i / 3 ) }} />
				) )}
				{Object.entries( HANDLES ).map( ( [ name, [ x, y, cursor ]] ) => (
					<div key={name} data-handle={name} onPointerDown={grab} className="absolute h-3 w-3 -ml-1.5 -mt-1.5 rounded-sm bg-handle shadow-md"
						style={{ left: pct( x ), top: pct( y ), cursor }} />
				) )}
			</div>
		</div>
	);

}
