// Hestroffer & Magnan 1998: I(µ)/I(1) = µ^α, α = −0.023 + 0.292 / λ[µm], at each primary's centroid. The core's sun
// (TSL/Sun.js) and the physical sky's disc average both read it.
export const LIMB_DARKENING_EXPONENT = [ 610, 550, 465 ].map( l => - 0.023 + 0.292 / ( l / 1000 ) );
