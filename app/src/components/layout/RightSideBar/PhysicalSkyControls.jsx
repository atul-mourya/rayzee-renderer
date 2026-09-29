import { Clock, Compass, ArrowUp, RefreshCcwDot, Haze, Mountain, CircleDot, Layers, SunMedium, Wind, Globe } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ColorInput } from "@/components/ui/colorinput";
import { Row } from "@/components/ui/row";
import { usePathTracerStore } from '@/store';
import { SKY_PRESETS } from '@/Constants';

const MONTHS = [ 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December' ];

const clock = hours => {

	const minutes = Math.round( hours * 60 );
	return `${Math.floor( minutes / 60 )}:${String( minutes % 60 ).padStart( 2, '0' )}`;

};

const LabelledSelect = ( { label, value, onValueChange, children } ) => (
	<Select value={value} onValueChange={onValueChange}>
		<span className="opacity-50 text-xs truncate">{label}</span>
		<SelectTrigger className="max-w-32 h-5 rounded-full">
			<SelectValue />
		</SelectTrigger>
		<SelectContent>{children}</SelectContent>
	</Select>
);

const PhysicalSkyControls = () => {

	const {
		skyPreset, skySunMode, skyTime, skyMonth, skyLatitude, skyNorthOffset,
		skySunAzimuth, skySunElevation, skySunStrength, skySunSize,
		skyTurbidity, skyOzone, skyAirDensity, skyGroundAlbedo, skyAltitude,
		handleSkyPresetChange, handleSkySunModeChange, handleSkyTimeChange, handleSkyMonthChange,
		handleSkyLatitudeChange, handleSkyNorthOffsetChange, handleSkySunAzimuthChange,
		handleSkySunElevationChange, handleSkySunStrengthChange, handleSkySunSizeChange,
		handleSkyTurbidityChange, handleSkyOzoneChange, handleSkyAirDensityChange,
		handleSkyGroundAlbedoChange, handleSkyAltitudeChange,
	} = usePathTracerStore();

	const byTime = skySunMode === 'time';

	const sunMenu = (
		<>
			<Row>
				<LabelledSelect label="Set sun by" value={skySunMode} onValueChange={handleSkySunModeChange}>
					<SelectItem value="time">Time of day</SelectItem>
					<SelectItem value="angles">Angles</SelectItem>
				</LabelledSelect>
			</Row>
			{byTime && (
				<>
					<Row>
						<LabelledSelect label="Month" value={String( skyMonth )} onValueChange={handleSkyMonthChange}>
							{MONTHS.map( ( name, i ) => <SelectItem key={name} value={String( i + 1 )}>{name}</SelectItem> )}
						</LabelledSelect>
					</Row>
					<Row>
						<Slider label="Latitude" icon={Globe} min={- 70} max={70} step={1} unit="°" value={[ skyLatitude ]} snapPoints={[ 0 ]} onValueChange={handleSkyLatitudeChange} />
					</Row>
				</>
			)}
			<Row>
				<Slider label="Sun Size" icon={CircleDot} min={0.1} max={10} step={0.01} unit="°" value={[ skySunSize ]} snapPoints={[ 0.53 ]} onValueChange={handleSkySunSizeChange} />
			</Row>
			<Row>
				<Slider label="Sun Strength" icon={SunMedium} min={0} max={4} step={0.01} value={[ skySunStrength ]} snapPoints={[ 1 ]} onValueChange={handleSkySunStrengthChange} />
			</Row>
		</>
	);

	const airMenu = (
		<>
			<Row>
				<ColorInput label="Ground" value={skyGroundAlbedo} onChange={handleSkyGroundAlbedoChange} />
			</Row>
			<Row>
				<Slider label="Altitude" icon={Mountain} min={0} max={8000} step={5} unit=" m" value={[ skyAltitude ]} snapPoints={[ 50 ]} onValueChange={handleSkyAltitudeChange} />
			</Row>
			<Row>
				<Slider label="Ozone" icon={Layers} min={0} max={600} step={5} unit=" DU" value={[ skyOzone ]} snapPoints={[ 300 ]} onValueChange={handleSkyOzoneChange} />
			</Row>
			<Row>
				<Slider label="Air Density" icon={Wind} min={0} max={3} step={0.01} value={[ skyAirDensity ]} snapPoints={[ 1 ]} onValueChange={handleSkyAirDensityChange} />
			</Row>
		</>
	);

	return (
		<>
			<Row>
				<LabelledSelect label="Preset" value={skyPreset} onValueChange={handleSkyPresetChange}>
					{Object.entries( SKY_PRESETS ).map( ( [ key, preset ] ) => <SelectItem key={key} value={key}>{preset.name}</SelectItem> )}
				</LabelledSelect>
			</Row>
			{byTime ? (
				<>
					<Row more={sunMenu}>
						<Slider label="Time of Day" icon={Clock} min={0} max={24} step={0.05} formatValue={clock} value={[ skyTime ]} snapPoints={[ 6, 12, 18 ]} onValueChange={handleSkyTimeChange} />
					</Row>
					<Row>
						<Slider label="Sun Direction" icon={Compass} min={0} max={360} step={1} unit="°" value={[ skyNorthOffset ]} snapPoints={[ 0, 90, 180, 270 ]} onValueChange={handleSkyNorthOffsetChange} />
					</Row>
				</>
			) : (
				<>
					<Row more={sunMenu}>
						<Slider label="Sun Height" icon={ArrowUp} min={- 12} max={90} step={0.25} precision={1} unit="°" value={[ skySunElevation ]} snapPoints={[ 0, 45, 90 ]} onValueChange={handleSkySunElevationChange} />
					</Row>
					<Row>
						<Slider label="Sun Rotation" icon={RefreshCcwDot} min={0} max={360} step={1} precision={0} unit="°" value={[ skySunAzimuth ]} snapPoints={[ 0, 90, 180, 270 ]} onValueChange={handleSkySunAzimuthChange} />
					</Row>
				</>
			)}
			<Row more={airMenu}>
				<Slider label="Haze" icon={Haze} min={1} max={10} step={0.1} value={[ skyTurbidity ]} snapPoints={[ 2 ]} onValueChange={handleSkyTurbidityChange} />
			</Row>
		</>
	);

};

export default PhysicalSkyControls;
