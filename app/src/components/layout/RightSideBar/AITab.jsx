import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Clock, CornerDownRight, Download, KeyRound, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useStore, useAIStore, nextVersionOf } from '@/store';
import { IDEAS, MAX_REFERENCES, SCOPES, SIZES } from '@/lib/aiEdit';
import { Elapsed } from '@/components/layout/Viewports/AIOverlay';

const STUDIO_URL = 'https://aistudio.google.com/app/apikey';

const clock = seconds => `${Math.floor( seconds / 60 )}:${String( Math.floor( seconds % 60 ) ).padStart( 2, '0' )}`;

function useNow( active ) {

	const [ now, setNow ] = useState( Date.now );
	useEffect( () => {

		if ( ! active ) return;
		const timer = setInterval( () => setNow( Date.now() ), 1000 );
		return () => clearInterval( timer );

	}, [ active ] );
	return now;

}

function ago( time ) {

	const minutes = Math.round( ( Date.now() - time ) / 60000 );
	if ( minutes < 1 ) return 'just now';
	if ( minutes < 60 ) return `${minutes} min ago`;
	const hours = Math.round( minutes / 60 );
	if ( hours < 24 ) return `${hours} h ago`;
	const days = Math.round( hours / 24 );
	return days < 30 ? `${days} day${days > 1 ? 's' : ''} ago` : new Date( time ).toLocaleDateString();

}

/** One line on how a version was made. */
function describeVersion( version ) {

	const parts = [];
	if ( version.part ) parts.push( 'Part of it' );
	else if ( version.scope ) parts.push( SCOPES.find( s => s.value === version.scope )?.label );
	if ( version.width ) parts.push( `${version.width} × ${version.height}` );
	if ( version.createdAt ) parts.push( ago( version.createdAt ) );
	if ( version.legacy ) parts.push( 'made before versions' );
	return parts.filter( Boolean ).join( ' · ' );

}

function Segmented( { value, options, onChange, label, disabled } ) {

	return (
		<Tabs value={value} onValueChange={onChange}>
			<TabsList aria-label={label} className="grid w-full" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
				{options.map( o => <TabsTrigger key={o.value} value={o.value} disabled={disabled} className="text-xs px-1">{o.label}</TabsTrigger> )}
			</TabsList>
		</Tabs>
	);

}

function Thumb( { src, className = 'w-16 h-12' } ) {

	return src
		? <img src={src} alt="" className={`${className} shrink-0 rounded-md object-cover ring-1 ring-border bg-black`} />
		: <div className={`${className} shrink-0 rounded-md ring-1 ring-border bg-black`} />;

}

