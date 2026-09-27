import { useRef, useState } from 'react';
import { useCameraStore, usePathTracerStore } from '@/store';
import { isPanorama } from '@/Constants';

const AutoFocusOverlay = ( { containerRef } ) => {

	const autoFocusMode = useCameraStore( state => state.autoFocusMode );
	const enableDOF = useCameraStore( state => state.enableDOF );
	const afScreenPoint = useCameraStore( state => state.afScreenPoint );
	const handleAFScreenPointChange = useCameraStore( state => state.handleAFScreenPointChange );
	const panorama = usePathTracerStore( state => isPanorama( state.cameraProjection ) );

	const [ isDragging, setIsDragging ] = useState( false );
	const dragContainerRef = useRef( null );

	if ( ! enableDOF || autoFocusMode !== 'auto' || panorama ) return null;

	const handlePointerDown = ( e ) => {

		setIsDragging( true );
		e.target.setPointerCapture( e.pointerId );
		dragContainerRef.current = containerRef.current;

	};

	const handlePointerMove = ( e ) => {

		if ( ! isDragging || ! dragContainerRef.current ) return;
		const rect = dragContainerRef.current.getBoundingClientRect();
		const x = Math.max( 0, Math.min( 1, ( e.clientX - rect.left ) / rect.width ) );
		const y = Math.max( 0, Math.min( 1, ( e.clientY - rect.top ) / rect.height ) );
		handleAFScreenPointChange( { x, y } );

	};

	const handlePointerUp = ( e ) => {

		setIsDragging( false );
		e.target.releasePointerCapture( e.pointerId );

	};

	return (
		<div className="absolute inset-0 pointer-events-none z-10">
			<div
				className="absolute pointer-events-auto cursor-grab active:cursor-grabbing"
				style={{
					left: `${afScreenPoint.x * 100}%`,
					top: `${afScreenPoint.y * 100}%`,
					transform: 'translate(-50%, -50%)',
				}}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
			>
				<svg width="28" height="28" className="opacity-60">
					<circle cx="14" cy="14" r="10" fill="none" stroke="white" strokeWidth="1.5" />
					<circle cx="14" cy="14" r="10" fill="none" stroke="black" strokeWidth="0.5" />
					<line x1="14" y1="6" x2="14" y2="22" stroke="white" strokeWidth="1" />
					<line x1="6" y1="14" x2="22" y2="14" stroke="white" strokeWidth="1" />
					<line x1="14" y1="6" x2="14" y2="22" stroke="black" strokeWidth="0.3" />
					<line x1="6" y1="14" x2="22" y2="14" stroke="black" strokeWidth="0.3" />
				</svg>
			</div>
		</div>
	);

};

export default AutoFocusOverlay;
