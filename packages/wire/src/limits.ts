// The dumbridge/1 ceilings shared by the wire sessions and the pull
// receiver. Both sides must agree on them, so they are declared once.
export const maximumManifestEntries = 4096;
export const maximumFileBytes = 1024 * 1024 * 1024;
export const maximumTransferBytes = 2 * 1024 * 1024 * 1024;
