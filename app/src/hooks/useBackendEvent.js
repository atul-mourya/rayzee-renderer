import { useEffect, useRef } from 'react';
import { getApp } from '@/lib/appProxy';

/**
 * React hook that subscribes to an event on the active app.
 *
 * @param {string} eventName - The event name to listen for (an `EngineEvents` value)
 * @param {Function} handler - The callback to invoke when the event fires
 */
export function useBackendEvent( eventName, handler ) {

	const handlerRef = useRef( handler );
	handlerRef.current = handler;

	useEffect( () => {

		const stableHandler = ( event ) => handlerRef.current( event );

		// Capture app reference so cleanup removes from the same instance
		const app = getApp();
		if ( app ) {

			app.addEventListener( eventName, stableHandler );

		}

		return () => {

			if ( app ) {

				app.removeEventListener( eventName, stableHandler );

			}

		};

	}, [ eventName ] );

}
