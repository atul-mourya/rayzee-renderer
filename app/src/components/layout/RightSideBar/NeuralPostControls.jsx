import { Row } from "@/components/ui/row";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

		handleEnableUpscalerChange,
		handleUpscalerScaleChange,
		handleUpscalerQualityChange,
		handleUpscalerBackendChange,
		handleNeuralRenderingChange,
		handleNRSettingChange,
	} = useStore();

	const denoised = enableOIDN || denoiserStrategy === 'oidn';

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

			{/* Neural rendering changes appearance, not resolution, so it is its own control rather
			    than an upscaler model, and it always runs last. */}
			<Row className="pt-2">
				<Switch label={"Neural Rendering (DLSS-NR)"} checked={neuralRendering} onCheckedChange={handleNeuralRenderingChange} />
			</Row>

			{neuralRendering && ( denoised ? ( <>
				<Row>
					<Slider label={"Intensity"} min={0} max={1} step={0.01} value={[ nrIntensity ]}
						onFinishChange={handleNRSettingChange( 'intensity', 'nrIntensity' )} />
				</Row>
				<Row>
					<Slider label={"Local Tone"} min={0} max={2} step={0.01} value={[ nrLocalTone ]}
						onFinishChange={handleNRSettingChange( 'localTone', 'nrLocalTone' )} />
				</Row>
				<Row>
					<Slider label={"Local Structure"} min={0} max={2} step={0.01} value={[ nrLocalStructure ]}
						onFinishChange={handleNRSettingChange( 'localStructure', 'nrLocalStructure' )} />
				</Row>
				<Row>
					<span className="opacity-50 text-[10px] leading-snug">
						Runs last, after any upscale. Downloads a 141 MB model on first use. Measured
						close to a no-op on path-traced images, and it desaturates slightly.
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
