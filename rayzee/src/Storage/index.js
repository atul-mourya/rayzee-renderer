export {
	StorageManager, StorageArea, StorageEntry, EntryWriter, STORAGE_KIND, ENGINE_AREAS, openInlineStorage,
} from './StorageManager.js';
export { openStorage, acquireSharedStorage } from './openStorage.js';
export { sharedStorage } from './shared.js';
export { fileIdentity, identityKey, sameIdentity, sampleHash, sha256Hex } from './identity.js';
export { DownloadCache, DOWNLOAD_POLICY, fetchFile, nameFromUrl, cachedObjectURL, sharedDownloads } from './DownloadCache.js';
export { acquireLock, heldLockNames } from './locks.js';
export { SpillStore } from './SpillStore.js';
