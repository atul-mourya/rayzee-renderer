import { useState, useEffect, useLayoutEffect, useCallback, memo, useMemo, useRef, useSyncExternalStore } from 'react';
import {
	Search, Box, Circle, Cylinder, Camera, ChevronRight, ChevronDown,
	Sun, Flashlight, Boxes, Folder, Shapes, Triangle, LampDesk,
	Eye, EyeOff, Layers, Filter, Trash2
} from 'lucide-react';
import { useStore } from '@/store';
import { getApp } from '@/lib/appProxy';
import { useToast } from '@/hooks/use-toast';
import { ROW_HEIGHT, flattenRows, scrollToShow, ancestorsOf } from '@/lib/outlinerRows';
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

// Theme-compliant styling constants
const STYLES = {
	bg: 'bg-background',
	itemActive: 'bg-accent text-accent-foreground',
	text: 'text-foreground',
	textMuted: 'text-muted-foreground',
	border: 'border-border',
	inputBg: 'bg-muted/50',
	iconOrange: 'text-orange-500',
	iconGreen: 'text-emerald-500',
	iconDefault: 'text-foreground',
};

// Icon component with theme colors
const ObjectIcon = memo( ( { object } ) => {

	const baseClass = "w-3 h-3 opacity-70";

	if ( object.type === 'Group' || object.type === 'Object3D' )
		return <Folder className={cn( baseClass, STYLES.iconDefault, "opacity-70" )} />;

	if ( object.type === 'Scene' )
		return <Boxes className={cn( baseClass, STYLES.iconDefault )} />;

	// Meshes - Orange (Blender convention, mapped to Tailwind palette)
	if ( object.type === 'Mesh' ) {

		const geometryType = object.geometry?.constructor?.name || '';
		const meshClass = cn( baseClass, STYLES.iconOrange );

		if ( geometryType.includes( 'BoxGeometry' ) ) return <Box className={meshClass} />;
		if ( geometryType.includes( 'SphereGeometry' ) ) return <Circle className={meshClass} />;
		if ( geometryType.includes( 'CylinderGeometry' ) ) return <Cylinder className={meshClass} />;
		if ( geometryType.includes( 'ConeGeometry' ) ) return <Triangle className={meshClass} />;
		return <Shapes className={meshClass} />;

	}

	// Lights & Camera - Orange
	if ( object.type === 'DirectionalLight' ) return <Sun className={cn( baseClass, STYLES.iconOrange )} />;
	if ( object.type === 'PointLight' ) return <LampDesk className={cn( baseClass, STYLES.iconOrange )} />;
	if ( object.type === 'SpotLight' ) return <Flashlight className={cn( baseClass, STYLES.iconOrange )} />;
	if ( object.type.includes( 'Camera' ) ) return <Camera className={cn( baseClass, STYLES.iconOrange )} />;

	return <Shapes className={cn( baseClass, STYLES.iconOrange )} />;

} );

ObjectIcon.displayName = 'ObjectIcon';

// Rows hear about selection from here: thousands of rows each subscribed to the store ran a selector
// apiece on every store write.
const rowSelection = {
	uuid: null,
	listeners: new Map(),
	subscribe( uuid, listener ) {

		let set = this.listeners.get( uuid );
		if ( ! set ) this.listeners.set( uuid, set = new Set() );
		set.add( listener );
		return () => {

			set.delete( listener );
			if ( set.size === 0 ) this.listeners.delete( uuid );

		};

	},
	select( uuid ) {

		if ( uuid === this.uuid ) return;
		const previous = this.uuid;
		this.uuid = uuid;
		this.listeners.get( previous )?.forEach( listener => listener() );
		this.listeners.get( uuid )?.forEach( listener => listener() );

	},
};

function useIsSelected( uuid ) {

	const subscribe = useCallback( listener => rowSelection.subscribe( uuid, listener ), [ uuid ] );
	return useSyncExternalStore( subscribe, () => rowSelection.uuid === uuid );

}

