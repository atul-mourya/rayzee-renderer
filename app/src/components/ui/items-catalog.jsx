import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { InfoIcon, Search, Loader2, Filter, X, Clock, Trash2, Star } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useRecentSearches } from '@/hooks/useRecentSearches';
import { useFavoritesStore } from '@/store';

// Stable per-item identity: prefer an explicit unique id (e.g. Sketchfab uid),
// else the name. Names are NOT guaranteed unique (Sketchfab returns dupes), so
// keys/selection must not rely on name alone.
const getItemKey = ( item ) => item.id || item.name;


/** data []: Array of objects representing items to display in the catalog {
	// Required Properties
	name: string;      // Used for item identification and display
	preview: string;   // URL/path to item's preview image
	// Optional Properties
	label?: string;    // Alternative display text (shown in tooltip)
	category?: string[];  // Array of categories for filtering
	tags?: string[];      // Array of tags for filtering
	redirection?: string;  // URL for "More Info" button link
}
*/

export const ItemsCatalog = ( {
	className,
	data = [],
	value,
	onValueChange,
	isLoading = false,
	error = null,
	catalogType = 'default', // New prop for identifying catalog type
	hideSearch = false, // Hide the built-in search/filter row (parent drives search)
	// Per-card hover actions. When provided, each card reveals these buttons on a
	// hover scrim instead of loading on click — e.g. Replace/Add for models. Shape:
	// { key, label, icon?, variant?, onClick(item), disabled?(item) }. onClick may
	// be async; the card shows a spinner and blocks re-entry until it settles.
	actions = null,
	...props
} ) => {

	const [ searchInput, setSearchInput ] = useState( '' );
	const [ busyKey, setBusyKey ] = useState( null );
	const [ debouncedSearchTerm, setDebouncedSearchTerm ] = useState( '' );
	const [ filterType, setFilterType ] = useState( '' );
	const [ filterValue, setFilterValue ] = useState( '' );

	// Recent searches hook
	const {
		recentSearches,
		addRecentSearch,
		removeRecentSearch,
		clearRecentSearches,
		hasRecentSearches
	} = useRecentSearches( catalogType );

	// Favorites hook
	const { toggleFavorite, isFavorite } = useFavoritesStore();

	// Refs for scroll functionality
	const scrollAreaRef = useRef( null );
	const itemRefs = useRef( {} );
	const debounceTimeoutRef = useRef( null );
	const searchInputRef = useRef( null );

	// Debounce search input
	useEffect( () => {

		if ( debounceTimeoutRef.current ) {

			clearTimeout( debounceTimeoutRef.current );

		}

		debounceTimeoutRef.current = setTimeout( () => {

			setDebouncedSearchTerm( searchInput );

		}, 150 );

		return () => {

			if ( debounceTimeoutRef.current ) {

				clearTimeout( debounceTimeoutRef.current );

			}

		};

	}, [ searchInput ] );

	const categories = useMemo( () => {

		return Array.from( new Set(
			data.flatMap( item => item.category || [] ).filter( Boolean )
		) );

	}, [ data ] );

	const tags = useMemo( () => {

		return Array.from( new Set(
			data.flatMap( item => item.tags || [] ).filter( Boolean )
		) );

	}, [ data ] );

	// Pre-process search strings for better performance
	const searchIndex = useMemo( () => {

		return data.map( item => {

			const searchableText = [
				item.name || '',
				item.label || '',
				...( item.category || [] ),
				...( item.tags || [] )
			].join( ' ' ).toLowerCase();

			return {
				item,
				searchableText,
				name: ( item.name || '' ).toLowerCase(),
				tags: ( item.tags || [] ).map( tag => tag.toLowerCase() ),
				categories: ( item.category || [] ).map( cat => cat.toLowerCase() )
			};

		} );

	}, [ data ] );

	// Optimized filtering with pre-computed search index and favorites sorting
	const filteredItems = useMemo( () => {

		let results = searchIndex;

		// Apply search filter
		if ( debouncedSearchTerm ) {

			const searchLower = debouncedSearchTerm.toLowerCase();
			results = results.filter( ( { searchableText } ) =>
				searchableText.includes( searchLower )
			);

		}

		// Apply category/tag filters
		if ( filterType === 'category' && filterValue ) {

			results = results.filter( ( { categories } ) =>
				categories.includes( filterValue.toLowerCase() )
			);

		} else if ( filterType === 'tag' && filterValue ) {

			results = results.filter( ( { tags } ) =>
				tags.includes( filterValue.toLowerCase() )
			);

		}

		// Sort by favorites first, then by original order
		const items = results.map( ( { item } ) => item );

		return items.sort( ( a, b ) => {

			const aIsFavorite = isFavorite( catalogType, a.id || a.name );
			const bIsFavorite = isFavorite( catalogType, b.id || b.name );

			// Favorites come first
			if ( aIsFavorite && ! bIsFavorite ) return - 1;
			if ( ! aIsFavorite && bIsFavorite ) return 1;

			// Maintain original order for items with same favorite status
			return 0;

		} );

	}, [ searchIndex, debouncedSearchTerm, filterType, filterValue, catalogType, isFavorite ] );

	const handleItemSelection = useCallback( ( key ) => {

		const index = data.findIndex( item => getItemKey( item ) === key );
		onValueChange( index.toString() );

		// Save current search term when user selects an item (indicates successful search)
		if ( searchInput && searchInput.trim().length >= 2 ) {

			addRecentSearch( searchInput.trim() );

		}

	}, [ data, onValueChange, searchInput, addRecentSearch ] );

	// Run a per-card hover action (Replace/Add). Blocks re-entry across the whole
	// catalog while one action is in flight and shows a spinner on that card.
	const handleAction = useCallback( async ( action, item, e ) => {

		e.stopPropagation();
		if ( busyKey || action.disabled?.( item ) ) return;

		const key = getItemKey( item );
		try {

			setBusyKey( key );
			await action.onClick( item );

		} finally {

			setBusyKey( null );

		}

	}, [ busyKey ] );

	const handleFilterTypeChange = useCallback( ( newType ) => {

		setFilterType( newType );
		setFilterValue( '' );

	}, [] );

	const handleFilterValueChange = useCallback( ( newValue ) => {

		setFilterValue( newValue );

		// Save current search term when user applies filter (indicates active searching)
		if ( searchInput && searchInput.trim().length >= 2 ) {

			addRecentSearch( searchInput.trim() );

		}

	}, [ searchInput, addRecentSearch ] );

	const handleClearSearch = useCallback( () => {

		setSearchInput( '' );
		setDebouncedSearchTerm( '' );

	}, [] );

	// Handle selecting a recent search
	const handleRecentSearchSelect = useCallback( ( searchTerm ) => {

		setSearchInput( searchTerm );
		setDebouncedSearchTerm( searchTerm );
		if ( searchInputRef.current ) {

			searchInputRef.current.focus();

		}

	}, [] );

	// Handle removing a single recent search
	const handleRemoveRecentSearch = useCallback( ( searchTerm, e ) => {

		e.stopPropagation();
		removeRecentSearch( searchTerm );

	}, [ removeRecentSearch ] );

	// Handle search input change - memoized to prevent recreation
	const handleSearchInputChange = useCallback( ( e ) => {

		setSearchInput( e.target.value );

	}, [] );

	// Handle input focus - could show recent searches
	const handleInputFocus = useCallback( () => {

		// Focus behavior can be added here if needed

	}, [] );

	// Handle Enter key for search
	const handleSearchKeyDown = useCallback( ( e ) => {

		if ( e.key === 'Enter' && searchInput.trim().length >= 2 ) {

			addRecentSearch( searchInput.trim() );

		}

	}, [ searchInput, addRecentSearch ] );

	// Handle favorite toggle
	const handleFavoriteToggle = useCallback( ( item, e ) => {

		e.stopPropagation();
		toggleFavorite( catalogType, item.id || item.name );

	}, [ catalogType, toggleFavorite ] );

	// Helper function to check if an item is selected
	const isItemSelected = useCallback( ( item ) => {

		if ( value === null || value === undefined ) return false;
		const selectedIndex = parseInt( value );
		const selectedItem = data[ selectedIndex ];
		return selectedItem && getItemKey( selectedItem ) === getItemKey( item );

	}, [ value, data ] );

	// Auto-scroll to selected item
	useEffect( () => {

		if ( value !== null && value !== undefined && data.length > 0 ) {

			const selectedIndex = parseInt( value );
			const selectedItem = data[ selectedIndex ];
			const selectedKey = selectedItem ? getItemKey( selectedItem ) : null;
			const isItemVisible = filteredItems.some( item => getItemKey( item ) === selectedKey );

			if ( selectedItem && isItemVisible && itemRefs.current[ selectedKey ] ) {

				const timeoutId = setTimeout( () => {

					const element = itemRefs.current[ selectedKey ];
					if ( element && element.isConnected ) {

						element.scrollIntoView( {
							behavior: 'smooth',
							block: 'center',
							inline: 'nearest'
						} );

					}

				}, 50 );

				return () => clearTimeout( timeoutId );

			}

		}

	}, [ value, data, filteredItems ] );

	// Clean up refs when data changes. Refs are stored under getItemKey(item)
	// (id||name), so prune by the same key — pruning by name would delete every
	// ref for id-bearing catalogs (e.g. Sketchfab, where id=uid != name).
	useEffect( () => {

		const currentKeys = new Set( data.map( item => getItemKey( item ) ) );
		Object.keys( itemRefs.current ).forEach( key => {

			if ( ! currentKeys.has( key ) ) {

				delete itemRefs.current[ key ];

			}

		} );

	}, [ data ] );

	// Optimized highlight function - only compute when needed
	const highlightSearchTerm = useCallback( ( text, searchTerm ) => {

		if ( ! searchTerm || ! text || searchTerm.length < 2 ) return text;

		try {

			const regex = new RegExp( `(${searchTerm.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' )})`, 'gi' );
			const parts = text.split( regex );

			if ( parts.length === 1 ) return text;

			return parts.map( ( part, index ) =>
				regex.test( part ) ?
					<mark key={index} className="bg-yellow-200 dark:bg-yellow-800 px-0.5 rounded">{part}</mark> :
					part
			);

		} catch {

			return text;

		}

	}, [] );

	// Memoize search summary to avoid recalculation
	const searchSummary = useMemo( () => {

		if ( ! debouncedSearchTerm ) return null;

		const totalResults = filteredItems.length;
		const totalItems = data.length;

		if ( totalResults === 0 ) {

			return `No results found for "${debouncedSearchTerm}"`;

		}

		if ( totalResults === totalItems ) {

			return null;

		}

		return `Found ${totalResults} of ${totalItems} items`;

	}, [ debouncedSearchTerm, filteredItems.length, data.length ] );

	if ( error ) {

		return (
			<div className="flex items-center justify-center h-64 text-red-500" role="alert">
				<p>{error}</p>
			</div>
		);

	}

	const showFilters = categories.length > 0 || tags.length > 0;

	return (
		<TooltipProvider>
			<div className={cn( "flex flex-col h-full mx-2", className )} {...props}>
				{ ! hideSearch && (
					<div className="flex items-center mb-2 gap-2">
						<div className="relative grow py-1">
							<Search size={14} className="absolute left-1 top-1/2 transform -translate-y-1/2 text-muted-foreground" />
							<Input
								ref={searchInputRef}
								type="text"
								placeholder="item, tag, category"
								className="h-5 pl-5 pr-6 outline-hidden text-xs w-full rounded-full bg-primary/20"
								value={searchInput}
								onChange={handleSearchInputChange}
								onFocus={handleInputFocus}
								onKeyDown={handleSearchKeyDown}
								aria-label="Search items, tags, and categories"
							/>
							{searchInput && (
								<Button
									variant="ghost"
									size="icon"
									className="absolute right-0.5 top-1/2 transform -translate-y-1/2 h-4 w-4 rounded-full hover:bg-muted"
									onClick={handleClearSearch}
									aria-label="Clear search"
								>
									<X size={10} className="text-muted-foreground" />
								</Button>
							)}

							{/* Recent Searches Dropdown */}
							{hasRecentSearches && (
								<Popover>
									<PopoverTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className="absolute right-1 top-1/2 transform -translate-y-1/2 h-4 w-4 rounded-full hover:bg-muted"
											aria-label="Show recent searches"
										>
											<Clock size={10} className="text-muted-foreground" />
										</Button>
									</PopoverTrigger>
									<PopoverContent className="w-[280px] p-0" align="start">
										<div className="p-2">
											<div className="flex items-center justify-between mb-2">
												<h4 className="text-sm font-medium">Recent Searches</h4>
												<Button
													variant="ghost"
													size="sm"
													onClick={clearRecentSearches}
													className="h-6 px-2 text-xs hover:bg-destructive hover:text-destructive-foreground"
													aria-label="Clear all recent searches"
												>
													<Trash2 size={12} className="mr-1" />
												Clear
												</Button>
											</div>
											<ScrollArea className="max-h-[200px]">
												<div className="space-y-1">
													{recentSearches.map( ( searchTerm, index ) => (
														<div
															key={index}
															className="flex items-center group hover:bg-accent rounded-sm"
														>
															<Button
																variant="ghost"
																className="flex-1 justify-start h-7 px-2 text-xs truncate"
																onClick={() => handleRecentSearchSelect( searchTerm )}
															>
																<Clock size={10} className="mr-2 flex-shrink-0 text-muted-foreground" />
																<span className="truncate">{searchTerm}</span>
															</Button>
															<Button
																variant="ghost"
																size="sm"
																className="h-7 w-7 opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground"
																onClick={( e ) => handleRemoveRecentSearch( searchTerm, e )}
																aria-label={`Remove "${searchTerm}" from recent searches`}
															>
																<X size={10} />
															</Button>
														</div>
													) )}
												</div>
											</ScrollArea>
										</div>
									</PopoverContent>
								</Popover>
							)}
						</div>
						{showFilters && (
							<Popover>
								<PopoverTrigger asChild>
									<Button
										size="icon"
										variant="outline"
										className="h-5 w-5 text-xs rounded-full hover:bg-accent bg-primary/20"
									>
										<Filter size={11}/>
									</Button>
								</PopoverTrigger>
								<PopoverContent className="w-[200px] p-0" align="end">
									<div className="p-1 space-y-1">
										<Select value={filterType} onValueChange={handleFilterTypeChange}>
											<SelectTrigger aria-label="Filter type" className="h-5 rounded-full">
												<SelectValue placeholder="Filter by" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="all">All</SelectItem>
												{categories.length > 0 && <SelectItem value="category">Category</SelectItem>}
												{tags.length > 0 && <SelectItem value="tag">Tag</SelectItem>}
											</SelectContent>
										</Select>
										{filterType && filterType !== 'all' && (
											<Select value={filterValue} onValueChange={handleFilterValueChange}>
												<SelectTrigger aria-label={`Select ${filterType}`} className="h-5 rounded-full">
													<SelectValue placeholder={`Select ${filterType}`} />
												</SelectTrigger>
												<SelectContent>
													{filterType === 'category'
														? categories.map( category => (
															<SelectItem key={category} value={category}>{category}</SelectItem>
														) )
														: tags.map( tag => (
															<SelectItem key={tag} value={tag}>{tag}</SelectItem>
														) )
													}
												</SelectContent>
											</Select>
										)}
									</div>
								</PopoverContent>
							</Popover>
						)}
					</div>
				)}

				{/* Search summary */}
				{searchSummary && (
					<div >
						<p className="text-xs text-muted-foreground">{searchSummary}</p>
					</div>
				)}

				{( filterType || filterValue ) && (
					<div className="flex items-center space-x-2 mb-2">
						<p className="text-xs text-muted-foreground">Active filters:</p>
						{filterType && (
							<Badge variant="secondary" className="text-xs">
								{filterType}: {filterValue || 'All'}
							</Badge>
						)}
					</div>
				)}
				<ScrollArea className="flex-1" ref={scrollAreaRef}>
					{isLoading ? (
						<div className="flex items-center justify-center h-64">
							<Loader2 className="h-8 w-8 animate-spin text-primary" />
						</div>
					) : filteredItems.length === 0 ? (
						<div className="flex items-center justify-center h-64 text-muted-foreground">
							<div className="text-center">
								<p className="mb-2">No items found.</p>
								{debouncedSearchTerm && (
									<p className="text-xs">Try different keywords or check your spelling.</p>
								)}
								{! debouncedSearchTerm && ( filterType || filterValue ) && (
									<p className="text-xs">Try adjusting your filters.</p>
								)}
							</div>
						</div>
					) : (
						<div className="p-1 grid grid-cols-2 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-2 gap-4">
							{filteredItems.map( ( item ) => {

								// Only compute matching data for items that will be highlighted
								const shouldHighlight = debouncedSearchTerm && debouncedSearchTerm.length >= 2;
								const matchingTags = shouldHighlight ?
									( item.tags || [] ).filter( tag => tag.toLowerCase().includes( debouncedSearchTerm.toLowerCase() ) ).slice( 0, 2 ) : [];
								const matchingCategories = shouldHighlight ?
									( item.category || [] ).filter( cat => cat.toLowerCase().includes( debouncedSearchTerm.toLowerCase() ) ).slice( 0, 2 ) : [];

								const itemKey = getItemKey( item );
								return (
									<Tooltip key={itemKey}>
										<TooltipTrigger asChild>
											<Card
												ref={( el ) => {

													if ( el ) itemRefs.current[ itemKey ] = el;

												}}
												className={cn(
													"transition-all hover:shadow-md rounded-md border-0",
													actions ? "cursor-default" : "cursor-pointer",
													isItemSelected( item )
														? "ring-1 ring-primary bg-accent"
														: "hover:bg-accent/50"
												)}
												onClick={actions ? undefined : () => handleItemSelection( itemKey )}
											>
												<CardContent className="p-1">
													<div className="group/thumb relative aspect-square mb-1 overflow-hidden rounded-lg">
														<img
															src={item.preview}
															alt={item.name}
															className="w-full h-full object-cover transition-transform group-hover/thumb:scale-105 rounded-lg"
															loading="lazy"
														/>
														{/* Hover actions (e.g. Replace / Add) over a scrim */}
														{actions && actions.length > 0 && (
															<div className="absolute inset-0 z-0 flex flex-col items-center justify-center gap-1.5 rounded-lg bg-black/55 opacity-0 transition-opacity duration-150 group-hover/thumb:opacity-100 focus-within:opacity-100">
																{busyKey === itemKey ? (
																	<Loader2 className="h-5 w-5 animate-spin text-white" />
																) : (
																	actions.map( ( action ) => (
																		<Button
																			key={action.key}
																			size="sm"
																			variant={action.variant || 'secondary'}
																			disabled={!! busyKey || action.disabled?.( item )}
																			onClick={( e ) => handleAction( action, item, e )}
																			className="h-6 min-w-[76px] gap-1 px-3 text-[11px] rounded-full"
																		>
																			{action.icon}
																			{action.label}
																		</Button>
																	) )
																)}
															</div>
														)}
														{/* Favorite button */}
														<Button
															variant="secondary"
															size="icon"
															className="absolute left-[1px] top-[1px] z-10 h-3 w-3 rounded-full bg-white/0 hover:bg-white/0 cursor-pointer"
															onClick={( e ) => handleFavoriteToggle( item, e )}
															aria-label={`${isFavorite( catalogType, item.id || item.name ) ? 'Remove from' : 'Add to'} favorites`}
														>
															<Star
																className={cn(
																	"h-3 w-3 opacity-60",
																	isFavorite( catalogType, item.id || item.name )
																		? "fill-red-800 text-red-800"
																		: "fill-white text-red-400"
																)}
															/>
														</Button>
														{item.redirection && (
															<Button
																variant="secondary"
																size="icon"
																className="absolute right-1 bottom-1 z-10 h-6 w-6 rounded-full opacity-80 hover:opacity-100"
																onClick={( e ) => {

																	e.stopPropagation();
																	window.open( item.redirection, "_blank", "noopener noreferrer" );

																}}
																aria-label={`More information about ${item.name}`}
															>
																<InfoIcon className="h-3 w-3" />
															</Button>
														)}
													</div>
													<p className="text-xs text-foreground opacity-60 text-center truncate">
														{shouldHighlight ? highlightSearchTerm( item.name, debouncedSearchTerm ) : item.name}
													</p>

													{/* Show matching tags/categories when searching */}
													{shouldHighlight && ( matchingTags.length > 0 || matchingCategories.length > 0 ) && (
														<div className="mt-1 space-y-1">
															{matchingTags.length > 0 && (
																<div className="flex flex-wrap gap-1">
																	{matchingTags.map( tag => (
																		<Badge key={tag} variant="outline" className="text-xs px-1 py-0">
																			{highlightSearchTerm( tag, debouncedSearchTerm )}
																		</Badge>
																	) )}
																</div>
															)}
															{matchingCategories.length > 0 && (
																<div className="flex flex-wrap gap-1">
																	{matchingCategories.map( category => (
																		<Badge key={category} variant="secondary" className="text-xs px-1 py-0">
																			{highlightSearchTerm( category, debouncedSearchTerm )}
																		</Badge>
																	) )}
																</div>
															)}
														</div>
													)}
												</CardContent>
											</Card>
										</TooltipTrigger>
										<TooltipContent>
											<div>
												<p className="font-medium">{item.name}</p>
												{item.label && <p className="text-sm opacity-75">{item.label}</p>}
												{item.tags && item.tags.length > 0 && (
													<p className="text-xs opacity-75 mt-1">Tags: {item.tags.join( ', ' )}</p>
												)}
												{item.category && item.category.length > 0 && (
													<p className="text-xs opacity-75">Categories: {item.category.join( ', ' )}</p>
												)}
											</div>
										</TooltipContent>
									</Tooltip>
								);

							} )}
						</div>
					)}
				</ScrollArea>
			</div>
		</TooltipProvider>
	);

};

export default ItemsCatalog;
