import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const SlotsContext = createContext( null );

export function StatusBarProvider( { children } ) {

	const [ slots, setSlots ] = useState( null );
	return <SlotsContext.Provider value={{ slots, setSlots }}>{children}</SlotsContext.Provider>;

}

// The bar along the bottom of the app. Its three places are filled by the viewport on screen (StatusBarPortal), so the
// live view and the Results page each bring their own graphs, picture size and toolbar.
export function StatusBar() {

	const { setSlots } = useContext( SlotsContext );
	const left = useRef( null );
	const center = useRef( null );
	const right = useRef( null );

	useLayoutEffect( () => {

		setSlots( { left: left.current, center: center.current, right: right.current } );
		return () => setSlots( null );

	}, [ setSlots ] );

	return (
		<footer className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-t">
			<div ref={left} className="flex h-full min-w-0 items-center overflow-hidden" />
			<div ref={center} className="flex items-center px-2" />
			<div ref={right} className="flex min-w-0 items-center justify-end px-2" />
		</footer>
	);

}

/** Shows `children` in one of the status bar's places: 'left', 'center' or 'right'. */
export function StatusBarPortal( { slot, children } ) {

	const place = useContext( SlotsContext )?.slots?.[ slot ];
	return place ? createPortal( children, place ) : null;

}
