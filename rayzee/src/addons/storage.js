/**
 * On-disk storage — `rayzee/addons/storage`: the origin private file system behind the download, environment and
 * scene caches and the memory spill. The renderer core runs without it (downloads land in memory, nothing is cached);
 * PathTracerApp installs it itself. On the core, install it before init():
 *
 * @example
 * import { RayzeeRenderer } from 'rayzee/core';
 * import { acquireSharedStorage } from 'rayzee/addons/storage';
 *
 * const renderer = new RayzeeRenderer( canvas );
 * renderer.setStorageOpener( acquireSharedStorage );
 * await renderer.init();
 */

export { openStorage, acquireSharedStorage } from '../Storage/openStorage.js';
export {
	StorageManager, StorageArea, StorageEntry, EntryWriter, STORAGE_KIND, ENGINE_AREAS, openInlineStorage,
} from '../Storage/StorageManager.js';
export { acquireLock, heldLockNames } from '../Storage/locks.js';
