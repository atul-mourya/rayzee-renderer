import { Row } from "@/components/ui/row";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
			<Row>
				<Switch label={"AI Upscaler"} checked={enableUpscaler} onCheckedChange={handleEnableUpscalerChange} />
			</Row>

			{enableUpscaler && ( <>
				<Row>
					<Select value={upscalerBackend} onValueChange={handleUpscalerBackendChange}>
						<span className="opacity-50 text-xs truncate">Model</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select model" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="esrgan">Real-ESRGAN</SelectItem>
							<SelectItem value="dlss">DLSS</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				{/* DLSS is a fixed 2x and takes no quality tiers, so its own controls are just the
				    requirement it cannot work without, plus how it differs from the other model.
				    Measured 512->1024 on a 1.9M-tri interior: DLSS 136 ms, Real-ESRGAN 436 ms;
				    RMSE against a native 1024 render 3.84 vs 3.28, detail 1.355 vs 1.096 where
				    native is 1.089 — so DLSS adds structure rather than reproducing it. */}
				{upscalerBackend === 'dlss' ? (
					<Row>
						<span className="opacity-50 text-[10px] leading-snug">
							{denoised
								? 'Fixed 2x, no quality tiers. Runs once on the denoised image when the render finishes. About 3x faster than Real-ESRGAN, and sharper than a native render — it adds detail rather than reproducing it.'
								: 'Needs a denoiser — turn on Final Denoise (OIDN). On a noisy image it is worse than a plain resize.'}
						</span>
					</Row>
				) : ( <>
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
					<Row>
						<span className="opacity-50 text-[10px] leading-snug">
							Closer to a native render than DLSS, and offers 4x — but about 3x slower.
						</span>
					</Row>
				</> )}
			</> )}

			{/* DLSS-NR. Named for what it does to a picture rather than for the model behind it —
			    it changes appearance, not resolution, so it is its own control and not an upscaler. */}
			<Row className="pt-2">
				<Switch label={"AI Retouch"} checked={neuralRendering} onCheckedChange={handleNeuralRenderingChange} />
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

			{neuralRendering && ! nrTooBig && ( denoised ? ( <>
				{/* A straight blend between the render and the model's version, so this is the one that
				    behaves predictably — the two below are handed to the model as inputs, not applied
				    after it, so their effect is not proportional to the number. */}
				<Row>
					<Slider label={"Amount"} unit="%" min={0} max={100} step={1} precision={0}
						value={[ asPercent( nrIntensity ) ]}
						onFinishChange={onPercent( 'intensity', 'nrIntensity' )} />
				</Row>
				<Row>
					<Slider label={"Local Light"} unit="%" min={- 100} max={100} step={1} precision={0}
						value={[ asOffset( nrLocalTone ) ]}
						onFinishChange={onOffset( 'localTone', 'nrLocalTone' )} />
				</Row>
				<Row>
					<Slider label={"Fine Details"} unit="%" min={- 100} max={100} step={1} precision={0}
						value={[ asOffset( nrLocalStructure ) ]}
						onFinishChange={onOffset( 'localStructure', 'nrLocalStructure' )} />
				</Row>
				{/* 0 keeps the render's own chroma; 100 takes the model's, which measured 6 % less
				    saturated on a 1.9M-tri interior while brightness and detail stayed put. */}
				<Row>
					<Slider label={"AI Color"} unit="%" min={0} max={100} step={1} precision={0}
						value={[ asPercent( nrColorStrength ) ]}
						onFinishChange={onPercent( 'colorStrength', 'nrColorStrength' )} />
				</Row>
				<Row>
					<span className="opacity-50 text-[10px] leading-snug">
						Adds fine detail and shapes local light, like a retoucher. Runs once when the render
						finishes. Downloads a 141 MB model the first time. AI Color decides whether the
						colour comes from your render or the model.
					</span>
				</Row>
			</> ) : (
				<Row>
					<span className="opacity-50 text-[10px] leading-snug">
						Needs a denoiser — turn on Final Denoise (OIDN).
					</span>
				</Row>
			) )}
		</>
	);

};

export default NeuralPostControls;
