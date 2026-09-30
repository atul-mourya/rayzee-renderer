import * as React from 'react';
import { cn } from '@/lib/utils';
import { Box3, Vector3 } from 'three';
import { Eye, EyeOff, Focus, Layers, Copy, Clipboard, Grid3x3 } from 'lucide-react';
import { useStore } from '@/store';
import { getApp } from '@/lib/appProxy';
import { EngineEvents } from 'rayzee';
import { useActiveApp } from '@/hooks/useActiveApp';

/**
 * MenuItem - Standalone menu item matching ContextMenuItem styling exactly
 * Does not require RadixUI context (no ContextMenuPrimitive.Item)
 */
const MenuItem = React.forwardRef( ( { className, inset, disabled, children, onClick, ...props }, ref ) => (
	<div
		ref={ref}
		className={cn(
			'relative flex cursor-default select-none items-center rounded-sm px-2 py-1 text-xs opacity-75 outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
			inset && 'pl-8',
			className
		)}
		data-disabled={disabled || undefined}
		onClick={disabled ? undefined : onClick}
		tabIndex={disabled ? - 1 : 0}
		role="menuitem"
		aria-disabled={disabled}
		{...props}
	>
		{children}
	</div>
) );
MenuItem.displayName = 'MenuItem';

/**
 * MenuSeparator - Standalone separator matching ContextMenuSeparator styling exactly
 * Does not require RadixUI context
 */
const MenuSeparator = React.forwardRef( ( { className, ...props }, ref ) => (
	<div
		ref={ref}
		className={cn( '-mx-1 my-1 h-px bg-border', className )}
		role="separator"
		aria-orientation="horizontal"
		{...props}
	/>
) );
MenuSeparator.displayName = 'MenuSeparator';

/**
 * InteractionContextMenu
 *
 * A context menu that appears when right-clicking on selected objects
 * Listens to events from InteractionManager and renders a styled menu
 * Uses the same styling classes as context-menu.jsx for consistency
 */
