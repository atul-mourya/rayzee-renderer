import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Row } from '@/components/ui/row';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Clock, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useStore, useAIStore, nextVersionOf } from '@/store';
import { IDEAS, MAX_REFERENCES, SCOPES, SIZES } from '@/lib/aiEdit';

const STUDIO_URL = 'https://aistudio.google.com/app/apikey';
const PILL = 'h-5 gap-1 rounded-full px-2 text-xs font-normal';

const label = ( text, tip ) => <span className="opacity-50 text-xs truncate" title={tip}>{text}</span>;

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

function Elapsed( { since } ) {

	const now = useNow( true );
	return clock( Math.max( 0, ( now - since ) / 1000 ) );

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
		<div className="space-y-3 py-1">
			<div className="space-y-1">
				<p className="text-sm font-medium">Connect your Gemini key</p>
				<p className="text-xs text-muted-foreground">AI edits use Google’s Gemini. Google bills your key for each image, and the picture is sent to Google to make the edit.</p>
			</div>
			{connect.pending && <p className="text-xs text-muted-foreground">Waiting to make: “{useAIStore.getState().prompt.trim()}”</p>}
			<form className="space-y-2" onSubmit={e => {

				e.preventDefault();
				saveKey( value );

			}}>
				<Label htmlFor="gemini-key" className="text-xs">API Key</Label>
				<Input id="gemini-key" type="password" autoComplete="off" value={value} onChange={e => setValue( e.target.value )} placeholder="Paste your Gemini API key" aria-invalid={!! error} aria-describedby={error ? 'gemini-key-error' : undefined} />
				{error && (
					<p id="gemini-key-error" className="flex gap-1.5 text-xs text-red-300">
						<AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{messages[ error ] ?? messages.other}
					</p>
				)}
				<p className="text-xs text-muted-foreground">Get your API key from <a href={STUDIO_URL} target="_blank" rel="noopener noreferrer" className="underline text-primary">Google AI Studio</a>. A working key is kept in this browser only.</p>
				<div className="flex gap-2 pt-1">
					<Button type="submit" size="sm" className="flex-1" disabled={! value.trim() || connect.checking}>
						{connect.checking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						{connect.checking ? 'Checking with Google…' : connect.pending ? 'Check key and generate' : 'Check key'}
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={closeConnect}>Cancel</Button>
				</div>
			</form>
		</div>
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
		<Alert className={`p-3 ${destructive ? 'border-destructive' : ''}`}>
			{notice.kind === 'quota' ? <Clock className="h-4 w-4 text-amber-400!" /> : <AlertCircle className={`h-4 w-4 ${destructive ? 'text-red-300!' : ''}`} />}
			<AlertTitle className={`text-xs ${destructive ? 'text-red-300' : ''}`}>{copy[ 0 ]}</AlertTitle>
			<AlertDescription className="text-xs text-muted-foreground">
				<p>{copy[ 1 ]}</p>
				<div className="flex gap-1.5 mt-2">
					{notice.kind === 'key'
						? <Button variant="outline" className={PILL} onClick={() => openConnect()}>Change key</Button>
						: <Button variant="outline" className={PILL} disabled={wait > 0} onClick={onRetry}>{wait > 0 ? `Try again in ${clock( wait )}` : 'Try again'}</Button>}
					<Button variant="ghost" className={PILL} onClick={() => dismiss( id )}>Dismiss</Button>
				</div>
			</AlertDescription>
		</Alert>
	);

}

function References( { disabled } ) {

	const references = useAIStore( s => s.references );
	const addReferences = useAIStore( s => s.addReferences );
	const removeReference = useAIStore( s => s.removeReference );
	const inputRef = useRef( null );

	return (
		<Row>
			{label( 'References', `Up to ${MAX_REFERENCES} pictures for Gemini to take a style, a material or an object from.` )}
			<div className="flex items-center gap-1.5">
				{references.map( r => (
					<div key={r.id} className="relative">
						<img src={r.url} alt={r.name} title={r.name} className="h-7 w-9 rounded object-cover ring-1 ring-border bg-black" />
						<button type="button" aria-label={`Remove ${r.name}`} onClick={() => removeReference( r.id )} className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-background border border-border flex items-center justify-center hover:bg-accent">
							<X className="h-2.5 w-2.5" />
						</button>
					</div>
				) )}
				{references.length < MAX_REFERENCES && (
					<Button variant="outline" className={PILL} disabled={disabled} onClick={() => inputRef.current?.click()}>
						<Plus className="h-3 w-3" />Add
					</Button>
				)}
			</div>
			<input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => {

				addReferences( e.target.files );
				e.target.value = '';

			}} />
		</Row>
	);

}

