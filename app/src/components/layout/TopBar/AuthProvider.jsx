
import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createLogger } from 'rayzee';

const log = createLogger( 'auth' );

const supabase = createClient(
	import.meta.env.VITE_SUPABASE_URL,
	import.meta.env.VITE_SUPABASE_ANON_KEY
);

const AuthProvider = ( { children } ) => {

	const [ isAuthModalOpen, setIsAuthModalOpen ] = useState( false );
	const [ user, setUser ] = useState( null );

	useEffect( () => {

		const { data: authListener } = supabase.auth.onAuthStateChange( ( event, session ) => {

			setUser( session?.user ?? null );
			// Never log the session itself — it carries access/refresh tokens.
			log.debug( `auth ${event} · ${session?.user ? 'signed in' : 'no session'}` );

		} );

		return () => {

			authListener?.subscription.unsubscribe();

		};

	}, [] );

	const handleLoginClick = () => {

		setIsAuthModalOpen( true );

	};

	const handleSignOut = async () => {

		await supabase.auth.signOut();
		setUser( null );

	};

	return (
		<>
			{children( { user, handleLoginClick, handleSignOut } )}
			<Dialog open={isAuthModalOpen} onOpenChange={setIsAuthModalOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Login</DialogTitle>
					</DialogHeader>
					<Auth
						supabaseClient={supabase}
						appearance={{ theme: ThemeSupa }}
						providers={[ 'google' ]}
						redirectTo={`${window.location.href}`}
					/>
				</DialogContent>
			</Dialog>
		</>
	);

};

export default AuthProvider;