const InteractionContextMenu = () => {

	'use no memo';

	const activeApp = useActiveApp();

	const [ menuState, setMenuState ] = React.useState( {
		visible: false,
		x: 0,
		y: 0,
		selectedObject: null
	} );

	const [ copiedMaterial, setCopiedMaterial ] = React.useState( null );
	const [ isIsolated, setIsIsolated ] = React.useState( false );
	const isolatedObjectRef = React.useRef( null );
	const visibilityStateBeforeIsolate = React.useRef( null );
	const menuRef = React.useRef( null );

	const toggleMeshVisibility = useStore( ( state ) => state.toggleMeshVisibility );
	const setMeshVisibility = useStore( ( state ) => state.setMeshVisibility );

	const closeMenu = React.useCallback( () => {

		setMenuState( prev => ( { ...prev, visible: false } ) );

	}, [] );

	const calculateMenuPosition = React.useCallback( ( x, y, menuElement ) => {

		if ( ! menuElement ) return { x, y };

		const menuRect = menuElement.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		let finalX = x;
		let finalY = y;

		if ( x + menuRect.width > viewportWidth ) {

			finalX = viewportWidth - menuRect.width - 8;

		}

		if ( y + menuRect.height > viewportHeight ) {

			finalY = viewportHeight - menuRect.height - 8;

		}

		if ( finalX < 8 ) {

			finalX = 8;

		}

		if ( finalY < 8 ) {

			finalY = 8;

		}

		return { x: finalX, y: finalY };

	}, [] );

	const handleHide = React.useCallback( () => {

		const object = menuState.selectedObject;

		if ( ! object ) return;

		// Use store's toggleMeshVisibility for synchronized visibility management
		// This ensures Outliner and other components stay in sync
		toggleMeshVisibility( object.uuid );

		// Deselect the object
		const app = getApp();
		app?.interactionManager?.dispatchEvent( { type: 'objectDeselected' } );

		closeMenu();

	}, [ menuState.selectedObject, toggleMeshVisibility, closeMenu ] );

	const handleFocus = React.useCallback( () => {

		const app = getApp();
		const object = menuState.selectedObject;

		if ( ! app || ! object ) return;

		const box = new Box3().setFromObject( object );
		const center = new Vector3();
		box.getCenter( center );

		app.cameraManager.focusOn( center );

		closeMenu();

	}, [ menuState.selectedObject, closeMenu ] );

	const handleIsolateToggle = React.useCallback( () => {

		const app = getApp();
		const selectedObject = menuState.selectedObject;
		if ( ! app || ! selectedObject ) return;

		const scene = app.getScene();

		if ( isIsolated ) {

			// Un-isolate: restore previous visibility state
			if ( visibilityStateBeforeIsolate.current ) {

				scene.traverse( ( child ) => {

					if ( child.isMesh && visibilityStateBeforeIsolate.current.has( child.uuid ) ) {

						// Restore the saved visibility state using store method for synchronization
						const wasVisible = visibilityStateBeforeIsolate.current.get( child.uuid );
						setMeshVisibility( child.uuid, wasVisible );

					}

				} );

			}

			setIsIsolated( false );
			isolatedObjectRef.current = null;
			visibilityStateBeforeIsolate.current = null;

		} else {

			// Isolate: save current visibility state then hide all except selected
			const visibilityMap = new Map();

			scene.traverse( ( child ) => {

				if ( child.isMesh ) {

					const isFloorPlane = child.name === 'Ground';
					const isHelper = child.name.includes( 'Helper' );

					if ( isFloorPlane || isHelper ) return;

					// Save current visibility state
					visibilityMap.set( child.uuid, child.visible );

					// Hide all meshes except the selected one using store method for synchronization
					if ( child.uuid !== selectedObject.uuid ) {

						setMeshVisibility( child.uuid, false );

					}

				}

			} );

			// Store the visibility state for later restoration
			visibilityStateBeforeIsolate.current = visibilityMap;

			setIsIsolated( true );
			isolatedObjectRef.current = selectedObject.uuid;

		}

		closeMenu();

	}, [ menuState.selectedObject, isIsolated, setMeshVisibility, closeMenu ] );

	const handleCopyMaterial = React.useCallback( () => {

		const object = menuState.selectedObject;

		if ( ! object || ! object.material ) return;

		const material = object.material;

		// Extract material properties
		const materialData = {
			color: material.color?.getHex(),
			metalness: material.metalness,
			roughness: material.roughness,
			opacity: material.opacity,
			transparent: material.transparent,
			emissive: material.emissive?.getHex(),
			emissiveIntensity: material.emissiveIntensity,
			clearcoat: material.clearcoat,
			clearcoatRoughness: material.clearcoatRoughness,
			ior: material.ior,
			transmission: material.transmission,
			thickness: material.thickness,
			specularIntensity: material.specularIntensity,
			specularColor: material.specularColor?.getHex(),
			sheen: material.sheen,
			sheenRoughness: material.sheenRoughness,
			sheenColor: material.sheenColor?.getHex(),
			iridescence: material.iridescence,
			iridescenceIOR: material.iridescenceIOR,
			normalScale: material.normalScale?.x,
			bumpScale: material.bumpScale,
			// Textures (kept in state for internal copy-paste, ignored in JSON)
			map: material.map,
			normalMap: material.normalMap,
			roughnessMap: material.roughnessMap,
			metalnessMap: material.metalnessMap,
			emissiveMap: material.emissiveMap,
			bumpMap: material.bumpMap,
			displacementMap: material.displacementMap,
			// Store reference for paste validation
			_objectUUID: object.uuid
		};

		// Store in component state
		setCopiedMaterial( materialData );

		// Create a JSON-safe version for clipboard (exclude textures)
		const jsonSafeData = { ...materialData };
		delete jsonSafeData.map;
		delete jsonSafeData.normalMap;
		delete jsonSafeData.roughnessMap;
		delete jsonSafeData.metalnessMap;
		delete jsonSafeData.emissiveMap;
		delete jsonSafeData.bumpMap;
		delete jsonSafeData.displacementMap;

		// Also copy to clipboard as JSON
		navigator.clipboard.writeText( JSON.stringify( jsonSafeData, null, 2 ) )
			.catch( err => console.error( 'Failed to copy material:', err ) );

		closeMenu();

	}, [ menuState.selectedObject, closeMenu ] );

	// Handle paste material action
	const handlePasteMaterial = React.useCallback( () => {

		const app = getApp();
		const object = menuState.selectedObject;

		if ( ! app || ! object || ! object.material || ! copiedMaterial ) return;

		const material = object.material;
		const pt = app.stages.pathTracer;

		// Apply material properties
		/* eslint-disable react-compiler/react-compiler -- intentional Three.js object mutation, not React state */
		if ( copiedMaterial.color !== undefined && material.color ) material.color.setHex( copiedMaterial.color );
		if ( copiedMaterial.metalness !== undefined ) material.metalness = copiedMaterial.metalness;
		if ( copiedMaterial.roughness !== undefined ) material.roughness = copiedMaterial.roughness;
		if ( copiedMaterial.opacity !== undefined ) material.opacity = copiedMaterial.opacity;
		if ( copiedMaterial.emissive !== undefined && material.emissive ) material.emissive.setHex( copiedMaterial.emissive );
		if ( copiedMaterial.emissiveIntensity !== undefined ) material.emissiveIntensity = copiedMaterial.emissiveIntensity;
		if ( copiedMaterial.clearcoat !== undefined ) material.clearcoat = copiedMaterial.clearcoat;
		if ( copiedMaterial.clearcoatRoughness !== undefined ) material.clearcoatRoughness = copiedMaterial.clearcoatRoughness;
		if ( copiedMaterial.ior !== undefined ) material.ior = copiedMaterial.ior;
		if ( copiedMaterial.transmission !== undefined ) material.transmission = copiedMaterial.transmission;
		if ( copiedMaterial.thickness !== undefined ) material.thickness = copiedMaterial.thickness;
		if ( copiedMaterial.specularIntensity !== undefined ) material.specularIntensity = copiedMaterial.specularIntensity;
		if ( copiedMaterial.specularColor !== undefined && material.specularColor ) material.specularColor.setHex( copiedMaterial.specularColor );
		if ( copiedMaterial.sheen !== undefined ) material.sheen = copiedMaterial.sheen;
		if ( copiedMaterial.sheenRoughness !== undefined ) material.sheenRoughness = copiedMaterial.sheenRoughness;
		if ( copiedMaterial.sheenColor !== undefined && material.sheenColor ) material.sheenColor.setHex( copiedMaterial.sheenColor );
		if ( copiedMaterial.iridescence !== undefined ) material.iridescence = copiedMaterial.iridescence;
		if ( copiedMaterial.iridescenceIOR !== undefined ) material.iridescenceIOR = copiedMaterial.iridescenceIOR;
		if ( copiedMaterial.normalScale !== undefined && material.normalScale ) material.normalScale.set( copiedMaterial.normalScale, copiedMaterial.normalScale );
		if ( copiedMaterial.bumpScale !== undefined ) material.bumpScale = copiedMaterial.bumpScale;

		// Apply textures
		if ( copiedMaterial.map !== undefined ) material.map = copiedMaterial.map;
		if ( copiedMaterial.normalMap !== undefined ) material.normalMap = copiedMaterial.normalMap;
		if ( copiedMaterial.roughnessMap !== undefined ) material.roughnessMap = copiedMaterial.roughnessMap;
		if ( copiedMaterial.metalnessMap !== undefined ) material.metalnessMap = copiedMaterial.metalnessMap;
		if ( copiedMaterial.emissiveMap !== undefined ) material.emissiveMap = copiedMaterial.emissiveMap;
		if ( copiedMaterial.bumpMap !== undefined ) material.bumpMap = copiedMaterial.bumpMap;
		if ( copiedMaterial.displacementMap !== undefined ) material.displacementMap = copiedMaterial.displacementMap;
		/* eslint-enable react-compiler/react-compiler */

		material.needsUpdate = true;

		// Perform full material update to sync all properties and texture indices
		if ( pt?.materialData ) {

			pt.materialData.updateMaterial( object.userData?.materialIndex ?? 0, material );

		} else {

			console.warn( 'PathTracerStage.materialData not available' );

		}

		// Reset path tracer to see changes
		app.reset();

		closeMenu();

	}, [ menuState.selectedObject, copiedMaterial, closeMenu ] );

	const handleDeselect = React.useCallback( () => {

		closeMenu();

		// Dispatch deselect event through InteractionManager
		// This triggers the proper event flow in PathTracerApp
		const app = getApp();
		if ( app ) {

			app.interactionManager.dispatchEvent( { type: 'objectDeselected' } );

		}

		// Note: We keep the isolated state even when deselecting
		// This allows the user to keep objects isolated while exploring

	}, [ closeMenu ] );

	React.useEffect( () => {

		const app = activeApp;
		if ( ! app ) return;

		const handleModelLoaded = () => {

			// Reset isolate state when a new model is loaded
			setIsIsolated( false );
			isolatedObjectRef.current = null;
			visibilityStateBeforeIsolate.current = null; // Clear saved visibility state

		};

		app.addEventListener( EngineEvents.MODEL_LOADED, handleModelLoaded );

		return () => app?.removeEventListener( EngineEvents.MODEL_LOADED, handleModelLoaded );

	}, [ activeApp ] );

	React.useEffect( () => {

		const app = activeApp;
		if ( ! app ) return;

		const handleContextMenuRequested = ( event ) => {

			setMenuState( {
				visible: true,
				x: event.x,
				y: event.y,
				selectedObject: event.selectedObject
			} );

		};

		return app.interactionManager.on( 'contextMenuRequested', handleContextMenuRequested );

	}, [ activeApp ] );

	React.useEffect( () => {

		if ( ! menuState.visible ) return;

		const handleClickOutside = ( event ) => {

			if ( menuRef.current && ! menuRef.current.contains( event.target ) ) {

				closeMenu();

			}

		};

		const handleKeyDown = ( event ) => {

			if ( event.key === 'Escape' ) {

				event.preventDefault();
				closeMenu();
				return;

			}

			if ( ! menuRef.current ) return;

			const menuItems = Array.from( menuRef.current.querySelectorAll( '[role="menuitem"]:not([aria-disabled="true"])' ) );
			const currentIndex = menuItems.indexOf( document.activeElement );

			if ( event.key === 'ArrowDown' ) {

				event.preventDefault();
				const nextIndex = ( currentIndex + 1 ) % menuItems.length;
				menuItems[ nextIndex ]?.focus();

			} else if ( event.key === 'ArrowUp' ) {

				event.preventDefault();
				const prevIndex = currentIndex <= 0 ? menuItems.length - 1 : currentIndex - 1;
				menuItems[ prevIndex ]?.focus();

			} else if ( event.key === 'Enter' || event.key === ' ' ) {

				event.preventDefault();
				document.activeElement?.click();

			}

		};

		// Use pointerdown with capture=true to handle clicks even if propagation is stopped by other components
		const timer = setTimeout( () => {

			document.addEventListener( 'pointerdown', handleClickOutside, true );
			document.addEventListener( 'keydown', handleKeyDown );

		}, 0 );

		return () => {

			clearTimeout( timer );
			document.removeEventListener( 'pointerdown', handleClickOutside, true );
			document.removeEventListener( 'keydown', handleKeyDown );

		};

	}, [ menuState.visible, closeMenu ] );

	React.useEffect( () => {

		if ( menuState.visible && menuRef.current ) {

			const { x, y } = calculateMenuPosition( menuState.x, menuState.y, menuRef.current );

			if ( x !== menuState.x || y !== menuState.y ) {

				setMenuState( prev => ( { ...prev, x, y } ) );

			}

			menuRef.current.focus();

		}

	}, [ menuState.visible, menuState.x, menuState.y, calculateMenuPosition ] );

	if ( ! menuState.visible ) return null;

	const isMesh = menuState.selectedObject?.type === 'Mesh' || menuState.selectedObject?.isMesh;

	return (
		<div
			ref={menuRef}
			id="interaction-context-menu"
			className={cn(
				'z-50 min-w-[8rem] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
			)}
			data-state="open"
			role="menu"
			tabIndex={- 1}
			onContextMenu={( e ) => e.preventDefault()}
			style={{
				position: 'fixed',
				left: `${menuState.x}px`,
				top: `${menuState.y}px`,
			}}
		>
			<MenuItem onClick={handleHide}>
				{menuState.selectedObject?.visible ? (
					<>
						<EyeOff className="h-3 w-3" />
						<span className="ml-2">Hide</span>
					</>
				) : (
					<>
						<Eye className="h-3 w-3" />
						<span className="ml-2">Show</span>
					</>
				)}
			</MenuItem>

			<MenuItem onClick={handleFocus}>
				<Focus className="h-3 w-3" />
				<span className="ml-2">Focus</span>
			</MenuItem>

			<MenuItem onClick={handleIsolateToggle}>
				{isIsolated ? (
					<>
						<Grid3x3 className="h-3 w-3" />
						<span className="ml-2">Un-isolate</span>
					</>
				) : (
					<>
						<Layers className="h-3 w-3" />
						<span className="ml-2">Isolate</span>
					</>
				)}
			</MenuItem>

			{isMesh && (
				<>
					<MenuSeparator />

					<MenuItem onClick={handleCopyMaterial}>
						<Copy className="h-3 w-3" />
						<span className="ml-2">Copy Material</span>
					</MenuItem>

					<MenuItem onClick={handlePasteMaterial} disabled={! copiedMaterial}>
						<Clipboard className="h-3 w-3" />
						<span className="ml-2">Paste Material</span>
					</MenuItem>
				</>
			)}

			<MenuSeparator />

			<MenuItem onClick={handleDeselect}>
				<Eye className="h-3 w-3" />
				<span className="ml-2">Deselect</span>
			</MenuItem>
		</div>
	);

};

export default InteractionContextMenu;
