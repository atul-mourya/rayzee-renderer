import { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from "@/lib/utils";

const SNAP_THRESHOLD = 5;
const AXIS_SNAP_THRESHOLD = 4;
const VIEW_BOX = "-3 -3 106 106"; // Add some padding to the viewBox to avoid clipping the at edges otherwide it should be 0 0 100 100
const INITIAL_POSITION = { x: 50, y: 50 };

export function Trackpad( { className, points = [], onMove, label, tip, ...props } ) {

	const [ position, setPosition ] = useState( INITIAL_POSITION );
	const [ isDragging, setIsDragging ] = useState( false );
	const [ snappedPoint, setSnappedPoint ] = useState( null );
	const svgRef = useRef( null );

	// Memoize the position calculation function
	const calculatePosition = useCallback( ( clientX, clientY ) => {

		const rect = svgRef.current?.getBoundingClientRect();
		if ( ! rect ) return null;

		return {
			x: ( ( clientX - rect.left ) / rect.width ) * 100,
			y: ( ( clientY - rect.top ) / rect.height ) * 100
		};

	}, [] );

	// Memoize the snap detection function
	const findNearestPoint = useCallback( ( x, y ) => {

		return points.reduce( ( nearest, point ) => {

			const distance = Math.hypot( x - point.x, y - point.y );
			return distance < SNAP_THRESHOLD && ( ! nearest || distance < nearest.distance )
				? { point, distance }
				: nearest;

		}, null );

	}, [ points ] );

	// Snap to vertical (x=50) or horizontal (y=50) center axes
	const snapToAxis = useCallback( ( pos ) => {

		const snapped = { x: pos.x, y: pos.y };
		if ( Math.abs( pos.x - 50 ) < AXIS_SNAP_THRESHOLD ) snapped.x = 50;
		if ( Math.abs( pos.y - 50 ) < AXIS_SNAP_THRESHOLD ) snapped.y = 50;
		return snapped;

	}, [] );

	const updatePosition = useCallback( ( event ) => {

		const newPosition = calculatePosition( event.clientX, event.clientY );
		if ( ! newPosition ) return;

		const nearestPoint = findNearestPoint( newPosition.x, newPosition.y );

		if ( nearestPoint ) {

			setPosition( nearestPoint.point );
			setSnappedPoint( nearestPoint.point );

		} else {

			setPosition( snapToAxis( newPosition ) );
			setSnappedPoint( null );

		}

	}, [ calculatePosition, findNearestPoint, snapToAxis ] );

	const handleMouseDown = useCallback( ( event ) => {

		setIsDragging( true );
		updatePosition( event );

	}, [ updatePosition ] );

	const handleMouseMove = useCallback( ( event ) => {

		if ( isDragging ) {

			updatePosition( event );
			onMove?.( position );

		}

	}, [ isDragging, updatePosition, onMove, position ] );

	const handleMouseUp = useCallback( () => {

		setIsDragging( false );
		if ( snappedPoint ) {

			onMove?.( snappedPoint );
			setSnappedPoint( null );

		} else {

			onMove?.( position );

		}

	}, [ snappedPoint, position, onMove ] );

	// Global mouse up handler
	useEffect( () => {

		const handleGlobalMouseUp = () => {

			setIsDragging( false );
			if ( snappedPoint?.onClick ) {

				snappedPoint.onClick();
				setSnappedPoint( null );

			}

		};

		window.addEventListener( 'mouseup', handleGlobalMouseUp );
		return () => window.removeEventListener( 'mouseup', handleGlobalMouseUp );

	}, [ snappedPoint ] );

	return (
		<>
			{label && <span className="opacity-50 text-xs truncate" title={tip}>{label}</span>}
			<div className={cn( "w-full h-full", className )} {...props}>
				<svg
					ref={svgRef}
					viewBox={VIEW_BOX}
					className="w-full h-full border rounded-lg shadow-md"
					onMouseDown={handleMouseDown}
					onMouseMove={handleMouseMove}
					onMouseUp={handleMouseUp}
					role="application"
					aria-label="Trackpad"
				>
					<defs>
						{/* Glow filter */}
						<filter id="glow" x="-150%" y="-150%" width="400%" height="400%">
							<feGaussianBlur stdDeviation="3.5" result="coloredBlur" />
							<feMerge>
								<feMergeNode in="coloredBlur" />
								<feMergeNode in="SourceGraphic" />
							</feMerge>
						</filter>
					</defs>

					<rect x="0" y="0" width="100" height="100" fill="transparent" />

					{/* Guidelines */}
					<g className="stroke-primary">
						<line x1="50" y1="0" x2="50" y2="100" className="opacity-30 [stroke-dasharray:2,2]" />
						<line x1="0" y1="50" x2="100" y2="50" className="opacity-30 [stroke-dasharray:2,2]" />
						<line x1={position.x} y1="0" x2={position.x} y2="100" />
						<line x1="0" y1={position.y} x2="100" y2={position.y} />
					</g>

					{/* Interactive points */}
					{points.map( ( point, index ) => (
						<circle key={index} cx={point.x} cy={point.y} r="3" className="stroke-primary fill-background cursor-pointer hover:fill-primary opacity-40" />
					) )}

					{/* Cursor circle */}
					<circle cx={position.x} cy={position.y} r="3" className="stroke-primary fill-primary pointer-events-none" style={{ filter: 'url(#glow)' }}
					/>
				</svg>
			</div>
		</>
	);

}
