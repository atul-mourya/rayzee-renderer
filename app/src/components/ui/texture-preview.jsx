import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight } from 'lucide-react';

const TexturePreview = ( { texture, label, tip, actions, expanded, onToggle } ) => {

	const canvasRef = useRef( null );
	const largeCanvasRef = useRef( null );
	const thumbRef = useRef( null );
	const popoverPosRef = useRef( null );
	const [ hovered, setHovered ] = useState( false );

	const renderTextureToCanvas = useCallback( ( texture, canvas ) => {

		if ( ! canvas || ! texture ) return;

		const context = canvas.getContext( '2d' );
		if ( ! context ) return;

		context.clearRect( 0, 0, canvas.width, canvas.height );

		if ( texture.image && texture.image.width > 0 ) {

			const image = texture.image;
			const scale = Math.min( canvas.width / image.width, canvas.height / image.height );
			const width = image.width * scale;
			const height = image.height * scale;
			const x = ( canvas.width - width ) / 2;
			const y = ( canvas.height - height ) / 2;

			try {

				if ( texture.isDataTexture || texture.isCompressedTexture ) {

					context.fillStyle = '#444';
					context.fillRect( x, y, width, height );
					context.fillStyle = '#fff';
					context.font = '10px Arial';
					context.textAlign = 'center';
					context.fillText( 'DATA', canvas.width / 2, canvas.height / 2 + 4 );

				} else {

					context.drawImage( image, x, y, width, height );

				}

			} catch {

				context.fillStyle = '#333';
				context.fillRect( x, y, width, height );
				context.fillStyle = '#999';
				context.font = '10px Arial';
				context.textAlign = 'center';
				context.fillText( 'IMG', canvas.width / 2, canvas.height / 2 + 4 );

			}

		} else {

			context.fillStyle = '#222';
			context.fillRect( 0, 0, canvas.width, canvas.height );
			context.fillStyle = '#666';
			context.font = '10px Arial';
			context.textAlign = 'center';
			context.fillText( '?', canvas.width / 2, canvas.height / 2 + 4 );

		}

	}, [] );

	useEffect( () => {

		if ( canvasRef.current && texture ) {

			renderTextureToCanvas( texture, canvasRef.current );

		}

	}, [ texture, renderTextureToCanvas ] );

	useEffect( () => {

		if ( largeCanvasRef.current && texture && hovered ) {

			renderTextureToCanvas( texture, largeCanvasRef.current );

		}

	}, [ texture, hovered, renderTextureToCanvas ] );

	const getTextureInfo = () => {

		if ( ! texture?.image ) return null;
		if ( texture.isDataTexture ) return 'Data';
		if ( texture.isCompressedTexture ) return 'Compressed';
		return `${texture.image.width}\u00D7${texture.image.height}`;

	};

	if ( ! texture ) {

		return (
			<div className="w-full h-10 bg-muted/20 rounded border border-dashed border-muted-foreground/20 flex items-center justify-center">
				<span className="text-[10px] opacity-40">No texture</span>
			</div>
		);

	}

	const sizeLabel = getTextureInfo();
	const isToggleable = typeof onToggle === 'function';

	return (
		<div className="relative flex items-center gap-2 group">
			{/* Square thumbnail */}
			<div
				ref={thumbRef}
				className="relative w-10 h-10 shrink-0 rounded border overflow-hidden cursor-pointer bg-muted/20"
				onMouseEnter={() => {

					if ( thumbRef.current ) {

						const rect = thumbRef.current.getBoundingClientRect();
						popoverPosRef.current = { left: rect.left, bottom: window.innerHeight - rect.top + 4 };

					}

					setHovered( true );

				}}
				onMouseLeave={() => setHovered( false )}
			>
				<canvas
					ref={canvasRef}
					width={64}
					height={64}
					className="w-full h-full"
				/>
			</div>

			{/* Label area — clickable to toggle when collapsible */}
			<div
				className={`flex-1 min-w-0 flex items-center gap-1 ${isToggleable ? 'cursor-pointer select-none' : ''}`}
				onClick={isToggleable ? onToggle : undefined}
			>
				{isToggleable && (
					<ChevronRight size={10} className={`shrink-0 opacity-40 transition-transform ${expanded ? 'rotate-90' : ''}`} />
				)}
				<div className="min-w-0">
					{label && <div className="text-[11px] font-medium truncate leading-tight" title={tip}>{label}</div>}
					{sizeLabel && <div className="text-[10px] opacity-40 leading-tight">{sizeLabel}</div>}
				</div>
			</div>

			{/* Action icons — appear on hover */}
			{actions && (
				<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
					{actions}
				</div>
			)}

			{/* Large preview popover — fixed to escape overflow clipping */}
			{hovered && popoverPosRef.current && (
				<div
					className="fixed z-100 bg-background border rounded-lg shadow-xl p-0.5"
					style={{ left: popoverPosRef.current.left, bottom: popoverPosRef.current.bottom }}
				>
					<canvas
						ref={largeCanvasRef}
						width={192}
						height={192}
						className="w-40 h-40 rounded"
					/>
				</div>
			)}
		</div>
	);

};

export { TexturePreview };
