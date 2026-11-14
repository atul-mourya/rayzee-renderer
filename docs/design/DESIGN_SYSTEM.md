# The app's design system

Every colour, text size and shadow the app draws comes from a token in `app/src/index.css`, and every control from a
primitive in `app/src/components/ui/`. Open the app with `?design` in its address (`http://localhost:5173/?design`)
for the reference page (`app/src/components/DesignSystem.jsx`): every colour with its value, and every shared control,
dark and light (the test names the few parts it leaves out, and why). It loads neither the app nor the engine.
`tests/unit/app/designTokens.test.js` keeps the rules below.

The look is the app's own: shadcn's slate theme (blue-grey surfaces, a blue accent), PT Sans, `--radius` 0.3 rem. PT
Sans is the installed face where there is one (macOS) and ships otherwise (`app/src/assets/fonts/`, regular and bold,
Latin; OFL). Text passes WCAG AA in both themes (4.5:1, 3:1 for a field's edge, an icon or the focus ring): measured
on the page's background and on the hover grey (`accent`). `designTokens.test.js` computes `foreground`,
`muted-foreground` and `primary` on every surface, and `primary-foreground` on `primary`, from the stylesheet; shadcn's
own dark `primary` (59.8 % lightness, 3.97:1 on the hover grey) is 64 % here (4.60:1), and light `muted-foreground` 45 %
(4.34 → 4.64:1). Text on a blue fill is `primary-foreground` (dark 5.62:1, light 4.94): the colour field's hex and a
slider's value once the fill reaches it (`foreground` there read 3.51 / 3.34). Blue text on a blue tint is the one
exception left: the selected mode tab and active render button (`primary/20`, dark 4.05, light 3.90) and a selected
light row (`primary/15`, dark 4.40, light 4.19).

## Tokens

| Group | Tokens | Use |
|---|---|---|
| Surfaces and text | `background`, `foreground`, `card`, `popover`, `secondary`, `muted`, `accent` (each with its `-foreground`), `border`, `input`, `field`, `ring` | shadcn's, as HSL triplets (`hsl(var(--background))`). `input` fills (a switch's track), `field` is the edge of a field typed into. |
| Signals | `primary`, `destructive` (fills, each with `-foreground`), `error`, `warning`, `ai` (text and icons), `success`, `ai-400…600`, `checked`, `disabled`, `highlight`, `favorite`, `favorite-outline` | One token a role: `text-error` for any error text or red icon, `bg-destructive` for a destructive button. |
| Over the render | `scrim` (with an opacity: `bg-scrim/60`), `on-scrim`, `on-scrim-200/300/400`, `on-scrim-error`, `overlay-accent`, `well`, `placeholder`, `placeholder-pulse`, `handle`, `on-handle` | Chips, toolbars, dialogs and pictures over the render: the same in both themes. |
| Floating | `surface-float`, `float-input`, `float-border` (at `/30`), `shadow-float` | A row's popover of expert controls (⋮). |
| Data | `axis-x/y/z`, `kind-object`, `kind-data` | Values, not chrome: axis labels, object kinds in the scene list. |
| Type | Tailwind's `text-xs` 12 · `sm` 14 · `base` 16 · `lg` 18 px, and `text-2xs` 11 · `text-xxs` 10 · `text-3xs` 9 px | The three below `xs` set no line height: they keep the one they inherit, as the `text-[10px]` they replaced did. |
| Corners | `rounded-sm` · `md` · `lg` from `--radius` | |

A colour both themes share is written once, in `:root`; one that differs is in both `:root:not(.dark)` (light) and
`.dark`. Light's text colours are a step darker than dark's (`error`, `warning`, `ai`, the axes), to read on white.

## Building a panel

```jsx
<ControlGroup name="Path Tracer" defaultOpen>
	<Row><Switch label="Enable" … /></Row>
	<Row more={<Row><Slider label="Transmissive Bounces" … /></Row>}>
		<Slider label="Bounces" … />                    {/* ⋮ opens the expert controls in a popover */}
	</Row>
	<Row>
		<span className="control-label">Light Transport</span>
		<Select …><SelectTrigger size="sm" className="max-w-32">…</SelectTrigger></Select>
	</Row>
</ControlGroup>
```

- Colours by role: `text-error` for an error, `<Chip>` for a label over a picture, `text-ai` for AI work in progress.
  A new role is a token first.