const VisibilityToggle = memo( ( { item, isVisible } ) => {

	const handleToggle = useCallback( ( e ) => {

		e.stopPropagation();
		useStore.getState().toggleMeshVisibility( item.uuid );

	}, [ item.uuid ] );

	return (
		<div
			onClick={handleToggle}
			className={cn(
				"flex items-center justify-center w-5 h-5 cursor-pointer hover:bg-accent/50 rounded-sm ml-auto",
				isVisible ? "opacity-70" : "opacity-50"
			)}
		>
			{isVisible ?
				<Eye size={12} className={STYLES.text} /> :
				<EyeOff size={12} className={STYLES.text} />
			}
		</div>
	);

} );

VisibilityToggle.displayName = 'VisibilityToggle';

// Remove a top-level scene object (loaded model). Shown only for removable roots.
const RemoveButton = memo( ( { uuid } ) => {

	const { toast } = useToast();

	const handleRemove = useCallback( async ( e ) => {

		e.stopPropagation();
		try {

			await getApp()?.removeSceneObject( uuid );

		} catch {

			// removeSceneObject rejects if a load/rebuild is already in progress.
			toast( {
				title: "Can't remove yet",
				description: 'Please wait for the current load to finish.',
				variant: 'destructive',
			} );

		}

	}, [ uuid, toast ] );

	return (
		<div
			onClick={handleRemove}
			className="flex items-center justify-center w-5 h-5 cursor-pointer rounded-sm opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground transition-opacity"
			title="Remove from scene"
			aria-label="Remove from scene"
		>
			<Trash2 size={12} className={STYLES.text} />
		</div>
	);

} );

RemoveButton.displayName = 'RemoveButton';

const ChevronToggle = memo( ( { isOpen, onToggle, hasChildren } ) => {

	return (
		<div
			onClick={hasChildren ? onToggle : undefined}
			className={cn(
				"flex items-center justify-center w-5 h-full cursor-pointer hover:text-foreground",
				! hasChildren && "opacity-0 pointer-events-none"
			)}
		>
			{isOpen ?
				<ChevronDown size={14} className="opacity-50" /> :
				<ChevronRight size={14} className="opacity-50" />
			}
		</div>
	);

} );

ChevronToggle.displayName = 'ChevronToggle';

// Only the rows in view, and OVERSCAN either side, are mounted.
const OVERSCAN = 12;
const LIST_PADDING = 4;

// Visibility from the store's events, by uuid, over what the layers were built with; cleared when they are rebuilt.
// A new map on each change, which is the snapshot.
const rowVisibility = {
	map: new Map(),
	listeners: new Set(),
	replace( map ) {

		this.map = map;
		this.listeners.forEach( listener => listener() );

	},
	set( uuid, visible ) {

		this.replace( new Map( this.map ).set( uuid, visible ) );

	},
	clear() {

		if ( this.map.size > 0 ) this.replace( new Map() );

	},
	subscribe( listener ) {

		rowVisibility.listeners.add( listener );
		return () => rowVisibility.listeners.delete( listener );

	},
};

