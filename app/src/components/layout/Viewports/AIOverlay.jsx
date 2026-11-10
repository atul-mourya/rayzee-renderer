import { useRef, useState } from 'react';
import { ChevronsLeftRight, Columns2, Image, SquareSplitHorizontal } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const clamp = v => Math.min( 1, Math.max( 0, v ) );
const stop = e => e.stopPropagation();

function capture( element, e ) {

	try {

		element.setPointerCapture( e.pointerId );

	} catch {

		// A pointer that is no longer down cannot be captured.

	}

}

export function CompareSwitch( { value, onChange, n } ) {

	const modes = [
		{ value: 'slider', Icon: SquareSplitHorizontal, name: 'Slider' },
		{ value: 'side', Icon: Columns2, name: 'Side by side' },
		{ value: 'version', Icon: Image, name: `v${n} only` },
	];

	return (
		<TooltipProvider delayDuration={300}>
			<Tabs value={value} onValueChange={onChange} onPointerDown={stop} onMouseDown={stop}>
				<TabsList aria-label="Compare as" className="h-8 shadow-md">
					{/* The tip wraps the icon: on the trigger, its data-state would hide which mode is on. */}
					{modes.map( ( { value: mode, Icon, name } ) => (
						<TabsTrigger key={mode} value={mode} aria-label={name} className="p-0">
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="flex items-center px-2 py-1"><Icon className="h-4 w-4" /></span>
								</TooltipTrigger>
								<TooltipContent side="bottom">{name}</TooltipContent>
							</Tooltip>
						</TabsTrigger>
					) )}
				</TabsList>
			</Tabs>
		</TooltipProvider>
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
