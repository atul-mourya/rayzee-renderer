import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Search, Loader2, ArrowLeft, Package, X } from 'lucide-react';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useFavoritesStore } from '@/store';
import { itemKey, rankSearch, searchEntries } from '@/lib/catalog';

const NO_LISTING = { query: '', category: null, pinned: [], items: [], cursor: null };

/**
 * Browses a catalog source by category, a page at a time as the grid scrolls. The search box searches
 * the open category, or every item from the category grid.
 *
 * @param {object} source - NAME, CATALOG, getCategories(), search( { query, category, cursor, pinned } )
 *   → { items, nextCursor } (category null: every item); optionally CATEGORY_CATALOG and VARIANTS ({ value, label }[])
 * @param {import('react').ReactNode} [notice] - a line above the listing (token hint, credit)
 * @param {string} [variant] - the VARIANTS value items load as
 * @param {(value:string) => void} [onVariantChange]
 * @param {Array} [actions] - per-card hover actions (ItemsCatalog's), for a source whose cards are not clicked
 * @param {(item:object) => any} [onPick] - a click on an item
 * @param {string} [selectedKey] - the item ringed as current; else the last one picked
 */
const CatalogBrowser = ( { source, notice, variant, onVariantChange, actions, onPick, selectedKey } ) => {

	const { toast } = useToast();

	// Categories (landing view)
	const [ categories, setCategories ] = useState( [] );
	const [ isLoadingCategories, setIsLoadingCategories ] = useState( false );
	const [ categoriesError, setCategoriesError ] = useState( null );
	const [ selectedCategory, setSelectedCategory ] = useState( null ); // { slug, name }

	// The listing keeps what its first page was asked with; later pages ask the same.
	const [ query, setQuery ] = useState( '' );
	const [ listing, setListing ] = useState( NO_LISTING );
	const [ isSearching, setIsSearching ] = useState( false );
	const [ isLoadingMore, setIsLoadingMore ] = useState( false );
	const [ moreFailed, setMoreFailed ] = useState( false );
	const [ error, setError ] = useState( null );
	const [ pickedKey, setPickedKey ] = useState( null );
	const loadingMore = useRef( false );

	const category = selectedCategory?.slug ?? null;
	const searchingAll = ! selectedCategory && query.trim() !== '';

	// Load categories once (the primary listing).
	useEffect( () => {

		let cancelled = false;
		setIsLoadingCategories( true );
		setCategoriesError( null );
		source.getCategories()
			.then( cats => {

				if ( ! cancelled ) setCategories( cats );

			} )
			.catch( e => {

				if ( ! cancelled ) setCategoriesError( e.message );

			} )
			.finally( () => {

				if ( ! cancelled ) setIsLoadingCategories( false );

			} );
		return () => {

			cancelled = true;

		};

	}, [ source ] );

	// First page of the open category, or of a search over everything; debounced while typing.
	useEffect( () => {

		if ( category === null && query.trim() === '' ) return undefined;

		let cancelled = false;
		const timer = setTimeout( async () => {

			setIsSearching( true );
			setError( null );
			const pinned = useFavoritesStore.getState().favorites[ source.CATALOG ] ?? [];
			try {

				const { items, nextCursor } = await source.search( { query, category, pinned } );
				if ( cancelled ) return; // a newer category/query superseded this request
				setListing( { query, category, pinned, items, cursor: nextCursor } );
				setMoreFailed( false );

			} catch ( e ) {

				if ( cancelled ) return;
				setError( e.message );
				setListing( NO_LISTING );

			} finally {

				if ( ! cancelled ) setIsSearching( false );

			}

		}, query ? 350 : 0 );

		return () => {

			cancelled = true;
			clearTimeout( timer );

		};

	}, [ source, category, query ] );

	const loadMore = useCallback( async () => {

		if ( ! listing.cursor || loadingMore.current ) return;
		loadingMore.current = true;
		setIsLoadingMore( true );
		setMoreFailed( false );
		try {

			const { query: q, category: c, pinned, cursor } = listing;
			const page = await source.search( { query: q, category: c, pinned, cursor } );
			setListing( current => {

				if ( current !== listing ) return current; // a new search replaced the listing meanwhile
				const seen = new Set( current.items.map( itemKey ) );
				return { ...current, items: [ ...current.items, ...page.items.filter( item => ! seen.has( itemKey( item ) ) ) ], cursor: page.nextCursor };

			} );

		} catch ( e ) {

			setMoreFailed( true );
			toast( { title: source.NAME, description: e.message, variant: 'destructive' } );

		} finally {

			loadingMore.current = false;
			setIsLoadingMore( false );

		}

	}, [ source, listing, toast ] );

	const openCategory = useCallback( ( c ) => {

		setSelectedCategory( { slug: c.slug, name: c.name } );
		setQuery( '' );
		setListing( NO_LISTING );

	}, [] );

	const handlePickCategory = useCallback( ( indexStr ) => {

		const c = categories[ parseInt( indexStr ) ];
		if ( c ) openCategory( c );

	}, [ categories, openCategory ] );

	const handleBack = useCallback( () => {

		setSelectedCategory( null );
		setQuery( '' );
		setListing( NO_LISTING );

	}, [] );

	const handlePick = useCallback( ( indexStr ) => {

		const item = listing.items[ parseInt( indexStr ) ];
		if ( ! item ) return;
		setPickedKey( itemKey( item ) );
		onPick( item );

	}, [ listing.items, onPick ] );

	const categoryIndex = useMemo( () => searchEntries( categories, c => [[ c.name, 4 ]] ), [ categories ] );
	const matchingCategories = searchingAll ? rankSearch( categoryIndex, query ).slice( 0, 8 ) : [];

	// Empty before its first page arrives means loading, not no results.
	const pending = listing.query !== query || listing.category !== category;
	const ringKey = selectedKey ?? pickedKey;
	const ringIndex = ringKey == null ? - 1 : listing.items.findIndex( item => itemKey( item ) === ringKey );

	return (
		<div className="flex flex-col h-full w-full">

			{notice && (
				<p className="px-2 pt-2 text-[10px] leading-tight text-muted-foreground">{notice}</p>
			)}

			{selectedCategory && (
				<div className="flex items-center gap-1 px-2 py-1 border-b border-border">
					<Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={handleBack}>
						<ArrowLeft size={12} className="mr-1" /> Back
					</Button>
					<div className="flex items-center gap-1 ml-auto text-xs text-primary">
						<Package size={12} />
						{selectedCategory.name}
					</div>
				</div>
			)}

			<div className="flex items-center gap-1 px-2 pt-2">
				<div className="relative flex-1">
					<Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="text"
						value={query}
						onChange={( e ) => setQuery( e.target.value )}
						placeholder={selectedCategory ? `Search in ${selectedCategory.name}…` : `Search ${source.NAME}…`}
						className="h-7 pl-7 pr-7 text-xs rounded-full bg-primary/20"
						aria-label={selectedCategory ? 'Search within category' : `Search ${source.NAME}`}
					/>
					{query && (
						<Button
							variant="ghost"
							size="icon"
							className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full"
							onClick={() => setQuery( '' )}
							aria-label="Clear search"
						>
							<X size={12} className="text-muted-foreground" />
						</Button>
					)}
				</div>
				{source.VARIANTS && (
					<Select value={variant} onValueChange={onVariantChange}>
						<SelectTrigger className="w-auto shrink-0 gap-1 h-7 px-2 rounded-full text-xs hover:cursor-pointer" aria-label="File version">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{source.VARIANTS.map( r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem> )}
						</SelectContent>
					</Select>
				)}
			</div>

			{matchingCategories.length > 0 && (
				<div className="flex flex-wrap items-center gap-1 px-2 pt-2 text-[11px]">
					<span className="text-muted-foreground">Categories:</span>
					{matchingCategories.map( c => (
						<Button key={c.slug} variant="outline" size="sm" className="h-5 px-2 rounded-full text-[11px]" onClick={() => openCategory( c )}>
							{c.name}
						</Button>
					) )}
				</div>
			)}

			<div className="flex-1 min-h-0 mt-2">
				{ selectedCategory || searchingAll ? (
					<ItemsCatalog
						data={listing.items}
						value={ringIndex >= 0 ? String( ringIndex ) : null}
						onValueChange={onPick ? handlePick : undefined}
						actions={actions}
						isLoading={isSearching || ( pending && listing.items.length === 0 )}
						error={error}
						hideSearch
						catalogType={source.CATALOG}
						onEndReached={listing.cursor && ! isLoadingMore && ! moreFailed ? loadMore : null}
					/>
				) : (
					<ItemsCatalog
						data={categories}
						value={null}
						onValueChange={handlePickCategory}
						isLoading={isLoadingCategories}
						error={categoriesError}
						hideSearch
						catalogType={source.CATEGORY_CATALOG ?? `${source.CATALOG}-categories`}
					/>
				)}
			</div>

			{( selectedCategory || searchingAll ) && listing.cursor && ( isLoadingMore || moreFailed ) && (
				<div className="px-2 py-2 border-t border-border">
					<Button
						variant="outline"
						size="sm"
						className="w-full h-7 text-xs"
						onClick={loadMore}
						disabled={isLoadingMore}
					>
						{isLoadingMore ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Load more'}
					</Button>
				</div>
			)}
		</div>
	);

};

export default CatalogBrowser;
