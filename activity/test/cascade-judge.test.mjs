import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeSafety } from '../judge.ts';

const model = { type: 'classifier', provider: 'fixture', id: 'decision', contextWindow: 32_768 };
const summary = '# User Message Summary\n## Context\nFixture\n## Intent\nCheck the draft\n## Allowed\nOpen locally\n## Forbidden\nNo publication\n## Guardrails\nKeep the archive';

function fixture({ cap, extraSummary = '', mutate, viaHttp = false, summarize, signal = new AbortController().signal,
  fallbackJudge, summaryRef, fallbackSummaryModel, summaryThinking, auto = true, earlier = true,
  guidance = 'Earlier guidance: keep the archive.' } = {}) {
  const action = { path: 'draft.md', content: 'Complete fixture action' };
  const calls = [], judges = [], summaries = [];
  const fallback = { ...model, id: 'fallback-decision' };
  let answers = [];
  let summaryWorks = true;
  const entries = [...(earlier ? ['Earlier request: no publication.'] : []), 'Latest request: check the draft.'];
  const ctx = {
    model: { provider: 'fixture', id: 'chat' },
    sessionManager: { getBranch: () => entries.map((content, i) => ({ type: 'message', id: `msg-${i}`, message: { role: 'user', content } })) },
    getSystemPrompt: () => guidance,
    modelRegistry: {
      find: (provider, id) => ({ provider, id, contextWindow: 32_768 }),
      findOfType: (type, provider, id) => type === 'classifier' && [model, fallback].find(m => m.provider === provider && m.id === id),
      getAll: () => [{ provider: 'fixture', id: 'chat', contextWindow: 32_768 }],
      classify: async (selected, request, options) => {
        calls.push(request.state.evidence);
        judges.push(selected.id);
        options.onPayload?.({});
        assert.equal(options.timeoutMs, undefined);
        const answer = answers.shift();
        if (typeof answer === 'function') return answer(options);
        if (answer instanceof Error) throw answer;
        const [choice, confidence] = answer;
        if (viaHttp) {
          const response = await options.fetch('https://fixture.invalid/systemone');
          if (!response.ok) return { stopReason: 'error', errorMessage: 'Synthetic provider failure' };
          options.onResponse?.(response);
        }
        return { stopReason: 'stop', answers: { verdict: { type: 'choice', choice, confidence } } };
      },
    },
  };
  const complete = async (selected, prompt, options) => {
    assert.match(prompt.systemPrompt, /at most 500 words/);
    assert.equal(options.maxTokens, 1500);
    assert.equal(options.timeoutMs, undefined);
    assert.equal(options.maxRetries, 0);
    summaries.push({ model: `${selected.provider}/${selected.id}`, thinking: options.reasoning, input: prompt.messages[0].content[0].text });
    mutate?.(action);
    return summarize ? summarize(selected, options) :
      { stopReason: 'stop', content: [{ type: 'text', text: summaryWorks ? summary + extraSummary : 'Invalid summary' }] };
  };
  const run = (...decisions) => {
    answers = decisions;
    return judgeSafety(ctx, 'fixture/decision', 'write', action, '/fixture',
      { auto, readOnly: !auto, remoteReadOnly: false }, signal, undefined, undefined, complete,
      fallbackJudge, undefined, summaryRef, undefined,
      { judgeMode: 'cascade', judgeBackend: 'classifier', judgeMaxChars: cap, fallbackSummaryModel, summaryThinking });
  };
  return { calls, judges, summaries, entries, run, failSummary: () => { summaryWorks = false; },
    changeGuidance: () => { guidance = 'Updated guidance: keep the archive.'; } };
}

test('cascade allows at exactly 60% when authority evidence is complete or only guards apply', async () => {
  for (const options of [{ earlier: false, guidance: '' }, { auto: false }]) {
    const f = fixture(options);
    const result = await f.run(['allow', .6]);
    assert.equal(result.decision, 'allow', result.reason);
    assert.equal(result.metrics.quickConfidence, .6);
    assert.equal(f.calls.length, 1);
    assert.equal(f.summaries.length, 0);
    assert.match(f.calls[0], /Latest request[\s\S]*Complete fixture action/);
    assert.doesNotMatch(f.calls[0], /Earlier request|Earlier guidance/);
  }
});

