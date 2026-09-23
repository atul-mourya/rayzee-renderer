import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Row } from '@/components/ui/row';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from '@/components/ui/select';
import { InfoTip } from '@/components/ui/info-tip';
import { getApp } from '@/lib/appProxy';
import { useColorStatus } from '@/lib/colorManagement';
import { textureSpaceGroups, spaceLabel } from '@/lib/colorLabels';

const AUTO = '__auto__';

/** Map slots that are colour. Everything else is packed as data and never colour-managed. */
export const COLOR_MAP_SLOTS = new Set( [ 'map', 'emissiveMap' ] );

const VIA = { tag: 'tagged', override: 'override', rule: 'file rule', three: 'from file' };

/**
 * The colour space one colour map is in — the per-image setting every OCIO application has.
 *
 * Automatic first, and saying what it decided, because that is right for nearly every texture and
 * an artist should only have to act on the exceptions: a log-encoded plate, an ACEScg-rendered
 * texture, a linear map mislabelled as sRGB.
 */
const TextureColorSpaceSelect = ( { texture } ) => {

	const status = useColorStatus();
	const [ busy, setBusy ] = useState( false );
	const [ error, setError ] = useState( null );
	const [ , bump ] = useState( 0 );

	const cm = getApp()?.color;
	const { choice, auto } = cm?.describeTextureSpace( texture ) ?? { choice: null, auto: null };
	const config = status?.config ?? null;
	const groups = textureSpaceGroups( config );

	const onChange = useCallback( async value => {

		setBusy( true );
		setError( null );
		try {

			await getApp()?.setTextureColorSpace( texture, value === AUTO ? null : value );
			getApp()?.reset();

		} catch ( err ) {

			setError( err.message );

		} finally {

			setBusy( false );
			bump( n => n + 1 );

		}

	}, [ texture ] );

	// Short in the menu, the full name and how it was decided on hover.
	const autoLabel = auto ? `Auto · ${spaceLabel( auto.colorSpace )}` : 'Auto';
	const autoTitle = auto ? `${auto.colorSpace}${auto.via && auto.via !== 'three' ? `, from the ${VIA[ auto.via ] ?? auto.via}` : ', as the file declares'}` : '';

	return (
		<>
			<Row>
				<span className="opacity-50 text-xs truncate flex items-center gap-1">
					Color Space
					<InfoTip text="What the numbers in this image mean. Auto is right for almost every texture; change it only for the exceptions, like a log-encoded plate or a texture rendered in ACEScg." />
				</span>
				<div className="flex items-center gap-1">
					{busy && <Loader2 size={12} className="animate-spin opacity-60" />}
					<Select value={choice ?? AUTO} onValueChange={onChange} disabled={busy}>
						<SelectTrigger className="max-w-36 h-5 rounded-full" title={choice ?? autoTitle}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={AUTO} title={autoTitle}>{autoLabel}</SelectItem>
							{/* With a config its own texture spaces replace these two, which it names anyway. */}
							{( ! config || choice === 'srgb' ) && <SelectItem value="srgb">sRGB</SelectItem>}
							{( ! config || choice === 'linear' ) && <SelectItem value="linear">Linear</SelectItem>}
							{groups.map( g => (
								<SelectGroup key={g.family}>
									<SelectLabel className="text-[10px] opacity-50">{g.family}</SelectLabel>
									{g.items.map( o => <SelectItem key={o.value} value={o.value} title={o.description}>{o.label}</SelectItem> )}
								</SelectGroup>
							) )}
						</SelectContent>
					</Select>
				</div>
			</Row>
			{error && <div className="px-1 text-[10px] leading-4 text-red-400">{error}</div>}
		</>
	);

};

export default TextureColorSpaceSelect;