function Editor( { render } ) {

	const id = render.id;
	const prompt = useAIStore( s => s.prompt );
	const scope = useAIStore( s => s.scope );
	const where = useAIStore( s => s.where );
	const size = useAIStore( s => s.size );
	const area = useAIStore( s => s.areas[ id ] );
	const job = useAIStore( s => s.jobs[ id ] );
	const notice = useAIStore( s => s.notices[ id ] );
	const store = useAIStore.getState();
	const promptRef = useRef( null );

	const busy = !! job;
	const ready = prompt.trim() && ! busy && ( where === 'whole' || area );

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
		<>
			<p className="text-sm font-semibold">AI Image Generation</p>
			<Editing render={render} where={where} />
			<div className="space-y-1.5">
				{label( 'Start from an idea' )}
				<div className="flex flex-wrap gap-1" aria-label="Ideas">
					{IDEAS.map( idea => {

						const picked = prompt.startsWith( idea.text.trim() );
						return (
							<Button key={idea.label} variant="outline" aria-pressed={picked} disabled={busy} onClick={() => pickIdea( idea )}
								className={`h-6 rounded-md px-2 text-xs font-normal ${picked ? 'bg-accent' : ''}`}>
								{idea.label}
							</Button>
						);

					} )}
				</div>
			</div>
			<div className="space-y-1.5">
				<label htmlFor="ai-prompt" className="block opacity-50 text-xs">What should change?</label>
				<Textarea id="ai-prompt" ref={promptRef} value={prompt} onChange={e => store.setPrompt( e.target.value )} rows={3}
					placeholder="Describe the change in your own words" disabled={busy} className="text-sm" />
			</div>

			<Separator className="my-2" />

			<Row>
				{label( 'Area', 'Whole picture: Gemini redraws all of it. Part of it: drag a box on the picture, and only that box changes.' )}
				<ToggleGroup type="single" value={where} onValueChange={v => v && store.setWhere( v )} disabled={busy} className="max-w-44">
					<ToggleGroupItem value="whole" className="text-xs px-3 h-5">Whole picture</ToggleGroupItem>
					<ToggleGroupItem value="part" className="text-xs px-3 h-5">Part of it</ToggleGroupItem>
				</ToggleGroup>
			</Row>
			{where === 'part' && (
				<Row>
					<span className="text-xs text-purple-300">{area ? 'Only the marked area changes.' : 'Drag on the picture to mark the area.'}</span>
					{area && ! busy && <Button variant="ghost" className={PILL} onClick={() => store.setArea( id, null )}>Clear</Button>}
				</Row>
			)}

			<Row>
				<Select value={scope} onValueChange={store.setScope} disabled={busy}>
					{label( 'May change', SCOPES.map( s => `${s.label}: ${s.hint}` ).join( '\n' ) )}
					<SelectTrigger className="max-w-36 h-5 rounded-full"><SelectValue /></SelectTrigger>
					<SelectContent>
						{SCOPES.map( s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem> )}
					</SelectContent>
				</Select>
			</Row>

			<Row>
				<Select value={size} onValueChange={store.setSize} disabled={busy}>
					{label( 'Size', 'How large a picture Gemini returns, in the render’s shape. 1K is the fastest.' )}
					<SelectTrigger className="max-w-36 h-5 rounded-full"><SelectValue /></SelectTrigger>
					<SelectContent>
						{SIZES.map( s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem> )}
					</SelectContent>
				</Select>
			</Row>

			<References disabled={busy} />

			<Separator className="my-2" />

			{notice && ! busy && <Notice id={id} notice={notice} onRetry={() => store.generate( render )} />}

			{busy ? (
				<div role="status" className="flex gap-2">
					<Button size="sm" className="flex-1" disabled>
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />Making v{job.n} · <Elapsed since={job.startedAt} />
					</Button>
					<Button size="sm" variant="outline" onClick={() => store.cancel( id )}>Cancel</Button>
				</div>
			) : (
				<Button size="sm" className="w-full" disabled={! ready} onClick={() => store.generate( render )}>
					<Sparkles className="mr-2 h-4 w-4" />Generate v{nextVersionOf( render )}
				</Button>
			)}
			<p className="text-xs text-muted-foreground text-center">
				{busy ? `You can switch tabs or renders. v${job.n} is added when it’s ready.` : 'Usually 20–50 s. Sent to Google, billed to your key.'}
			</p>
		</>
	);

}

