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

const LabelledSelect = ( { label, tip, value, onValueChange, children } ) => (
	<Select value={value} onValueChange={onValueChange}>
		<span className="opacity-50 text-xs truncate" title={tip}>{label}</span>
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
				<LabelledSelect label="Set sun by" tip="Place the sun by a time of day and date, or by its height and direction in degrees." value={skySunMode} onValueChange={handleSkySunModeChange}>
					<SelectItem value="time">Time of day</SelectItem>
					<SelectItem value="angles">Angles</SelectItem>
				</LabelledSelect>
			</Row>
			{byTime && (
				<>
					<Row>
						<LabelledSelect label="Month" tip="The time of year. The sun rides higher in summer than in winter." value={String( skyMonth )} onValueChange={handleSkyMonthChange}>
							{MONTHS.map( ( name, i ) => <SelectItem key={name} value={String( i + 1 )}>{name}</SelectItem> )}
						</LabelledSelect>
					</Row>
					<Row>
						<Slider label="Latitude" tip="How far north or south of the equator the scene is. It changes how high the sun climbs." icon={Globe} min={- 70} max={70} step={1} unit="°" value={[ skyLatitude ]} snapPoints={[ 0 ]} onValueChange={handleSkyLatitudeChange} />
					</Row>
				</>
			)}
			<Row>
				<Slider label="Sun Size" tip="How large the sun looks. The real sun is 0.53°; larger gives softer shadows." icon={CircleDot} min={0.1} max={10} step={0.01} unit="°" value={[ skySunSize ]} snapPoints={[ 0.53 ]} onValueChange={handleSkySunSizeChange} />
			</Row>
			<Row>
				<Slider label="Sun Strength" tip="How bright the sun is compared with the sky. 1 is the real balance." icon={SunMedium} min={0} max={4} step={0.01} value={[ skySunStrength ]} snapPoints={[ 1 ]} onValueChange={handleSkySunStrengthChange} />
			</Row>
		</>
	);

	const airMenu = (
		<>
			<Row>
				<ColorInput label="Ground" tip="The colour of the ground. It also tints the sky a little." value={skyGroundAlbedo} onChange={handleSkyGroundAlbedoChange} />
			</Row>
			<Row>
				<Slider label="Altitude" tip="How high above sea level the scene is. Higher up, the sky is a deeper blue." icon={Mountain} min={0} max={8000} step={5} unit=" m" value={[ skyAltitude ]} snapPoints={[ 50 ]} onValueChange={handleSkyAltitudeChange} />
			</Row>
			<Row>
				<Slider label="Ozone" tip="The amount of ozone high in the air. It gives twilight its blue. 300 is typical." icon={Layers} min={0} max={600} step={5} unit=" DU" value={[ skyOzone ]} snapPoints={[ 300 ]} onValueChange={handleSkyOzoneChange} />
			</Row>
			<Row>
				<Slider label="Air Density" tip="How much air there is. 1 is Earth's; more gives redder sunsets." icon={Wind} min={0} max={3} step={0.01} value={[ skyAirDensity ]} snapPoints={[ 1 ]} onValueChange={handleSkyAirDensityChange} />
			</Row>
		</>
	);

	return (
		<>
			<Row>
				<LabelledSelect label="Preset" tip="A ready-made sky, from clear noon to blue hour. It sets the sun, the haze and the brightness." value={skyPreset} onValueChange={handleSkyPresetChange}>
					{Object.entries( SKY_PRESETS ).map( ( [ key, preset ] ) => <SelectItem key={key} value={key}>{preset.name}</SelectItem> )}
				</LabelledSelect>
			</Row>
			{byTime ? (
				<>
					<Row more={sunMenu}>
						<Slider label="Time of Day" tip="Where the sun is in its daily path. More settings, such as the date and place, are under ⋮." icon={Clock} min={0} max={24} step={0.05} formatValue={clock} value={[ skyTime ]} snapPoints={[ 6, 12, 18 ]} onValueChange={handleSkyTimeChange} />
					</Row>
					<Row>
						<Slider label="Sun Direction" tip="Turns the compass, so the sun rises and sets on a different side of the scene." icon={Compass} min={0} max={360} step={1} unit="°" value={[ skyNorthOffset ]} snapPoints={[ 0, 90, 180, 270 ]} onValueChange={handleSkyNorthOffsetChange} />
					</Row>
				</>
			) : (
				<>
					<Row more={sunMenu}>
						<Slider label="Sun Height" tip="How high the sun is above the horizon. Below 0 it has set." icon={ArrowUp} min={- 12} max={90} step={0.25} precision={1} unit="°" value={[ skySunElevation ]} snapPoints={[ 0, 45, 90 ]} onValueChange={handleSkySunElevationChange} />
					</Row>
					<Row>
						<Slider label="Sun Rotation" tip="Which side of the scene the sun is on." icon={RefreshCcwDot} min={0} max={360} step={1} precision={0} unit="°" value={[ skySunAzimuth ]} snapPoints={[ 0, 90, 180, 270 ]} onValueChange={handleSkySunAzimuthChange} />
					</Row>
				</>
			)}
			<Row more={airMenu}>
				<Slider label="Haze" tip="How hazy the air is: low is a clear blue sky, high a white, misty one. Air and ground settings are under ⋮." icon={Haze} min={1} max={10} step={0.1} value={[ skyTurbidity ]} snapPoints={[ 2 ]} onValueChange={handleSkyTurbidityChange} />
			</Row>
		</>
	);

};

export default PhysicalSkyControls;
