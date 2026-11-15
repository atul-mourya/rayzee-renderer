import { useEffect, useRef } from 'react';
import { StatsProfiler } from 'stats-gl';
import { EngineEvents } from 'rayzee';

// A tile a reading, its recent values as faint bars behind the number (the newest on the right, in the accent).
const CHIPS = [
	{ key: 'fps', label: 'fps', width: 56, title: 'Frames drawn a second' },
	{ key: 'cpu', label: 'cpu', width: 62, title: 'Milliseconds the CPU spends on a frame' },
	{ key: 'gpu', label: 'gpu', width: 62, title: 'Milliseconds the GPU spends drawing a frame to the screen' },
	{ key: 'compute', label: 'compute', width: 72, title: 'Milliseconds the GPU spends tracing a frame' },
	{ key: 'denoise', label: 'denoise', width: 92, title: 'Denoised pictures shown a second, and how long the last one took' },
];
const HEIGHT = 30;
const PITCH = 3;
const BAR_MS = 125;
const TEXT_MS = 250;

// Bars 2 px wide from the bottom, scaled from half the lowest value up: a steady reading still shows its wobble.
function barPaths( samples, width ) {

	const recent = samples.slice( - Math.floor( width / PITCH ) );
	const low = Math.min( ...recent ) * 0.5;
	const span = Math.max( ...recent ) * 1.12 - low || 1;
	let past = '', newest = '';
	recent.forEach( ( value, i ) => {

		const height = Math.max( 1, ( value - low ) / span * HEIGHT ).toFixed( 1 );
		const bar = `M${width - ( recent.length - i ) * PITCH + 1},${HEIGHT}v-${height}h2v${height}z`;
		if ( i === recent.length - 1 ) newest = bar;
		else past += bar;

	} );
	return [ past, newest ];

}

/** The status bar's speed readings, ticked on every engine FRAME event; stats-gl's profiler measures them. */
export default function StatsPanel( { app } ) {

	const root = useRef( null );

	useEffect( () => {

		const renderer = app?.renderer;
		const holder = root.current;
		if ( ! renderer || ! holder ) return;

		const part = ( key, name ) => holder.querySelector( `[data-chip="${key}"] [data-part="${name}"]` );
		const parts = {}, history = {};
		for ( const { key } of CHIPS ) {

			parts[ key ] = { value: part( key, 'value' ), unit: part( key, 'unit' ), past: part( key, 'past' ), newest: part( key, 'newest' ) };
			history[ key ] = [];

		}

		// The profiler wraps renderer.info.reset to time the CPU; put the original back when done.
		const infoReset = renderer.info.reset;
		const profiler = new StatsProfiler( { trackGPU: true, trackCPT: true } );
		profiler.init( renderer );

		const sums = {}, shown = {};
		const landed = [];
		let frames = 0, lastPass = 0, barAt = performance.now(), textAt = 0;

		const writeText = () => {

			const text = {
				fps: [ shown.fps.toFixed( 0 ), '' ],
				cpu: [ shown.cpu.toFixed( 1 ), ' ms' ],
				gpu: [ shown.gpu.toFixed( 1 ), ' ms' ],
				compute: [ shown.compute.toFixed( 1 ), ' ms' ],
				denoise: [ `${landed.length}/s`, lastPass ? ` · ${lastPass.toFixed( 0 )} ms` : '' ],
			};
			for ( const key in text ) {

				parts[ key ].value.textContent = text[ key ][ 0 ];
				parts[ key ].unit.textContent = text[ key ][ 1 ];

			}

		};

		const onFrame = () => {

			// Three.js WebGPU only writes renderer.info.{render,compute}.timestamp when
			// resolveTimestampsAsync() is called — stats-gl reads but never resolves.
			if ( renderer.backend?.trackTimestamp ) {

				renderer.resolveTimestampsAsync( 'render' );
				renderer.resolveTimestampsAsync( 'compute' );

			}

			profiler.update();
			const now = performance.now();
			while ( landed.length && now - landed[ 0 ] > 1000 ) landed.shift();

			const { fps, cpu, gpu, gpuCompute } = profiler.getData();
			const reading = { fps, cpu, gpu, compute: gpuCompute, denoise: landed.length };
			for ( const key in reading ) {

				sums[ key ] = ( sums[ key ] ?? 0 ) + reading[ key ];
				shown[ key ] = key in shown ? shown[ key ] * 0.7 + reading[ key ] * 0.3 : reading[ key ];

			}

			frames ++;

			if ( now - barAt >= BAR_MS ) {

				barAt = now;
				for ( const { key, width } of CHIPS ) {

					history[ key ].push( sums[ key ] / frames );
					if ( history[ key ].length > 40 ) history[ key ].shift();
					sums[ key ] = 0;
					const [ past, newest ] = barPaths( history[ key ], width );
					parts[ key ].past.setAttribute( 'd', past );
					parts[ key ].newest.setAttribute( 'd', newest );

				}

				frames = 0;

			}

			if ( now - textAt >= TEXT_MS ) {

				textAt = now;
				writeText();

			}

		};

		// Under a live denoiser the view changes only when a denoised picture lands: these count those.
		const onDenoised = e => {

			if ( ! e.continuous || ! e.delivered ) return;
			landed.push( performance.now() );
			lastPass = e.ms;

		};

		app.addEventListener( EngineEvents.FRAME, onFrame );
		app.addEventListener( EngineEvents.DENOISING_END, onDenoised );

		return () => {

			app.removeEventListener( EngineEvents.FRAME, onFrame );
			app.removeEventListener( EngineEvents.DENOISING_END, onDenoised );
			profiler.dispose();
			renderer.info.reset = infoReset;

		};

	}, [ app ] );

	return (
		<div ref={root} className="flex h-full items-center gap-1.5 pl-2.5">
			{CHIPS.map( ( { key, label, width, title } ) => (
				<div
					key={key}
					data-chip={key}
					title={title}
					className="relative h-[30px] shrink-0 overflow-hidden rounded-md bg-muted"
					style={{ width }}
				>
					<svg width={width} height={HEIGHT} aria-hidden="true" className="absolute inset-0">
						<path data-part="past" className="fill-foreground opacity-[0.13]" />
						<path data-part="newest" className="fill-primary opacity-75" />
					</svg>
					<div className="relative flex h-full flex-col justify-between whitespace-nowrap px-[7px] py-1 leading-none">
						<span className="text-xxs text-muted-foreground">{label}</span>
						<span className="text-xs font-bold tabular-nums text-foreground">
							<span data-part="value">–</span>
							<span data-part="unit" className="text-xxs font-normal text-muted-foreground" />
						</span>
					</div>
				</div>
			) )}
		</div>
	);

}
