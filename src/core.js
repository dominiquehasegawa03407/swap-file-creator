/**
 * swap-file-creator — create and activate a Linux swap file.
 *
 * This module is structured around a CommandDispatcher so the three shell
 * calls (fallocate, chmod, mkswap, swapon) can be captured in tests without
 * ever touching the host system. The dispatcher is a plain object with methods
 * that return { code, stderr } — the same shape child_process would return if
 * we were calling it directly, which keeps the real default thin.
 */

/**
 * @typedef {{ code: number, stderr: string }} CommandResult
 * Zero code on success, non-zero on failure. stderr is captured verbatim so
 * callers can surface it; stdout is discarded because none of the three tools
 * print useful information there.
 */

/**
 * @typedef {Object} CommandDispatcher
 * @property {(path: string, sizeBytes: number) => CommandResult} fallocate
 * @property {(path: string, modeOctet: string) => CommandResult} chmod
 * @property {(path: string) => CommandResult} mkswap
 * @property {(path: string) => CommandResult} swapon
 */

/**
 * @typedef {Object} SwapResult
 * @property {string} path      Absolute path to the swap file created.
 * @property {number} sizeBytes Size in bytes requested and allocated.
 * @property {string[]} commands  The ordered commands that were executed, in
 *   shell form, for logging or audit. Each entry is the exact argv joined by
 *   single spaces.
 */

import { execFileSync } from 'node:child_process';

/**
 * Parse a human size string like "1G", "512M", "4096K", or "2048" into bytes.
 *
 * Suffixes are case-insensitive and matched by first character only. A bare
 * integer is treated as bytes. We do NOT support fractional values (e.g.
 * "1.5G") — mkswap and fallocate both operate on whole bytes, and allowing
 * fractions would just push the rounding problem into this function without
 * making it clearer. Return null for anything we refuse to parse.
 *
 * @param {string} size
 * @returns {number|null}
 */
export function parseSizeToBytes(size) {
  if (typeof size !== 'string') return null;
  const trimmed = size.trim();
  if (trimmed === '') return null;

  const match = /^([0-9]+)\s*([kKmMgG]?)$/.exec(trimmed);
  if (!match) return null;

  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;

  const unit = match[2].toLowerCase();
  const multipliers = { '': 1, 'k': 1024, 'm': 1024 * 1024, 'g': 1024 * 1024 * 1024 };
  const bytes = num * multipliers[unit];
  // Guard against non-integer results from unit multiplication.
  if (!Number.isInteger(bytes)) return null;
  return bytes;
}

/**
 * Default dispatcher that runs the real commands via execFileSync.
 *
 * We use execFileSync (not exec) so the commands cannot be hijacked by shell
 * metacharacters in the path argument — the path is passed as a separate argv
 * element, never interpolated into a shell string. chmod is included even
 * though swapon would set its own permissions, because a file readable by
 * non-root before swapon is a minor information leak; setting 0600 up front is
 * defence in depth and costs nothing.
 *
 * Errors are normalised to { code, stderr } so the upper layer never has to
 * distinguish between a thrown Error and a non-zero exit.
 */
export function createDefaultDispatcher() {
  /** @type {CommandDispatcher} */
  return {
    fallocate(path, sizeBytes) {
      try {
        execFileSync('fallocate', ['-l', String(sizeBytes), path], { stdio: ['ignore', 'ignore', 'pipe'] });
        return { code: 0, stderr: '' };
      } catch (err) {
        return { code: err.status ?? 1, stderr: String(err.stderr ?? err.message) };
      }
    },
    chmod(path, modeOctet) {
      try {
        execFileSync('chmod', [modeOctet, path], { stdio: ['ignore', 'ignore', 'pipe'] });
        return { code: 0, stderr: '' };
      } catch (err) {
        return { code: err.status ?? 1, stderr: String(err.stderr ?? err.message) };
      }
    },
    mkswap(path) {
      try {
        execFileSync('mkswap', [path], { stdio: ['ignore', 'ignore', 'pipe'] });
        return { code: 0, stderr: '' };
      } catch (err) {
        return { code: err.status ?? 1, stderr: String(err.stderr ?? err.message) };
      }
    },
    swapon(path) {
      try {
        execFileSync('swapon', [path], { stdio: ['ignore', 'ignore', 'pipe'] });
        return { code: 0, stderr: '' };
      } catch (err) {
        return { code: err.status ?? 1, stderr: String(err.stderr ?? err.message) };
      }
    },
  };
}

