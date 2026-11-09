import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_FILES = 10;
const MAX_BYTES = 1024 * 1024;

/** Selected by the trusted submitter, never by a Worker report. */
export function normalizeAttentionSnapshotPaths(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > MAX_FILES) throw new Error(`attentionSnapshotPaths must contain 1 to ${MAX_FILES} relative file paths`);
  const paths = value.map(file => {
    if (typeof file !== 'string' || !file || file.length > 1000 || isAbsolute(file) || /[\\\0]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(file)) {
      throw new Error('attentionSnapshotPaths must use normalized relative file paths');
    }
    if (file.split('/').some(part => part === '.git' || part === '.ssh' || part === '.aws' || /^\.env(?:\.|$)/.test(part))) throw new Error('attentionSnapshotPaths cannot select credentials or repository internals');
    return file;
  });
  if (new Set(paths).size !== paths.length) throw new Error('attentionSnapshotPaths must not repeat files');
  return paths;
}

/** Capture bounded, regular UTF-8 files without following symbolic links. */
export function captureAttentionFiles(workspace, paths) {
  const root = realpathSync(workspace);
  let remaining = MAX_BYTES;
  return normalizeAttentionSnapshotPaths(paths).map(file => {
    let current = root;
    for (const part of file.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Attention snapshot refuses symbolic link: ${file}`);
    }
    const actual = realpathSync(current), within = relative(root, actual);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error(`Attention snapshot escapes workspace: ${file}`);
    const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error(`Attention snapshot requires a regular file: ${file}`);
      if (stat.size > remaining) throw new Error(`Attention snapshot exceeds ${MAX_BYTES} bytes`);
      const buffer = Buffer.alloc(remaining + 1);
      let length = 0, read;
      while (length < buffer.length && (read = readSync(fd, buffer, length, buffer.length - length, null))) length += read;
      if (length > remaining) throw new Error(`Attention snapshot exceeds ${MAX_BYTES} bytes`);
      const bytes = buffer.subarray(0, length), content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`Attention snapshot requires UTF-8 text: ${file}`);
      remaining -= length;
      return { path: file, content, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally { closeSync(fd); }
  });
}