const OutlinerRow = memo( ( { row, onToggleOpen } ) => {

	const { item, depth, parentHidden, visible, open } = row;
	const isSelected = useIsSelected( item.uuid );

	const handleNodeClick = useCallback( ( e ) => {

		e.stopPropagation();
		const app = getApp();
		if ( ! app ) return;

		const { setSelectedObject } = useStore.getState();
		if ( isSelected ) {

			app.interactionManager.select( null );
			app.refreshFrame();
			setSelectedObject( null );
			return;

		}

		const scene = app.getScene();
		const object = scene.getObjectByProperty( 'uuid', item.uuid );
		if ( object ) {

			app.interactionManager.select( object );
			app.refreshFrame();
			setSelectedObject( object );

		}

	}, [ isSelected, item.uuid ] );

	const handleContextMenu = useCallback( ( e ) => {

		e.preventDefault();
		e.stopPropagation();

		const app = getApp();
		if ( ! app ) return;

		const scene = app.getScene();
		const object = scene.getObjectByProperty( 'uuid', item.uuid );

		if ( object ) {

			// Select object if not already selected
			if ( ! isSelected ) {

				app.interactionManager.select( object );
				app.refreshFrame();
				useStore.getState().setSelectedObject( object );

			}

			// Dispatch event for InteractionContextMenu
			app.interactionManager.dispatchEvent( {
				type: 'contextMenuRequested',
				x: e.clientX,
				y: e.clientY,
				selectedObject: object
			} );

		}

	}, [ item.uuid, isSelected ] );

	const toggleOpen = useCallback( ( e ) => {

		e.stopPropagation();
		onToggleOpen( item.uuid );

	}, [ item.uuid, onToggleOpen ] );

	return (
		<div
			className={cn(
				"group flex items-center h-7 pr-1 cursor-pointer transition-colors border-none outline-none min-w-full w-fit select-none",
				isSelected ? STYLES.itemActive : "hover:bg-accent/50 text-muted-foreground hover:text-foreground",
				( parentHidden || ! visible ) && "opacity-50"
			)}
			style={{ paddingLeft: depth * 12 + 8 }}
			onClick={handleNodeClick}
			onContextMenu={handleContextMenu}
		>
			<ChevronToggle isOpen={open} onToggle={toggleOpen} hasChildren={item.children.length > 0} />

			<div className="flex items-center justify-center w-5 h-full">
				<ObjectIcon object={item} />
			</div>

			<span className={cn(
				"text-xs ml-1 flex-1 whitespace-nowrap pr-2",
				isSelected ? "text-accent-foreground font-medium" : "opacity-70"
			)}>
				{item.name}
			</span>

			{/* Right side controls */}
			<div className="sticky right-0 flex items-center h-full pl-2 pr-1 ml-auto">
				<div className="absolute inset-0 bg-background -z-20" />
				<div className={cn(
					"absolute inset-0 -z-10 transition-colors",
					isSelected ? "bg-accent" : "group-hover:bg-accent/0"
				)} />
				{/* Gradient mask for smooth transition - simplified */}
				<div className={cn(
					"absolute left-0 top-0 bottom-0 w-4 -translate-x-full bg-gradient-to-l from-background to-transparent pointer-events-none",
					isSelected && "from-accent"
				)} />
				{item.removable && <RemoveButton uuid={item.uuid} />}
				<VisibilityToggle item={item} isVisible={visible} />
			</div>
		</div>
	);

} );

OutlinerRow.displayName = 'OutlinerRow';

const OutlinerHeader = memo( ( { searchTerm, onSearchChange, filters, onFilterChange } ) => {

	const allChecked = Object.values( filters ).every( Boolean );

	const toggleFilter = ( key ) => {

		onFilterChange( { ...filters, [ key ]: ! filters[ key ] } );

	};

	const toggleAll = () => {

		const newState = ! allChecked;
		const newFilters = Object.keys( filters ).reduce( ( acc, key ) => {

			acc[ key ] = newState;
			return acc;

		}, {} );
		onFilterChange( newFilters );

	};

	return (
		<div className={cn( "flex items-center px-2 py-1 gap-1 shrink-0 border-b h-10", STYLES.bg, STYLES.border )}>
			{/* View Layer Button */}
			<div className={cn( "h-7 w-7 flex items-center justify-center rounded hover:bg-accent/50 cursor-pointer text-muted-foreground hover:text-foreground transition-colors" )}>
				<Layers size={14} strokeWidth={1.5} />
			</div>

			{/* Search Bar */}
			<div className={cn( "flex-1 h-7 flex items-center px-2 rounded gap-2", STYLES.inputBg )}>
				<Search size={12} className="text-muted-foreground/50" />
				<input
					value={searchTerm}
					onChange={onSearchChange}
					placeholder="Search..."
					className="bg-transparent border-none outline-none text-xs text-foreground placeholder:text-muted-foreground/50 w-full focus:ring-0 p-0 leading-none"
				/>
			</div>

			{/* Filter Button */}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<div className={cn( "h-7 w-7 flex items-center justify-center rounded hover:bg-accent/50 cursor-pointer text-muted-foreground hover:text-foreground transition-colors",
						! allChecked && "text-accent-foreground bg-accent/30"
					)}>
						<Filter size={14} strokeWidth={1.5} />
					</div>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-40">
					<DropdownMenuItem
						className="gap-2"
						onSelect={( e ) => {

							e.preventDefault();
							toggleAll();

						}}
					>
						<Checkbox
							checked={allChecked}
							className="pointer-events-none data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
						/>
						<span className="text-xs opacity-70">All</span>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					{[ 'Groups', 'Meshes', 'Lights', 'Cameras' ].map( ( key ) => (
						<DropdownMenuItem
							key={key}
							className="gap-2"
							onSelect={( e ) => {

								e.preventDefault();
								toggleFilter( key );

							}}
						>
							<Checkbox
								checked={filters[ key ]}
								className="pointer-events-none data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
							/>
							<span className="text-xs opacity-70">{key}</span>
						</DropdownMenuItem>
					) )}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);

} );