test('either omitted authority source escalates a high-confidence cascade allow', async () => {
  for (const [options, source] of [[{ guidance: '' }, /Earlier request/], [{ earlier: false }, /Earlier guidance/]]) {
    const f = fixture(options);
    const result = await f.run(['allow', .99], ['block', .9]);
    assert.equal(result.decision, 'block', result.reason);
    assert.equal(result.metrics.escalated, true);
    assert.equal(f.calls.length, 2);
    assert.doesNotMatch(f.calls[0], source);
    assert.match(f.summaries[0].input, source);
  }
});

test('cascade escalates low allows and blocks; exact summary cache follows history and guidance', async () => {
  const f = fixture();
  const first = await f.run(['allow', .59], ['block', .3]);
  assert.equal(first.decision, 'block', first.reason);
  assert.equal(first.metrics.escalated, true);
  assert.equal(first.metrics.providerDispatches, 2);
  assert.equal(first.metrics.attempts, 2);
  assert.equal(first.metrics.summary.status, 'generated');
  assert.equal(f.summaries[0].model, 'fixture/chat');
  assert.equal(f.summaries[0].thinking, 'low');
  assert.match(f.summaries[0].input, /Earlier guidance[\s\S]*Earlier request/);
  assert.doesNotMatch(f.summaries[0].input, /Latest request|Complete fixture action/);
  assert.match(f.calls[1], /No publication[\s\S]*Latest request[\s\S]*Complete fixture action/);
  const second = await f.run(['block', .99], ['allow', .2]);
  assert.equal(second.decision, 'allow', second.reason);
  assert.equal(second.metrics.summary.status, 'cached');
  assert.equal(f.summaries.length, 1);
  f.entries.push('New request: keep it local.');
  assert.equal((await f.run(['block', .7], ['block', .9])).metrics.summary.status, 'generated');
  f.changeGuidance();
  assert.equal((await f.run(['block', .7], ['block', .9])).metrics.summary.status, 'generated');
  assert.equal(f.summaries.length, 3);
});

test('failed summary uses the original context, within the same cap', async () => {
  const f = fixture();
  f.failSummary();
  const result = await f.run(['allow', .59], ['block', .9]);
  assert.equal(result.decision, 'block');
  assert.equal(result.metrics.summary.status, 'failed');
  assert.match(f.calls[1], /Earlier guidance/);
  assert.match(f.calls[1], /Earlier request[\s\S]*Latest request/);
  assert.doesNotMatch(f.calls[1], /Invalid summary/);
});

test('cascade keeps its action snapshot and vetoes an auto allow when the summary is cut to fit', async () => {
  const f = fixture({ cap: 2400, extraSummary: ' extra detail'.repeat(300), mutate: action => { action.content = 'Changed mid-review'; } });
  const result = await f.run(['allow', .8], ['allow', .8]);
  assert.equal(result.decision, 'block', result.reason);
  assert.match(result.reason, /incomplete instruction or human context/);
  assert.equal(result.metrics.attempts, 2);
  assert.match(f.calls[1], /Summary truncated/);
  assert.match(f.calls[1], /Complete fixture action/);
  assert.doesNotMatch(f.calls[1], /Changed mid-review/);
  assert.ok(result.metrics.promptChars <= 2400);
});

test('cascade waits for a slow summary and retries its transient failures', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  let calls = 0;
  const f = fixture({ summarize: async (selected, options) => {
    if (++calls === 1) {
      options.onResponse({ status: 429, headers: { 'Retry-After': '2' } }, selected);
      return { stopReason: 'error', content: [], errorMessage: 'Try later' };
    }
    await new Promise(resolve => setTimeout(resolve, 40_000));
    return { stopReason: 'stop', content: [{ type: 'text', text: summary }] };
  } });
  const pending = f.run(['block', .9], ['allow', .8]);
  await flush();
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(39_999);
  await flush();
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.allow, true, result.reason);
  assert.equal(result.metrics.summary.providerRequests, 2);
});

