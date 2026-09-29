import { describe, it, expect } from 'vitest';
import { sunPosition, timeForSunElevation, dayOfYearForMonth } from '@/core/Processor/SunPosition.js';

const march = dayOfYearForMonth( 3 );

describe( 'sunPosition', () => {

	it( 'rises due east at 6:00 and sets due west at 18:00 on the equinox', () => {

		const rise = sunPosition( { hours: 6, dayOfYear: march, latitude: 40 } );
		const set = sunPosition( { hours: 18, dayOfYear: march, latitude: 40 } );
		expect( rise.elevation ).toBeCloseTo( 0, 0 );
		expect( rise.azimuth ).toBeCloseTo( 90, 0 );
		expect( set.azimuth ).toBeCloseTo( 270, 0 );

	} );

	it( 'culminates at 90° − latitude + declination, south of the northern tropics and north of the southern', () => {

		expect( sunPosition( { hours: 12, dayOfYear: march, latitude: 40 } ).elevation ).toBeCloseTo( 50, 0 );
		const june = sunPosition( { hours: 12, dayOfYear: dayOfYearForMonth( 6 ), latitude: 40 } );
		expect( june.elevation ).toBeCloseTo( 73.4, 0 );
		expect( june.azimuth ).toBeCloseTo( 180, 3 );
		const sydney = sunPosition( { hours: 12, dayOfYear: dayOfYearForMonth( 6 ), latitude: - 34 } );
		expect( sydney.elevation ).toBeCloseTo( 32.6, 0 );
		expect( sydney.azimuth % 360 ).toBeCloseTo( 0, 3 );

	} );

} );

describe( 'timeForSunElevation', () => {

	it( 'finds the time the sun reaches an elevation, either side of noon', () => {

		for ( const afternoon of [ false, true ] ) {

			const hours = timeForSunElevation( { elevation: 6, dayOfYear: march, latitude: 40, afternoon } );
			expect( hours < 12 ).toBe( ! afternoon );
			expect( sunPosition( { hours, dayOfYear: march, latitude: 40 } ).elevation ).toBeCloseTo( 6, 3 );

		}

	} );

	it( 'settles on noon or midnight when the sun never gets there', () => {

		expect( timeForSunElevation( { elevation: 80, dayOfYear: march, latitude: 40 } ) ).toBe( 12 );
		expect( timeForSunElevation( { elevation: - 80, dayOfYear: march, latitude: 40, afternoon: true } ) ).toBe( 24 );

	} );

} );
