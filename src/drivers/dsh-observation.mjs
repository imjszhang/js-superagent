import { createNativeExecutionObserver, nativeRetryReason } from '../runtime/execution-observation.mjs';

const iso = value => value !== undefined && value !== null && value !== '' && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
function retryReason(failure) {
  const reason = nativeRetryReason(failure);
  if (reason !== 'unknown' || typeof failure?.message !== 'string' || failure.message.length >= 8192) return reason;
  try { const body = JSON.parse(failure.message); if ((body.error?.code ?? body.error?.type ?? body.code ?? body.type) === 'budget_exceeded') return 'budget'; }
  catch { /* Plain prose stays unknown. */ }
  return reason;
}
export function createDshExecutionObserver(options) {
  const observer = createNativeExecutionObserver(options);
  let nativeSequence = -1;
  return {
    observe(event) {
      const { ended, waiting, lastState } = observer.state();
      if (!event || !Number.isSafeInteger(event.seq) || event.seq <= nativeSequence || ended) return;
      nativeSequence = event.seq;
      const data = event.data ?? {}, at = iso(event.time);
      if (event.type === 'turn/start' && lastState === 'ended') observer.emit({ state: 'active', turnId: String(data.turn), reason: 'native-next-turn', evidence: 'dsh-turn-start' });
      else if (event.type === 'llm/retry' && typeof data.provider === 'string' && Number.isSafeInteger(data.retry)) {
        const delay = Number.isSafeInteger(data.delayMs) && data.delayMs >= 0 ? data.delayMs : null;
        observer.emit({ state: 'waiting', turnId: String(data.turn), reason: retryReason(data.failure), provider: data.provider, attempts: data.retry,
          ...(at ? { at } : {}), nextAt: at && delay !== null ? new Date(Date.parse(at) + delay).toISOString() : null, evidence: 'dsh-llm-retry' });
      } else if (waiting && ['assistant/message', 'tool/call'].includes(event.type)) observer.emit({ state: 'active', turnId: String(data.turn), reason: 'native-progress', evidence: `dsh-${event.type}` });
      else if (event.type === 'turn/end') observer.emit({ state: 'ended', turnId: String(data.turn), reason: data.reason?.kind ?? 'ended', evidence: 'dsh-turn-end' });
    },
    end(reason) { observer.end(reason); },
  };
}
