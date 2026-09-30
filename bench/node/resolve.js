// The corpus imports engine helpers through the `@/core` alias Vite resolves; plain Node needs it spelled out.
const CORE = new URL( '../../rayzee/src/', import.meta.url );

export async function resolve( specifier, context, next ) {

	if ( specifier.startsWith( '@/core/' ) ) return next( new URL( specifier.slice( '@/core/'.length ), CORE ).href, context );
	return next( specifier, context );

}
