import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSwapFile,
  swapFileCommand,
  parseSizeToBytes,
  createDefaultDispatcher,
  planSwapCommands,
} from '../src/core.js';

/**
 * A recording dispatcher that never touches the system. Each call is appended
 * to .calls so tests can assert on the exact sequence. Every call succeeds by
 * default; tests can override by setting .nextResult.
 */
function recordingDispatcher(nextResult = { code: 0, stderr: '' }) {
  const calls = [];
  const d = {
    calls,
    nextResult,
    fallocate(path, sizeBytes) { calls.push(['fallocate', path, sizeBytes]); return this.nextResult; },
    chmod(path, mode)          { calls.push(['chmod', path, mode]); return this.nextResult; },
    mkswap(path)               { calls.push(['mkswap', path]); return this.nextResult; },
    swapon(path)               { calls.push(['swapon', path]); return this.nextResult; },
  };
  return d;
}

test('parseSizeToBytes handles bare bytes', () => {
  assert.equal(parseSizeToBytes('2048'), 2048);
});

test('parseSizeToBytes handles K/M/G case-insensitively', () => {
  assert.equal(parseSizeToBytes('512K'), 512 * 1024);
  assert.equal(parseSizeToBytes('512k'), 512 * 1024);
  assert.equal(parseSizeToBytes('1M'), 1024 * 1024);
  assert.equal(parseSizeToBytes('1m'), 1024 * 1024);
  assert.equal(parseSizeToBytes('1G'), 1024 * 1024 * 1024);
  assert.equal(parseSizeToBytes('1g'), 1024 * 1024 * 1024);
});

test('parseSizeToBytes trims surrounding whitespace', () => {
  assert.equal(parseSizeToBytes('  1G '), 1024 * 1024 * 1024);
});

test('parseSizeToBytes rejects non-numeric input', () => {
  assert.equal(parseSizeToBytes('abc'), null);
  assert.equal(parseSizeToBytes(''), null);
  assert.equal(parseSizeToBytes('G'), null);
});

test('parseSizeToBytes rejects unsupported suffixes', () => {
  assert.equal(parseSizeToBytes('1T'), null);
  assert.equal(parseSizeToBytes('1B'), null);
});

test('parseSizeToBytes rejects zero and negative sizes', () => {
  assert.equal(parseSizeToBytes('0'), null);
  assert.equal(parseSizeToBytes('-1G'), null);
});

test('createSwapFile runs the four steps in order and returns the plan', () => {
  const d = recordingDispatcher();
  const result = createSwapFile('/swapfile', '1G', d);
  assert.equal(result.path, '/swapfile');
  assert.equal(result.sizeBytes, 1024 * 1024 * 1024);
  assert.deepEqual(d.calls, [
    ['fallocate', '/swapfile', 1024 * 1024 * 1024],
    ['chmod', '/swapfile', '0600'],
    ['mkswap', '/swapfile'],
    ['swapon', '/swapfile'],
  ]);
});

test('createSwapFile accepts a raw byte number', () => {
  const d = recordingDispatcher();
  const result = createSwapFile('/swapfile', 1048576, d);
  assert.equal(result.sizeBytes, 1048576);
});

test('createSwapFile throws on relative path', () => {
  assert.throws(() => createSwapFile('swapfile', '1G', recordingDispatcher()), /absolute/);
});

test('createSwapFile throws on empty path', () => {
  assert.throws(() => createSwapFile('', '1G', recordingDispatcher()), /non-empty/);
});

test('createSwapFile throws on unparseable size', () => {
  assert.throws(() => createSwapFile('/swapfile', 'abc', recordingDispatcher()), /positive integer/);
});

test('createSwapFile throws on zero size', () => {
  assert.throws(() => createSwapFile('/swapfile', '0', recordingDispatcher()), /positive integer/);
});

test('createSwapFile surfaces failure with step and stderr', () => {
  const d = recordingDispatcher({ code: 1, stderr: 'no space left on device' });
  assert.throws(
    () => createSwapFile('/swapfile', '1G', d),
    (err) => err instanceof Error && /fallocate/.test(err.message) && /no space left/.test(err.message) && err.step === 'fallocate' && err.code === 1,
  );
  // Only fallocate should have run.
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0][0], 'fallocate');
});

test('createSwapFile stops at the first failing step', () => {
  // Succeed for fallocate and chmod, fail at mkswap.
  const calls = [];
  const d = {
    fallocate(p, s) { calls.push(['fallocate', p, s]); return { code: 0, stderr: '' }; },
    chmod(p, m)     { calls.push(['chmod', p, m]); return { code: 0, stderr: '' }; },
    mkswap(p)       { calls.push(['mkswap', p]); return { code: 1, stderr: 'bad pages' }; },
    swapon(p)       { calls.push(['swapon', p]); return { code: 0, stderr: '' }; },
  };
  assert.throws(
    () => createSwapFile('/swapfile', '1M', d),
    /mkswap failed.*bad pages/,
  );
  assert.equal(calls.length, 3); // fallocate, chmod, mkswap — swapon never called
  assert.equal(calls[2][0], 'mkswap');
});

test('swapFileCommand returns the four commands without running them', () => {
  const cmds = swapFileCommand('/swapfile', '2G');
  assert.deepEqual(cmds, [
    `fallocate -l ${2 * 1024 * 1024 * 1024} /swapfile`,
    'chmod 0600 /swapfile',
    'mkswap /swapfile',
    'swapon /swapfile',
  ]);
});

test('swapFileCommand validates its arguments the same way createSwapFile does', () => {
  assert.throws(() => swapFileCommand('rel', '1G'), /absolute/);
  assert.throws(() => swapFileCommand('/swapfile', 'bad'), /positive integer/);
});

test('planSwapCommands produces the ordered shell-form strings', () => {
  assert.deepEqual(planSwapCommands(null, '/x', 1024), [
    'fallocate -l 1024 /x',
    'chmod 0600 /x',
    'mkswap /x',
    'swapon /x',
  ]);
});

test('createDefaultDispatcher exposes the four expected methods', () => {
  const d = createDefaultDispatcher();
  assert.equal(typeof d.fallocate, 'function');
  assert.equal(typeof d.chmod, 'function');
  assert.equal(typeof d.mkswap, 'function');
  assert.equal(typeof d.swapon, 'function');
});
