import { useState, useEffect } from 'react';
import { Loader2, AlertTriangle } from "lucide-react";
import { useStore } from '@/store';
import { Progress } from "@/components/ui/progress";
import { getApp } from '@/lib/appProxy';

// Format a byte count as a compact human-readable string (e.g. "2.3 MB").
const formatBytes = ( bytes ) => {

	if ( bytes == null || ! isFinite( bytes ) ) return '';
	if ( bytes < 1024 ) return `${bytes} B`;
	const units = [ 'KB', 'MB', 'GB' ];
	let value = bytes / 1024;
	let unit = 0;
	while ( value >= 1024 && unit < units.length - 1 ) {

		value /= 1024;
		unit ++;

	}

	return `${value.toFixed( value >= 100 ? 0 : 1 )} ${units[ unit ]}`;

};

const LoadingOverlay = ( {
	showProgress = true,
	showStatus = true
} ) => {

	const loading = useStore( ( state ) => state.loading );
	const [ progressAnimation, setProgressAnimation ] = useState( 0 );
	const [ cancelling, setCancelling ] = useState( false );

	// Smoothly animate progress
	useEffect( () => {

		if ( loading.isLoading && loading.progress > progressAnimation ) {

			const timer = setTimeout( () => {

				setProgressAnimation( prev => Math.min( prev + 1, loading.progress ) );

			}, 20 );
			return () => clearTimeout( timer );

		} else if ( ! loading.isLoading ) {

			setProgressAnimation( 0 );

		}

	}, [ progressAnimation, loading.isLoading, loading.progress ] );

	// Reset the "Cancelling…" latch whenever a fresh load starts.
	useEffect( () => {

		if ( ! loading.isLoading ) setCancelling( false );

	}, [ loading.isLoading ] );

	// Calculate time elapsed since loading started
	const [ elapsedTime, setElapsedTime ] = useState( 0 );

	useEffect( () => {

		let intervalId;

		if ( loading.isLoading ) {

			const startTime = Date.now();
			intervalId = setInterval( () => {

				setElapsedTime( Math.floor( ( Date.now() - startTime ) / 1000 ) );

			}, 1000 );

		} else {

			setElapsedTime( 0 );

		}

		return () => {

			if ( intervalId ) clearInterval( intervalId );

		};

	}, [ loading.isLoading ] );

	// Format elapsed time in MM:SS format
	const formatElapsedTime = ( seconds ) => {

		const mins = Math.floor( seconds / 60 );
		const secs = seconds % 60;
		return `${mins.toString().padStart( 2, '0' )}:${secs.toString().padStart( 2, '0' )}`;

	};

	const handleCancel = () => {

		setCancelling( true );
		getApp()?.cancelLoad();

	};

	if ( ! loading.isLoading ) return null;

	// While bytes are streaming, the footer's left slot shows the transfer size
	// instead of the percentage — the bar already conveys the percentage, so
	// showing both is redundant. Falls back to "%" for the processing phases.
	const totalKnown = loading.totalBytes > 0;
	const downloading = totalKnown || loading.loadedBytes > 0;
	const footerLeft = downloading
		? ( totalKnown
			? `${formatBytes( loading.loadedBytes )} / ${formatBytes( loading.totalBytes )}`
			: formatBytes( loading.loadedBytes ) )
		: `${progressAnimation}%`;

	// A build that gave up should not keep spinning at 100%: the scene-memory preflight refuses
	// large scenes on purpose, and a refusal that looks like a hang reads as a bug.
	const failed = loading.failed === true;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div className="absolute inset-0 bg-background/80 backdrop-blur-xs" />
			<div className="relative flex flex-col items-center space-y-6 p-6 rounded-lg bg-card shadow-lg">
				<div className="relative">
					{failed ? (
						<AlertTriangle className="relative h-12 w-12 text-destructive" />
					) : (
						<>
							<div className="absolute -inset-1 bg-linear-to-r from-primary to-primary-foreground opacity-75 blur-lg" />
							<Loader2 className="relative h-12 w-12 animate-spin text-primary" />
						</>
					)}
				</div>

				<div className="flex flex-col items-center gap-4">
					<p className={`text-xl font-semibold ${failed ? 'text-destructive' : 'text-foreground animate-pulse'}`}>
						{failed ? ( loading.failedTitle || "Couldn't load" ) : ( loading.title || 'Loading' )}
					</p>

					{showStatus && loading.status && (
						<p className="text-sm text-muted-foreground text-center max-w-xs">
							{loading.status}
						</p>
					)}

					{failed && (
						<button
							type="button"
							onClick={() => useStore.getState().setLoading( { isLoading: false } )}
							className="text-xs text-muted-foreground transition-colors hover:text-foreground underline-offset-4 hover:underline"
						>
							Dismiss
						</button>
					)}

					{! failed && showProgress && loading.progress > 0 && (
						<div className="w-64">
							<Progress value={progressAnimation} className="h-2" />
							<div className="flex justify-between text-xs text-muted-foreground mt-2 w-full tabular-nums">
								<span>{footerLeft}</span>
								<span>Time: {formatElapsedTime( elapsedTime )}</span>
							</div>
						</div>
					)}

					{/* Show hint during heavy processing phases */}
					{! failed && loading.status && ( loading.status.includes( 'Building BVH' ) || loading.status.includes( 'Processing Textures' ) ) && (
						<p className="text-xs text-muted-foreground -mt-1">
							{loading.progress < 100
								? "This may take a while for large models..."
								: "Almost done..."}
						</p>
					)}

					{! failed && loading.canCancel && (
						<button
							type="button"
							onClick={handleCancel}
							disabled={cancelling}
							className="text-xs text-muted-foreground transition-colors hover:text-foreground underline-offset-4 hover:underline disabled:opacity-60 disabled:no-underline"
						>
							{cancelling ? 'Cancelling…' : 'Cancel'}
						</button>
					)}
				</div>
			</div>
		</div>
	);

};

export default LoadingOverlay;