function KeyForm() {

	const connect = useAIStore( s => s.connect );
	const saveKey = useAIStore( s => s.saveKey );
	const closeConnect = useAIStore( s => s.closeConnect );
	const [ value, setValue ] = useState( '' );
	const error = connect.error;
	const messages = {
		key: 'Google says this key isn’t valid. Copy it again from Google AI Studio. It wasn’t saved.',
		network: 'Couldn’t reach Google to check the key. Check the connection, then try again.',
		quota: 'Google is busy with this key right now. Try again in a moment.',
		other: 'Google couldn’t check the key. Try again in a moment.',
	};

	return (
		<Card>
			<CardHeader className="p-3">
				<CardTitle className="text-sm">Connect your Gemini key</CardTitle>
				<CardDescription>AI edits use Google’s Gemini. Google bills your key for each image, and the picture is sent to Google to make the edit.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3 p-3 pt-0">
				{connect.pending && <p className="text-xs text-muted-foreground">Waiting to make: “{useAIStore.getState().prompt.trim()}”</p>}
				<form className="space-y-2" onSubmit={e => {

					e.preventDefault();
					saveKey( value );

				}}>
					<Label htmlFor="gemini-key">API Key</Label>
					<Input id="gemini-key" type="password" autoComplete="off" value={value} onChange={e => setValue( e.target.value )} placeholder="Paste your Gemini API key" aria-invalid={!! error} aria-describedby={error ? 'gemini-key-error' : undefined} />
					{error && (
						<p id="gemini-key-error" className="flex gap-1.5 text-xs text-red-300">
							<AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{messages[ error ] ?? messages.other}
						</p>
					)}
					<p className="text-xs text-muted-foreground">Get your API key from <a href={STUDIO_URL} target="_blank" rel="noopener noreferrer" className="underline text-primary">Google AI Studio</a></p>
					<div className="flex gap-2 pt-1">
						<Button type="submit" className="flex-1" disabled={! value.trim() || connect.checking}>
							{connect.checking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
							{connect.checking ? 'Checking with Google…' : connect.pending ? 'Check key and generate' : 'Check key'}
						</Button>
						<Button type="button" variant="outline" onClick={closeConnect}>Cancel</Button>
					</div>
				</form>
				<p className="text-xs text-muted-foreground">A working key is kept in this browser only. Remove it any time from this panel.</p>
			</CardContent>
		</Card>
	);

}

function Notice( { notice, onRetry, id } ) {

	const openConnect = useAIStore( s => s.openConnect );
	const dismiss = useAIStore( s => s.dismissNotice );
	const now = useNow( !! notice.retryAt );
	const wait = notice.retryAt ? Math.ceil( ( notice.retryAt - now ) / 1000 ) : 0;

	const copy = {
		quota: [ 'Gemini’s limit for this key is used up for now.', 'Google allows more in a moment. Your prompt is kept.' ],
		declined: [ 'Google declined this edit.', 'Its safety filter stopped it. Try describing the change differently.' ],
		network: [ 'Couldn’t reach Google.', 'Check the connection, then try again.' ],
		key: [ 'Google no longer accepts this key.', 'It may have been deleted or limited in Google AI Studio.' ],
		'no-image': [ 'Gemini answered without a picture.', notice.text || 'Try describing the change differently.' ],
		other: [ 'The edit didn’t work.', notice.message ],
	}[ notice.kind ] ?? [ 'The edit didn’t work.', notice.message ];
	const destructive = notice.kind === 'declined' || notice.kind === 'key';

	return (
		<div className="space-y-2">
			<Alert className={destructive ? 'border-destructive' : undefined}>
				{notice.kind === 'quota' ? <Clock className="h-4 w-4 text-amber-400!" /> : <AlertCircle className={`h-4 w-4 ${destructive ? 'text-red-300!' : ''}`} />}
				<AlertTitle className={destructive ? 'text-red-300' : undefined}>{copy[ 0 ]}</AlertTitle>
				<AlertDescription className="text-muted-foreground">{copy[ 1 ]}</AlertDescription>
			</Alert>
			<div className="flex gap-2">
				{notice.kind === 'key'
					? <Button size="sm" variant="outline" className="flex-1" onClick={() => openConnect()}>Change key</Button>
					: <Button size="sm" variant="outline" className="flex-1" disabled={wait > 0} onClick={onRetry}>{wait > 0 ? `Try again in ${clock( wait )}` : 'Try again'}</Button>}
				<Button size="sm" variant="ghost" onClick={() => dismiss( id )}>Dismiss</Button>
			</div>
		</div>
	);

}

function References() {

	const references = useAIStore( s => s.references );
	const addReferences = useAIStore( s => s.addReferences );
	const removeReference = useAIStore( s => s.removeReference );
	const inputRef = useRef( null );

	return (
		<div className="space-y-2">
			<Label>Reference images <span className="text-muted-foreground">(optional)</span></Label>
			<div className="flex flex-wrap gap-2 items-center">
				{references.map( r => (
					<div key={r.id} className="relative">
						<Thumb src={r.url} />
						<button type="button" aria-label={`Remove ${r.name}`} onClick={() => removeReference( r.id )} className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-background border border-border flex items-center justify-center hover:bg-accent">
							<X className="h-3 w-3" />
						</button>
					</div>
				) )}
				{references.length < MAX_REFERENCES && (
					<button type="button" aria-label="Add a reference image" onClick={() => inputRef.current?.click()} className="w-16 h-12 rounded-md border border-dashed border-slate-600 bg-input/30 text-muted-foreground flex items-center justify-center hover:bg-accent">
						<Plus className="h-4 w-4" />
					</button>
				)}
				{references.length === 0 && <span className="text-xs text-muted-foreground flex-1 min-w-24">A style, a material, or an object to put in.</span>}
			</div>
			<input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => {

				addReferences( e.target.files );
				e.target.value = '';

			}} />
		</div>
	);

}

