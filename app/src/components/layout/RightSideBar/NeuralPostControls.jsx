import { Row } from "@/components/ui/row";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTip } from "@/components/ui/info-tip";
import { DLSS_NR_MAX_PIXELS } from 'rayzee';
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
		upscalerBackend,
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
		handleUpscalerBackendChange,
		handleNeuralRenderingChange,
		handleNRSettingChange,
	} = useStore();

	const denoised = enableOIDN || denoiserStrategy === 'oidn';

	// The detail pass runs FIRST, on the traced image, so the upscaler's factor does not enter into
	// it. Reachable only if the host raises the render reserve past 2048.
	const nrTooBig = canvasWidth * canvasHeight > DLSS_NR_MAX_PIXELS;

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
				<Switch label={"AI Upscaler"} checked={enableUpscaler} disabled={! denoised}
					onCheckedChange={handleEnableUpscalerChange} />
			</Row>

			{enableUpscaler && ( <>
				{/* Measured 512->1024 on a 1.9M-tri interior: DLSS 136 ms, Real-ESRGAN 436 ms; RMSE
				    against a native 1024 render 3.84 vs 3.28, detail 1.355 vs 1.096 where native is
				    1.089 — so DLSS adds structure rather than reproducing it. */}
				<Row>
					<Select value={upscalerBackend} onValueChange={handleUpscalerBackendChange}>
						<span className="opacity-50 text-xs truncate inline-flex items-center">
							Model
							<InfoTip text="Real-ESRGAN reconstructs what a full-size render looks like, and offers 4x. DLSS is sharper than a native render — it invents detail rather than reproducing it — and about 3x faster, but is fixed at 2x and needs a denoised image." />
						</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select model" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="esrgan">Real-ESRGAN</SelectItem>
							<SelectItem value="dlss">DLSS</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				{upscalerBackend === 'dlss' ? null : ( <>
					<Row>
						<Select value={upscalerScale.toString()} onValueChange={handleUpscalerScaleChange}>
							<span className="opacity-50 text-xs truncate">Scale Factor</span>
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
							<span className="opacity-50 text-xs truncate">Quality</span>
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
			</> )}

			{/* DLSS-NR. Named for what it does to a picture rather than for the model behind it —
			    it changes appearance, not resolution, so it is its own control and not an upscaler. */}
			<Row className="pt-2">
				<Switch
					label={<>AI Retouch<InfoTip text="A retouch pass over the finished render: adds fine surface detail and shapes light locally, the way a photographer would work on a photograph. Runs once when the render completes, before any upscale. Downloads a 141 MB model the first time." /></>}
					checked={neuralRendering} disabled={! denoised}
					onCheckedChange={handleNeuralRenderingChange} />
			</Row>

			{neuralRendering && nrTooBig && (
				<Row>
					<span className="opacity-50 text-[10px] leading-snug">
						Skipped at this size — {canvasWidth} × {canvasHeight} is
						{' '}{( canvasWidth * canvasHeight / 1e6 ).toFixed( 1 )} MP, above the
						{' '}{( DLSS_NR_MAX_PIXELS / 1e6 ).toFixed( 1 )} MP it survives.
					</span>
				</Row>
			)}

			{neuralRendering && ! nrTooBig && ( <>
				{/* Amount is a straight blend, so it behaves predictably. Local Light and Fine Details
				    are handed to the model as inputs rather than applied after it, which is why their
				    effect is not proportional to the number. */}
				<Row>
					<Slider label={<>Amount<InfoTip text="How much of the retouch reaches the image. 0% is off. The only one of these that blends predictably — reach for it first when the effect is too strong." /></>}
						unit="%" min={0} max={100} step={1} precision={0}
						value={[ asPercent( nrIntensity ) ]}
						onFinishChange={onPercent( 'intensity', 'nrIntensity' )} />
				</Row>
				<Row>
					<Slider label={<>Local Light<InfoTip text="Shapes light within small areas, like dodge and burn. 0% is what the model would do on its own; negative asks for less, positive for more." /></>}
						unit="%" min={- 100} max={100} step={1} precision={0}
						value={[ asOffset( nrLocalTone ) ]}
						onFinishChange={onOffset( 'localTone', 'nrLocalTone' )} />
				</Row>
				<Row>
					<Slider label={<>Fine Details<InfoTip text="Brings out fine surface detail, like clarity or texture. 0% is what the model would do on its own. Pushing it up suits flat materials; on a detailed surface it starts to look crunchy." /></>}
						unit="%" min={- 100} max={100} step={1} precision={0}
						value={[ asOffset( nrLocalStructure ) ]}
						onFinishChange={onOffset( 'localStructure', 'nrLocalStructure' )} />
				</Row>
				{/* 0 keeps the render's own chroma; 100 takes the model's, which measured 6 % less
				    saturated on a 1.9M-tri interior while brightness and detail stayed put. */}
				<Row>
					<Slider label={<>AI Color<InfoTip text="Whose colour reaches the image. 0% keeps your render's exactly. 100% takes the model's, which measures about 6% less saturated — brightness and detail are the same either way." /></>}
						unit="%" min={0} max={100} step={1} precision={0}
						value={[ asPercent( nrColorStrength ) ]}
						onFinishChange={onPercent( 'colorStrength', 'nrColorStrength' )} />
				</Row>
			</> )}
		</>
	);

};

export default NeuralPostControls;
