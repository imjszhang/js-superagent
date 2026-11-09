import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, writeFileSync, readFileSync, symlinkSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMachineCoordinator, listenAddressesOverlap, sameBoot, inspectProcessOwner, currentProcessIdentity } from '../src/machine-coordination.mjs';
import { ensureProjectIdentity, inspectProjectIdentity, assertProjectIdentity, assertLegacyProjectRoot, writeRelocatedProjectIdentity } from '../src/project-identity.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-machine-')));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  const directory = join(base, 'machine'); const states = new Map([[100, 'alive'], [200, 'alive'], [300, 'alive']]); let at = 1;
  const deps = pid => ({ directory, now: () => at++, processIdentity: { host: 'test', pid, birth: `${pid}-birth`, bootId: 'boot' }, ownerState: owner => states.get(owner?.pid) ?? 'unknown' });
  const project = (name, projectId = name, pid = 100) => { const root = join(base, name); mkdirSync(root, { recursive: true }); return { root, projectId, coordinator: createMachineCoordinator({ projectRoot: root, projectId }, deps(pid)) }; };
  return { base, directory, states, deps, project };
}
test('inspection does not create files; same basename independent roots and symlink aliases retain identity', t => {
  const f = fixture(t), a = f.project('a/project'), b = f.project('b/project');
  assert.equal(a.coordinator.status().initialized, false); assert.equal(inspectProjectIdentity(a.root, a.projectId).initialized, false); assert.equal(existsSync(f.directory), false); assert.equal(existsSync(stateDir(a.root)), false);
  assert.deepEqual(a.coordinator.overlapStatus(), { projectRoot: a.root, overlaps: [] }); assert.equal(existsSync(f.directory), false);
  const ia = a.coordinator.register(), ib = b.coordinator.register(); assert.notEqual(ia.instanceId, ib.instanceId);
  const alias = join(f.base, 'alias'); symlinkSync(a.root, alias);
  assert.equal(ensureProjectIdentity(alias, a.projectId).instanceId, ia.instanceId);
  assert.equal(a.coordinator.listProjects().length, 2);
});

