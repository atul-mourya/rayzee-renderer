import { getApp } from '@/lib/appProxy';

const loads = new WeakMap();

/**
 * Load the spot-light gobo and IES libraries into an app, once. Started after the first frame:
 * they are ~180 downloads, and nothing needs them until a light is given a mask or a profile.
 */
export function loadLightLibraries( app ) {

	if ( ! loads.has( app ) ) {

		loads.set( app, ( async () => {

			try {

				const [ { GOBO_LIBRARY }, { IES_LIBRARY } ] = await Promise.all( [
					import( '@/services/GoboLibrary' ),
					import( '@/services/IESLibrary' ),
				] );
				await Promise.all( [
					app.goboManager?.loadLibrary?.( GOBO_LIBRARY ),
					app.iesManager?.loadLibrary?.( IES_LIBRARY ),
				] );

				let used = false;
				app.scene?.traverse( o => {

					if ( o.isLight && ( o.userData?.gobo || o.userData?.ies ) ) used = true;

				} );
				if ( used ) app.reset();

			} catch ( e ) {

				console.warn( 'Light mask / IES library load failed', e );

			}

		} )() );

	}

	return loads.get( app );

}

/** Resolves once the running app's libraries have loaded, or failed to. */
export function lightLibrariesReady() {

	const app = getApp();
	return ( app && loads.get( app ) ) || Promise.resolve();

}
