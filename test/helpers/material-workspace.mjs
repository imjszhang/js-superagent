import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ensureProjectIdentity } from '../../src/project-identity.mjs';
import { materialSnapshotDigest } from '../../src/materials.mjs';
import { prepareMaterialWorkspace } from '../../src/workspaces.mjs';

export function fixture(t) {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'material-workspace-'))), root = join(outer, 'project');
  mkdirSync(root); t.after(() => rmSync(outer, { recursive: true, force: true }));
  const identity = ensureProjectIdentity(root, 'material-workspace-test');
  return { root, projectRoot: root, outer, identity };
}
export function put(root, path, value, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value, { mode });
}
export function snapshot(f, paths, include = ['docs'], exclude = []) {
  const files = Object.fromEntries(paths.map(path => {
    const bytes = readFileSync(join(f.root, path));
    return [path, { content: bytes.toString('base64'), encoding: 'base64', sha256: createHash('sha256').update(bytes).digest('hex'), mode: statSync(join(f.root, path)).mode & 0o777, size: bytes.length }];
  }));
  const result = { version: 1, source: { root: f.root, projectId: f.identity.projectId, instanceId: f.identity.instanceId, entryId: 'project-docs', view: { kind: 'current' } },
    files, include, exclude, observedAt: new Date().toISOString() };
  return { ...result, digest: materialSnapshotDigest(result) };
}
export function prepare(f, materialSnapshot, options = {}) {
  return prepareMaterialWorkspace({ projectRoot: f.root, ticketId: 'material-ticket', materialSnapshot, preparationId: 'preparation-1', persist() {}, ...options });
}
