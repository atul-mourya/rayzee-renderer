import { describe, it, expect } from 'vitest';
import { shortcutFor } from '@/lib/keyboardShortcuts';

// A key press as the window sees it. `inside`: the element the target sits in, matched against each selector's own
// parts; `keyboardFocus`: the target matches :focus-visible (reached with Tab).
function press( key, { tag = 'DIV', inside = null, keyboardFocus = false, prevented = false, mods = {} } = {} ) {

	const within = sel => inside !== null && sel.split( ',' ).map( s => s.trim() ).includes( inside );
	return {
		key,
		defaultPrevented: prevented,
		ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
		target: {
			tagName: tag, contentEditable: 'inherit',
			closest: sel => ( within( sel ) || ( tag === 'BUTTON' && sel.split( ',' ).map( s => s.trim() ).includes( 'button' ) ) ? {} : null ),
			matches: sel => sel === ':focus-visible' && keyboardFocus,
		},
	};

}

describe( 'shortcutFor', () => {

	it( 'maps Esc, R and Space', () => {

		expect( shortcutFor( press( 'Escape' ) ) ).toBe( 'deselect' );
		expect( shortcutFor( press( 'r' ) ) ).toBe( 'resetCamera' );
		expect( shortcutFor( press( 'R' ) ) ).toBe( 'resetCamera' );
		expect( shortcutFor( press( ' ' ), { appMode: 'preview' } ) ).toBe( 'playPause' );
		expect( shortcutFor( press( ' ' ), { appMode: 'final-render' } ) ).toBe( 'playPause' );
		expect( shortcutFor( press( 'a' ) ) ).toBeNull();

	} );

	it( 'leaves R with a modifier to the browser (Cmd+R reloads)', () => {

		expect( shortcutFor( press( 'r', { mods: { metaKey: true } } ) ) ).toBeNull();
		expect( shortcutFor( press( 'R', { mods: { shiftKey: true } } ) ) ).toBeNull();

	} );

	it( 'undoes and redoes the Results page\'s edits with Cmd or Ctrl + Z, there only', () => {

		const results = { appMode: 'results' };
		expect( shortcutFor( press( 'z', { mods: { metaKey: true } } ), results ) ).toBe( 'undo' );
		expect( shortcutFor( press( 'z', { mods: { ctrlKey: true } } ), results ) ).toBe( 'undo' );
		expect( shortcutFor( press( 'Z', { mods: { metaKey: true, shiftKey: true } } ), results ) ).toBe( 'redo' );
		expect( shortcutFor( press( 'y', { mods: { ctrlKey: true } } ), results ) ).toBe( 'redo' );
		expect( shortcutFor( press( 'z' ), results ) ).toBeNull();
		expect( shortcutFor( press( 'z', { mods: { metaKey: true } } ), { appMode: 'preview' } ) ).toBeNull();
		expect( shortcutFor( press( 'z', { tag: 'INPUT', mods: { metaKey: true } } ), results ) ).toBeNull();

	} );

	it( 'ignores keys typed into a field', () => {

		for ( const tag of [ 'INPUT', 'TEXTAREA', 'SELECT' ] ) expect( shortcutFor( press( ' ', { tag } ) ) ).toBeNull();
		const editable = press( 'r' );
		editable.target.isContentEditable = true;
		expect( shortcutFor( editable ) ).toBeNull();

	} );

	it( 'does nothing more with a key something else handled (the right-click menu’s Esc and Space)', () => {

		expect( shortcutFor( press( 'Escape', { prevented: true } ) ) ).toBeNull();
		expect( shortcutFor( press( ' ', { prevented: true } ) ) ).toBeNull();

	} );

	it( 'plays or pauses from a control a click left focused (click Render, then Space)', () => {

		expect( shortcutFor( press( ' ', { tag: 'BUTTON' } ) ) ).toBe( 'playPause' );
		for ( const role of [ 'switch', 'tab', 'checkbox' ] ) {

			expect( shortcutFor( press( ' ', { inside: `[role="${role}"]` } ) ), role ).toBe( 'playPause' );

		}

	} );

	it( 'leaves Space to a control the keyboard reached, and to a menu item', () => {

		expect( shortcutFor( press( ' ', { tag: 'BUTTON', keyboardFocus: true } ) ) ).toBeNull();
		expect( shortcutFor( press( ' ', { inside: '[role="switch"]', keyboardFocus: true } ) ) ).toBeNull();
		expect( shortcutFor( press( ' ', { inside: '[role="menuitem"]' } ) ) ).toBeNull();
		expect( shortcutFor( press( ' ', { inside: '[role="option"]' } ) ) ).toBeNull();
		// The canvas, focused from the keyboard or not, is no control.
		expect( shortcutFor( press( ' ', { tag: 'CANVAS', keyboardFocus: true } ) ) ).toBe( 'playPause' );

	} );

	it( 'does not play the hidden renderer from the Results page', () => {

		expect( shortcutFor( press( ' ' ), { appMode: 'results' } ) ).toBeNull();
		expect( shortcutFor( press( 'Escape' ), { appMode: 'results' } ) ).toBe( 'deselect' );

	} );

} );
