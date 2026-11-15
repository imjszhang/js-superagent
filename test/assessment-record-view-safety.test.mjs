import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssessmentRecordView, ASSESSMENT_CONTEXT_UNAVAILABLE} from '../src/runtime/assessment-records.mjs';
import {isAssessmentContextChanged} from '../src/runtime/assessment-refresh.mjs';

const row = (id, text) => ({resource:'threads', id, value:{id, text}});
const unavailable = error => error.code === ASSESSMENT_CONTEXT_UNAVAILABLE && error.failureKind === 'context' && !error.message.includes('secret');

test('assessment view exposes only host-projected references, never guessed hidden records', () => {
  const hidden = row('secret-thread', 'PRIVATE_SYNTHETIC_BODY');
  const projected = [row('visible-thread', 'Public synthetic context')];
  const view = createAssessmentRecordView(() => projected);
  assert.deepEqual(view.references, [{resource:'threads',id:'visible-thread'}]);
  assert.doesNotMatch(JSON.stringify(view.read('threads','visible-thread')), /PRIVATE_SYNTHETIC_BODY/);
  assert.throws(() => view.read(hidden.resource,hidden.id), unavailable);
  assert.throws(() => view.read('threads','nonexistent-thread'), unavailable);
});

test('record removed from the authorized projection cannot be read or accepted after a prior read', () => {
  let rows = [row('visible-thread','Synthetic restricted context')];
  const view = createAssessmentRecordView(() => rows);
  view.read('threads','visible-thread');
  rows = [];
  assert.throws(() => view.read('threads','visible-thread'), unavailable);
  assert.throws(() => view.verify(), unavailable);
});

test('pagination and final verification reject changed content under the same reference', () => {
  let rows = [row('thread','x'.repeat(12000))];
  const view = createAssessmentRecordView(() => rows);
  const first = view.read('threads','thread',{limit:200});
  const second = view.read('threads','thread',{offset:first.nextOffset,limit:200,version:first.version});
  assert.equal(second.offset,200);assert.equal(second.version,first.version);
  rows = [row('thread','y'.repeat(12000))];
  assert.throws(() => view.read('threads','thread',{offset:second.nextOffset,version:first.version}),isAssessmentContextChanged);
  assert.throws(() => view.verify(),isAssessmentContextChanged);
});

test('a changed disclosure proof invalidates an unchanged visible body', () => {
  let proof = {ticketIds:['material-one'],contentVersions:[['material-one','first']]};
  const view = createAssessmentRecordView(() => [{...row('thread','Same bounded body'),provenance:proof}]);
  view.read('threads','thread');
  proof = {ticketIds:['material-one'],contentVersions:[['material-one','second']]};
  assert.throws(() => view.verify(),isAssessmentContextChanged);
});

test('a newly available record is not silently granted to the existing evaluation', () => {
  const rows = [row('initial','Initial synthetic record')];
  const view = createAssessmentRecordView(() => rows);
  rows.push(row('later','Later record'));
  assert.deepEqual(view.references,[{resource:'threads',id:'initial'}]);
  assert.throws(() => view.read('threads','later'),unavailable);
});

test('initial projection is frozen even when a producer reuses mutable row objects', () => {
  const rows = [row('thread','Initial body')];
  const view = createAssessmentRecordView(() => rows);
  rows[0].value.text = 'Changed before the first read';
  assert.throws(() => view.read('threads','thread'),isAssessmentContextChanged);
});
