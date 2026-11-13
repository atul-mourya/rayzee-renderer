import React from 'react';
import { Check, X } from 'lucide-react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

const SaveControls = ( { onSave, onDiscard } ) => {

	const [ keepHDR, setKeepHDR ] = useLocalStorage( 'rayzee-keep-hdr', true );

	return (
		<div className="absolute top-2 right-2 flex items-center space-x-2">
			<Chip asChild rounded className="cursor-pointer select-none">
				<label title="Also keep the full-range (EXR) image, so exposure and tone mapping can change later without rendering again">
					<Checkbox checked={keepHDR} onCheckedChange={v => setKeepHDR( v === true )} />
					Keep HDR copy
				</label>
			</Chip>
			<Button size="xs" rounded onClick={() => onSave( { keepHDR } )}>
				<Check size={14} className="mr-1" /> Save
			</Button>
			<Button size="xs" rounded onClick={onDiscard}>
				<X size={14} className="mr-1" /> Ignore
			</Button>
		</div>
	);

};

export default React.memo( SaveControls );
