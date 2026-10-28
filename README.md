# swap-file-creator

Creates and activates a Linux swap file at a specified size, handling `fallocate`, `chmod 0600`, `mkswap`, and `swapon` in the correct order.

```js
import { createSwapFile, swapFileCommand } from 'swap-file-creator';

// Dry-run: see the commands without running them.
const plan = swapFileCommand('/swapfile', '1G');
// => ['fallocate -l 1073741824 /swapfile',
//     'chmod 0600 /swapfile',
//     'mkswap /swapfile',
//     'swapon /swapfile']

// Real run — executes via execFileSync against the host.
// Must be run as a user with permission to fallocate, chmod, mkswap, and swapon
// (typically root). On a system where /swapfile is writable, this returns:
// const result = createSwapFile('/swapfile', '1G');
// => { path: '/swapfile', sizeBytes: 1073741824, commands: [...] }
```

## Why this exists

Creating a swap file is a four-step dance (`fallocate`, `chmod`, `mkswap`, `swapon`) where each step must succeed before the next runs, and the failure messages from the underlying tools are terse. This library wraps that sequence so a caller doesn't have to remember the order or translate non-zero exits into something useful.

The trade-off: there is no rollback. If `mkswap` fails after `fallocate` succeeds, the file is left on disk and `swapon` is never called. Rolling back would mean deciding whether to `swapoff` (if the kernel got involved) and whether to delete the file the caller may have wanted to inspect — both are better left to the caller, who knows the context. The thrown `Error` carries `.step`, `.code`, and `.stderr` so the caller can clean up deliberately.

## The awkward edge

`fallocate` creates a sparse file on some filesystems (e.g. ext4 without `-b`), and `mkswap` will refuse a file that reports fewer real blocks than its nominal size. If you see `mkswap` fail with "swapfile has holes", the fix is at the filesystem layer (`dd if=/dev/zero` instead of `fallocate`), not in this library — we deliberately use `fallocate` because it is fast and correct on the common case.

## Exported names

- `createSwapFile(path, size, dispatcher?)` — runs the four steps and returns `{ path, sizeBytes, commands }`. Throws on bad input or any non-zero step.
- `swapFileCommand(path, size)` — returns the command list without executing.
- `parseSizeToBytes(size)` — parses `"1G"`, `"512M"`, `"4096K"`, or a bare byte count. Returns `null` for anything else.
- `createDefaultDispatcher()` — returns the real `execFileSync`-based dispatcher. Override in tests.
- `planSwapCommands(dispatcher, path, sizeBytes)` — returns the shell-form command strings.