- Sizes: `text-xs` and up for text, `text-2xs` / `text-xxs` for dense labels and hints.
- Icons: 10, 12, 14 or 16 px — 12 beside panel text, 16 in dialogs and alerts, 10 inside the smallest controls.
- Names: a control with a `label` is named by it; in a `Row`, a dropdown or toggle group is named by the row's
  `control-label` (`useRowLabel`). An icon-only button takes an `aria-label`.
- No colour or movement fades: they were turned off on purpose (2025-03), so no `transition-colors` /
  `transition-transform`.

## Components own their shape

A component used as it is stays one component; restyled where it is used, each place becomes a copy that drifts (the
app had 30 dropdowns made into pills one at a time, and 58 labels dimmed by hand). So a shape a panel uses is a size
or variant of the component, and a caller passes only what is about its place: a width, a column count, a margin.

| Component | Shapes | Use |
|---|---|---|
| `Button` | sizes `xs` (24 px), `sm` (32), `default` (36), `lg`; `icon-xs` (20 round), `icon-sm` (32), `icon`; `pill` (20 px pill); `text` (no box) | a panel's actions are `xs`, `pill`, `icon-xs` |
| `Button` | `rounded` (round ends at any size: buttons over the render) | `<Button size="xs" rounded>` |
| `Button` | `variant="quiet"` (muted until hovered: a text action, a small icon in a row), `"quiet-destructive"` (the same, red on hover: remove, delete, cancel a load), `outline` with `aria-pressed` (a choice that stays on) | `<Button variant="quiet-destructive" size="icon-xs" aria-label="Remove light">` |
| `AlertDialogAction` | `variant="destructive"` | the confirm of a delete |
| `Chip` (`ui/badge.jsx`) | `tone="scrim"` / `"ai"`, `size="md"` / `"sm"` (16 px, on a thumbnail), `rounded` | a label over a picture: `<Chip tone="ai">v2</Chip>` |
| `Badge` | `size="sm"` | a tag on a catalog card |
| `Input` | `variant="filled"`: a panel's blue-tinted field, seen by its fill (plain fields show their edge) | the number field, the catalog search |
| `Menubar` | the top bar's: no box, quiet names | `<Menubar>` |
| `SelectTrigger` | `size="sm"`: the 20 px pill | `<SelectTrigger size="sm" className="max-w-32">` |
| `ToggleGroup` | `size="xs"`, passed to its items | `<ToggleGroup size="xs">` (the group is already the 20 px pill) |
| `TabsList` | `variant="bar"` (a sidebar's icon tabs), `"pills"`, `"compact"`, passed to its tabs | `<TabsList variant="compact" className="grid-cols-4">` |
| Text | `control-label` (a control's name), `control-hint` (a note under it or in a dialog) | `text-xs` at half opacity, 65 % in light |

The `Slider` takes the keyboard once it is tabbed to: arrows step (Shift × 10), Page Up / Down × 10, Home and End jump
to its ends, Enter types a value (`sliderKeyTarget`). ⚠️ After a click the keys stay with the page: walk mode's arrows
walk after the Walk Speed slider is dragged.

## Rules the test keeps

- No Tailwind palette colour (`bg-blue-600`, `text-gray-300`, `bg-black/60`) and no hex in a component. The few that
  are data say why in the test's `ALLOWED` list: the convergence legend (the engine's overlay colours), material
  defaults, colours drawn into a canvas or an image.
- No colour function in an arbitrary value (`shadow-[…rgba(…)]`), and every `var(--x)` a component names exists.
- No pixel text sizes (`text-[10px]`): use the scale.
- A colour is written once for both themes or once in each; the themes set the same tokens; no shadow token is `none`;
  the sizes below `xs` set no line height.
- No pill dropdown, panel-sized toggle, styled tab or tab bar, or resized button written out where it is used, and no
  label or hint as `opacity-50 text-xs`: the sizes, variants and `control-label` / `control-hint` above.
- No `<button>` or `<input>` outside `ui/` but the ones the test lists (thumbnails, tiles, rows), and no chip built from
  `bg-scrim` / `bg-ai-…` where it is used: a new one is a `Button`, a `Chip`, or a line in the list.
- Icons at 10, 12, 14 or 16 px. No `transition-colors` / `transition-transform`.
- Every `ui/` part is on the reference page or in the test's list of parts it leaves out, and every colour token is on
  the page.
- `cn()` knows `text-3xs`, `text-xxs` and `text-2xs` are sizes and `shadow-float` a shadow. ⚠️ tailwind-merge read an
  unknown size as a colour, and a colour after it dropped the size.
