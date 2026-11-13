# The app's design system

Every colour, text size and shadow the app draws comes from a token in `app/src/index.css`, and every control from a
primitive in `app/src/components/ui/`. Open the app with `?design` in its address (`http://localhost:5173/?design`)
for the reference page (`app/src/components/DesignSystem.jsx`): every token and control, dark and light. It starts no
renderer. `tests/unit/app/designTokens.test.js` keeps the rules below.

The look is the app's own: shadcn's slate theme (blue-grey surfaces, a blue accent), PT Sans, `--radius` 0.3 rem. The
tokens were introduced without changing a pixel: each holds the exact colour the class it replaced drew, and the app
measured the same before and after in both themes.

## Tokens

| Group | Tokens | Use |
|---|---|---|
| Surfaces and text | `background`, `foreground`, `card`, `popover`, `secondary`, `muted`, `muted-foreground`, `accent`, `border`, `input`, `ring` | shadcn's, as HSL triplets (`hsl(var(--background))`). Every primitive is built on them. |
| Signals | `primary`, `destructive`, `success`, `warning-400/500`, `danger-50…600`, `ai-300…600`, `checked`, `disabled`, `highlight`, `favorite`, `favorite-outline` | A role with several shades keeps each shade the app used (`danger-300` for the AI tab's errors, `danger-400` for inline ones). |
| Over the render | `scrim` (with an opacity: `bg-scrim/60`), `on-scrim`, `on-scrim-200/300/400`, `overlay-accent`, `well`, `placeholder`, `placeholder-pulse`, `handle`, `on-handle` | Chips, toolbars, dialogs and pictures over the render: the same in both themes. |
| Floating | `surface-float`, `float-input`, `float-border` (at `/30`), `shadow-float` | A row's popover of expert controls (⋮). |
| Data | `axis-x/y/z`, `kind-object`, `kind-data`, `chart-1…5` | Values, not chrome: axis labels, object kinds in the scene list, chart series. |
| Type | Tailwind's `text-xs` 12 · `sm` 14 · `base` 16 · `lg` 18 px, and `text-2xs` 11 · `text-xxs` 10 · `text-3xs` 9 px | The three below `xs` set no line height: they keep the one they inherit, as the `text-[10px]` they replaced did. |
| Corners | `rounded-sm` · `md` · `lg` from `--radius` | |

A token is defined in both `:root` (light) and `.dark`; the test fails if one theme lacks one. Shades that differ only
slightly (three reds for error text, four greys for text over the render) are kept apart because merging them would
change the look; a merge is a look change, made on purpose.

## Building a panel

```jsx
<ControlGroup name="Path Tracer" defaultOpen>
	<Row><Switch label="Enable" … /></Row>
	<Row more={<Row><Slider label="Transmissive Bounces" … /></Row>}>
		<Slider label="Bounces" … />                    {/* ⋮ opens the expert controls in a popover */}
	</Row>
</ControlGroup>
```

- Colours by role: `text-danger-400` for an inline error, `bg-scrim/60 text-on-scrim-300` for a chip over a picture,
  `text-ai-400` for AI work in progress. A new role, or a shade a role lacks, is a token in both themes first.
- Sizes: `text-xs` and up for text, `text-2xs` / `text-xxs` for dense labels and hints.

## Components own their shape

A component used as it is stays one component; restyled where it is used, each place becomes a copy that drifts (the
app had 30 dropdowns made into pills one at a time, and 58 labels dimmed by hand). So a shape a panel uses is a size
or variant of the component, and a caller passes only what is about its place: a width, a column count, a margin.

| Component | Panel shape | Use |
|---|---|---|
| `SelectTrigger` | `size="sm"`: the 20 px pill | `<SelectTrigger size="sm" className="max-w-32">` |
| `Button` | `size="xs"` (24 px), `"icon-xs"` (20 px round), `"pill"` (20 px pill) | a panel's actions; `sm`, `default`, `lg`, `icon` elsewhere |
| `ToggleGroup` | `size="xs"`, passed to its items | `<ToggleGroup size="xs">` (the group is already the 20 px pill) |
| `TabsList` | `variant="bar"` (a sidebar's icon tabs), `"pills"`, `"compact"`, passed to its tabs | `<TabsList variant="bar" className="grid-cols-6">` |
| Text | `control-label` (a control's name), `control-hint` (a note under it or in a dialog) | today both are `text-xs` at half opacity |

The `Slider` takes the keyboard once it is tabbed to: arrows step (Shift × 10), Page Up / Down × 10, Home and End jump
to its ends, Enter types a value (`sliderKeyTarget`). ⚠️ After a click the keys stay with the page: walk mode's arrows
walk after the Walk Speed slider is dragged.

## Rules the test keeps

- No Tailwind palette colour (`bg-blue-600`, `text-gray-300`, `bg-black/60`) and no hex in a component. The few that
  are data say why in the test's `ALLOWED` list: the convergence legend (the engine's overlay colours), material
  defaults, colours drawn into a canvas or an image.
- No colour function in an arbitrary value (`shadow-[…rgba(…)]`), and every `var(--x)` a component names exists.
- No pixel text sizes (`text-[10px]`): use the scale.
- Both themes define the same tokens; no shadow token is `none`; the sizes below `xs` set no line height.
- No pill dropdown, panel-sized toggle, styled tab or resized button written out where it is used, and no label or hint
  as `opacity-50 text-xs`: the sizes, variants and `control-label` / `control-hint` above.
- `cn()` knows `text-3xs`, `text-xxs` and `text-2xs` are sizes and `shadow-float` a shadow. ⚠️ tailwind-merge read an
  unknown size as a colour, and a colour after it dropped the size.
