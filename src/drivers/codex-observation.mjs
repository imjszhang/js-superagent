import { createNativeExecutionObserver, nativeRetryReason } from '../runtime/execution-observation.mjs';

export function createCodexExecutionObserver(options) {
  const observer = createNativeExecutionObserver(options);
  const sessionId = options.sessionId ?? (() => undefined);
  return {
    observe(message) {
      const params = message?.params;
      const { waiting, ended } = observer.state();
      if (!params || params.threadId !== sessionId() || ended) return;
      if (message.method === 'error' && params.willRetry === true && typeof params.turnId === 'string') {
        observer.emit({ state: 'waiting', turnId: params.turnId, reason: nativeRetryReason({ code: params.error?.codexErrorInfo }), evidence: 'codex-error-willRetry', attempts: null, provider: null });
      } else if (waiting && ['item/started', 'item/completed'].includes(message.method) && ['agentMessage', 'commandExecution', 'dynamicToolCall'].includes(params.item?.type)) {
        observer.emit({ state: 'active', turnId: params.turnId, reason: 'native-progress', evidence: 'codex-item-progress' });
      } else if (message.method === 'turn/completed') observer.emit({ state: 'ended', turnId: params.turn?.id, reason: params.turn?.status ?? 'ended', evidence: 'codex-turn-completed' });
    },
    end(reason) { observer.end(reason); },
  };
}
