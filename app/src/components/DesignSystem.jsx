import { useEffect, useState } from "react";
import { AlertTriangle, Aperture, Camera, Check, Eye, Info, Plus, Sparkles, Sun, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
	AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge, Chip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorInput } from "@/components/ui/colorinput";
import { ControlGroup } from "@/components/ui/control-group";
import {
	Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
	DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Menubar, MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarTrigger } from "@/components/ui/menubar";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Row } from "@/components/ui/row";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { SliderToggle } from "@/components/ui/slider-toggle";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/toaster";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Vector3Component } from "@/components/ui/vector3";

// The design system's reference: its tokens and every shared control, in either theme (the token test lists the parts
// it leaves out). Opened with `?design` in the app's URL (main.jsx); it starts no renderer. docs/design/DESIGN_SYSTEM.md
// says how to use what it shows.

const PARTS = [ "scene.pbrt", "geometry/terrain.pbrt", "geometry/trees.pbrt", "materials.pbrt", "lights.pbrt", "textures/bark.png", "textures/leaves.png", "textures/rock.exr" ];

// [ token, use ]
const GROUPS = [
	[ "Surfaces and text", "The shadcn tokens every primitive is built on.", [
		[ "background", "Panels and the app frame" ], [ "foreground", "Body text" ],
		[ "card", "Cards and dialogs" ], [ "card-foreground", "Text on a card" ],
		[ "popover", "Menus and popovers" ], [ "popover-foreground", "Text in a menu" ],
		[ "secondary", "Secondary buttons" ], [ "secondary-foreground", "Their text" ],
		[ "muted", "Section headers, quiet fills" ], [ "muted-foreground", "Hints and quiet buttons" ],
		[ "accent", "Hover and the chosen row" ], [ "accent-foreground", "Text on it" ],
		[ "border", "Dividers and edges" ], [ "input", "A switch's off track, a slider's fill" ],
		[ "field", "The edge of a field you type into" ], [ "ring", "Keyboard focus" ],
	]],
	[ "Signals", "Colour is never the only signal: each comes with a word or an icon.", [
		[ "primary", "On, chosen, the main action" ], [ "primary-foreground", "Text on it" ],
		[ "destructive", "A destructive button's fill" ], [ "destructive-foreground", "Text on it" ],
		[ "error", "Error text and icons, removing on hover" ], [ "warning", "Quota, waiting, needs attention" ],
		[ "success", "Done (over the render)" ], [ "ai", "AI in progress and hints" ],
		[ "ai-600", "Made by the AI editor (a chip's fill)" ], [ "ai-500", "The marked area's edge" ],
		[ "ai-400", "AI in progress over a picture" ], [ "checked", "A checked box in the scene list" ],
		[ "disabled", "A disabled slider's fill" ], [ "highlight", "A search match" ],
		[ "favorite", "A favourite" ], [ "favorite-outline", "Not yet a favourite" ],
	]],
	[ "Over the render", "Chips, toolbars and dialogs drawn over the picture: the same in both themes.", [
		[ "scrim", "Behind a chip or a dialog (with an opacity: /50 … /80)" ], [ "on-scrim", "Values and titles on it" ],
		[ "on-scrim-200", "Its secondary text" ], [ "on-scrim-300", "Its labels" ], [ "on-scrim-400", "Its hints" ],
		[ "on-scrim-error", "An error on it" ], [ "overlay-accent", "The stats overlay's active value" ],
		[ "well", "Behind a picture or thumbnail" ], [ "placeholder", "A picture still loading" ],
		[ "placeholder-pulse", "Its pulse" ], [ "handle", "The compare slider" ], [ "on-handle", "Its arrows" ],
	]],
	[ "Floating", "A row's popover of expert controls (⋮).", [
		[ "surface-float", "Its surface" ], [ "float-input", "Fields inside it" ], [ "float-border", "Its edge (at /30)" ],
	]],
];