test('both decision passes share five retries', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const timeout = () => Object.assign(new Error('transport timed out'), { name: 'TimeoutError' });
  const f = fixture();
  const pending = f.run(timeout(), timeout(), timeout(), timeout(), ['block', .9], timeout(), timeout(), ['allow', .9]);
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 100; j++) await Promise.resolve();
    t.mock.timers.tick(2_000);
  }
  const result = await pending;
  assert.equal(result.allow, false);
  assert.equal(result.metrics.attempts, 7, 'two initial attempts plus five retries');
  assert.equal(result.metrics.retries, 5);
  assert.equal(f.calls.length, 7, 'a later allow was never requested');
});

test('failed second review preserves a quick block without switching reviewers', async () => {
  const f = fixture({ fallbackJudge: 'fixture/fallback-decision' });
  const result = await f.run(['block', .9], new SyntaxError('malformed response'), ['allow', .9]);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /second review failed/);
  assert.equal(result.metrics.attempts, 2);
  assert.deepEqual(f.judges, ['decision', 'decision']);
});

test('decision fallback gets a first call but no extra retries after both passes exhaust the budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const timeout = () => Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' });
  const f = fixture({ fallbackJudge: 'fixture/fallback-decision' });
  const pending = f.run(timeout(), timeout(), timeout(), timeout(), ['allow', .2], timeout(), timeout(), timeout(), ['allow', .9]);
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 100; j++) await Promise.resolve();
    t.mock.timers.tick(2_000);
  }
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.metrics.fallbackUsed, true);
  assert.equal(result.metrics.attempts, 8);
  assert.equal(result.metrics.retries, 5);
  assert.deepEqual(f.judges, [...Array(7).fill('decision'), 'fallback-decision']);
});

test('cascade tries configured summary models before the current chat model and aggregates usage', async () => {
  const f = fixture({ summaryRef: 'fixture/primary-summary', fallbackSummaryModel: 'fixture/backup-summary', summaryThinking: 'high',
    summarize: async (selected, options) => {
      const usage = { input: 10, output: 5, totalTokens: 15, cost: { total: .01 } };
      if (selected.id === 'backup-summary') {
        options.onResponse({ status: 401 }, selected);
        return { stopReason: 'error', errorMessage: 'Synthetic unauthorized response', content: [], usage };
      }
      return { stopReason: 'stop', content: [{ type: 'text', text: selected.id === 'chat' ? summary : 'Malformed' }], usage };
    } });
  const result = await f.run(['allow', .59], ['allow', .9]);
  assert.equal(result.allow, true, result.reason);
  assert.deepEqual(f.summaries.map(s => [s.model, s.thinking]), [
    ['fixture/primary-summary', 'high'], ['fixture/backup-summary', 'high'], ['fixture/chat', 'low'],
  ]);
  assert.equal(result.metrics.summary.providerRequests, 3);
  assert.equal(result.metrics.summary.totalTokens, 45);
  assert.equal(result.metrics.summary.costTotalUsd, .03);
  assert.equal(result.metrics.summary.model, 'chat');
  assert.match(f.calls[1], /No publication/);
  assert.doesNotMatch(f.calls[1], /Earlier request/);
});

test('cascade uses implicit current model at low and does not repeat duplicate summary refs or aliases', async () => {
  for (const options of [
    { fallbackSummaryModel: 'chat', summaryThinking: 'high', thinking: 'low' },
    { summaryRef: 'fixture/chat', fallbackSummaryModel: 'fixture/chat', summaryThinking: 'high', thinking: 'high' },
  ]) {
    const f = fixture(options);
    f.failSummary();
    const result = await f.run(['allow', .59], ['block', .9]);
    assert.equal(result.decision, 'block');
    assert.deepEqual(f.summaries.map(s => [s.model, s.thinking]), [['fixture/chat', options.thinking]]);
    assert.equal(result.metrics.summary.status, 'failed');
    assert.match(f.calls[1], /Earlier guidance/);
    assert.match(f.calls[1], /Earlier request[\s\S]*Latest request/);
  }
});

