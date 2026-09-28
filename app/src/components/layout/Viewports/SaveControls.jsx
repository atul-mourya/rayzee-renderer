import React from 'react';
import { Check, X } from 'lucide-react';
import { useLocalStorage } from '@/hooks/useLocalStorage';

const SaveControls = ( { onSave, onDiscard } ) => {

	const [ keepHDR, setKeepHDR ] = useLocalStorage( 'rayzee-keep-hdr', true );

	return (
		<div className="absolute top-2 right-2 flex items-center space-x-2">
			<label
				className="flex items-center gap-1 bg-black/60 text-xs text-gray-200 px-2 py-1 rounded-full cursor-pointer select-none"
				title="Also keep the full-range (EXR) image, so exposure and tone mapping can change later without rendering again"
			>
				<input type="checkbox" className="accent-current" checked={keepHDR} onChange={( e ) => setKeepHDR( e.target.checked )} />
				Keep HDR copy
			</label>
			<button
				onClick={() => onSave( { keepHDR } )}
				className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-primary/90 transition-all cursor-pointer"
			>
				<Check size={14} className="mr-1" /> Save
			</button>
			<button
				onClick={onDiscard}
				className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-secondary/90 transition-all cursor-pointer"
			>
				<X size={14} className="mr-1" /> Ignore
			</button>
		</div>
	);

};

export default React.memo( SaveControls );