/**
 * Given a dispatcher, produce the ordered list of shell-form command strings
 * that createSwapFile will run. Factored out so tests can assert on the plan
 * without re-running the createSwapFile orchestration.
 *
 * @param {CommandDispatcher} _dispatcher  Unused here but kept in the signature
 *   for symmetry with createSwapFile; callers that want to inspect the plan do
 *   not need a real dispatcher to get it.
 * @param {string} path
 * @param {number} sizeBytes
 * @returns {string[]}
 */
export function planSwapCommands(_dispatcher, path, sizeBytes) {
  return [
    `fallocate -l ${sizeBytes} ${path}`,
    `chmod 0600 ${path}`,
    `mkswap ${path}`,
    `swapon ${path}`,
  ];
}

/**
 * Create and activate a swap file.
 *
 * Throws if the path is empty/relative (swap files must be addressed by an
 * absolute path — mkswap and swapon both require it, and catching it here is
 * friendlier than letting mkswap fail with a cryptic message).
 *
 * Throws if the size string cannot be parsed or is zero/negative.
 *
 * Throws an Error whose .message contains the failing command and stderr if any
 * of the four steps returns a non-zero code. The earlier successful steps are
 * not rolled back — rolling back a half-created swap file is fiddly (swapon may
 * have already engaged the kernel) and the caller is in a better position to
 * decide what to do. This is the documented edge.
 *
 * @param {string} path Absolute path for the swap file.
 * @param {string|number} size Human size string ("1G") or raw bytes.
 * @param {CommandDispatcher} [dispatcher] Optional dispatcher; defaults to the
 *   real execFileSync-based one. Tests pass a recorder.
 * @returns {SwapResult}
 */
export function createSwapFile(path, size, dispatcher = createDefaultDispatcher()) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  if (!path.startsWith('/')) {
    throw new Error('path must be absolute');
  }

  const sizeBytes = typeof size === 'number' ? size : parseSizeToBytes(String(size));
  if (sizeBytes === null || sizeBytes === undefined || sizeBytes <= 0 || !Number.isInteger(sizeBytes)) {
    throw new Error(`size must be a positive integer number of bytes, got: ${String(size)}`);
  }

  const steps = [
    ['fallocate', () => dispatcher.fallocate(path, sizeBytes)],
    ['chmod',     () => dispatcher.chmod(path, '0600')],
    ['mkswap',    () => dispatcher.mkswap(path)],
    ['swapon',    () => dispatcher.swapon(path)],
  ];

  for (const [name, run] of steps) {
    const result = run();
    if (result.code !== 0) {
      const err = new Error(`${name} failed with code ${result.code}: ${result.stderr.trim()}`);
      err.step = name;
      err.code = result.code;
      err.stderr = result.stderr;
      throw err;
    }
  }

  return {
    path,
    sizeBytes,
    commands: planSwapCommands(dispatcher, path, sizeBytes),
  };
}

/**
 * Returns the command list that createSwapFile would run, without executing
 * anything. Useful for dry-run output or for audit logs.
 *
 * @param {string} path
 * @param {string|number} size
 * @returns {string[]}
 */
export function swapFileCommand(path, size) {
  const sizeBytes = typeof size === 'number' ? size : parseSizeToBytes(String(size));
  if (sizeBytes === null || sizeBytes === undefined || sizeBytes <= 0 || !Number.isInteger(sizeBytes)) {
    throw new Error(`size must be a positive integer number of bytes, got: ${String(size)}`);
  }
  if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/')) {
    throw new Error('path must be a non-empty absolute path');
  }
  return planSwapCommands(null, path, sizeBytes);
}