test('cancelling summary work stops the cascade without trying a backup or dispatching the second judge pass', async () => {
  const cancel = new AbortController();
  const f = fixture({ signal: cancel.signal, summaryRef: 'fixture/primary-summary', fallbackSummaryModel: 'fixture/backup-summary',
    summarize: async () => { cancel.abort(); return new Promise(() => {}); } });
  const result = await f.run(['block', .9], ['allow', .9]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /cancelled/);
  assert.deepEqual(f.judges, ['decision']);
  assert.deepEqual(f.summaries.map(s => s.model), ['fixture/primary-summary']);
  assert.equal(result.metrics.summary.providerRequests, 1);
  assert.equal(result.metrics.summary.costTotalUsd, undefined);
});

test('provider AbortError after a summary HTTP failure stops all further calls and preserves a quick block', async () => {
  for (const quick of ['block', 'allow']) {
    const f = fixture({ summaryRef: 'fixture/primary-summary', fallbackSummaryModel: 'fixture/backup-summary',
      fallbackJudge: 'fixture/fallback-decision',
      summarize: async (selected, options) => {
        options.onResponse({ status: 503 }, selected);
        throw new DOMException('synthetic summary abort', 'AbortError');
      } });
    const result = await f.run([quick, .9], ['allow', .9]);
    if (quick === 'block') assert.equal(result.decision, 'block');
    else assert.equal(result.technicalStop, 'invalid-review');
    assert.match(result.reason, /cancelled: synthetic summary abort/);
    assert.equal(result.metrics.summary.status, 'failed');
    assert.equal(result.metrics.summary.providerRequests, 1);
    assert.deepEqual(f.judges, ['decision']);
    assert.deepEqual(f.summaries.map(s => s.model), ['fixture/primary-summary']);
  }
});

test('classifier AbortError after HTTP failure never retries, switches or starts another pass', async () => {
  const abort = options => {
    options.onResponse(new Response(null, { status: 503 }));
    throw new DOMException('synthetic judge abort', 'AbortError');
  };
  const f = fixture({ fallbackJudge: 'fixture/fallback-decision' });
  const result = await f.run(abort, ['allow', .9]);
  assert.equal(result.technicalStop, 'invalid-review');
  assert.match(result.reason, /cancelled: synthetic judge abort/);
  assert.equal(result.metrics.retries, 0);
  assert.deepEqual(f.judges, ['decision']);
  assert.equal(f.summaries.length, 0);

  const blocked = await f.run(['block', .9], abort, ['allow', .9]);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /cancelled: synthetic judge abort/);
  assert.equal(blocked.metrics.retries, 0);
  assert.deepEqual(f.judges, ['decision', 'decision', 'decision']);
});

test('classifier retries a transport timeout before receiving headers', async () => {
  const f = fixture({ earlier: false, guidance: '' });
  const result = await f.run(Object.assign(new Error('transport timed out'), { name: 'TimeoutError' }), ['allow', .9]);
  assert.equal(result.allow, true, result.reason);
  assert.equal(result.metrics.retries, 1);
});

test('classifier counts and retries a 503 even without the response hook', async () => {
  const f = fixture({ viaHttp: true, earlier: false, guidance: '' });
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(null, { status: ++calls === 1 ? 503 : 200 });
  try {
    const result = await f.run(['block', .8], ['allow', .8]);
    assert.equal(result.decision, 'allow', result.reason);
    assert.equal(result.metrics.providerRequests, 2);
    assert.equal(result.metrics.providerDispatches, 2);
    assert.equal(result.metrics.retries, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});
