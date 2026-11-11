/** A small dispatcher for the existing scoped-read contract, not a new plugin registry. */
export function combineContextReads(...providers) {
  const available = providers.filter(Boolean);
  if (!available.length) return null;
  const owner = resource => {
    const matches = available.filter(provider => provider.references().some(ref => ref.resource === resource));
    if (matches.length !== 1) throw new Error('Context resource has no unique authorized provider');
    return matches[0];
  };
  return {
    references: () => available.flatMap(provider => provider.references()),
    prepare: args => ({ resource: args.resource, prepared: owner(args.resource).prepare(args) }),
    validate: value => owner(value.resource).validate(value.prepared),
    read: (value, options) => owner(value.resource).read(value.prepared, options),
  };
}

/** Destination identity comes from the configured channel, never model prose. */
export function materialDestination(channel) {
  const source = channel?.source ?? 'local', address = channel?.address ?? {};
  if (source === 'local') return { source, id: 'operator' };
  if (source === 'feishu') return { source, id: address.operator === 'true' ? 'operator' : address.chatId ?? address.chat_id ?? address.openId ?? address.open_id ?? '' };
  if (source === 'github') return { source, id: `${address.repository ?? ''}#${address.issueNumber ?? address.number ?? address.pullNumber ?? ''}` };
  return { source, id: address.id ?? '' };
}
