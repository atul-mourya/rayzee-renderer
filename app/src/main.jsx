import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { logVersion } from './lib/version';

logVersion();

createRoot( document.getElementById( 'root' ) ).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