const DATA = [ "axis-x", "axis-y", "axis-z", "kind-object", "kind-data" ];
const TOKENS = [ ...GROUPS.flatMap( ( [ , , tokens ] ) => tokens.map( ( [ t ] ) => t ) ), ...DATA ];

// A token's colour: the shadcn ones are HSL triplets.
const paint = value => /^[\d.]+ /.test( value ) ? `hsl(${value})` : value;

const TYPE = [
	[ "text-lg", "18 px" ], [ "text-base", "16 px" ], [ "text-sm", "14 px" ], [ "text-xs", "12 px" ],
	[ "text-2xs", "11 px" ], [ "text-xxs", "10 px" ], [ "text-3xs", "9 px" ],
];

function Section( { title, note, children } ) {

	return (
		<section className="space-y-3">
			<div>
				<h2 className="text-sm font-semibold">{title}</h2>
				{note && <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{note}</p>}
			</div>
			{children}
		</section>
	);

}

function Swatch( { token, use, value } ) {

	return (
		<div className="flex items-center gap-3">
			<div className="h-8 w-12 shrink-0 rounded-md border border-border" style={{ background: paint( value ) }} />
			<div className="min-w-0">
				<div className="text-2xs font-medium">--{token}</div>
				<div className="truncate text-xxs text-muted-foreground">{use}</div>
				<div className="truncate text-xxs text-muted-foreground tabular-nums">{paint( value )}</div>
			</div>
		</div>
	);

}

