// What a key press means to the whole app: 'deselect' (Esc), 'resetCamera' (R), 'playPause' (Space), or null. A key
// already handled (a menu's Esc or Space) does nothing more; Space does nothing on Results, and presses a control only
// when the keyboard (Tab) reached it.
const TYPING = new Set( [ 'INPUT', 'TEXTAREA', 'SELECT' ] );
const MENU_ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';
const CONTROL = 'button, a[href], [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"]';

export function shortcutFor( event, { appMode } = {} ) {

	const target = event.target;
	if ( event.defaultPrevented ) return null;
	if ( target && ( TYPING.has( target.tagName ) || target.isContentEditable || target.contentEditable === 'true' ) ) return null;

	const noModifiers = ! event.ctrlKey && ! event.altKey && ! event.shiftKey && ! event.metaKey;

	switch ( event.key ) {

		case 'Escape':
			return 'deselect';

		case 'r':
		case 'R':
			return noModifiers ? 'resetCamera' : null;

		case ' ':
			if ( appMode === 'results' ) return null;
			if ( target?.closest?.( MENU_ITEM ) ) return null;
			if ( target?.closest?.( CONTROL ) && target.matches?.( ':focus-visible' ) ) return null;
			return 'playPause';

		default:
			return null;

	}

}
