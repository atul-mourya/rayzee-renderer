/**
 * A canvas for a render nobody watches. three.js reads its size and asks it for a WebGPU context;
 * the camera controls attach listeners to it. Here the context presents into a plain texture, and
 * the listeners go nowhere, so no document, window or swapchain is needed. Read results with
 * `renderToBuffer()`; there is no picture to capture from it.
 */

const inert = {
	addEventListener() {},
	removeEventListener() {},
	dispatchEvent() {

		return true;

	},
};

class HeadlessGPUContext {

	constructor( canvas ) {

		this.canvas = canvas;
		this._configuration = null;
		this._texture = null;

	}

	configure( configuration ) {

		this.unconfigure();
		this._configuration = configuration;

	}

	unconfigure() {

		this._texture?.destroy();
		this._texture = null;
		this._configuration = null;

	}

	getConfiguration() {

		return this._configuration;

	}

	getCurrentTexture() {

		if ( ! this._configuration ) throw new Error( 'HeadlessGPUContext: getCurrentTexture() before configure()' );

		const width = Math.max( 1, this.canvas.width );
		const height = Math.max( 1, this.canvas.height );

		if ( this._texture?.width !== width || this._texture?.height !== height ) {

			const { device, format, usage } = this._configuration;
			this._texture?.destroy();
			this._texture = device.createTexture( { label: 'headless-canvas', size: [ width, height ], format, usage } );

		}

		return this._texture;

	}

}

/**
 * @param {number} [width=1]
 * @param {number} [height=1]
 */
export function createHeadlessCanvas( width = 1, height = 1 ) {

	const ownerDocument = { ...inert, defaultView: null };

	const canvas = {
		...inert,
		isHeadlessCanvas: true,
		width,
		height,
		clientWidth: 0,
		clientHeight: 0,
		style: {},
		parentNode: null,
		ownerDocument,
		getRootNode: () => ownerDocument,
		getBoundingClientRect() {

			return { x: 0, y: 0, left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height };

		},
		setPointerCapture() {},
		releasePointerCapture() {},
		hasPointerCapture: () => false,
		focus() {},
		getContext: ( type ) => ( type === 'webgpu' ? context : null ),
	};

	const context = new HeadlessGPUContext( canvas );
	return canvas;

}
