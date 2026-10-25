/**
 * Generate memoized style objects for viewport components
 * @param {number} canvasWidth - Width of the canvas
 * @param {number} canvasHeight - Height of the canvas
 * @param {number} viewportScale - Current viewport scale
 * @returns {Object} Style objects for wrapper, container, and canvas
 */
export const generateViewportStyles = ( canvasWidth, canvasHeight, viewportScale ) => {

	const wrapperStyle = {
		width: `${canvasWidth}px`,
		height: `${canvasHeight}px`,
		transform: `scale(${viewportScale / 100})`,
		transformOrigin: 'center center',
		transition: "none"
	};

	const containerStyle = {
		position: "relative",
		width: `${canvasWidth}px`,
		height: `${canvasHeight}px`,
		overflow: "hidden",
		borderRadius: "5px",
		background: "repeating-conic-gradient(rgb(128 128 128 / 20%) 0%, rgb(128 128 128 / 20%) 25%, transparent 0%, transparent 50%) 50% center / 20px 20px"
	};

	const canvasStyle = {
		position: 'absolute',
		top: 0,
		left: 0,
		width: `${canvasWidth}px`,
		height: `${canvasHeight}px`
	};

	return { wrapperStyle, containerStyle, canvasStyle };

};
