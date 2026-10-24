import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { BrightnessContrastShader } from 'three/examples/jsm/shaders/BrightnessContrastShader.js';
import { Fn, If, uniform, float, vec3, max, min, mix, dot, select, fract, abs, sign, exp2 } from 'three/tsl';

// Custom shader for hue, saturation, and exposure
const ColorAdjustmentShader = {
	uniforms: {
		"tDiffuse": { value: null },
		"hue": { value: 0.0 },
		"saturation": { value: 0.0 },
		"exposure": { value: 0.0 },
		"gamma": { value: 2.2 }
	},
	vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
	fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float hue;
        uniform float saturation;
        uniform float exposure;
        uniform float gamma;
        varying vec2 vUv;

		// Function to decode from gamma space to linear space
		vec3 gammaToLinear(vec3 color) {
			return pow(color, vec3(2.2));
		}

		// Function to encode from linear space to gamma space
		vec3 linearToGamma(vec3 color, float gamma) {
			return pow(color, vec3(1.0 / gamma));
		}

		// Desaturate using luminosity factors
		vec3 desaturated(vec3 color) {
			// sRGB colorspace luminosity factor
			vec3 luma = vec3(0.2126, 0.7152, 0.0722);
			float luminance = dot(color, luma);
			return vec3(luminance);
		}

		// Apply saturation by mixing original color with desaturated version
		vec3 applyColorSaturation(vec3 color, float value) {
			vec3 gray = desaturated(color);
			return mix(gray, color, 1.0 + value);
		}

		// Function to convert RGB to HSL (for hue only)
        vec3 rgb2hsl(vec3 color) {
            float maxColor = max(max(color.r, color.g), color.b);
            float minColor = min(min(color.r, color.g), color.b);
            float delta = maxColor - minColor;
            
            float h = 0.0;
            float s = 0.0;
            float l = (maxColor + minColor) / 2.0;
            
            if (delta > 0.0) {
                s = l < 0.5 ? delta / (maxColor + minColor) : delta / (2.0 - maxColor - minColor);
                
                if (maxColor == color.r) {
                    h = (color.g - color.b) / delta + (color.g < color.b ? 6.0 : 0.0);
                } else if (maxColor == color.g) {
                    h = (color.b - color.r) / delta + 2.0;
                } else {
                    h = (color.r - color.g) / delta + 4.0;
                }
                h /= 6.0;
            }
            
            return vec3(h, s, l);
        }

        float hue2rgb(float p, float q, float t) {
            if (t < 0.0) t += 1.0;
            if (t > 1.0) t -= 1.0;
            if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
            if (t < 1.0/2.0) return q;
            if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
            return p;
        }
        
        // Function to convert HSL to RGB
        vec3 hsl2rgb(vec3 hsl) {
            float h = hsl.x;
            float s = hsl.y;
            float l = hsl.z;
            
            float r, g, b;
            
            if (s == 0.0) {
                r = g = b = l;
            } else {
                float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
                float p = 2.0 * l - q;
                
                r = hue2rgb(p, q, h + 1.0/3.0);
                g = hue2rgb(p, q, h);
                b = hue2rgb(p, q, h - 1.0/3.0);
            }
            
            return vec3(r, g, b);
        }

        void main() {
            vec4 texel = texture2D(tDiffuse, vUv);
			
			// Decode from gamma space to linear space
			vec3 linearColor = gammaToLinear(texel.rgb);
			
			// Apply saturation using luminosity-based approach
			vec3 colorWithSaturation = applyColorSaturation(linearColor, saturation);
			
			// Apply hue shift (still using HSL but only for hue)
			if (abs(hue) > 0.01) {
				vec3 hslColor = rgb2hsl(colorWithSaturation);
				hslColor.x = fract(hslColor.x + hue / 360.0);
				// Keep original saturation and luminance, only change hue
				colorWithSaturation = hsl2rgb(hslColor);
			}
			
			// Apply exposure
			vec3 colorWithExposure = colorWithSaturation * pow(2.0, exposure);
			
			// Encode back to gamma space using the gamma value
			vec3 finalColor = linearToGamma(colorWithExposure, gamma);
			
			gl_FragColor = vec4(finalColor, texel.a);
		}
    `
};

export class ImageProcessorComposer {

	constructor( inputCanvas, outputCanvas = null ) {

		if ( ! inputCanvas ) throw new Error( 'Input canvas is required' );

		this.inputCanvas = inputCanvas;
		this.outputCanvas = outputCanvas || document.createElement( 'canvas' );

		this.width = inputCanvas.width;
		this.height = inputCanvas.height;

		this.outputCanvas.width = this.width;
		this.outputCanvas.height = this.height;

		this.renderer = new THREE.WebGLRenderer( {
			canvas: this.outputCanvas,
			preserveDrawingBuffer: true,
		} );
		this.renderer.setSize( this.width, this.height, false );

		this.scene = new THREE.Scene();
		this.camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		// Create quad with input image
		const geometry = new THREE.PlaneGeometry( 2, 2 );
		const texture = new THREE.CanvasTexture( inputCanvas );
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;

		const material = new THREE.MeshBasicMaterial( { map: texture } );
		this.quad = new THREE.Mesh( geometry, material );
		this.scene.add( this.quad );

		// Composer setup
		this.composer = new EffectComposer( this.renderer );
		this.renderPass = new RenderPass( this.scene, this.camera );
		this.composer.addPass( this.renderPass );

		// Add brightness/contrast pass
		this.brightnessContrastPass = new ShaderPass( BrightnessContrastShader );
		this.brightnessContrastPass.uniforms[ 'brightness' ].value = 0;
		this.brightnessContrastPass.uniforms[ 'contrast' ].value = 0;
		this.composer.addPass( this.brightnessContrastPass );

		// Add color adjustment pass
		this.colorAdjustmentPass = new ShaderPass( ColorAdjustmentShader );
		this.colorAdjustmentPass.uniforms[ 'hue' ].value = 0;
		this.colorAdjustmentPass.uniforms[ 'saturation' ].value = 0;
		this.colorAdjustmentPass.uniforms[ 'exposure' ].value = 0;
		this.colorAdjustmentPass.uniforms[ 'gamma' ].value = 2.2;
		this.composer.addPass( this.colorAdjustmentPass );

	}

	resize( width, height ) {

		this.width = width;
		this.height = height;
		this.renderer.setSize( width, height, false );
		this.composer.setSize( width, height );

		// Recreate texture to pick up new canvas dimensions
		if ( this.quad.material.map ) {

			this.quad.material.map.dispose();

		}

		const texture = new THREE.CanvasTexture( this.inputCanvas );
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;
		this.quad.material.map = texture;
		this.quad.material.needsUpdate = true;

	}

	updateTexture() {

		if ( this.quad && this.quad.material && this.quad.material.map ) {

			this.quad.material.map.needsUpdate = true;

		}

	}

	setParameters( params = {} ) {

		// Set brightness/contrast
		if ( params.brightness !== undefined ) {

			this.brightnessContrastPass.uniforms[ 'brightness' ].value = params.brightness / 100;

		}

		if ( params.contrast !== undefined ) {

			this.brightnessContrastPass.uniforms[ 'contrast' ].value = params.contrast / 100;

		}

		// Set hue/saturation/exposure
		if ( params.hue !== undefined ) {

			this.colorAdjustmentPass.uniforms[ 'hue' ].value = params.hue;

		}

		if ( params.saturation !== undefined ) {

			this.colorAdjustmentPass.uniforms[ 'saturation' ].value = params.saturation / 100;

		}

		if ( params.exposure !== undefined ) {

			this.colorAdjustmentPass.uniforms[ 'exposure' ].value = params.exposure / 100;

		}

		if ( params.gamma !== undefined ) {

			this.colorAdjustmentPass.uniforms[ 'gamma' ].value = params.gamma;

		}

	}

	render() {

		this.updateTexture();
		this.composer.render();
		return this.outputCanvas;

	}

	dispose() {

		this.renderer.dispose();
		this.composer.passes.forEach( p => p.dispose?.() );
		this.composer = null;

	}

}

/**
 * The same edits as {@link ImageProcessorComposer}, on a saved render's HDR picture after its view
 * (`PictureView.setGrade`): identical up to white, colours brighter than white carried along (hue turns the colour scaled
 * down to white, then back). `set()` takes the Results panel's values; the view's `redraw()` shows them.
 */
export function pictureGrade() {

	const u = {
		brightness: uniform( 0 ), contrast: uniform( 0 ), saturation: uniform( 0 ),
		hue: uniform( 0 ), exposure: uniform( 0 ), gamma: uniform( 2.2 ),
	};

	const turnHue = Fn( ( [ rgb, degrees ] ) => {

		const scale = max( float( 1 ), max( rgb.x, max( rgb.y, rgb.z ) ) ).toVar();
		const c = rgb.div( scale ).toVar();
		const hi = max( c.x, max( c.y, c.z ) ).toVar();
		const lo = min( c.x, min( c.y, c.z ) ).toVar();
		const delta = hi.sub( lo ).toVar();
		const l = hi.add( lo ).mul( 0.5 ).toVar();
		const out = c.toVar();

		If( delta.greaterThan( 0 ), () => {

			const s = select( l.lessThan( 0.5 ), delta.div( hi.add( lo ) ), delta.div( float( 2 ).sub( hi ).sub( lo ) ) ).toVar();
			const h = float( 0 ).toVar();
			If( hi.equal( c.x ), () => {

				h.assign( c.y.sub( c.z ).div( delta ).add( select( c.y.lessThan( c.z ), float( 6 ), float( 0 ) ) ) );

			} ).ElseIf( hi.equal( c.y ), () => {

				h.assign( c.z.sub( c.x ).div( delta ).add( 2 ) );

			} ).Else( () => {

				h.assign( c.x.sub( c.y ).div( delta ).add( 4 ) );

			} );

			h.assign( fract( h.div( 6 ).add( degrees.div( 360 ) ) ) );
			const q = select( l.lessThan( 0.5 ), l.mul( s.add( 1 ) ), l.add( s ).sub( l.mul( s ) ) ).toVar();
			const p = l.mul( 2 ).sub( q ).toVar();
			const channel = at => {

				const t = fract( at );
				return select( t.lessThan( 1 / 6 ), p.add( q.sub( p ).mul( 6 ).mul( t ) ),
					select( t.lessThan( 0.5 ), q, select( t.lessThan( 2 / 3 ), p.add( q.sub( p ).mul( float( 2 / 3 ).sub( t ) ).mul( 6 ) ), p ) ) );

			};

			out.assign( vec3( channel( h.add( 1 / 3 ) ), channel( h ), channel( h.sub( 1 / 3 ) ) ) );

		} );

		return out.mul( scale );

	} );

	const grade = Fn( ( [ encoded ] ) => {

		// Brightness and contrast on the encoded colour, as BrightnessContrastShader. Below 0 is a colour outside the
		// canvas's gamut, kept: at the panel's defaults the picture is as saved.
		const centred = encoded.add( u.brightness ).sub( 0.5 ).toVar();
		const steeper = centred.div( float( 1 ).sub( u.contrast ) );
		const flatter = centred.mul( u.contrast.add( 1 ) );
		const contrasted = select( u.contrast.greaterThan( 0 ), steeper, flatter ).add( 0.5 ).toVar();
		const linear = sign( contrasted ).mul( abs( contrasted ).pow( vec3( 2.2 ) ) ).toVar();
		const saturated = mix( vec3( dot( linear, vec3( 0.2126, 0.7152, 0.0722 ) ) ), linear, u.saturation.add( 1 ) ).toVar();
		If( abs( u.hue ).greaterThan( 0.01 ), () => {

			saturated.assign( turnHue( saturated, u.hue ) );

		} );
		const exposed = saturated.mul( exp2( u.exposure ) );
		return sign( exposed ).mul( abs( exposed ).pow( vec3( float( 1 ).div( u.gamma ) ) ) );

	} );

	const set = ( { brightness = 0, contrast = 0, saturation = 0, hue = 0, exposure = 0, gamma = 2.2 } = {} ) => {

		u.brightness.value = brightness / 100;
		u.contrast.value = contrast / 100;
		u.saturation.value = saturation / 100;
		u.hue.value = hue;
		u.exposure.value = exposure / 100;
		u.gamma.value = gamma;

	};

	return { grade, set };

}
