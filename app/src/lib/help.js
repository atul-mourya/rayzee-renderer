// Where help lives: the docs site, shipped beside the app at docs/ (app/vite.config.js), and the code on GitHub.

export const REPO_URL = 'https://github.com/atul-mourya/rayzee-renderer';

/**
 * A docs page's address beside the running app.
 * @param {string} [page] the site's route: 'app/', 'app/controls', 'guide/getting-started'
 * @returns {string}
 */
export function docsUrl( page = '' ) {

	return new URL( `docs/#/${page}`, document.baseURI ).href;

}
