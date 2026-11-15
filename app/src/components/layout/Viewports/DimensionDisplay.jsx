import React from 'react';

// The render's size in pixels, in the status bar.
const DimensionDisplay = ( { dimension } ) => (
	<span className="text-xs tabular-nums text-muted-foreground">{dimension.width} × {dimension.height}</span>
);

export default React.memo( DimensionDisplay );