function EditCard( { render } ) {

	const id = render?.id;
	const prompt = useAIStore( s => s.prompt );
	const scope = useAIStore( s => s.scope );
	const where = useAIStore( s => s.where );
	const size = useAIStore( s => s.size );
	const area = useAIStore( s => s.areas[ id ] );
	const from = useAIStore( s => s.startFrom[ id ] ?? 'render' );
	const job = useAIStore( s => s.jobs[ id ] );
	const notice = useAIStore( s => s.notices[ id ] );
	const store = useAIStore.getState();
	const promptRef = useRef( null );

	const versions = render?.aiVersions ?? [];
	const fromVersion = versions.find( v => v.n === from );
	const base = fromVersion ?? render;
	const scopeHint = SCOPES.find( s => s.value === scope )?.hint;
	const ready = render && prompt.trim() && ! job && ( where === 'whole' || area );

	const pickIdea = idea => {

		store.setPrompt( idea.text );
		requestAnimationFrame( () => {

			const el = promptRef.current;
			if ( ! el ) return;
			el.focus();
			el.setSelectionRange( idea.text.length, idea.text.length );

		} );

	};

	return (
		<Card>
			<CardHeader className="p-3">
				<CardTitle className="text-sm">AI Image Generation</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4 p-3 pt-0">
				{render ? (
					<div className="flex gap-2.5 items-center">
						<Thumb src={fromVersion?.url ?? render.thumb} className="w-20 h-15" />
						<div className="min-w-0">
							<p className="text-sm font-medium truncate">Editing: {fromVersion ? `v${fromVersion.n} · ${fromVersion.prompt}` : `Render · ${new Date( render.timestamp ).toLocaleDateString( undefined, { day: 'numeric', month: 'short' } )}`}</p>
							<p className="text-xs text-muted-foreground">
								{base?.width ? `${base.width} × ${base.height}` : ''}{fromVersion ? '' : ' · Adjust edits included'}
								{where === 'part' ? ' · the marked area' : ''}
							</p>
						</div>
					</div>
				) : (
					<div className="p-4 border-2 border-dashed border-muted-foreground/25 rounded-md text-center text-sm text-muted-foreground">
						Pick a render on the left to edit it.
					</div>
				)}

				<div className="space-y-2">
					<Label>Start from an idea</Label>
					<div className="flex flex-wrap gap-1.5" aria-label="Ideas">
						{IDEAS.map( idea => (
							<Button key={idea.label} size="sm" variant="outline" aria-pressed={prompt.startsWith( idea.text.trim() )}
								className={`h-7 px-2.5 ${prompt.startsWith( idea.text.trim() ) ? 'bg-accent' : ''}`} onClick={() => pickIdea( idea )}>
								{idea.label}
							</Button>
						) )}
					</div>
				</div>

				<div className="space-y-2">
					<Label htmlFor="ai-prompt">What should change?</Label>
					<Textarea id="ai-prompt" ref={promptRef} value={prompt} onChange={e => store.setPrompt( e.target.value )} rows={3}
						placeholder="Describe the change in your own words" disabled={!! job} />
				</div>

				<div className="space-y-2">
					<Label>How much can change</Label>
					<Segmented label="How much can change" value={scope} options={SCOPES} onChange={store.setScope} disabled={!! job} />
					<p className="text-xs text-muted-foreground">{scopeHint}</p>
				</div>

				<div className="space-y-2">
					<Label>Where</Label>
					<Segmented label="Where" value={where} options={[ { value: 'whole', label: 'Whole picture' }, { value: 'part', label: 'Part of it' } ]} onChange={store.setWhere} disabled={!! job} />
					{where === 'part' && (
						<div className="flex items-start justify-between gap-2">
							<p className="text-xs text-muted-foreground">{area ? 'Only the marked area changes; the rest stays exactly as rendered.' : 'Drag on the picture to mark the area to change.'}</p>
							{area && ! job && <Button size="sm" variant="ghost" className="h-6 px-2 shrink-0" onClick={() => store.setArea( id, null )}>Clear</Button>}
						</div>
					)}
				</div>

				<References />

				<div className="grid grid-cols-2 gap-2">
					<div className="space-y-2 min-w-0">
						<Label>Start from</Label>
						<Select value={String( from )} onValueChange={v => store.setStartFrom( id, v === 'render' ? 'render' : Number( v ) )} disabled={! render || !! job}>
							<SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectItem value="render">Render</SelectItem>
								{versions.map( v => <SelectItem key={v.n} value={String( v.n )}>v{v.n} · {v.prompt || 'AI version'}</SelectItem> )}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-2 min-w-0">
						<Label>Size</Label>
						<Select value={size} onValueChange={store.setSize} disabled={!! job}>
							<SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
							<SelectContent>
								{SIZES.map( s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem> )}
							</SelectContent>
						</Select>
					</div>
				</div>

				{notice && ! job && <Notice id={id} notice={notice} onRetry={() => store.generate( render )} />}

				{job && (
					<Alert role="status">
						<Loader2 className="h-4 w-4 animate-spin text-purple-400!" />
						<AlertTitle>Making v{job.n} · <Elapsed since={job.startedAt} /></AlertTitle>
						<AlertDescription className="text-muted-foreground">
							<p>You can switch tabs or pick another render. v{job.n} is added to this render when it’s ready.</p>
							<Button size="sm" variant="outline" className="mt-2 w-fit" onClick={() => store.cancel( id )}>Cancel</Button>
						</AlertDescription>
					</Alert>
				)}

				<div className="space-y-1.5">
					<Button className="w-full" disabled={! ready} onClick={() => store.generate( render )}>
						{job ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
						{job ? 'Generating…' : `Generate v${nextVersionOf( render )}`}
					</Button>
					<p className="text-xs text-muted-foreground text-center">Usually 20–50 s. Billed to your Gemini key.</p>
				</div>
			</CardContent>
		</Card>
	);

}

function VersionsCard( { render } ) {

	const id = render.id;
	const shown = useAIStore( s => s.shown[ id ] ?? 'render' );
	const store = useAIStore.getState();
	const setExportRequest = useStore( s => s.setExportRequest );
	const [ confirming, setConfirming ] = useState( null );
	const versions = render.aiVersions;
	const current = versions.find( v => v.n === shown );

	const row = ( key, active, onClick, thumb, title, meta ) => (
		<button key={key} type="button" onClick={onClick} aria-pressed={active}
			className={`w-full flex gap-2.5 items-start p-1.5 rounded-md text-left hover:bg-accent/60 ${active ? 'bg-accent' : ''}`}>
			<Thumb src={thumb} />
			<span className="min-w-0 flex-1">
				<span className="block text-sm leading-5 line-clamp-2">{title}</span>
				<span className="block text-xs text-muted-foreground">{meta}</span>
			</span>
		</button>
	);

	return (
		<Card>
			<CardHeader className="p-3">
				<CardTitle className="text-sm">Versions of this render ({versions.length})</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1 p-2 pt-0">
				{row( 'render', shown === 'render', () => store.show( id, 'render' ), render.thumb, <span className="font-semibold">Render</span>, 'as rendered' )}
				{[ ...versions ].reverse().map( v => row( v.n, shown === v.n, () => store.show( id, v.n ), v.url,
					<><span className="font-semibold">v{v.n}</span> {v.prompt || 'AI version'}</>, describeVersion( v ) ) )}

				{current && confirming !== current.n && (
					<div className="flex flex-wrap gap-2 p-1.5 pt-2">
						<Button size="sm" onClick={() => {

							store.setStartFrom( id, current.n );
							document.getElementById( 'ai-prompt' )?.focus();

						}}>
							<CornerDownRight className="mr-1.5 h-3.5 w-3.5" />Refine from v{current.n}
						</Button>
						<Button size="sm" variant="outline" onClick={() => setExportRequest( { tab: 'picture', from: 'result', source: `v${current.n}` } )}>
							<Download className="mr-1.5 h-3.5 w-3.5" />Export…
						</Button>
						<Button size="sm" variant="destructive" onClick={() => setConfirming( current.n )}>
							<Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete v{current.n}
						</Button>
					</div>
				)}

				{current && confirming === current.n && (
					<div className="space-y-2 p-1.5 pt-2">
						<Alert>
							<AlertTitle>Delete v{current.n}?</AlertTitle>
							<AlertDescription className="text-muted-foreground">Its image and prompt are removed. The render stays.</AlertDescription>
						</Alert>
						<div className="flex gap-2">
							<Button size="sm" variant="destructive" className="flex-1" onClick={async () => {

								setConfirming( null );
								await store.deleteVersion( render, current.n );

							}}>Delete</Button>
							<Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirming( null )}>Cancel</Button>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);

}

function KeyFooter() {

	const key = useAIStore( s => s.key );
	const openConnect = useAIStore( s => s.openConnect );
	const removeKey = useAIStore( s => s.removeKey );

	return (
		<div className="flex flex-col items-center gap-0.5 pb-3 text-xs text-muted-foreground">
			<div className="flex items-center gap-1">
				<KeyRound className="h-3.5 w-3.5" />
				<span>{key ? `Gemini key ••••${key.slice( - 4 )}` : 'No Gemini key yet'}</span>
				<Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => openConnect()}>{key ? 'Change' : 'Add key'}</Button>
				{key && <Button size="sm" variant="ghost" className="h-7 px-2" onClick={removeKey}>Remove</Button>}
			</div>
			<span>The picture is sent to Google to make the edit.</span>
		</div>
	);

}

const AITab = () => {

	const render = useStore( s => s.selectedResult );
	const connect = useAIStore( s => s.connect );

	return (
		<>
			<Separator className="bg-primary" />
			<div className="flex flex-col gap-2">
				{connect ? <KeyForm /> : <EditCard render={render} />}
				{render?.aiVersions?.length > 0 && <VersionsCard render={render} />}
				<KeyFooter />
			</div>
		</>
	);

};

export default AITab;
