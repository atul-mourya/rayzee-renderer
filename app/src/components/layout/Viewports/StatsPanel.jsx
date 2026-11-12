import { useEffect } from 'react';
import Stats from 'stats-gl';
import { EngineEvents } from 'rayzee';

const FG = '#ffffff';
const BG = '#1e293b';

function themePanel( panel ) {

	if ( ! panel ) return;
	const gradient = panel.context.createLinearGradient(
		0, panel.GRAPH_Y,
		0, panel.GRAPH_Y + panel.GRAPH_HEIGHT
	);
	gradient.addColorStop( 0, FG );
	panel.fg = FG;
	panel.bg = BG;
	panel.gradient = gradient;

}

// The other graphs tick once a loop frame; under a live denoiser the view changes only when a
// denoised picture lands. This one counts those: pictures a second, and the last pass's time.
function denoisePanel( stats ) {

	const panel = stats.addPanel( new Stats.Panel( 'DN', FG, BG ) );
	themePanel( panel );
	// Above the strip: a fifth panel in the row covered the viewport's toolbar in a narrow window.
	panel.canvas.style.left = '0px';
	panel.canvas.style.top = `${- panel.HEIGHT / panel.PR}px`;
	panel.canvas.style.visibility = 'hidden';

	const landed = [];
	let lastMs = 0, peak = 0, textAt = 0, hideTimer = 0;

	const draw = () => {

		const now = performance.now();
		while ( landed.length && now - landed[ 0 ] > 1000 ) landed.shift();
		const rate = landed.length;
		peak = Math.max( peak, rate );
		panel.updateGraph( rate, peak );
		if ( now - textAt < 250 ) return;
		textAt = now;
		panel.update( rate, peak, 0, ` ${lastMs.toFixed( 0 )}ms` );

	};

	return {
		draw: () => landed.length && draw(),
		onEnd: e => {

			if ( ! e.continuous || ! e.delivered ) return;
			landed.push( performance.now() );
			lastMs = e.ms;
			panel.canvas.style.visibility = 'visible';
			clearTimeout( hideTimer );
			hideTimer = setTimeout( () => {

				landed.length = 0;
				peak = 0;
				panel.canvas.style.visibility = 'hidden';

			}, 2000 );

		},
		dispose: () => clearTimeout( hideTimer ),
	};

}

/**
 * Mounts a stats-gl HUD against the engine's renderer and ticks it on
 * every engine FRAME event. The HUD is mounted into `container` (or the
 * canvas parent) and torn down on unmount.
 */
export default function StatsPanel( { app, container } ) {

	useEffect( () => {

		if ( ! app?.renderer ) return;

		const stats = new Stats( { horizontal: true, trackGPU: true, trackCPT: true } );
		stats.dom.style.position = 'absolute';
		stats.dom.style.top = 'unset';
		stats.dom.style.bottom = '48px';
		stats.init( app.renderer );

		const mount = container || app.canvas?.parentElement || document.body;
		mount.appendChild( stats.dom );

		themePanel( stats.fpsPanel );
		themePanel( stats.msPanel );
		themePanel( stats.gpuPanel );
		themePanel( stats.gpuPanelCompute );
		const denoise = denoisePanel( stats );

		// Three.js WebGPU only writes renderer.info.{render,compute}.timestamp when
		// resolveTimestampsAsync() is called — stats-gl reads but never resolves.
		const renderer = app.renderer;
		const onFrame = () => {

			if ( renderer.backend?.trackTimestamp ) {

				renderer.resolveTimestampsAsync( 'render' );
				renderer.resolveTimestampsAsync( 'compute' );

			}

			stats.update();
			denoise.draw();

		};

		app.addEventListener( EngineEvents.FRAME, onFrame );
		app.addEventListener( EngineEvents.DENOISING_END, denoise.onEnd );

		return () => {

			app.removeEventListener( EngineEvents.FRAME, onFrame );
			app.removeEventListener( EngineEvents.DENOISING_END, denoise.onEnd );
			denoise.dispose();
			stats.dom.remove();

		};

	}, [ app, container ] );

	return null;

}
