import { contextBytes, utf8Slice } from './worker-context.mjs';
import { MATERIAL_LIMITS, materialDigest, materialError, materialGitStatus, materialDirectoryAllowed, materialPathAllowed, listMaterialDirectory, readMaterialContent, captureMaterialSnapshot, assertMaterialSourceIdentity } from '../materials.mjs';

const MAX_REFERENCES = 4096;
/** The provider accepts only host-minted records. Persistent observations restore their references. */
export function createWorkerProjectReads({ binding, assertActive = () => {}, validateBinding = () => {}, signal, snapshots, observations = [], onObservation = () => {}, now = () => new Date().toISOString() } = {}) {
  if (binding?.version !== 1 || !Array.isArray(binding.sources) || !binding.sources.length) throw materialError('MATERIAL_FORMAT', 'Material provider requires a resolved binding');
  const bindingDigest = materialDigest(binding), descriptors = new Map(), history = structuredClone(observations);
  const active = () => { signal?.throwIfAborted(); assertActive(); validateBinding(); };
  const sourceOf = id => {
    const source = binding.sources.find(source => source.id === id);
    if (!source) throw materialError('MATERIAL_ACCESS_DENIED', 'Material reference belongs to another binding');
    return source;
  };
  const reference = descriptor => {
    const source = sourceOf(descriptor.sourceId);
    if (!['status', 'directory', 'file'].includes(descriptor.kind) || (descriptor.kind === 'file' ? !materialPathAllowed(source, descriptor.path) : !materialDirectoryAllowed(source, descriptor.path))) throw materialError('MATERIAL_ACCESS_DENIED', 'Material reference is outside its source');
    const value = { sourceId: descriptor.sourceId, kind: descriptor.kind, path: descriptor.path };
    const id = `material:${materialDigest({ bindingDigest, ...value })}`;
    return { resource: 'materials', id };
  };
  const register = descriptor => {
    const ref = reference(descriptor);
    if (!descriptors.has(ref.id) && descriptors.size >= MAX_REFERENCES) throw materialError('MATERIAL_LIMIT', 'Material reference budget exhausted');
    descriptors.set(ref.id, { sourceId: descriptor.sourceId, kind: descriptor.kind, path: descriptor.path });
    return ref;
  };
  for (const source of binding.sources) { register({ sourceId: source.id, kind: 'status', path: '.' }); register({ sourceId: source.id, kind: 'directory', path: '.' }); }
  for (const observation of history) {
    if (observation.bindingDigest !== bindingDigest) throw materialError('MATERIAL_BINDING_CHANGED', 'Saved material observation has a different binding');
    const own = register(observation.descriptor);
    if (own.id !== observation.id) throw materialError('MATERIAL_FORMAT', 'Saved material reference changed');
    for (const descriptor of observation.references ?? []) register(descriptor);
  }
  const references = () => {
    active();
    return [...descriptors].map(([id, descriptor]) => ({ resource: 'materials', id, value: { sourceId: descriptor.sourceId, kind: descriptor.kind, path: descriptor.path, view: sourceOf(descriptor.sourceId).view } }));
  };
  const validate = prepared => {
    active();
    const descriptor = descriptors.get(prepared?.id);
    if (prepared?.resource !== 'materials' || prepared.bindingDigest !== bindingDigest || !descriptor || prepared.descriptorDigest !== materialDigest(descriptor)) throw materialError('MATERIAL_ACCESS_DENIED', 'Material reference was not granted to this run');
  };
  const prepare = args => {
    active();
    if (!args || Object.keys(args).some(key => !['resource', 'id', 'version', 'offset', 'limit'].includes(key)) || args.resource !== 'materials' || !descriptors.has(args.id)) throw materialError('MATERIAL_ACCESS_DENIED', 'Unknown material read reference');
    const offset = args.offset ?? 0, limit = args.limit ?? 8192;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 256 || limit > 8192 || args.version !== undefined && !/^[a-f\d]{64}$/.test(args.version) || offset > 0 && args.version === undefined) throw materialError('MATERIAL_FORMAT', 'Invalid material page');
    return { resource: 'materials', id: args.id, bindingDigest, descriptorDigest: materialDigest(descriptors.get(args.id)), args: { ...args, offset, limit } };
  };
  const load = descriptor => {
    const source = sourceOf(descriptor.sourceId);
    assertMaterialSourceIdentity(source);
    if (descriptor.kind === 'status') return { value: { sourceId: source.id, projectId: source.project.projectId, view: source.view, include: source.include, exclude: source.exclude,
      git: source.view.kind === 'current' ? materialGitStatus(source) : source.view.kind === 'commit' ? { head: source.view.sha } : null }, refs: [] };
    if (descriptor.kind === 'directory') {
      const entries = listMaterialDirectory(source, descriptor.path, snapshots), refs = entries.map(entry => ({ sourceId: source.id, kind: entry.kind, path: entry.path }));
      const items = entries.map((entry, index) => ({ ...entry, ...reference(refs[index]) }));
      // Stable IDs belong to the complete directory value, but merely hashing
      // that value (including freshness checks) must not grant all its children.
      let offset = contextBytes(`${JSON.stringify({ sourceId: source.id, path: descriptor.path }).slice(0, -1)},"items":[`);
      const ranges = items.map((item, index) => {
        const start = offset, end = start + contextBytes(item);
        offset = end + 1;
        return { start, end, descriptor: refs[index] };
      });
      return { value: { sourceId: source.id, path: descriptor.path, items }, ranges };
    }
    const file = readMaterialContent(source, descriptor.path, snapshots);
    if (file.size > MATERIAL_LIMITS.recordBytes) throw materialError('MATERIAL_LIMIT', 'Material text exceeds its retained record limit');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { throw materialError('MATERIAL_ENCODING', 'Material content is not UTF-8 text'); }
    if (text.includes('\0')) throw materialError('MATERIAL_ENCODING', 'Binary material is available only through a host snapshot');
    return { value: { sourceId: source.id, path: descriptor.path, sha256: file.sha256, mode: file.mode, text }, refs: [] };
  };
  const read = async (prepared, { signal: callSignal, charge = () => {} } = {}) => {
    validate(prepared); callSignal?.throwIfAborted();
    const descriptor = descriptors.get(prepared.id), loaded = load(descriptor), version = materialDigest(loaded.value), serialized = JSON.stringify(loaded.value);
    if (contextBytes(serialized) > MATERIAL_LIMITS.recordBytes) throw materialError('MATERIAL_LIMIT', 'Material record exceeds its bound');
    charge({ requests: 1, bytes: contextBytes(serialized) });
    if (prepared.args.version !== undefined && prepared.args.version !== version) throw materialError('MATERIAL_CHANGED', 'Material changed between pages; read its new version');
    validate(prepared); callSignal?.throwIfAborted();
    const observedAt = now(), envelopeLimit = prepared.args.limit + 4096;
    const page = limit => {
      const slice = utf8Slice(serialized, prepared.args.offset, limit), end = prepared.args.offset + contextBytes(slice.text);
      const refs = (loaded.ranges ?? []).filter(range => range.start < end && range.end > prepared.args.offset).map(range => range.descriptor);
      return { refs, result: { resource: 'materials', id: prepared.id, version, offset: prepared.args.offset, ...slice,
        source: { sourceId: descriptor.sourceId, view: sourceOf(descriptor.sourceId).view, observedAt }, references: refs.map(reference) } };
    };
    let selected = page(prepared.args.limit);
    if (contextBytes(selected.result) > envelopeLimit) {
      // JSON text is escaped again in the outer response. Fit that complete
      // response, including only this page's references, into the host reserve.
      let lower = 0, upper = prepared.args.limit;
      while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2), candidate = page(middle);
        if (contextBytes(candidate.result) <= envelopeLimit) lower = middle;
        else upper = middle - 1;
      }
      selected = page(lower);
    }
    if (contextBytes(selected.result) > envelopeLimit || !selected.result.text && selected.result.nextOffset !== null)
      throw materialError('MATERIAL_PAGE_LIMIT', 'Material page metadata exceeds the permitted response envelope');
    const added = new Set(selected.refs.map(ref => reference(ref).id).filter(id => !descriptors.has(id)));
    if (descriptors.size + added.size > MAX_REFERENCES) throw materialError('MATERIAL_LIMIT', 'Material reference budget exhausted');
    const { offset, nextOffset, length } = selected.result;
    const observation = { version: 1, bindingDigest, id: prepared.id, descriptor: structuredClone(descriptor), valueVersion: version,
      observedAt, page: { offset, nextOffset, length }, references: selected.refs };
    onObservation(structuredClone(observation));
    for (const ref of selected.refs) register(ref);
    history.push(observation);
    return selected.result;
  };
  const checkFreshness = () => {
    active();
    const latest = new Map(history.map(observation => [observation.id, observation])), changed = [];
    for (const observation of latest.values()) {
      if (sourceOf(observation.descriptor.sourceId).view.kind !== 'current') continue;
      try { if (materialDigest(load(observation.descriptor).value) !== observation.valueVersion) changed.push(observation.id); }
      catch (error) { if (['MATERIAL_ACCESS_DENIED', 'MATERIAL_BINDING_CHANGED', 'MATERIAL_IDENTITY'].includes(error.code)) throw error; changed.push(observation.id); }
    }
    return { version: 1, fresh: changed.length === 0, changed, observedRecords: latest.size, checkedAt: now() };
  };
  const exportSnapshot = sourceId => { active(); return captureMaterialSnapshot(sourceOf(sourceId), { snapshots, assertActive: active, now }); };
  return Object.freeze({ references, prepare, validate, read, observations: () => structuredClone(history), checkFreshness, exportSnapshot });
}
