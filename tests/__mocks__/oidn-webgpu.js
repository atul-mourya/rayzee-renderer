// Mock for oidn-webgpu — its ESM exports use extensionless imports (./tza)
// which break in Node.js strict ESM resolution.
export default {};
export const OIDNDevice = class {};
export const OIDNFilter = class {};
