// Public DSH jobs contract only. Waiting is installed before handoff so
// tool-jobs observes awaited=true and does not enqueue a model wakeup.
export function createDshNativeCollector(jobs, { sessionId, emit }) {
  const owned = new Map();
  const controller = new AbortController();
  const running = job => ['running', 'stopping'].includes(job.status);
  const inspect = id => {
    const job = jobs.get(id, sessionId);
    if (job.owner !== sessionId || !['bash','pwsh'].includes(job.kind)) throw new Error('Native job is not an owned shell command');
    return job;
  };
  const collect = async id => {
    let job = inspect(id);
    while (running(job)) job = await jobs.wait(id, 30000, sessionId, controller.signal);
    const output = jobs.readAt(id, 0, sessionId);
    let truncated = job.output.earliest > 0 || (output.chunks?.length ?? 0) > 256;
    const chunks = (output.chunks ?? []).slice(-256).map(chunk => {
      const original = String(chunk.text), text = Array.from(original).slice(-4000).join('');
      const skipped = Buffer.byteLength(original) - Buffer.byteLength(text); truncated ||= skipped > 0;
      return { at: chunk.at + skipped, channel: chunk.channel, text, ...(chunk.gapBefore || skipped ? { gapBefore: true } : {}) };
    });
    let retained = 0;
    const bounded = chunks.reverse().filter(chunk => { retained += Buffer.byteLength(JSON.stringify(chunk)); if (retained > 32000) { truncated = true; return false; } return true; }).reverse();
    await emit({ type: 'settled', job: { id: job.id, owner: job.owner, kind: job.kind, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, detail: job.detail?.slice(0, 1000) },
      output: { chunks: bounded, total: job.output.total, earliest: job.output.earliest, truncated } });
    return job;
  };
  return {
    hold(ids) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('Invalid native handoff jobs');
      ids.forEach(inspect);
      // Calling the async collector synchronously registers jobs.wait before the ack.
      for (const id of ids) if (!owned.has(id)) {
        const task = collect(id); owned.set(id, task); task.catch(error => emit({ type: 'failed', jobId: id, reason: String(error.message).slice(0, 300) }).catch(() => {}));
      }
      return { installed: true, jobIds: ids };
    },
    async close() { controller.abort(); await Promise.allSettled(owned.values()); },
  };
}
