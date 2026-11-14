import { useState } from 'react';
import { Slider } from "@/components/ui/slider";
import { ColorInput } from "@/components/ui/colorinput";
import { Row } from "@/components/ui/row";
import { Separator } from '@/components/ui/separator';
import { getApp } from '@/lib/appProxy';

const scalar = val => Number( Array.isArray( val ) ? val[ 0 ] : val );

// Out here: React holds a component's props unchangeable.
function setVolume( volume, key, value ) {

	if ( volume[ key ]?.isColor ) volume[ key ].set( value );
	else volume[ key ] = scalar( value );
	getApp()?.updateVolumes();

}

/** The selected smoke, cloud or fire: how thick it is, its colour, and its glow. */
const VolumeControls = ( { volume } ) => {

	const read = () => ( {
		density: volume.density,
		color: `#${volume.color.getHexString()}`,
		anisotropy: volume.anisotropy,
		glow: volume.emissionStrength,
		glowColor: `#${volume.emissionColor.getHexString()}`,
		temperature: volume.temperature,
	} );
	const [ state, setState ] = useState( read );

	const change = ( key ) => ( val ) => {

		setVolume( volume, key, val );
		setState( read() );

	};

	return (
		<div className="flex flex-col space-y-3 mx-2 py-2">
			<Row>
				<Slider label="Density" tip="How thick it is: how much light it stops along each metre. Clouds and smoke look thicker the higher this is." min={0} max={Math.max( 50, Math.ceil( state.density * 2 ) )} step={0.1} value={[ state.density ]} onValueChange={change( 'density' )} />
			</Row>
			<Row>
				<ColorInput label="Color" tip="The colour of the light it scatters. White for clouds, grey or darker for smoke." value={state.color} onChange={change( 'color' )} />
			</Row>
			<Row>
				<Slider label="Glow Toward Light" tip="How much brighter it looks when you face the light, as clouds do around the sun. 0 looks the same from every side." min={0} max={0.9} step={0.01} value={[ state.anisotropy ]} onValueChange={change( 'anisotropy' )} />
			</Row>
			{volume.emissionGrid && (
				<>
					<Separator />
					<Row>
						<Slider label="Fire Brightness" tip="How brightly the flames glow. 0 turns them off." min={0} max={10} step={0.05} value={[ state.glow ]} onValueChange={change( 'emissionStrength' )} />
					</Row>
					{volume.blackbody ? (
						<Row>
							<Slider label="Temperature" tip="How hot the flames are. Cooler flames glow dim red, hotter ones bright yellow and white." min={300} max={4000} step={10} unit=" K" value={[ state.temperature ]} onValueChange={change( 'temperature' )} />
						</Row>
					) : (
						<Row>
							<ColorInput label="Fire Color" tip="The colour the flames glow." value={state.glowColor} onChange={change( 'emissionColor' )} />
						</Row>
					)}
				</>
			)}
		</div>
	);

};

export default VolumeControls;
