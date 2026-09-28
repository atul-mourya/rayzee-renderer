/** Per-namespace managers opened on this page, shared by every app on it. */
export const sharedByNamespace = new Map();

/** The storage an app on this page opened for `namespace`, or null — for code that holds no app. */
export function sharedStorage( namespace ) {

	return sharedByNamespace.get( namespace )?.storage ?? null;

}
