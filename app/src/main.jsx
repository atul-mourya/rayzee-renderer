import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { logVersion } from './lib/version';
import { crossOriginIsolate } from './lib/crossOriginIsolation';

logVersion();

// `?design` shows the design system's reference page instead of the app (no renderer starts).
const DesignSystem = new URLSearchParams( location.search ).has( 'design' ) ? lazy( () => import( './components/DesignSystem.jsx' ) ) : null;

crossOriginIsolate().then( () => createRoot( document.getElementById( 'root' ) ).render(
	<StrictMode>
		{DesignSystem ? <Suspense fallback={null}><DesignSystem /></Suspense> : <App />}
	</StrictMode>,
) );
