/* Browser-only draft data, never authorization or an automatic save/send queue. */
(function (global) {
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const forbidden = key => /^(?:__proto__|constructor|prototype)$/.test(key) ||
    /(?:password|private.?key|secret|token|authorization|cookie|credentials?|environment|api.?key)/i.test(key) && !/(?:Env|Path)$/i.test(key);
  function safe(value, depth = 0) {
    if (depth > 30) return false;
    if (typeof value === 'string') return value.length <= 100000 && !/-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+\S+|\bsk-[a-zA-Z0-9_-]{20,}/i.test(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return typeof value !== 'number' || Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 1000 && value.every(item => safe(item, depth + 1));
    return plain(value) && Object.entries(value).every(([key, item]) => !forbidden(key) && safe(item, depth + 1));
  }
  function merge3(base, local, remote, path = []) {
    if (equal(local, base) || equal(local, remote)) return { value: clone(remote), conflicts: [] };
    if (equal(remote, base)) return { value: clone(local), conflicts: [] };
    if (plain(base) && plain(local) && plain(remote)) {
      const value = {}, conflicts = [];
      for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        const merged = merge3(base[key], local[key], remote[key], [...path, key]);
        if (merged.value !== undefined) value[key] = merged.value;
        conflicts.push(...merged.conflicts);
      }
      return { value, conflicts };
    }
    return { value: clone(local), conflicts: [{ path, local: clone(local), remote: clone(remote) }] };
  }
  function choose(value, path, replacement) {
    if (!path.length) return clone(replacement);
    const next = clone(value), parent = path.slice(0, -1).reduce((object, key) => object[key], next), key = path.at(-1);
    if (replacement === undefined) delete parent[key]; else parent[key] = clone(replacement);
    return next;
  }
  const parse = value => { try { return JSON.parse(value); } catch { return value; } };
  function decode(key, value) {
    if (['coordinator', 'repository'].includes(key)) return parse(value);
    if (key === 'worker') return { ...value, settings: parse(value.settings) };
    if (key === 'prompts') return { ...value, knowledge: parse(value.knowledge) };
    return clone(value);
  }
  function encode(key, value) {
    const json = v => typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    if (['coordinator', 'repository'].includes(key)) return json(value);
    if (key === 'worker') return { ...value, settings: json(value.settings) };
    if (key === 'prompts') return { ...value, knowledge: json(value.knowledge) };
    return clone(value);
  }
  function safeEditor(key, record) {
    // Invalid advanced JSON remains in memory: it cannot be screened by field.
    for (const value of [record.base, record.value]) {
      const decoded = decode(key, value);
      if (['coordinator', 'repository'].includes(key) && !plain(decoded)) return false;
      if (key === 'worker' && !plain(decoded.settings)) return false;
      if (!safe(decoded)) return false;
    }
    return true;
  }
  function createStore({ storage, projectId, notify = () => {} }) {
    const valid = typeof projectId === 'string' && /^[A-Za-z\d._:-]{1,200}$/.test(projectId);
    const prefix = valid ? `js-superagent:drafts:v1:${projectId}:` : null;
    const key = id => prefix + encodeURIComponent(id);
    const issue = reason => { notify(reason); return null; };
    return {
      load(id) {
        if (!prefix) return null;
        try {
          const raw = storage().getItem(key(id)); if (raw === null) return null;
          const record = JSON.parse(raw);
          if (record?.formatVersion !== 1 || record.projectId !== projectId || record.id !== id || !safe(record.payload)) { storage().removeItem(key(id)); return issue('invalid'); }
          return clone(record.payload);
        } catch { return issue('unavailable'); }
      },
      save(id, payload, { editorKey } = {}) {
        if (!prefix) return issue('identity');
        if (!safe(payload) || editorKey && !safeEditor(editorKey, payload)) { this.remove(id); return issue('sensitive'); }
        try {
          const raw = JSON.stringify({ formatVersion: 1, projectId, id, updatedAt: new Date().toISOString(), payload });
          if (raw.length > 200000) return issue('oversized');
          storage().setItem(key(id), raw); return true;
        } catch { return issue('unavailable'); }
      },
      remove(id) { if (prefix) try { storage().removeItem(key(id)); } catch { issue('unavailable'); } },
    };
  }
  global.SuperagentDrafts = Object.freeze({ merge3, choose, decode, encode, createStore, safeEditor });
})(globalThis);
