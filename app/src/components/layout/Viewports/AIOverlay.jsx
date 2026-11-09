import { useEffect, useRef, useState } from 'react';
import { ChevronsLeftRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const clamp = v => Math.min( 1, Math.max( 0, v ) );
const stop = e => e.stopPropagation();

function capture( element, e ) {

	try {

		element.setPointerCapture( e.pointerId );

	} catch {

		// A pointer that is no longer down cannot be captured.

	}

}

export function Elapsed( { since } ) {

	const [ now, setNow ] = useState( Date.now );
	useEffect( () => {

		const timer = setInterval( () => setNow( Date.now() ), 1000 );
		return () => clearInterval( timer );

	}, [] );
	const seconds = Math.max( 0, Math.floor( ( now - since ) / 1000 ) );
	return `${Math.floor( seconds / 60 )}:${String( seconds % 60 ).padStart( 2, '0' )}`;

}

/** The render and its AI versions, as thumbnails to switch between. */
export function VersionStrip( { render, shown, job, onShow } ) {

	const versions = render.aiVersions ?? [];
	if ( ! versions.length && ! job ) return null;

	const item = ( key, active, onClick, src, label, title ) => (
		<button key={key} type="button" onClick={onClick} aria-pressed={active} title={title} className="flex flex-col gap-1 shrink-0 text-left">
			<span className={`block w-16 h-12 rounded-md overflow-hidden bg-black ${active ? 'ring-2 ring-primary' : 'ring-1 ring-border'}`}>
				{src && <img src={src} alt="" className="w-full h-full object-cover" />}
			</span>
			<span className="text-xs leading-none font-medium">{label}</span>
		</button>
	);

	return (
		<div aria-label="Versions of this render" onPointerDown={stop} onMouseDown={stop}
			className="flex gap-2 p-1.5 pb-2 rounded-md bg-background/90 border border-border overflow-x-auto max-w-full">
			{item( 'render', shown === 'render', () => onShow( 'render' ), render.thumb, 'Render', 'As rendered' )}
			{versions.map( v => item( v.n, shown === v.n, () => onShow( v.n ), v.url, `v${v.n}`, v.prompt ) )}
			{job && (
				<div className="flex flex-col gap-1 shrink-0">
					<span className="w-16 h-12 rounded-md border border-dashed border-purple-500 flex items-center justify-center">
						<Loader2 className="h-4 w-4 animate-spin text-purple-400" />
					</span>
					<span className="text-xs leading-none font-medium">v{job.n}</span>
				</div>
			)}
		</div>
	);

}

export function CompareSwitch( { value, onChange, n } ) {

	return (
		<Tabs value={value} onValueChange={onChange} onPointerDown={stop} onMouseDown={stop}>
			<TabsList aria-label="Compare as" className="h-8 shadow-md">
				<TabsTrigger value="slider" className="text-xs px-2.5">Slider</TabsTrigger>
				<TabsTrigger value="side" className="text-xs px-2.5">Side by side</TabsTrigger>
				<TabsTrigger value="version" className="text-xs px-2.5">v{n} only</TabsTrigger>
			</TabsList>
		</Tabs>
	);

}

/** The line between the render (left) and the version (right); drag it, or use the arrow keys. */
export function SplitHandle( { split, onChange, label } ) {

	const ref = useRef( null );
	const move = e => {

		if ( ! e.currentTarget.hasPointerCapture( e.pointerId ) ) return;
		const box = ref.current.closest( '[data-compare]' ).getBoundingClientRect();
		onChange( clamp( ( e.clientX - box.left ) / box.width ) );

	};

	const grab = e => {

		e.stopPropagation();
		capture( e.currentTarget, e );

	};

	return (
		<div ref={ref} className="absolute inset-y-0 z-10 -ml-2.5 w-5 cursor-ew-resize" style={{ left: `${split * 100}%` }}
			onPointerDown={grab} onPointerMove={move} onMouseDown={stop}>
			<div className="absolute inset-y-0 left-1/2 -ml-px w-0.5 bg-white pointer-events-none" />
			<div role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round( split * 100 )}
				onKeyDown={e => {

					if ( e.key === 'ArrowLeft' ) onChange( clamp( split - 0.05 ) );
					if ( e.key === 'ArrowRight' ) onChange( clamp( split + 0.05 ) );

				}}
				className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-white text-slate-900 flex items-center justify-center shadow-md focus-visible:outline-2 focus-visible:outline-primary">
				<ChevronsLeftRight className="h-4 w-4" />
			</div>
		</div>
	);

}

/**
 * The area an edit changes: dragged out on the picture while `editable`, shown as `fitted` (the area grown to a shape
 * Gemini returns) otherwise. Fractions of the picture.
 */
export function AreaLayer( { fitted, onChange, editable } ) {

	const layerRef = useRef( null );
	const startRef = useRef( null );
	const draftRef = useRef( null );
	const [ draft, setDraft ] = useState( null );

	const point = e => {

		const box = layerRef.current.getBoundingClientRect();
		return { x: clamp( ( e.clientX - box.left ) / box.width ), y: clamp( ( e.clientY - box.top ) / box.height ) };

	};

	const update = next => {

		draftRef.current = next;
		setDraft( next );

	};

	const shown = draft ?? fitted;

	return (
		<div ref={layerRef} className="absolute inset-0 z-10"
			style={{ cursor: editable ? 'crosshair' : 'default', pointerEvents: editable ? 'auto' : 'none' }}
			onMouseDown={editable ? stop : undefined}
			onPointerDown={e => {

				if ( ! editable || e.button !== 0 ) return;
				e.stopPropagation();
				capture( layerRef.current, e );
				startRef.current = point( e );
				update( { ...startRef.current, w: 0, h: 0 } );

			}}
			onPointerMove={e => {

				const s = startRef.current;
				if ( ! s ) return;
				const p = point( e );
				update( { x: Math.min( s.x, p.x ), y: Math.min( s.y, p.y ), w: Math.abs( p.x - s.x ), h: Math.abs( p.y - s.y ) } );

			}}
			onPointerUp={() => {

				const d = draftRef.current;
				startRef.current = null;
				update( null );
				if ( d && d.w > 0.02 && d.h > 0.02 ) onChange( d );

			}}>
			{shown && (
				<div aria-label="Area to change" className="absolute border-2 border-dashed border-purple-500 bg-purple-600/10 pointer-events-none"
					style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.w * 100}%`, height: `${shown.h * 100}%` }}>
					<span className="absolute top-1 left-1 px-2 py-0.5 rounded-md bg-purple-600 text-white text-xs whitespace-nowrap">Area to change</span>
				</div>
			)}
		</div>
	);

}

export function JobChip( { job, onCancel } ) {

	return (
		<div role="status" onPointerDown={stop} onMouseDown={stop} className="flex items-center gap-2 pl-2.5 pr-1 py-1 bg-black/80 rounded-md text-xs text-gray-300 shadow-md whitespace-nowrap">
			<Loader2 className="h-3 w-3 animate-spin text-purple-400" />
			<span>Making v{job.n} · <Elapsed since={job.startedAt} />{job.part ? ' · only the marked area' : ''}</span>
			<Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onCancel}>Cancel</Button>
		</div>
	);

}
