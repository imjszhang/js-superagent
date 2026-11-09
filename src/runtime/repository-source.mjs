const defaults = { enabled: false, observe: false, fetchPullHead: false, streams: { pulls: true, issues: false, comments: false, reviewComments: false, mentions: false, defaultBranchCI: false } };
function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be an object`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Unknown ${name} field`);
}

/** Settings select read streams; GitHub credentials and actor authority stay in project configuration. */
export function normalizeRepositorySourceSettings(value = {}, previous = defaults) {
  object(value, 'repository source settings', ['enabled', 'observe', 'fetchPullHead', 'streams']);
  if (value.streams !== undefined) object(value.streams, 'repository source streams', Object.keys(defaults.streams));
  const result = { enabled: value.enabled ?? previous.enabled ?? false, observe: value.observe ?? previous.observe ?? false,
    fetchPullHead: value.fetchPullHead ?? previous.fetchPullHead ?? false,
    streams: { ...defaults.streams, ...previous.streams, ...value.streams } };
  for (const key of ['enabled', 'observe', 'fetchPullHead']) if (typeof result[key] !== 'boolean' || value[key] === null) throw new Error(`repository source ${key} must be boolean`);
  if (Object.values(result.streams).some(enabled => typeof enabled !== 'boolean')) throw new Error('repository source stream flags must be boolean');
  if (result.enabled && !Object.values(result.streams).some(Boolean)) throw new Error('Enable at least one repository source stream');
  return result;
}
