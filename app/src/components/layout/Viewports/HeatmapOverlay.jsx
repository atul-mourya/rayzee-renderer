import { useEffect, useRef } from 'react';
import { EngineEvents } from 'rayzee';

const POSITION_STYLES = {
	'top-right': { top: 10, right: 10 },
	'top-left': { top: 10, left: 10 },
	'bottom-right': { bottom: 60, right: 10 },
	'bottom-left': { bottom: 60, left: 10 },
};

// Heatmaps are debug aids — we throttle readbacks so async pixel transfers
// don't contend with the path tracer's GPU work each frame.
const READBACK_INTERVAL_MS = 100;

/**
 * Readback-and-paint overlay for a stage's debug heatmap RenderTarget.
 * Subscribes to EngineEvents.FRAME, asynchronously reads pixels at most
 * every ~250ms, and paints them into a positioned canvas.
 *
 * @param {object} props
 * @param {object} props.app           - PathTracerApp instance (EventDispatcher)
 * @param {object} props.renderTarget  - Three.js RenderTarget (FloatType expected)
 * @param {boolean} props.visible      - Mount + read when true
 * @param {string} [props.title]       - Header label
 * @param {string} [props.position]    - 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
 * @param {number} [props.size]        - Square edge in CSS pixels
 */
export default function HeatmapOverlay( {
	app,
	renderTarget,
	visible,
	title = 'Heatmap',
	position = 'bottom-right',
	size = 240,
} ) {

	const canvasRef = useRef( null );

	useEffect( () => {

		if ( ! visible || ! app?.renderer || ! renderTarget ) return;

		const canvas = canvasRef.current;
		if ( ! canvas ) return;

		const ctx = canvas.getContext( '2d' );
		let pending = false;
		let lastReadAt = 0;
		let pixelBuffer = new Uint8ClampedArray( 0 );
		let cancelled = false;

		const onFrame = () => {

			if ( cancelled || pending ) return;

			const now = performance.now();
			if ( now - lastReadAt < READBACK_INTERVAL_MS ) return;
			lastReadAt = now;

			const w = renderTarget.width;
			const h = renderTarget.height;
			if ( ! w || ! h ) return;

			pending = true;
			app.renderer.readRenderTargetPixelsAsync( renderTarget, 0, 0, w, h, 0 )
				.then( ( buffer ) => {

					pending = false;
					if ( cancelled || ! buffer ) return;

					if ( canvas.width !== w || canvas.height !== h ) {

						canvas.width = w;
						canvas.height = h;

					}

					if ( pixelBuffer.length !== 4 * w * h ) {

						pixelBuffer = new Uint8ClampedArray( 4 * w * h );

					}

					// Rows arrive padded to 256 bytes.
					const row = 4 * w;
					const stride = Math.ceil( row * buffer.BYTES_PER_ELEMENT / 256 ) * 256 / buffer.BYTES_PER_ELEMENT;
					for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < row; x ++ ) {

						const v = buffer[ y * stride + x ] * 255;
						pixelBuffer[ y * row + x ] = v < 0 ? 0 : v > 255 ? 255 : v;

					}

					ctx.putImageData( new ImageData( pixelBuffer, w, h ), 0, 0 );

				} )
				.catch( ( err ) => {

					pending = false;
					console.warn( 'HeatmapOverlay: readback failed', err );

				} );

		};

		app.addEventListener( EngineEvents.FRAME, onFrame );
		return () => {

			cancelled = true;
			app.removeEventListener( EngineEvents.FRAME, onFrame );

		};

	}, [ visible, app, renderTarget ] );

	if ( ! visible ) return null;

	return (
		<div
			style={{
				position: 'absolute',
				...POSITION_STYLES[ position ],
				width: size,
				height: size + 22,
				background: '#1e293b',
				border: '1px solid #334155',
				borderRadius: 4,
				padding: 4,
				color: '#f8fafc',
				fontSize: 11,
				zIndex: 10,
				pointerEvents: 'none',
			}}
		>
			<div style={{ marginBottom: 4, opacity: 0.8 }}>{title}</div>
			<canvas
				ref={canvasRef}
				style={{ width: '100%', height: size, display: 'block', imageRendering: 'pixelated' }}
			/>
		</div>
	);

}
