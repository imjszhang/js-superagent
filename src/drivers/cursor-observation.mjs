import { createNativeExecutionObserver } from '../runtime/execution-observation.mjs';

/** stream-json exposes no retry or wait events, so a Cursor run is only active or ended. */
export function createCursorExecutionObserver(options) {
  const observer = createNativeExecutionObserver(options);
  let started = false;
  return {
    observe(event) {
      if (!event || observer.state().ended) return;
      if (!started && ['user', 'assistant', 'tool_call'].includes(event.type)) {
        started = true;
        observer.emit({ state: 'active', reason: 'native-progress', evidence: `cursor-${event.type}` });
      } else if (event.type === 'result') observer.emit({ state: 'ended', reason: event.subtype === 'success' && event.is_error === false ? 'completed' : 'failed', evidence: 'cursor-result' });
    },
    end(reason) { observer.end(reason); },
  };
}