export default function DesignSystem() {

	const [ dark, setDark ] = useState( true );
	const [ bounces, setBounces ] = useState( 8 );
	const [ mode, setMode ] = useState( "orbit" );
	const [ aiOnly, setAiOnly ] = useState( false );
	const [ values, setValues ] = useState( {} );
	const { toast } = useToast();

	// On the root, as the app's theme provider does: menus and tooltips render outside this tree.
	useEffect( () => {

		document.documentElement.classList.toggle( "dark", dark );
		document.documentElement.classList.toggle( "light", ! dark );
		const style = getComputedStyle( document.documentElement );
		setValues( Object.fromEntries( TOKENS.map( t => [ t, style.getPropertyValue( `--${t}` ).trim() ] ) ) );

	}, [ dark ] );

	return (
		<TooltipProvider>
			<div className="min-h-screen bg-background text-foreground">
				<header className="sticky top-0 z-10 flex h-12 items-center gap-4 border-b border-border bg-background px-6">
					<h1 className="text-sm font-semibold">Rayzee design system</h1>
					<span className="text-xs text-muted-foreground">The app&apos;s tokens and controls</span>
					<div className="grow" />
					<Tabs value={dark ? "dark" : "light"} onValueChange={v => setDark( v === "dark" )}>
						<TabsList>
							<TabsTrigger value="dark">Dark</TabsTrigger>
							<TabsTrigger value="light">Light</TabsTrigger>
						</TabsList>
					</Tabs>
				</header>

				<main className="mx-auto grid max-w-6xl gap-10 px-6 py-8 lg:grid-cols-[1fr_20rem]">
					<div className="space-y-10">
						{GROUPS.map( ( [ title, note, tokens ] ) => (
							<Section key={title} title={title} note={note}>
								<div className="grid gap-3 sm:grid-cols-2">{tokens.map( ( [ t, u ] ) => <Swatch key={t} token={t} use={u} value={values[ t ] ?? ""} /> )}</div>
							</Section>
						) )}

						<Section title="Data colours" note="Values, not chrome: the X, Y and Z axes, object kinds in the scene list. Darker in light, to read on white.">
							<div className="flex flex-wrap gap-2">
								{DATA.map( t => (
									<div key={t} className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
										<span className="h-3 w-3 rounded-sm" style={{ background: `var(--${t})` }} />
										<span className="text-xxs" style={{ color: `var(--${t})` }}>{t}</span>
									</div>
								) )}
							</div>
						</Section>

						<Section title="Type" note="PT Sans, else the platform's UI face. Below 12 px the sizes keep the line height they inherit.">
							<div className="divide-y divide-border rounded-lg border border-border">
								{TYPE.map( ( [ cls, px ] ) => (
									<div key={cls} className="flex items-baseline gap-4 px-4 py-2">
										<span className="w-20 shrink-0 text-xxs text-muted-foreground">{cls.replace( "text-", "" )} · {px}</span>
										<span className={cls}>Bounces 12 · 1920 × 1080</span>
									</div>
								) )}
							</div>
						</Section>

						<Section title="Corners and elevation" note="Corners derive from --radius (0.3 rem). Only what floats over the page casts a shadow.">
							<div className="flex flex-wrap items-end gap-4">
								{[ "rounded-sm", "rounded-md", "rounded-lg", "rounded-full" ].map( r => (
									<div key={r} className="flex flex-col items-center gap-1.5">
										<div className={cn( r, "h-12 w-16 bg-secondary" )} />
										<span className="text-xxs text-muted-foreground">{r}</span>
									</div>
								) )}
								<div className="flex flex-col items-center gap-1.5">
									<div className="h-12 w-20 rounded-lg border border-float-border/30 bg-surface-float shadow-float" />
									<span className="text-xxs text-muted-foreground">shadow-float</span>
								</div>
							</div>
						</Section>

						<Section title="Buttons">
							<div className="space-y-3">
								<div className="flex flex-wrap items-center gap-2">
									<Button>Render</Button>
									<Button variant="secondary">Save view</Button>
									<Button variant="outline">Export…</Button>
									<Button variant="ghost">Reset</Button>
									<Button variant="destructive">Delete render</Button>
									<Button variant="link">Learn more</Button>
									<Button disabled>Disabled</Button>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<Button size="lg">Large</Button>
									<Button>Default</Button>
									<Button size="sm">Small</Button>
									<Button size="icon" variant="ghost" aria-label="Camera"><Camera size={14} /></Button>
									<Button size="icon" variant="outline" aria-label="Sun"><Sun size={14} /></Button>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<span className="control-hint">In a panel:</span>
									<Button size="xs" variant="outline">Add key</Button>
									<Button size="pill">Reset</Button>
									<Button size="icon-xs" variant="outline" aria-label="Add"><Plus size={12} /></Button>
									<Button size="icon-xs" variant="ghost" aria-label="Show"><Eye size={12} /></Button>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<span className="control-hint">Pressed:</span>
									<Button variant="outline" size="xs" aria-pressed={! aiOnly} onClick={() => setAiOnly( false )}>All</Button>
									<Button variant="outline" size="xs" aria-pressed={aiOnly} onClick={() => setAiOnly( true )}>AI only</Button>
									<span className="control-hint">Text:</span>
									<Button variant="quiet" size="text">Cancel</Button>
								</div>
								<div className="flex flex-wrap items-center gap-2 rounded-md bg-muted-foreground p-3">
									<span className="text-xs text-on-scrim">Over a picture:</span>
									<Button size="xs" rounded><Check size={14} className="mr-1" /> Save</Button>
									<Button size="xs" rounded><X size={14} className="mr-1" /> Ignore</Button>
								</div>
							</div>
						</Section>

						<Section title="Switching views" note="A tab bar's variant styles its tabs: bar (the sidebar's icon tabs), pills, compact.">
							<div className="grid max-w-md gap-4">
								<Tabs defaultValue="camera">
									<TabsList variant="bar" className="grid-cols-3">
										<TabsTrigger value="tracer"><Aperture size={14} /><span className="text-xs">Tracer</span></TabsTrigger>
										<TabsTrigger value="camera"><Camera size={14} /><span className="text-xs">Camera</span></TabsTrigger>
										<TabsTrigger value="light"><Sun size={14} /><span className="text-xs">Light</span></TabsTrigger>
									</TabsList>
								</Tabs>
								<Tabs defaultValue="properties">
									<TabsList variant="pills" className="grid-cols-2">
										<TabsTrigger value="properties">Properties</TabsTrigger>
										<TabsTrigger value="textures">Textures</TabsTrigger>
									</TabsList>
								</Tabs>
								<Tabs defaultValue="models">
									<TabsList variant="compact" className="grid-cols-3">
										<TabsTrigger value="models">Models</TabsTrigger>
										<TabsTrigger value="materials">Materials</TabsTrigger>
										<TabsTrigger value="environments">Environments</TabsTrigger>
									</TabsList>
								</Tabs>
							</div>
						</Section>

						<Section title="Status">
							<div className="space-y-3">
								<div className="flex flex-wrap gap-2">
									<Badge>Rendering</Badge>
									<Badge variant="secondary">1024 spp</Badge>
									<Badge variant="destructive">Failed</Badge>
									<Badge variant="outline">EXR</Badge>
									<Badge variant="secondary" size="sm">interior</Badge>
								</div>
								<div className="max-w-sm space-y-1.5">
									<Progress value={62} />
									<div className="flex justify-between text-xs text-muted-foreground"><span>Building BVH</span><span>62 %</span></div>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									<Alert><Info className="h-4 w-4" /><AlertTitle>Saved</AlertTitle><AlertDescription>The render is on the Results page.</AlertDescription></Alert>
									<Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Couldn&apos;t load</AlertTitle><AlertDescription>The file isn&apos;t a glTF. Open a .glb or .gltf.</AlertDescription></Alert>
								</div>
								<div className="flex flex-wrap items-center gap-2 rounded-md bg-muted-foreground p-3">
									<span className="text-xs text-on-scrim">Chips over a picture:</span>
									<Chip>Render</Chip>
									<Chip tone="ai">v2</Chip>
									<Chip>⏱ 1m 12s</Chip>
									<Chip size="sm">v3</Chip>
									<Chip tone="ai" size="sm"><Sparkles size={10} />2</Chip>
								</div>
							</div>
						</Section>

						<Section title="Menus, dialogs and popovers">
							<div className="flex h-10 items-center rounded-md border border-border px-2">
								<Menubar>
									<MenubarMenu>
										<MenubarTrigger>File</MenubarTrigger>
										<MenubarContent>
											<MenubarItem>Open</MenubarItem>
											<MenubarItem>Open Recent…</MenubarItem>
											<MenubarSeparator />
											<MenubarItem>Export Picture…</MenubarItem>
										</MenubarContent>
									</MenubarMenu>
									<MenubarMenu>
										<MenubarTrigger>Edit</MenubarTrigger>
										<MenubarContent><MenubarItem disabled>Undo</MenubarItem></MenubarContent>
									</MenubarMenu>
								</Menubar>
							</div>
							<div className="flex flex-wrap items-start gap-4">
								<Dialog>
									<DialogTrigger asChild><Button variant="outline">Dialog</Button></DialogTrigger>
									<DialogContent>
										<DialogHeader>
											<DialogTitle>Import from URL</DialogTitle>
											<DialogDescription>Paste a link to a .glb, .gltf or .zip.</DialogDescription>
										</DialogHeader>
										<Input placeholder="https://…" />
										<DialogFooter><Button>Import</Button></DialogFooter>
									</DialogContent>
								</Dialog>
								<AlertDialog>
									<AlertDialogTrigger asChild><Button variant="outline">Confirm</Button></AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>Delete this render?</AlertDialogTitle>
											<AlertDialogDescription>Its AI versions go with it. This can&apos;t be undone.</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Keep</AlertDialogCancel>
											<AlertDialogAction>Delete</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
								<Popover>
									<PopoverTrigger asChild><Button variant="outline">Popover</Button></PopoverTrigger>
									<PopoverContent className="text-xs">Anything that opens beside its button and stays until clicked away.</PopoverContent>
								</Popover>
								<DropdownMenu>
									<DropdownMenuTrigger asChild><Button variant="outline">File</Button></DropdownMenuTrigger>
									<DropdownMenuContent align="start" className="w-52">
										<DropdownMenuLabel>Open</DropdownMenuLabel>
										<DropdownMenuItem>Open model…<DropdownMenuShortcut>⌘O</DropdownMenuShortcut></DropdownMenuItem>
										<DropdownMenuItem>Open folder…</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem>Export picture…</DropdownMenuItem>
										<DropdownMenuItem disabled>Export video…</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
								<Tooltip>
									<TooltipTrigger asChild><Button variant="ghost">Hover for a tooltip</Button></TooltipTrigger>
									<TooltipContent>How many times light may bounce between surfaces.</TooltipContent>
								</Tooltip>
								<Button variant="ghost" onClick={() => toast( { title: "Saved", description: "The render is on the Results page." } )}>Notification</Button>
								<Button variant="ghost" onClick={() => toast( { title: "Couldn’t load the catalog", description: "The server didn’t answer.", variant: "destructive" } )}>Failure</Button>
							</div>
						</Section>
					</div>

					<aside className="space-y-4">
						<div className="text-xs text-muted-foreground">A panel, as the right sidebar builds one</div>
						<div className="overflow-hidden rounded-lg border border-border">
							<ControlGroup name="Path Tracer" defaultOpen>
								<div className="space-y-3 p-3">
									<Row><Switch label="Enable" defaultChecked /></Row>
									<Row more={<Row><Slider label="Transmissive Bounces" min={0} max={64} value={[ 12 ]} /></Row>}>
										<Slider label="Bounces" min={0} max={20} value={[ bounces ]} onValueChange={v => setBounces( v[ 0 ] )} />
									</Row>
									<Row>
										<span className="control-label">Light Transport</span>
										<Select defaultValue="path">
											<SelectTrigger size="sm" className="max-w-32"><SelectValue /></SelectTrigger>
											<SelectContent>
												<SelectItem value="path">Path Tracing</SelectItem>
												<SelectItem value="bidirectional">Bidirectional</SelectItem>
												<SelectItem value="vcm">Vertex Merging</SelectItem>
											</SelectContent>
										</Select>
									</Row>
									<Row><SliderToggle label="Emissive Geometry" enabled value={[ 40 ]} /></Row>
									<Separator />
									<Row><Slider label="Disabled" min={0} max={10} value={[ 4 ]} disabled /></Row>
								</div>
							</ControlGroup>
							<ControlGroup name="Camera" defaultOpen>
								<div className="space-y-3 p-3">
									<Row>
										<span className="control-label">Navigation</span>
										<ToggleGroup type="single" size="xs" value={mode} onValueChange={v => v && setMode( v )}>
											<ToggleGroupItem value="orbit">Orbit</ToggleGroupItem>
											<ToggleGroupItem value="walk">Walk</ToggleGroupItem>
										</ToggleGroup>
									</Row>
									<Row><NumberInput label="Focal Length" value={35} min={8} max={300} step={1} precision={0} /></Row>
									<Row><ColorInput label="Background Color" value="#3a5f7d" /></Row>
									<Row><Vector3Component label="Position" value={[ 1.2, 0.5, - 3 ]} /></Row>
								</div>
							</ControlGroup>
							<ControlGroup name="Closed section" />
						</div>
						<div className="space-y-2 rounded-lg border border-border p-3">
							<label className="flex items-center gap-2 text-xs"><Checkbox defaultChecked /> Keep HDR copy</label>
							<Label htmlFor="ds-search">Search</Label>
							<Input id="ds-search" placeholder="Search…" />
							<Textarea id="ds-change" aria-label="The change" placeholder="Describe the change, like “make it evening”" />
						</div>
						<div className="space-y-1.5">
							<div className="text-xs text-muted-foreground">A list that scrolls, as a dialog shows a scene&apos;s parts</div>
							<ScrollArea className="h-28 rounded-md border border-border">
								<div className="space-y-1 p-2">{PARTS.map( p => <label key={p} className="flex items-center gap-2 text-xs"><Checkbox /> {p}</label> )}</div>
							</ScrollArea>
						</div>
					</aside>
				</main>
			</div>
			<Toaster />
		</TooltipProvider>
	);

}
