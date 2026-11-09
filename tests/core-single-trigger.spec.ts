import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError } from '../src/core/index.ts'
import type { Candidate, EngineOptions, Policy, Trigger } from '../src/core/index.ts'

const at = '2026-11-03T00:00:00.000Z'
function trigger(id: string, actor = 'alice', thread = 'issue'): Trigger {
  return { id, source: 'github', actor: { source: 'github', id: actor }, human: true, at, text: `Question ${id}`,
    threads: [{ source: 'github', id: thread }], channel: { source: 'github', thread, address: { comment: id } }, meta: {} }
}
function harness(options: { emit?: EngineOptions['emit'] } = {}) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const release = vi.fn()
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: t => t.actor.id === 'blocked' ? { admissible: false, reason: 'sender denied' }
      : { admissible: true, strength: t.actor.id === 'alice' ? 'explicit' : 'inferred', basis: { via: 'listed', sender: t.actor.id } },
    revalidate: () => true, admitsInferred: rules => rules.includes('enabled'),
  }
  const engine = new Engine({ repo, policy: () => policy, now: () => at,
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: candidate => requests.push(candidate), release },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }, ...options,
  })
  const batch = (...inputs: Trigger[]) => { for (const input of inputs) engine.receive(input); engine.evaluateDue(); return requests.at(-1)! }
  const close = (candidate: Candidate, id = candidate.triggers[0]!.id) => engine.decideTrigger(id, {
    kind: 'ignore', evalId: candidate.evalId, reason: 'Answered this question', audit: { kind: 'answer' },
  })
  const thread = () => repo.threads.get('github:issue')!
  const decisions = () => repo.decisions.byThread('github:issue')
  return { repo, engine, policy, requests, release, batch, close, thread, decisions }
}

