/** GitHub webhook delivery IDs may be 64-bit numbers beyond JS integer precision. */
export function parseGitHubDeliveryList(raw) {
  const data = JSON.parse(raw, function (key, value, context) {
    if (key === 'id' && typeof value === 'number' && typeof this.guid === 'string' && 'redelivery' in this) {
      if (!context?.source || !/^[1-9]\d*$/.test(context.source)) throw new Error('Invalid GitHub delivery ID');
      return context.source;
    }
    return value;
  });
  if (!Array.isArray(data) || data.some(item => !item || typeof item !== 'object' ||
      typeof item.id !== 'string' || !/^[1-9]\d*$/.test(item.id))) throw new Error('Invalid GitHub delivery list');
  return data;
}
