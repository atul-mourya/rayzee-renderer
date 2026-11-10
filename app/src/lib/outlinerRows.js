// The Outliner's rows are a fixed 28 px (h-7); it mounts only those in view.
export const ROW_HEIGHT = 28;

/** The open tree as one list: a row a node, its children after it while it is open. */
export function flattenRows( nodes, collapsed, visibleOf, depth = 0, parentHidden = false, out = [] ) {

	for ( const item of nodes ) {

		const visible = visibleOf.get( item.uuid ) ?? item.visible;
		const open = ! collapsed.has( item.uuid );
		out.push( { item, depth, parentHidden, visible, open } );
		if ( open && item.children.length > 0 ) flattenRows( item.children, collapsed, visibleOf, depth + 1, parentHidden || ! visible, out );

	}

	return out;

}

/** The scroll position that brings row `index` into a view `height` px tall now at `top`: the nearest edge, or none. */
export function scrollToShow( index, top, height, rowHeight = ROW_HEIGHT ) {

	const start = index * rowHeight, end = start + rowHeight;
	if ( start < top ) return start;
	if ( end > top + height ) return end - height;
	return top;

}

/** The uuids above `uuid` in `nodes`, root first; null when it is not there. */
export function ancestorsOf( nodes, uuid, trail = [] ) {

	for ( const node of nodes ) {

		if ( node.uuid === uuid ) return trail;
		const found = ancestorsOf( node.children, uuid, [ ...trail, node.uuid ] );
		if ( found ) return found;

	}

	return null;

}
