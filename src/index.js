/**
 * swap-file-creator — create and activate a Linux swap file.
 *
 * Re-exports the public surface from ./core.js so consumers can import
 * everything from a single entry point.
 */
export { createSwapFile, swapFileCommand } from './core.js';