test('overlapping roots permit registration and local writes but serialize runtime and maintenance execution in both directions', t => {
  const f = fixture(t), parent = f.project('tree'), child = f.project('tree/package', 'child', 200), sibling = f.project('treehouse', 'sibling', 300);
  parent.coordinator.register(); child.coordinator.register(); sibling.coordinator.register();
  assert.equal(child.coordinator.overlapStatus().overlaps[0].active, false);
  const parentLease = parent.coordinator.acquireLease();
  assert.throws(() => child.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  assert.throws(() => child.coordinator.acquireMaintenance(), { code: 'PROJECT_ROOT_OVERLAP' });
  assert.doesNotThrow(() => child.coordinator.assertWritable());
  const siblingLease = sibling.coordinator.acquireLease(); sibling.coordinator.releaseLease(siblingLease);
  const status = child.coordinator.overlapStatus(); assert.equal(status.overlaps.length, 1); assert.equal(status.overlaps[0].active, true); assert.equal(status.overlaps[0].leases[0].ownerState, 'alive');
  parent.coordinator.releaseLease(parentLease);
  const maintenance = child.coordinator.acquireMaintenance();
  assert.throws(() => parent.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  assert.throws(() => parent.coordinator.acquireMaintenance(), { code: 'PROJECT_ROOT_OVERLAP' });
  child.coordinator.releaseLease(maintenance);
  const childLease = child.coordinator.acquireLease(); assert.throws(() => parent.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' }); child.coordinator.releaseLease(childLease);
  const next = parent.coordinator.acquireLease(); parent.coordinator.releaseLease(next);
});

test('overlap inspection canonicalizes symlinks and works without initializing the inspected project', t => {
  const f = fixture(t), parent = f.project('tree'), child = f.project('tree/package', 'child', 200); parent.coordinator.register();
  const alias = join(f.base, 'alias'); symlinkSync(child.root, alias);
  const inspected = createMachineCoordinator({ projectRoot: alias, projectId: 'child' }, f.deps(200));
  assert.equal(inspected.overlapStatus().projectRoot, child.root); assert.equal(inspected.overlapStatus().overlaps[0].projectRoot, parent.root);
  assert.equal(existsSync(stateDir(child.root)), false);
  const lease = parent.coordinator.acquireLease(); assert.equal(inspected.overlapStatus().overlaps[0].active, true); parent.coordinator.releaseLease(lease);
});

test('overlapping roots retain live or unknown guardians and orphan slots until verified exit', t => {
  const f = fixture(t), parent = f.project('tree'), child = f.project('tree/package', 'child', 200); parent.coordinator.register(); child.coordinator.register();
  parent.coordinator.acquireLease('runtime', { guardians: [{ pid: 300 }] }); f.states.set(100, 'dead');
  assert.throws(() => child.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  f.states.set(300, 'unknown'); assert.throws(() => child.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  f.states.set(300, 'dead'); const next = child.coordinator.acquireLease(); child.coordinator.releaseLease(next);
  f.states.set(100, 'alive'); f.states.set(300, 'alive');
  parent.coordinator.acquireSlot({ key: 'orphan', guardians: [{ pid: 300 }] }); f.states.set(100, 'dead');
  assert.throws(() => child.coordinator.acquireMaintenance(), { code: 'PROJECT_ROOT_OVERLAP' });
  assert.throws(() => child.coordinator.acquireSlot({ key: 'competing' }), { code: 'PROJECT_ROOT_OVERLAP' });
  assert.equal(child.coordinator.overlapStatus().overlaps[0].slots[0].key, 'orphan');
  f.states.set(300, 'dead'); const recovered = child.coordinator.acquireLease(); child.coordinator.releaseLease(recovered);
});

test('relocation overlap checks fence source and destination until the maintenance lease is released', t => {
  const f = fixture(t), source = f.project('source/project'), sourceParent = f.project('source', 'source-parent', 200), targetParent = f.project('target', 'target-parent', 300);
  const identity = source.coordinator.register(); sourceParent.coordinator.register(); targetParent.coordinator.register();
  const destination = join(targetParent.root, 'project'); cpSync(source.root, destination, { recursive: true }); cpSync(stateDir(source.root), stateDir(destination), { recursive: true });
  const target = createMachineCoordinator({ projectRoot: destination, projectId: source.projectId }, f.deps(100));
  const sourceLease = sourceParent.coordinator.acquireLease(); assert.throws(() => target.acquireRelocation({ fromRoot: source.root }), { code: 'PROJECT_ROOT_OVERLAP' }); sourceParent.coordinator.releaseLease(sourceLease);
  const targetLease = targetParent.coordinator.acquireLease(); assert.throws(() => target.acquireRelocation({ fromRoot: source.root }), { code: 'PROJECT_ROOT_OVERLAP' }); targetParent.coordinator.releaseLease(targetLease);
  const maintenance = target.acquireRelocation({ fromRoot: source.root });
  assert.throws(() => targetParent.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  target.relocate({ toRoot: destination, maintenanceLease: maintenance }); writeRelocatedProjectIdentity(destination, identity, { fromRoot: source.root });
  assert.throws(() => sourceParent.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  assert.throws(() => targetParent.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  target.releaseLease(maintenance);
  const releasedSource = sourceParent.coordinator.acquireLease(), releasedTarget = targetParent.coordinator.acquireLease();
  sourceParent.coordinator.releaseLease(releasedSource); targetParent.coordinator.releaseLease(releasedTarget);
});

test('relocate checks a new destination even when maintenance was acquired at the original root', t => {
  const f = fixture(t), source = f.project('source'), targetParent = f.project('target', 'target', 200); source.coordinator.register(); targetParent.coordinator.register();
  const destination = join(targetParent.root, 'project'); mkdirSync(destination);
  const maintenance = source.coordinator.acquireMaintenance(), runtime = targetParent.coordinator.acquireLease();
  assert.throws(() => source.coordinator.relocate({ toRoot: destination, maintenanceLease: maintenance }), { code: 'PROJECT_ROOT_OVERLAP' });
  assert.equal(source.coordinator.listProjects().find(row => row.projectId === 'source').projectRoot, source.root);
  targetParent.coordinator.releaseLease(runtime); source.coordinator.releaseLease(maintenance);
});

test('maintenance additional roots canonicalize missing paths and can only widen a held scope', t => {
  const f = fixture(t), source = f.project('source'), parent = f.project('parent', 'parent', 200); source.coordinator.register(); parent.coordinator.register();
  const alias = join(f.base, 'parent-alias'); symlinkSync(parent.root, alias);
  assert.throws(() => source.coordinator.acquireLease('runtime', { roots: [parent.root] }), /Only maintenance/);
  assert.throws(() => source.coordinator.acquireMaintenance({ roots: ['relative'] }), /absolute/);
  const lease = source.coordinator.acquireMaintenance({ roots: [join(alias, 'missing', 'old-project')] });
  assert.ok(lease.owner.projectRoots.includes(join(parent.root, 'missing', 'old-project')));
  source.coordinator.acquireMaintenance();
  assert.throws(() => parent.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  source.coordinator.releaseLease(lease); const runtime = parent.coordinator.acquireLease(); parent.coordinator.releaseLease(runtime);
});
test('copied identities and old service ownership block adoption while stopped legacy state requires explicit adoption', t => {
  const f = fixture(t), a = f.project('a'), b = f.project('b', 'a'); a.coordinator.register(); cpSync(stateDir(a.root), stateDir(b.root), { recursive: true });
  assert.equal(inspectProjectIdentity(b.root, b.projectId).matches, false); assert.throws(() => b.coordinator.register(), { code: 'PROJECT_RELOCATED' });
  const legacy = f.project('legacy'); mkdirSync(join(stateDir(legacy.root), 'service'), { recursive: true }); writeFileSync(join(stateDir(legacy.root), 'state.sqlite'), 'legacy');
  assert.throws(() => legacy.coordinator.register(), { code: 'PROJECT_IDENTITY_ADOPTION_REQUIRED' }); assert.ok(legacy.coordinator.register({ adoptLegacy: true }).instanceId);
  const bad = f.project('bad'); mkdirSync(join(stateDir(bad.root), 'service'), { recursive: true }); writeFileSync(join(stateDir(bad.root), 'service/.owner.json'), JSON.stringify({ projectRoot: a.root, projectId: 'bad' }));
  assert.equal(inspectProjectIdentity(bad.root, 'bad').matches, false); assert.throws(() => assertLegacyProjectRoot(bad.root, 'bad'), { code: 'PROJECT_RELOCATED' });
});
test('leases share one coordinator, reject a second even in the same PID, and fence stale release tokens', t => {
  const f = fixture(t), a = f.project('a'); a.coordinator.register(); const peer = createMachineCoordinator({ projectRoot: a.root, projectId: a.projectId }, f.deps(100));
  const first = a.coordinator.acquireLease(); assert.deepEqual(a.coordinator.acquireLease(), first); assert.throws(() => peer.acquireLease(), { code: 'PROJECT_LEASE_BUSY' });
  a.coordinator.releaseLease(first); const next = peer.acquireLease(); assert.ok(next.epoch > first.epoch); assert.throws(() => a.coordinator.releaseLease(first), { code: 'PROJECT_LEASE_LOST' }); peer.releaseLease(next);
});
test('dead owners do not release live or unknown guardians; verified death permits recovery', t => {
  const f = fixture(t), a = f.project('a'); a.coordinator.register(); const first = a.coordinator.acquireLease('runtime', { guardians: [{ pid: 300 }] }); f.states.set(100, 'dead');
  const peer = createMachineCoordinator({ projectRoot: a.root, projectId: a.projectId }, f.deps(200)); assert.throws(() => peer.acquireLease(), { code: 'PROJECT_LEASE_BUSY' });
  f.states.set(300, 'unknown'); assert.throws(() => peer.acquireLease(), { code: 'PROJECT_LEASE_BUSY' }); f.states.set(300, 'dead'); const recovered = peer.acquireLease(); assert.ok(recovered.epoch > first.epoch); peer.releaseLease(recovered);
});
test('maintenance blocks all ordinary writes and execution, token permits migration-owned writes', t => {
  const f = fixture(t), a = f.project('a'); a.coordinator.register(); const lease = a.coordinator.acquireMaintenance();
  assert.throws(() => a.coordinator.assertWritable(), { code: 'PROJECT_MAINTENANCE' }); assert.doesNotThrow(() => a.coordinator.assertWritable({ maintenanceToken: lease.token })); assert.throws(() => a.coordinator.acquireLease(), { code: 'PROJECT_MAINTENANCE' });
  a.coordinator.releaseLease(lease); assert.doesNotThrow(() => a.coordinator.assertWritable());
});
test('repository ownership survives stopped leases and repository rename; different identities cannot claim or release it', t => {
  const f = fixture(t), a = f.project('a'), b = f.project('b'); a.coordinator.register(); b.coordinator.register();
  a.coordinator.claimRepository({ repository: 'Owner/Repo', repositoryId: 55 }); const lease = a.coordinator.acquireLease(); a.coordinator.releaseLease(lease);
  assert.throws(() => b.coordinator.claimRepository({ repository: 'owner/repo' }), { code: 'GITHUB_REPOSITORY_OWNED' }); assert.throws(() => b.coordinator.claimRepository({ repository: 'owner/renamed', repositoryId: 55 }), { code: 'GITHUB_REPOSITORY_OWNED' });
  a.coordinator.claimRepository({ repository: 'owner/renamed', repositoryId: 55 }); assert.deepEqual(a.coordinator.repositoryBinding().map(row => row.repository).sort(), ['owner/renamed', 'owner/repo']); assert.throws(() => b.coordinator.releaseRepository({ repository: 'owner/renamed', assertSafe: () => true }), { code: 'GITHUB_REPOSITORY_OWNED' });
  assert.throws(() => a.coordinator.claimRepository({ repository: 'owner/repo', repositoryId: 56 }), { code: 'GITHUB_REPOSITORY_ID_CHANGED' });
  assert.throws(() => a.coordinator.releaseRepository({ repository: 'owner/renamed' }), { code: 'GITHUB_BINDING_RELEASE_UNSAFE' }); a.coordinator.releaseRepository({ repository: 'owner/renamed', assertSafe: () => true });
  assert.throws(() => b.coordinator.claimRepository({ repository: 'owner/renamed', repositoryId: 55 }), { code: 'GITHUB_REPOSITORY_OWNED' });
  a.coordinator.releaseRepository({ repository: 'owner/repo', assertSafe: () => true }); b.coordinator.claimRepository({ repository: 'owner/renamed', repositoryId: 55 });
});
test('fixed port declarations detect wildcard overlap without conflating independent loopback ports', t => {
  const f = fixture(t), a = f.project('a'), b = f.project('b'); a.coordinator.register(); b.coordinator.register(); a.coordinator.reservePort({ host: '127.0.0.1', port: 8787 });
  assert.equal(b.coordinator.portStatus({ host: '::', port: 8787 }).available, false); assert.throws(() => b.coordinator.reservePort({ host: '0.0.0.0', port: 8787 }), { code: 'WEBHOOK_PORT_OWNED' }); b.coordinator.reservePort({ host: '127.0.0.1', port: 8788 }); assert.equal(listenAddressesOverlap('localhost', '::1'), true);
  a.coordinator.releasePort(); assert.equal(b.coordinator.portStatus({ host: '127.0.0.1', port: 8787 }).available, true);
});
test('machine capacity queues fairly, cancellation works, stale slot cannot release a newer run, and unsafe child waiting fails', t => {
  const f = fixture(t), a = f.project('a'), b = f.project('b'); a.coordinator.register(); b.coordinator.register(); a.coordinator.setLimits({ maxActiveExecutions: 1 });
  const first = a.coordinator.acquireSlot({ key: 'run' }).slot; assert.equal(b.coordinator.acquireSlot({ key: 'run' }).acquired, false);
  assert.throws(() => a.coordinator.acquireSlot({ key: 'child', kind: 'child', parentKey: 'run' }), { code: 'MACHINE_CHILD_CAPACITY' }); a.coordinator.releaseSlot(first);
  assert.equal(a.coordinator.acquireSlot({ key: 'run' }).acquired, false); const second = b.coordinator.acquireSlot({ key: 'run' }); assert.equal(second.acquired, true); assert.throws(() => a.coordinator.releaseSlot(first), { code: 'EXECUTION_SLOT_LOST' }); assert.equal(a.coordinator.cancelSlot('run'), true);
  b.coordinator.releaseSlot(second.slot); const third = a.coordinator.acquireSlot({ key: 'run' }); assert.equal(third.acquired, true); a.coordinator.releaseSlot(third.slot);
});
test('relocation preserves identity with explicit maintenance and refuses a destination owned by another project', t => {
  const f = fixture(t), a = f.project('a'), b = f.project('b'); const identity = a.coordinator.register(); b.coordinator.register(); const lease = a.coordinator.acquireMaintenance();
  assert.throws(() => a.coordinator.relocate({ toRoot: b.root, maintenanceLease: lease }), { code: 'PROJECT_IDENTITY_CONFLICT' });
  const destination = join(f.base, 'moved'); mkdirSync(destination); const moved = a.coordinator.relocate({ toRoot: destination, maintenanceLease: lease }); assert.equal(moved.instanceId, identity.instanceId); a.coordinator.releaseLease(lease);
  writeRelocatedProjectIdentity(destination, identity, { fromRoot: a.root }); assert.equal(assertProjectIdentity(destination, 'a').instanceId, identity.instanceId); assert.equal(createMachineCoordinator({ projectRoot: destination, projectId: 'a' }, f.deps(100)).register().projectRoot, destination);
});
test('a parent can yield capacity to a child while preserving guardians and reacquire afterwards', t => {
  const f = fixture(t), a = f.project('a'); a.coordinator.register(); a.coordinator.setLimits({ maxActiveExecutions: 1 });
  const parent = a.coordinator.acquireSlot({ key: 'parent', guardians: [{ pid: 300 }] }).slot;
  assert.equal(a.coordinator.yieldSlot(parent).suspended, true);
  assert.equal(a.coordinator.cancelSlot('parent'), false, 'A cancelled resumption must retain live guardian ownership');
  const child = a.coordinator.acquireSlot({ key: 'child', kind: 'child', parentKey: 'parent' }); assert.equal(child.acquired, true);
  assert.equal(a.coordinator.acquireSlot({ key: 'parent' }).acquired, false); a.coordinator.releaseSlot(child.slot);
  const resumed = a.coordinator.acquireSlot({ key: 'parent' }); assert.equal(resumed.acquired, true);
  assert.throws(() => a.coordinator.releaseSlot(resumed.slot), { code: 'PROJECT_GUARDIANS_ACTIVE' }); f.states.set(300, 'dead'); a.coordinator.releaseSlot(resumed.slot);
});
test('a dead parent with live yielded guardians cannot free capacity after a crash', t => {
  const f = fixture(t), a = f.project('a'), b = f.project('b', 'b', 200); a.coordinator.register(); b.coordinator.register(); a.coordinator.setLimits({ maxActiveExecutions: 1 });
  const parent = a.coordinator.acquireSlot({ key: 'parent', guardians: [{ pid: 300 }] }).slot; a.coordinator.yieldSlot(parent); f.states.set(100, 'dead');
  assert.equal(b.coordinator.acquireSlot({ key: 'next' }).acquired, false); f.states.set(300, 'dead'); const next = b.coordinator.acquireSlot({ key: 'next' }); assert.equal(next.acquired, true); b.coordinator.releaseSlot(next.slot);
});
test('explicit relocation can lock a moved instance whose original directory is missing', t => {
  const f = fixture(t), a = f.project('a'); const identity = a.coordinator.register(); a.coordinator.claimRepository({ repository: 'owner/repo', repositoryId: 77 });
  const destination = join(f.base, 'moved'), state = stateDir(a.root); renameSync(a.root, destination); renameSync(state, stateDir(destination));
  const c = createMachineCoordinator({ projectRoot: destination, projectId: 'a' }, f.deps(100)); const lease = c.acquireRelocation({ fromRoot: a.root });
  assert.throws(() => c.acquireLease(), { code: 'PROJECT_RELOCATED' }); c.relocate({ toRoot: destination, maintenanceLease: lease });
  writeRelocatedProjectIdentity(destination, identity, { fromRoot: a.root }); c.releaseLease(lease);
  const moved = createMachineCoordinator({ projectRoot: destination, projectId: 'a' }, f.deps(100)); moved.register(); assert.equal(moved.repositoryBinding()[0].projectRoot, destination);
});
test('an interrupted registry relocation resumes only with the matching local operation journal', t => {
  const f = fixture(t), a = f.project('parent/a'), parent = f.project('parent', 'parent', 200); const identity = a.coordinator.register(), destination = join(f.base, 'moved'); parent.coordinator.register();
  cpSync(a.root, destination, { recursive: true }); cpSync(stateDir(a.root), stateDir(destination), { recursive: true });
  const first = createMachineCoordinator({ projectRoot: destination, projectId: a.projectId }, f.deps(100)); const lease = first.acquireRelocation({ fromRoot: a.root }); first.relocate({ toRoot: destination, maintenanceLease: lease }); first.releaseLease(lease);
  const retry = createMachineCoordinator({ projectRoot: destination, projectId: a.projectId }, f.deps(100)); assert.throws(() => retry.acquireRelocation({ fromRoot: a.root }), { code: 'PROJECT_IDENTITY_CONFLICT' });
  const journalDirectory = join(stateDir(destination), 'maintenance'); mkdirSync(journalDirectory, { mode: 0o700 });
  writeFileSync(join(journalDirectory, 'project-operation.json'), JSON.stringify({ schemaVersion: 1, id: 'operation-1', operation: 'relocate', fromRoot: a.root, projectRoot: destination, identity, phase: 'rewritten' }), { mode: 0o600 });
  assert.throws(() => retry.acquireRelocation({ fromRoot: a.root, recoveryId: 'wrong' }), { code: 'PROJECT_IDENTITY_CONFLICT' });
  const parentLease = parent.coordinator.acquireLease(); assert.throws(() => retry.acquireRelocation({ fromRoot: a.root, recoveryId: 'operation-1' }), { code: 'PROJECT_ROOT_OVERLAP' }); parent.coordinator.releaseLease(parentLease);
  const recovered = retry.acquireRelocation({ fromRoot: a.root, recoveryId: 'operation-1' });
  assert.throws(() => parent.coordinator.acquireLease(), { code: 'PROJECT_ROOT_OVERLAP' });
  writeRelocatedProjectIdentity(destination, identity, { fromRoot: a.root }); retry.releaseLease(recovered);
});
test('deleting or replacing the machine registry cannot silently forget an existing project registration', t => {
  const f = fixture(t), a = f.project('a'); a.coordinator.register(); rmSync(f.directory, { recursive: true });
  assert.throws(() => a.coordinator.register(), { code: 'MACHINE_REGISTRY_MISSING' }); assert.equal(existsSync(f.directory), false);
  createMachineCoordinator({}, f.deps(100)).setLimits({ maxActiveExecutions: 1 });
  assert.throws(() => a.coordinator.register(), { code: 'MACHINE_REGISTRY_CHANGED' });
});
test('a fresh project cannot rebuild a missing database while the registry identity survives', t => {
  const f = fixture(t), a = f.project('a'), b = f.project('b'); a.coordinator.register();
  rmSync(a.coordinator.path);
  assert.throws(() => b.coordinator.register(), { code: 'MACHINE_REGISTRY_MISSING' }); assert.equal(existsSync(a.coordinator.path), false);
});
test('unfinished registry initialization never grants recreation to another caller or an elapsed timer', t => {
  const f = fixture(t), a = f.project('a'); mkdirSync(f.directory, { mode: 0o700 });
  writeFileSync(join(f.directory, 'registry.json'), JSON.stringify({ schemaVersion: 1, id: 'registry', phase: 'initializing', createdAt: 1, creator: { token: 'other', pid: 999999 } }), { mode: 0o600 });
  assert.throws(() => a.coordinator.register(), { code: 'MACHINE_REGISTRY_INITIALIZING' }); assert.equal(existsSync(a.coordinator.path), false);
});
test('an emptied database cannot be recreated under an already ready registry identity', t => {
  const f = fixture(t), a = f.project('a'), b = f.project('b'); a.coordinator.register();
  const before = readFileSync(join(f.directory, 'registry.json'), 'utf8'); assert.equal(JSON.parse(before).phase, 'ready'); writeFileSync(a.coordinator.path, '');
  assert.throws(() => b.coordinator.register(), { code: 'MACHINE_PROTOCOL_UNSUPPORTED' }); assert.equal(readFileSync(join(f.directory, 'registry.json'), 'utf8'), before);
});
test('a relocation source left on disk cannot accept new local writes after ownership moves', t => {
  const f = fixture(t), a = f.project('a'); const identity = a.coordinator.register(); const destination = join(f.base, 'moved');
  cpSync(a.root, destination, { recursive: true }); cpSync(stateDir(a.root), stateDir(destination), { recursive: true }); const lease = a.coordinator.acquireMaintenance();
  a.coordinator.relocate({ toRoot: destination, maintenanceLease: lease }); writeRelocatedProjectIdentity(destination, identity, { fromRoot: a.root }); a.coordinator.releaseLease(lease);
  const stale = createMachineCoordinator({ projectRoot: a.root, projectId: 'a' }, f.deps(100));
  assert.throws(() => stale.assertWritable(), { code: 'PROJECT_IDENTITY_CONFLICT' });
  const moved = createMachineCoordinator({ projectRoot: destination, projectId: 'a' }, f.deps(100)); assert.doesNotThrow(() => moved.assertWritable());
  const fresh = f.project('fresh'); ensureProjectIdentity(fresh.root, 'fresh'); assert.doesNotThrow(() => fresh.coordinator.assertWritable());
});

test('a macOS boot time correction does not make a live owner look dead', () => {
  const boot = '{ sec = 1793885231, usec = 263089 } Thu Nov  5 21:27:11 2026';
  assert.equal(sameBoot(boot, '{ sec = 1793885231, usec = 160241 } Thu Nov  5 21:27:11 2026'), true);
  assert.equal(sameBoot(boot, '{ sec = 1793885232, usec = 1000 } Thu Nov  5 21:27:12 2026'), true);
  assert.equal(sameBoot(boot, '{ sec = 1793895231, usec = 263089 } Fri Nov  6 00:13:51 2026'), false);
  assert.equal(sameBoot('8f1c0b8e-0000-4000-8000-000000000001', '8f1c0b8e-0000-4000-8000-000000000002'), false);
  assert.equal(sameBoot('8f1c0b8e-0000-4000-8000-000000000001', '8f1c0b8e-0000-4000-8000-000000000001'), true);
  assert.equal(sameBoot(undefined, boot), false);
  const self = currentProcessIdentity();
  assert.equal(inspectProcessOwner(self), 'alive');
  const darwin = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}(.*)$/.exec(self.bootId);
  if (darwin) {
    const shifted = `{ sec = ${darwin[1]}, usec = ${(Number(darwin[2]) + 102848) % 1000000} }${darwin[3]}`;
    assert.equal(inspectProcessOwner({ ...self, bootId: shifted }), 'alive');
    assert.equal(inspectProcessOwner({ ...self, bootId: `{ sec = ${Number(darwin[1]) + 100000}, usec = 0 }${darwin[3]}` }), 'dead');
    assert.equal(inspectProcessOwner({ ...self, birth: 'Thu Jan  1 00:00:00 2026' }), 'dead');
  }
});

test('a changed macOS host name keeps the same-boot owner identity', () => {
  const self = currentProcessIdentity();
  assert.equal(inspectProcessOwner({ ...self, host: 'Mac' }), 'alive');
  assert.equal(inspectProcessOwner({ ...self, host: 'Mac', birth: 'Thu Jan  1 00:00:00 2026' }), 'dead');
  assert.equal(inspectProcessOwner({ ...self, host: 'other-machine', bootId: 'another-boot' }), 'unknown');
  assert.equal(inspectProcessOwner({ ...self, host: 'Mac', bootId: undefined }), 'unknown');
});
