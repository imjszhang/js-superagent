const ID = /^[A-Za-z\d._:-]{1,160}$/;
/** Process exit alone is insufficient: no bridge callbacks may outlive ownership. */
export function nativeHandoffClosed(processClosed, cleanup) {
  const closed = processClosed.then(async outcome => { await cleanup(); return outcome; }, async error => { await cleanup(error); throw error; });
  closed.catch(() => {});
  return closed;
}

/** Keep original job identities across leases, including evidence still in transit. */
export function nativeHandoffJobIds(previous, active) {
  const ids = [...new Set([...previous, ...active])];
  if (!ids.length || ids.length > 8 || ids.some(id => !ID.test(id))) throw new Error('Native handoff job budget exceeded');
  return ids;
}

/** Receipt only for terminal results actually included in this human turn. */
export function nativeHandoffEvidenceReceipts(records) {
  return records.map(record => ({ leaseId: record.id, jobIds: [...new Set((record.results ?? [])
    .filter(result => result.type === 'settled' && record.jobIds.includes(result.job?.id)).map(result => result.job.id))] }))
    .filter(receipt => receipt.jobIds.length);
}

/** Collector evidence has one committed host owner. A proposed transfer is not
 * an owner until hold acknowledges it; evidence arriving meanwhile stays local. */
export function createNativeHandoffOwnership({ persist, update }) {
  let current, transferring = false;
  const evidence = new Map(), waiters = new Set();
  const jobId = event => event.type === 'settled' ? event.job?.id : event.jobId;
  const flush = async () => {
    if (!current) return;
    for (const id of current.jobIds) if (evidence.has(id)) await update(current.id, evidence.get(id));
  };
  return {
    get current() { return current; },
    jobIds() { return [...new Set([...(current?.jobIds ?? []), ...evidence.keys()])]; },
    waitForEvidence(ids) {
      if (ids.every(id => evidence.has(id))) return Promise.resolve();
      return new Promise(resolve => waiters.add({ ids, resolve }));
    },
    async collect(event) {
      const id = jobId(event);
      if (!['settled', 'failed'].includes(event.type) || !ID.test(id ?? '')) throw new Error('Invalid native collector evidence');
      await persist(event);
      evidence.set(id, event);
      if (!transferring && current?.jobIds.includes(id)) await update(current.id, event);
      for (const waiter of waiters) if (waiter.ids.every(id => evidence.has(id))) { waiters.delete(waiter); waiter.resolve(); }
    },
    async propose(record, control, hold) {
      if (transferring) throw new Error('Native handoff transfer already pending');
      const previous = current;
      transferring = true;
      let accepted = false, failure;
      try { accepted = await hold(record, control) === true; current = accepted ? record : previous; }
      catch (error) { current = previous; failure = error; }
      finally { transferring = false; }
      // Rejected proposals retain the prior owner, including results that arrived
      // during the decision. New-job evidence remains local until a later transfer.
      try { await flush(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
      return accepted;
    },
  };
}
