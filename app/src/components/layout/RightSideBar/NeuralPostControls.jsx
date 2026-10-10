import { Row } from "@/components/ui/row";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RETOUCH_MAX_PIXELS } from 'rayzee';
import { usePathTracerStore as useStore } from '@/store';

/**
 * The AI upscaler and the neural-rendering pass.
 *
 * Shared by the Preview and Render panels rather than duplicated: both write the same engine state
 * (`denoisingManager.upscalerBackend` and friends), so a panel that showed only some of it left the
 * other mode running a model with nothing in the UI naming it.
 */
const NeuralPostControls = () => {

	const {
		enableOIDN,
		denoiserStrategy,
		enableUpscaler,
		upscalerScale,
		upscalerQuality,
		retouchVisible,
		neuralRendering,
		nrIntensity,
		nrLocalTone,
		nrLocalStructure,
		nrColorStrength,
		canvasWidth,
		canvasHeight,

		handleEnableUpscalerChange,
		handleUpscalerScaleChange,
		handleUpscalerQualityChange,
		handleNeuralRenderingChange,
		handleNRSettingChange,
	} = useStore();

	const denoised = enableOIDN || denoiserStrategy === 'oidn';

	// The detail pass runs FIRST, on the traced image, so the upscaler's factor does not enter into
	// it. Reachable only if the host raises the render reserve past 2048.
	const nrTooBig = canvasWidth * canvasHeight > RETOUCH_MAX_PIXELS;
	const retouchOn = retouchVisible && neuralRendering;

	// The model's settings are engine units; these sliders are what an artist expects to see.
	//
	// Amount and AI Color are 0..1, so a plain percentage. Local Light and Fine Details are 0..2 with
	// **1 as neutral**, which as 0..200 % would park the default at 100 and read as "already turned
	// up" — so they are shown centred on zero, the way every photo tool spells the same idea.
	const asPercent = v => Math.round( v * 100 );
	const fromPercent = v => v / 100;
	const asOffset = v => Math.round( ( v - 1 ) * 100 );
	const fromOffset = v => v / 100 + 1;

	const onPercent = ( key, storeKey ) => {

		const apply = handleNRSettingChange( key, storeKey );
		return v => apply( fromPercent( v ) );

	};

	const onOffset = ( key, storeKey ) => {

		const apply = handleNRSettingChange( key, storeKey );
		return v => apply( fromOffset( v ) );

	};

	return (
		<>
			{/* Both passes are gated on a denoised frame rather than merely warned about: on raw
			    Monte-Carlo noise the upscaler measured worse than a plain resize, and the detail pass
			    reads noise as detail. One line says why, once, for both. */}
			{! denoised && (
				<Row>
					<span className="opacity-50 text-[10px] leading-snug">
						Turn on Final Denoise (OIDN) to use the AI passes — they need a clean image.
					</span>
				</Row>
			)}

			<Row>
				<Switch label={"AI Upscaler"} tip="Makes the finished render bigger with AI, so you can render small and deliver large." checked={enableUpscaler} disabled={! denoised}
					onCheckedChange={handleEnableUpscalerChange} />
			</Row>

			{/* No Model menu: the neural super-resolution backend cannot load, which leaves Real-ESRGAN. */}
			{enableUpscaler && ( <>
				<Row>
					<Select value={upscalerScale.toString()} onValueChange={handleUpscalerScaleChange}>
						<span className="opacity-50 text-xs truncate" title="How many times bigger the final picture is, on each side.">Scale Factor</span>
						<SelectTrigger className="max-w-24 h-5 rounded-full" >
							<SelectValue placeholder="Select scale" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="2">2x</SelectItem>
							<SelectItem value="4">4x</SelectItem>
						</SelectContent>
					</Select>
				</Row>
				<Row>
					<Select value={upscalerQuality} onValueChange={handleUpscalerQualityChange}>
						<span className="opacity-50 text-xs truncate" title="How hard the AI works on the enlargement. Quality looks best but takes longest.">Quality</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select quality" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="fast">Fast</SelectItem>
							<SelectItem value="balanced">Balanced</SelectItem>
							<SelectItem value="quality">Quality</SelectItem>
						</SelectContent>
					</Select>
				</Row>
			</> )}

			{/* Retouch. Named for what it does to a picture rather than for the model behind it —
			    it changes appearance, not resolution, so it is its own control and not an upscaler.
			    Hidden until `rayzee.showRetouch()`: its model is not distributed. */}
			{retouchVisible && (
				<Row className="pt-2">
					<Switch
						label={"AI Retouch"}
						tip="Sharpens surface detail and adjusts light and shade in the finished render, as a photographer would. Downloads a 141 MB model the first time."
						checked={neuralRendering} disabled={! denoised}
						onCheckedChange={handleNeuralRenderingChange} />
				</Row>
			)}

			{retouchOn && nrTooBig && (
				<Row>
					<span className="opacity-50 text-[10px] leading-snug">
						Skipped at this size — {canvasWidth} × {canvasHeight} is
						{' '}{( canvasWidth * canvasHeight / 1e6 ).toFixed( 1 )} MP, above the
						{' '}{( RETOUCH_MAX_PIXELS / 1e6 ).toFixed( 1 )} MP it survives.
					</span>
				</Row>
			)}

			{retouchOn && ! nrTooBig && ( <>
				{/* Amount is a straight blend, so it behaves predictably. Local Light and Fine Details
				    are handed to the model as inputs rather than applied after it, which is why their
				    effect is not proportional to the number. */}
				<Row>
					<Slider label={"Amount"} tip="How much of the AI touch-up shows. 0% is off. Lower this first when the effect is too strong."
						unit="%" min={0} max={100} step={1} precision={0}
						value={[ asPercent( nrIntensity ) ]}
						onFinishChange={onPercent( 'intensity', 'nrIntensity' )} />
				</Row>
				<Row>
					<Slider label={"Local Light"} tip="How much the AI brightens and darkens small areas. 0% is its own choice; below 0 is less, above 0 more."
						unit="%" min={- 100} max={100} step={1} precision={0}
						value={[ asOffset( nrLocalTone ) ]}
						onFinishChange={onOffset( 'localTone', 'nrLocalTone' )} />
				</Row>
				<Row>
					<Slider label={"Fine Details"} tip="How much the AI sharpens fine surface detail. 0% is its own choice. Too much looks over-sharpened on detailed surfaces."
						unit="%" min={- 100} max={100} step={1} precision={0}
						value={[ asOffset( nrLocalStructure ) ]}
						onFinishChange={onOffset( 'localStructure', 'nrLocalStructure' )} />
				</Row>
				{/* 0 keeps the render's own chroma; 100 takes the model's, which measured 6 % less
				    saturated on a 1.9M-tri interior while brightness and detail stayed put. */}
				<Row>
					<Slider label={"AI Color"} tip="How much the AI may change your colours. 0% keeps yours exactly; 100% uses the AI's, which are a little less vivid."
						unit="%" min={0} max={100} step={1} precision={0}
						value={[ asPercent( nrColorStrength ) ]}
						onFinishChange={onPercent( 'colorStrength', 'nrColorStrength' )} />
				</Row>
			</> )}
		</>
	);

};

export default NeuralPostControls;