OutlinerHeader.displayName = 'OutlinerHeader';

const createLayerItem = ( object ) => ( {
	name: object.userData?.__rayzeeName || object.name || `${object.type} ${object.id}`,
	type: object.type,
	uuid: object.uuid,
	geometry: object.geometry?.constructor?.name,
	visible: object.visible ?? true,
	// Top-level loaded models are tagged and can be removed from the scene.
	removable: !! object.userData?.__rayzeeSceneObject,
	children: object.children.map( createLayerItem ),
} );

const isVisibleByType = ( layer, filters ) => {

	if ( layer.type === 'Scene' ) return true;
	if ( layer.type === 'Mesh' ) return filters.Meshes;
	if ( layer.type.includes( 'Light' ) ) return filters.Lights;
	if ( layer.type.includes( 'Camera' ) ) return filters.Cameras;
	if ( layer.type === 'Group' || layer.type === 'Object3D' ) return filters.Groups;
	return true;

};

const filterLayers = ( layers, term, filters ) => layers.reduce( ( acc, layer ) => {

	if ( ! isVisibleByType( layer, filters ) ) return acc;

	const matchesSearch = ! term ||
		layer.name.toLowerCase().includes( term.toLowerCase() ) ||
		layer.type.toLowerCase().includes( term.toLowerCase() );

	const filteredChildren = filterLayers( layer.children, term, filters );

	if ( matchesSearch || filteredChildren.length > 0 ) {

		acc.push( {
			...layer,
			children: filteredChildren,
		} );

	}

	return acc;

}, [] );

