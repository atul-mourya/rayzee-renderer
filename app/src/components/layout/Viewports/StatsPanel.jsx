import { useEffect, useRef } from 'react';
import Stats from 'stats-gl';
import { EngineEvents } from 'rayzee';

// The theme's text on the theme's background, so the strip is part of the bar it sits in. A canvas: no CSS reaches it.
function themeColors() {

	const style = getComputedStyle( document.documentElement );
	return {
		fg: `hsl(${style.getPropertyValue( '--foreground' ).trim()})`,
		bg: `hsl(${style.getPropertyValue( '--background' ).trim()})`,
	};

}

// Repaints a panel in the theme's colours; its graph so far is cleared.
function themePanel( panel ) {

	if ( ! panel ) return;
	Object.assign( panel, themeColors() );
	panel.initializeCanvas();
	const gradient = panel.context.createLinearGradient( 0, panel.GRAPH_Y, 0, panel.GRAPH_Y + panel.GRAPH_HEIGHT );
	gradient.addColorStop( 0, panel.fg );
	panel.gradient = gradient;

}

// The other graphs tick once a loop frame; under a live denoiser the view changes only when a
// denoised picture lands. This one counts those: pictures a second, and the last pass's time.
function denoisePanel( stats ) {

	const { fg, bg } = themeColors();
	const panel = stats.addPanel( new Stats.Panel( 'DN', fg, bg ) );
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
		panel,
		dispose: () => clearTimeout( hideTimer ),
	};

}

// stats-gl's panels: 90 × 48 px each, in a row. FPS, CPU, GPU, compute, and the denoiser's while it runs.
const PANEL_WIDTH = 90;
const PANEL_HEIGHT = 48;
const PANELS = 5;

/**
 * A stats-gl strip against the engine's renderer, ticked on every engine FRAME event: a row in the flow, scaled to the
 * height of what holds it (the status bar).
 */
export default function StatsPanel( { app } ) {

	const holder = useRef( null );

	useEffect( () => {

		if ( ! app?.renderer || ! holder.current ) return;

		const stats = new Stats( { horizontal: true, trackGPU: true, trackCPT: true } );
		stats.dom.style.cssText = `position: relative; width: ${PANELS * PANEL_WIDTH}px; height: ${PANEL_HEIGHT}px;`;
		stats.dom.style.zoom = holder.current.clientHeight / PANEL_HEIGHT;
		stats.init( app.renderer );
		holder.current.appendChild( stats.dom );

		const denoise = denoisePanel( stats );
		const graphs = [
			[ stats.fpsPanel, stats.averageFps, 0 ],
			[ stats.msPanel, stats.averageCpu, stats.precision ],
			[ stats.gpuPanel, stats.averageGpu, stats.precision ],
			[ stats.gpuPanelCompute, stats.averageGpuCompute, stats.precision ],
		];
		// Repainted, then redrawn from the readings stats-gl keeps: a finished render ticks no frame to refill them.
		const retheme = () => {

			themePanel( denoise.panel );
			for ( const [ panel, average, precision ] of graphs ) {

				themePanel( panel );
				const samples = average?.graph ?? [];
				const max = Math.max( ...samples, 0.1 );
				samples.forEach( value => panel?.updateGraph( value, max ) );
				const key = String( panel?.id );
				if ( stats.lastValue && key in stats.lastValue ) panel.update( stats.lastValue[ key ], stats.lastMax[ key ], precision );

			}

		};

		retheme();
		// The theme is a class on the page's root (theme-provider.jsx).
		const themeWatch = new MutationObserver( retheme );
		themeWatch.observe( document.documentElement, { attributes: true, attributeFilter: [ 'class' ] } );

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
			themeWatch.disconnect();
			denoise.dispose();
			stats.dom.remove();

		};

	}, [ app ] );

	return <div ref={holder} className="h-full" />;

}
