import { useEffect, useState } from "react";
import { AlertTriangle, Aperture, Camera, Info, Plus, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorInput } from "@/components/ui/colorinput";
import { ControlGroup } from "@/components/ui/control-group";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
	DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Progress } from "@/components/ui/progress";
import { Row } from "@/components/ui/row";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { SliderToggle } from "@/components/ui/slider-toggle";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Vector3Component } from "@/components/ui/vector3";

// The design system's reference: every token and control, in either theme. Opened with `?design` in the app's URL
// (main.jsx); it starts no renderer. docs/design/DESIGN_SYSTEM.md says how to use what it shows.

// [ token, use, true for an HSL triplet (the shadcn tokens) ]
const GROUPS = [
	[ "Surfaces and text", "The shadcn tokens every primitive is built on.", [
		[ "background", "Panels and the app frame", true ], [ "foreground", "Body text", true ],
		[ "card", "Cards and dialogs", true ], [ "popover", "Menus and popovers", true ],
		[ "secondary", "Secondary buttons", true ], [ "muted", "Section headers, quiet fills", true ],
		[ "muted-foreground", "Labels and hints", true ], [ "accent", "Hover and the chosen row", true ],
		[ "border", "Dividers and edges", true ], [ "input", "Field edges", true ],
	]],
	[ "Signals", "Colour is never the only signal: each comes with a word or an icon.", [
		[ "primary", "On, chosen, the main action", true ], [ "ring", "Keyboard focus", true ],
		[ "destructive", "Destructive buttons and alerts", true ], [ "success", "Done" ],
		[ "warning-400", "Quota and waiting" ], [ "warning-500", "Needs attention" ],
		[ "danger-300", "AI errors" ], [ "danger-400", "Inline errors" ], [ "danger-500", "A failed list" ],
		[ "ai-600", "Made by the AI editor" ], [ "ai-400", "AI in progress" ], [ "ai-300", "AI hints" ],
		[ "checked", "A checked box in the scene list" ], [ "disabled", "A disabled slider's fill" ],
		[ "highlight", "A search match" ], [ "favorite", "A favourite" ],
	]],
	[ "Over the render", "Chips, toolbars and dialogs drawn over the picture: the same in both themes.", [
		[ "scrim", "Behind a chip or a dialog (with an opacity: /50 … /80)" ], [ "on-scrim", "Values and titles on it" ],
		[ "on-scrim-200", "Its secondary text" ], [ "on-scrim-300", "Its labels" ], [ "on-scrim-400", "Its hints" ],
		[ "overlay-accent", "The stats overlay's active value" ], [ "well", "Behind a picture or thumbnail" ],
		[ "placeholder", "A picture still loading" ], [ "handle", "The compare slider" ],
	]],
	[ "Floating", "A row's popover of expert controls (⋮).", [
		[ "surface-float", "Its surface" ], [ "float-input", "Fields inside it" ],
	]],
];

const DATA = [ "axis-x", "axis-y", "axis-z", "kind-object", "kind-data" ];
const CHARTS = [ "chart-1", "chart-2", "chart-3", "chart-4", "chart-5" ];

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

function Swatch( { token, use, hsl } ) {

	return (
		<div className="flex items-center gap-3">
			<div className="h-8 w-12 shrink-0 rounded-md border border-border" style={{ background: hsl ? `hsl(var(--${token}))` : `var(--${token})` }} />
			<div className="min-w-0">
				<div className="text-2xs font-medium">--{token}</div>
				<div className="truncate text-xxs text-muted-foreground">{use}</div>
			</div>
		</div>
	);

}

export default function DesignSystem() {

	const [ dark, setDark ] = useState( true );
	const [ bounces, setBounces ] = useState( 8 );
	const [ mode, setMode ] = useState( "orbit" );

	// On the root, as the app's theme provider does: menus and tooltips render outside this tree.
	useEffect( () => {

		document.documentElement.classList.toggle( "dark", dark );
		document.documentElement.classList.toggle( "light", ! dark );

	}, [ dark ] );

	return (
		<TooltipProvider>
			<div className="min-h-screen bg-background text-foreground">
				<header className="sticky top-0 z-10 flex h-12 items-center gap-4 border-b border-border bg-background px-6">
					<span className="text-sm font-semibold">Rayzee design system</span>
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
								<div className="grid gap-3 sm:grid-cols-2">{tokens.map( ( [ t, u, hsl ] ) => <Swatch key={t} token={t} use={u} hsl={hsl} /> )}</div>
							</Section>
						) )}

						<Section title="Data colours" note="Values, not chrome: the X, Y and Z axes, object kinds in the scene list, chart series.">
							<div className="flex flex-wrap gap-2">
								{DATA.map( t => (
									<div key={t} className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
										<span className="h-3 w-3 rounded-sm" style={{ background: `var(--${t})` }} />
										<span className="text-xxs text-muted-foreground">{t}</span>
									</div>
								) )}
								{CHARTS.map( t => (
									<div key={t} className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
										<span className="h-3 w-3 rounded-sm" style={{ background: `hsl(var(--${t}))` }} />
										<span className="text-xxs text-muted-foreground">{t}</span>
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
									<TabsList variant="compact" className="relative grid w-full grid-cols-3 h-auto p-0">
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
									<span className="rounded-full bg-ai-600 px-2 py-0.5 text-2xs font-semibold text-on-scrim">v3</span>
								</div>
								<div className="max-w-sm space-y-1.5">
									<Progress value={62} />
									<div className="flex justify-between text-xs text-muted-foreground"><span>Building BVH</span><span>62 %</span></div>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									<Alert><Info className="h-4 w-4" /><AlertTitle>Saved</AlertTitle><AlertDescription>The render is on the Results page.</AlertDescription></Alert>
									<Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Couldn&apos;t load</AlertTitle><AlertDescription>The file isn&apos;t a glTF. Open a .glb or .gltf.</AlertDescription></Alert>
								</div>
								<div className="flex flex-wrap items-center gap-2 rounded-md bg-well p-3">
									<span className="rounded-md bg-scrim/60 px-2 py-1 text-xs text-on-scrim-300">Render</span>
									<span className="rounded-md bg-ai-600 px-2 py-1 text-xs text-on-scrim">v2</span>
									<span className="rounded-full bg-scrim/60 px-2 py-1 text-xs text-on-scrim-200">Save</span>
								</div>
							</div>
						</Section>

						<Section title="Floating">
							<div className="flex flex-wrap items-start gap-4">
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
							<Input placeholder="Search…" />
							<Textarea placeholder="Describe the change, like “make it evening”" />
						</div>
					</aside>
				</main>
			</div>
		</TooltipProvider>
	);

}