const Outliner = () => {

	const [ searchTerm, setSearchTerm ] = useState( '' );
	const [ filters, setFilters ] = useState( {
		Groups: true,
		Meshes: true,
		Lights: true,
		Cameras: true,
	} );
	const layers = useStore( ( state ) => state.layers );
	const setLayers = useStore( ( state ) => state.setLayers );
	const selectedObject = useStore( ( state ) => state.selectedObject );
	// By uuid, so a node keeps its state across a rebuild of the layers, as its row did.
	const [ collapsed, setCollapsed ] = useState( () => new Set() );
	const visibleOf = useSyncExternalStore( rowVisibility.subscribe, () => rowVisibility.map );
	const scrollRef = useRef( null );
	const [ view, setView ] = useState( { top: 0, height: 0 } );
	const revealRef = useRef( selectedObject?.uuid ?? null );
	const [ revealed, setRevealed ] = useState( 0 );

	useLayoutEffect( () => rowSelection.select( selectedObject?.uuid ?? null ), [ selectedObject ] );

	const getSceneElements = useCallback( () => {

		const scene = getApp()?.getScene();
		if ( ! scene ) return [];

		const sceneGraph = [ createLayerItem( scene ) ];

		if ( sceneGraph.length > 0 && sceneGraph[ 0 ].type === 'Scene' ) {

			sceneGraph[ 0 ].name = "Scene Collection";

		}

		return sceneGraph;

	}, [] );

	const updateLayers = useCallback( () => {

		rowVisibility.clear();
		setLayers( getSceneElements() );

	}, [ getSceneElements, setLayers ] );

	useEffect( () => {

		const handleSceneUpdate = () => updateLayers();
		window.addEventListener( 'SceneRebuild', handleSceneUpdate );
		updateLayers();
		return () => {

			window.removeEventListener( 'SceneRebuild', handleSceneUpdate );

		};

	}, [ updateLayers ] );

	useEffect( () => {

		const handleMeshVisibilityChanged = ( event ) => rowVisibility.set( event.detail.uuid, event.detail.visible );
		window.addEventListener( 'meshVisibilityChanged', handleMeshVisibilityChanged );
		return () => window.removeEventListener( 'meshVisibilityChanged', handleMeshVisibilityChanged );

	}, [] );

	// Selection often arrives from the viewport, where the row may be scrolled out of view or under a collapsed group.
	useEffect( () => useStore.subscribe( ( state, previous ) => {

		const object = state.selectedObject;
		if ( ! object || object === previous.selectedObject ) return;
		const ancestors = ancestorsOf( state.layers, object.uuid );
		if ( ! ancestors ) return;
		revealRef.current = object.uuid;
		setCollapsed( set => ancestors.some( uuid => set.has( uuid ) ) ? new Set( [ ...set ].filter( uuid => ! ancestors.includes( uuid ) ) ) : set );
		setRevealed( n => n + 1 );

	} ), [] );

	const filteredLayers = useMemo( () =>
		filterLayers( layers, searchTerm, filters )
	, [ layers, searchTerm, filters ] );

	const rows = useMemo( () => flattenRows( filteredLayers, collapsed, visibleOf ), [ filteredLayers, collapsed, visibleOf ] );

	const toggleOpen = useCallback( ( uuid ) => {

		setCollapsed( set => {

			const next = new Set( set );
			if ( next.has( uuid ) ) next.delete( uuid );
			else next.add( uuid );
			return next;

		} );

	}, [] );

	const measure = useCallback( () => {

		const el = scrollRef.current;
		if ( el ) setView( v => ( v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight } ) );

	}, [] );

	useLayoutEffect( () => {

		const el = scrollRef.current;
		if ( ! el ) return;
		measure();
		const observer = new ResizeObserver( measure );
		observer.observe( el );
		return () => observer.disconnect();

	}, [ measure ] );

	useLayoutEffect( () => {

		const uuid = revealRef.current;
		const el = scrollRef.current;
		if ( ! uuid || ! el ) return;
		revealRef.current = null;
		const index = rows.findIndex( row => row.item.uuid === uuid );
		if ( index < 0 ) return;
		el.scrollTop = scrollToShow( index, el.scrollTop - LIST_PADDING, el.clientHeight ) + LIST_PADDING;
		measure();

	}, [ rows, revealed, measure ] );

	const handleSearchChange = useCallback( ( e ) => {

		setSearchTerm( e.target.value );

	}, [] );

	const handleFilterChange = useCallback( ( newFilters ) => {

		setFilters( newFilters );

	}, [] );

	const first = Math.max( 0, Math.floor( ( view.top - LIST_PADDING ) / ROW_HEIGHT ) - OVERSCAN );
	const last = Math.min( rows.length, Math.ceil( ( view.top + view.height ) / ROW_HEIGHT ) + OVERSCAN );

	return (
		<div className={cn( "w-full h-full flex flex-col overflow-hidden select-none", STYLES.bg )}>
			<OutlinerHeader
				searchTerm={searchTerm}
				onSearchChange={handleSearchChange}
				filters={filters}
				onFilterChange={handleFilterChange}
			/>
			<div ref={scrollRef} className="flex-1 overflow-auto py-1" onScroll={measure}>
				<div className="flex flex-col min-w-full w-fit">
					{rows.length > 0 ? (
						<>
							<div style={{ height: first * ROW_HEIGHT }} />
							{rows.slice( first, last ).map( ( row ) => (
								<OutlinerRow key={row.item.uuid} row={row} onToggleOpen={toggleOpen} />
							) )}
							<div style={{ height: ( rows.length - last ) * ROW_HEIGHT }} />
						</>
					) : (
						<div className="text-xs text-muted-foreground/50 px-4 py-8 text-center italic">
            No items found
						</div>
					)}
				</div>
			</div>
		</div>
	);

};

export default Outliner;