describe('single-trigger decisions', () => {
  it('answers one person after a pause, then reassesses the other with their own authority', () => {
    const h = harness()
    h.policy.paused = true
    h.batch(trigger('a', 'alice'), trigger('b', 'bob'))
    expect(h.requests).toHaveLength(0)
    h.policy.paused = false
    h.engine.evaluateDue()
    const first = h.requests[0]!
    expect(first.triggers.map(t => t.id)).toEqual(['a', 'b'])
    expect(first.strength).toBe('explicit')
    const decision = h.close(first, 'a')
    expect(decision).toMatchObject({ kind: 'ignore', triggerIds: ['a'], strength: 'explicit', audit: {
      kind: 'answer', triggerDecision: { sourceEvalId: first.evalId, triggerId: 'a',
        gate: { admissible: true, strength: 'explicit', basis: { sender: 'alice' } }, owners: [] },
    } })
    expect(decision.evalId).not.toBe(first.evalId)
    expect(h.repo.triggers.disposition('b')?.decisionId).toBeUndefined()
    expect(h.thread().pending).toEqual(['b'])
    expect(h.engine.candidate('a')).toBeUndefined()
    expect(h.release).toHaveBeenCalledExactlyOnceWith(first.evalId)
    h.engine.evaluateDue()
    const next = h.requests[1]!
    expect(next.evalId).not.toBe(first.evalId)
    expect(next.triggers.map(t => t.id)).toEqual(['b'])
    expect(next).toMatchObject({ strength: 'inferred', thread: { evaluating: { actor: { id: 'bob' }, basis: { sender: 'bob' } } } })
    expect(() => h.engine.decide('b', { kind: 'accept', evalId: next.evalId, title: 'Work', scope: 'small', reason: 'requested' }))
      .toThrow(new UserError('notExplicit'))
  })

  it('does not borrow a stronger sibling authority when closing the weaker target', () => {
    const h = harness()
    const candidate = h.batch(trigger('a', 'alice'), trigger('b', 'bob'))
    expect(h.close(candidate, 'b')).toMatchObject({ triggerIds: ['b'], strength: 'inferred', audit: {
      triggerDecision: { gate: { strength: 'inferred', basis: { sender: 'bob' } } },
    } })
    h.engine.evaluateDue()
    expect(h.requests[1]).toMatchObject({ strength: 'explicit', triggers: [{ id: 'a' }] })
  })

  it('can record unavailable for a denied input without discarding a valid sibling', () => {
    const h = harness()
    const candidate = h.batch(trigger('denied', 'blocked'), trigger('allowed'))
    expect(candidate.triggers).toHaveLength(2)
    expect(() => h.close(candidate, 'denied')).toThrow(new UserError('notAdmissible', { reason: 'sender denied' }))
    expect(h.decisions()).toEqual([])
    const result = h.engine.decideTrigger('denied', { kind: 'unavailable', evalId: candidate.evalId, reason: 'Answer not authorized' })
    expect(result).toMatchObject({ kind: 'unavailable', triggerIds: ['denied'], strength: 'inferred', audit: {
      triggerDecision: { gate: { admissible: false, reason: 'sender denied' }, owners: [] },
    } })
    expect(result.mandate).toBeUndefined()
    h.engine.evaluateDue()
    expect(h.requests[1]?.triggers.map(t => t.id)).toEqual(['allowed'])
    expect(h.close(h.requests[1]!)).toMatchObject({ triggerIds: ['allowed'] })
  })

  it('rejects old evals, changed policy, missing eval IDs, and repeat closures without state changes', () => {
    const h = harness()
    const candidate = h.batch(trigger('a'), trigger('b'))
    const before = h.thread()
    expect(() => h.engine.decideTrigger('a', { kind: 'ignore', reason: 'x', evalId: 'old' })).toThrow(new UserError('evalFinished', { eval: 'old' }))
    // @ts-expect-error JavaScript callers must also provide an eval ID.
    expect(() => h.engine.decideTrigger('a', { kind: 'ignore', reason: 'x' })).toThrow(UserError)
    h.policy.version = 'v2'
    expect(() => h.close(candidate)).toThrow('Policy changed since this evaluation')
    expect(h.thread()).toEqual(before)
    expect(h.decisions()).toEqual([])
    h.policy.version = 'v1'
    h.close(candidate)
    h.engine.evaluateDue()
    const next = h.thread()
    expect(() => h.close(candidate)).toThrow(new UserError('evalFinished', { eval: candidate.evalId }))
    expect(() => h.close(candidate, 'b')).toThrow(new UserError('evalFinished', { eval: candidate.evalId }))
    expect(h.thread()).toEqual(next)
    expect(h.decisions()).toHaveLength(1)
  })

  it('preserves new pending input in order and never requeues the handled target', () => {
    const h = harness()
    const candidate = h.batch(trigger('a'), trigger('b'))
    h.engine.receive(trigger('c'))
    h.engine.receive(trigger('d'))
    h.close(candidate, 'b')
    expect(h.thread().pending).toEqual(['a', 'c', 'd'])
    expect(h.engine.receive(trigger('b'))).toBe('duplicate')
    h.engine.evaluateDue()
    const next = h.requests[1]!
    expect(next.triggers.map(t => t.id)).toEqual(['a', 'c', 'd'])
    // The original command still decides its whole batch.
    expect(h.engine.decide('c', { kind: 'ignore', evalId: next.evalId, reason: 'No work' }).triggerIds).toEqual(['a', 'c', 'd'])
    expect(h.decisions().map(d => d.triggerIds)).toEqual([['b'], ['a', 'c', 'd']])
  })

  it('ends a singleton once and accepts later fresh inputs on the same thread', () => {
    const h = harness()
    const candidate = h.batch(trigger('a'))
    const result = h.close(candidate)
    expect(h.thread()).toMatchObject({ pending: [] })
    expect(h.thread().evaluating).toBeUndefined()
    expect(() => h.close(candidate)).toThrow(UserError)
    expect(h.decisions()).toEqual([result])
    const next = h.batch(trigger('b'))
    expect(next.triggers.map(t => t.id)).toEqual(['b'])
    expect(h.close(next).triggerIds).toEqual(['b'])
  })

  it('rejects closing an input taken by a worker, but can record unavailable without changing the worker', () => {
    const h = harness()
    h.batch(trigger('origin', 'alice', 'other'))
    const ticketId = h.engine.decide('origin', { kind: 'accept', title: 'Work', scope: 'small', reason: 'requested' }).ticketId!
    const candidate = h.batch(trigger('a'), trigger('b'))
    h.engine.bindThread(ticketId, { source: 'github', id: 'issue' }, true)
    h.engine.deliverSubscribed('a', [ticketId])
    const ticket = h.repo.tickets.get(ticketId)
    expect(() => h.close(candidate, 'a')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.decisions()).toEqual([])
    const result = h.engine.decideTrigger('a', { kind: 'unavailable', evalId: candidate.evalId, reason: 'Worker now owns this question' })
    expect(result.audit).toMatchObject({ triggerDecision: { owners: [ticketId] } })
    expect(h.repo.tickets.get(ticketId)).toEqual(ticket)
    expect(h.repo.triggers.disposition('a')?.fanout).toEqual([ticketId])
    h.engine.evaluateDue()
    expect(h.requests.at(-1)?.triggers.map(t => t.id)).toEqual(['b'])
  })

  it('rolls back the decision and requeue in an enclosing transaction, then can retry', () => {
    const h = harness()
    const candidate = h.batch(trigger('a'), trigger('b'))
    const before = h.thread()
    const dispositions = ['a', 'b'].map(id => h.repo.triggers.disposition(id))
    expect(() => h.repo.atomic(() => { h.close(candidate); throw new Error('outbox failed') })).toThrow('outbox failed')
    expect(h.thread()).toEqual(before)
    expect(h.decisions()).toEqual([])
    expect(['a', 'b'].map(id => h.repo.triggers.disposition(id))).toEqual(dispositions)
    expect(h.close(candidate).triggerIds).toEqual(['a'])
  })

  it('rolls back a failure after recording and refuses accept or stop through the narrow API', () => {
    const h = harness({ emit: event => { if (event.type === 'decision.recorded') throw new Error('event write failed') } })
    const candidate = h.batch(trigger('a'), trigger('b'))
    const before = h.thread()
    expect(() => h.close(candidate)).toThrow('event write failed')
    expect(h.thread()).toEqual(before)
    expect(h.decisions()).toEqual([])
    expect(h.repo.triggers.disposition('a')?.decisionId).toBeUndefined()
    // @ts-expect-error Runtime validation also rejects unsupported outcomes from JavaScript callers.
    expect(() => h.engine.decideTrigger('a', { kind: 'accept', evalId: candidate.evalId, title: 'x', scope: 'x', reason: 'x' })).toThrow('Single-trigger decisions')
    // @ts-expect-error The per-input command cannot stop tickets.
    expect(() => h.engine.decideTrigger('a', { kind: 'stop', evalId: candidate.evalId, ticketId: 'x', reason: 'x' })).toThrow('Single-trigger decisions')
    expect(h.thread()).toEqual(before)
  })
})
