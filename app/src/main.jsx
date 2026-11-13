import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { crossOriginIsolate } from './lib/crossOriginIsolation';

// `?design` shows the design system's reference page instead of the app; neither downloads the other, and the page
// skips the engine (the version log imports it). Both fetch while isolation settles.
const page = new URLSearchParams( location.search ).has( 'design' )
	? import( './components/DesignSystem.jsx' )
	: Promise.all( [ import( './App.jsx' ), import( './lib/version' ) ] ).then( ( [ app, version ] ) => {

		version.logVersion();
		return app;

	} );

Promise.all( [ page, crossOriginIsolate() ] ).then( ( [ { default: Page } ] ) => createRoot( document.getElementById( 'root' ) ).render(
	<StrictMode>
		<Page />
	</StrictMode>,
) );