/** What the picture shows, which is also what the next edit starts from: the render or one of its AI versions. */
function Editing( { render, where } ) {

	const id = render.id;
	const shown = useAIStore( s => s.shown[ id ] ?? 'render' );
	const job = useAIStore( s => s.jobs[ id ] );
	const [ confirming, setConfirming ] = useState( null );
	const store = useAIStore.getState();
	const versions = render.aiVersions ?? [];
	const current = versions.find( v => v.n === shown );
	const base = current ?? render;

	const title = current
		? `v${current.n} · ${current.prompt || 'AI version'}`
		: `Render · ${new Date( render.timestamp ).toLocaleDateString( undefined, { day: 'numeric', month: 'short' } )}`;
	const meta = [
		current ? describeVersion( current ) : base.width && `${base.width} × ${base.height} · Adjust edits included`,
		where === 'part' && 'the marked area',
	].filter( Boolean ).join( ' · ' );

	if ( ! versions.length && ! job ) {

		return (
			<div className="flex gap-2.5 items-center">
				<img src={render.thumb} alt="" className="w-20 h-15 shrink-0 rounded-md object-cover ring-1 ring-border bg-black" />
				<div className="min-w-0">
					<p className="text-sm font-medium truncate">Editing: {title}</p>
					<p className="text-xs text-muted-foreground">{meta}</p>
				</div>
			</div>
		);

	}

	const tile = ( key, active, onClick, src, text, tip ) => (
		<button key={key} type="button" onClick={onClick} aria-pressed={active} title={tip} className="flex flex-col gap-1 shrink-0">
			<span className={`block w-14 h-10 rounded overflow-hidden bg-black ${active ? 'ring-2 ring-primary' : 'ring-1 ring-border'}`}>
				{src && <img src={src} alt="" className="w-full h-full object-cover" />}
			</span>
			<span className={`text-xs leading-none ${active ? '' : 'opacity-50'}`}>{text}</span>
		</button>
	);

	return (
		<>
			<div aria-label="Versions of this render" className="flex gap-2 overflow-x-auto p-0.5">
				{tile( 'render', shown === 'render', () => store.show( id, 'render' ), render.thumb, 'Render', 'As rendered, with the Adjust tab’s edits' )}
				{versions.map( v => tile( v.n, shown === v.n, () => store.show( id, v.n ), v.url, `v${v.n}`, v.prompt ) )}
				{job && (
					<div className="flex flex-col gap-1 shrink-0" title={job.prompt}>
						<span className="w-14 h-10 rounded border border-dashed border-purple-500 flex items-center justify-center">
							<Loader2 className="h-4 w-4 animate-spin text-purple-400" />
						</span>
						<span className="text-xs leading-none opacity-50">v{job.n}</span>
					</div>
				)}
			</div>

			<div className="space-y-1">
				<p className="text-sm font-medium leading-5 line-clamp-2">Editing: {title}</p>
				{current && confirming === current.n ? (
					<div className="flex items-center gap-1.5">
						<p className="text-xs flex-1 min-w-0">Delete v{current.n}? <span className="text-muted-foreground">The render stays.</span></p>
						<Button variant="destructive" className={PILL} onClick={async () => {

							setConfirming( null );
							await store.deleteVersion( render, current.n );

						}}>Delete</Button>
						<Button variant="outline" className={PILL} onClick={() => setConfirming( null )}>Cancel</Button>
					</div>
				) : (
					<div className="flex items-center gap-1.5">
						<p className="text-xs text-muted-foreground truncate flex-1 min-w-0">{meta}</p>
						{current && (
							<Button variant="ghost" aria-label={`Delete v${current.n}`} title={`Delete v${current.n}`} className={`${PILL} text-red-300 hover:text-red-200`} onClick={() => setConfirming( current.n )}>
								<Trash2 className="h-3 w-3" />
							</Button>
						)}
					</div>
				)}
			</div>
		</>
	);

}

function KeyRow() {

	const key = useAIStore( s => s.key );
	const openConnect = useAIStore( s => s.openConnect );
	const removeKey = useAIStore( s => s.removeKey );

	return (
		<Row>
			{label( 'Gemini key', 'Kept in this browser only. Each edit sends the picture to Google and is billed to this key.' )}
			<div className="flex items-center gap-1">
				<span className="text-xs text-muted-foreground">{key ? `••••${key.slice( - 4 )}` : 'None'}</span>
				<Button variant="ghost" className={PILL} onClick={() => openConnect()}>{key ? 'Change' : 'Add'}</Button>
				{key && <Button variant="ghost" className={PILL} onClick={removeKey}>Remove</Button>}
			</div>
		</Row>
	);

}

const AITab = () => {

	const render = useStore( s => s.selectedResult );
	const connect = useAIStore( s => s.connect );

	return (
		<div>
			<Separator className="bg-primary" />
			<div className="space-y-2 p-2">
				{connect && <KeyForm />}
				{! connect && ! render && <p className="py-4 text-sm text-center text-muted-foreground">Pick a render on the left to edit it with AI.</p>}
				{! connect && render && <Editor render={render} />}
				{! connect && (
					<>
						<Separator className="my-2" />
						<KeyRow />
					</>
				)}
			</div>
		</div>
	);

};

export default AITab;
