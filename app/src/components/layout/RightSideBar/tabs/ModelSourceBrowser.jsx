import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, Loader2, ArrowLeft, Package, Plus } from 'lucide-react';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { getApp } from '@/lib/appProxy';
import { cn } from '@/lib/utils';

/**
 * Browse surface for an online model source (SketchfabService, AboService). Category-first
 * (like PolyHaven): the primary listing is model categories; selecting one shows that
 * category's models with a within-category search. Each model card reveals Replace / Add
 * actions on hover; the action resolves the model's file, then hands it to onReplace / onAdd.
 *
 * @param {object} source - NAME, CATALOG, getCategories(), search(), canDownload( item ),
 *   resolveDownload( item, { variant } ), and VARIANTS ({ value, label }[]) when it offers more than one file
 * @param {import('react').ReactNode} [notice] - a line above the listing (token hint, credit)
 * @param {string} [variant] - the VARIANTS value models load as
 * @param {(value:string) => void} [onVariantChange]
 * @param {(url:string, name:string, item:object) => Promise<any>} onReplace - swap the scene
 * @param {(url:string, name:string, item:object) => Promise<any>} onAdd - append to the scene
 */
const ModelSourceBrowser = ( { source, notice, variant, onVariantChange, onReplace, onAdd } ) => {

	const { toast } = useToast();

	// Categories (landing view)
	const [ categories, setCategories ] = useState( [] );
	const [ isLoadingCategories, setIsLoadingCategories ] = useState( false );
	const [ categoriesError, setCategoriesError ] = useState( null );
	const [ selectedCategory, setSelectedCategory ] = useState( null ); // { slug, name }

	// Models (drill-down view)
	const [ query, setQuery ] = useState( '' );
	const [ items, setItems ] = useState( [] );
	const [ cursor, setCursor ] = useState( null );
	const [ isSearching, setIsSearching ] = useState( false );
	const [ isLoadingMore, setIsLoadingMore ] = useState( false );
	const [ error, setError ] = useState( null );

	const debounceRef = useRef( null );

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

	// Fetch models whenever a category is open (and re-fetch on within-category query change).
	useEffect( () => {

		if ( ! selectedCategory ) return undefined;

		let cancelled = false;
		if ( debounceRef.current ) clearTimeout( debounceRef.current );
		debounceRef.current = setTimeout( async () => {

			setIsSearching( true );
			setError( null );
			try {

				const { items: results, nextCursor } = await source.search( { query, category: selectedCategory.slug } );
				if ( cancelled ) return; // a newer category/query superseded this request
				setItems( results );
				setCursor( nextCursor );

			} catch ( e ) {

				if ( cancelled ) return;
				setError( e.message );
				setItems( [] );
				setCursor( null );

			} finally {

				if ( ! cancelled ) setIsSearching( false );

			}

		}, 350 );

		return () => {

			cancelled = true;
			clearTimeout( debounceRef.current );

		};

	}, [ source, selectedCategory, query ] );

	const handlePickCategory = useCallback( ( indexStr ) => {

		const c = categories[ parseInt( indexStr ) ];
		if ( ! c ) return;
		setSelectedCategory( { slug: c.slug, name: c.name } );
		setQuery( '' );
		setItems( [] );
		setCursor( null );

	}, [ categories ] );

	const handleBack = useCallback( () => {

		setSelectedCategory( null );
		setQuery( '' );
		setItems( [] );
		setCursor( null );

	}, [] );

	const handleLoadMore = useCallback( async () => {

		if ( ! cursor || isLoadingMore || ! selectedCategory ) return;
		setIsLoadingMore( true );
		try {

			const { items: more, nextCursor } = await source.search( { query, category: selectedCategory.slug, cursor } );
			setItems( prev => [ ...prev, ...more ] );
			setCursor( nextCursor );

		} catch ( e ) {

			toast( { title: source.NAME, description: e.message, variant: 'destructive' } );

		} finally {

			setIsLoadingMore( false );

		}

	}, [ source, cursor, isLoadingMore, query, selectedCategory, toast ] );

	// Resolve the model's file, then run the caller's replace/append.
	const resolveAndRun = useCallback( async ( item, run ) => {

		try {

			const picked = await source.resolveDownload( item, { variant } );
			if ( ! picked.url ) {

				toast( { title: 'No download', description: `${source.NAME} offers no downloadable file for this model.`, variant: 'destructive' } );

			} else if ( picked.format === 'zip' ) {

				if ( run !== onReplace ) {

					toast( { title: 'Replace only', description: 'This model comes as a glTF archive, which can replace the scene but not be added to it.' } );
					return;

				}

				await getApp()?.loadFile( picked.url, { filename: `${item.id}.zip`, cacheKey: picked.cacheKey } );

			} else {

				await run( picked.url, item.name, item, { cacheKey: picked.cacheKey } );

			}

		} catch ( e ) {

			toast( { title: 'Error loading model', description: e.message, variant: 'destructive' } );

		}

	}, [ source, variant, toast, onReplace ] );

	// Per-card hover actions. Disabled (with a hint) when the model can't be downloaded.
	const modelActions = useMemo( () => {

		const disabled = ( item ) => ! source.canDownload( item );
		return [
			{ key: 'replace', label: 'Replace', variant: 'default', disabled, onClick: ( item ) => resolveAndRun( item, onReplace ) },
			{ key: 'add', label: 'Add', variant: 'secondary', icon: <Plus size={12} />, disabled, onClick: ( item ) => resolveAndRun( item, onAdd ) },
		];

	}, [ source, resolveAndRun, onReplace, onAdd ] );

	return (
		<div className="flex flex-col h-full w-full">

			{notice && (
				<p className="px-2 pt-2 text-[10px] leading-tight text-muted-foreground">{notice}</p>
			)}

			{ ! selectedCategory ? (
				/* Primary listing: categories */
				<div className="flex-1 min-h-0 mt-2">
					<ItemsCatalog
						data={categories}
						value={null}
						onValueChange={handlePickCategory}
						isLoading={isLoadingCategories}
						error={categoriesError}
						catalogType={`${source.CATALOG}-categories`}
					/>
				</div>
			) : (
				/* Drill-down: models within the selected category */
				<div className="flex flex-col h-full min-h-0">
					<div className="flex items-center gap-1 px-2 py-1 border-b border-border">
						<Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={handleBack}>
							<ArrowLeft size={12} className="mr-1" /> Back
						</Button>
						<div className={cn( 'flex items-center gap-1 text-xs text-primary', source.VARIANTS ? 'mx-auto' : 'ml-auto' )}>
							<Package size={12} />
							{selectedCategory.name}
						</div>
						{source.VARIANTS && (
							<Select value={variant} onValueChange={onVariantChange}>
								<SelectTrigger className="w-auto shrink-0 gap-1 h-6 px-2 rounded-full text-xs hover:cursor-pointer" aria-label="Model file">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{source.VARIANTS.map( r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem> )}
								</SelectContent>
							</Select>
						)}
					</div>

					<div className="px-2 pt-2">
						<div className="relative">
							<Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
							<Input
								type="text"
								value={query}
								onChange={( e ) => setQuery( e.target.value )}
								placeholder={`Search in ${selectedCategory.name}…`}
								className="h-7 pl-7 text-xs rounded-full bg-primary/20"
								aria-label="Search within category"
							/>
						</div>
					</div>

					<div className="flex-1 min-h-0 mt-2">
						<ItemsCatalog
							data={items}
							value={null}
							actions={modelActions}
							isLoading={isSearching}
							error={error}
							hideSearch
							catalogType={source.CATALOG}
						/>
					</div>

					{cursor && ! isSearching && (
						<div className="px-2 py-2 border-t border-border">
							<Button
								variant="outline"
								size="sm"
								className="w-full h-7 text-xs"
								onClick={handleLoadMore}
								disabled={isLoadingMore}
							>
								{isLoadingMore ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Load more'}
							</Button>
						</div>
					)}
				</div>
			)}
		</div>
	);

};

export default ModelSourceBrowser;
