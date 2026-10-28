import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { runnerSource } from '../src/runner';

async function execute(source: string) {
  const dom = new JSDOM('<title>Test page</title>', { runScripts: 'outside-only' });
  const messages: { operation: string; payload?: any; runId: string; token: string }[] = [];
  let settle!: () => void;
  const finished = new Promise<void>(resolve => { settle = resolve; });
  Object.assign(dom.window, { chrome: { runtime: { sendMessage: async (message: typeof messages[number]) => {
    messages.push(message);
    if (message.operation === 'finish') settle();
    if (message.operation === 'saveFile' && message.payload.path === 'fail.txt') return { ok: false, error: 'Quota exhausted' };
    return { ok: true, value: message.operation === 'saveFile' ? { id: 'artifact-1', path: message.payload.path } : {} };
  } } } });
  dom.window.eval(runnerSource('run-1', 'token-1', source));
  await finished;
  dom.window.close();
  return messages;
}
describe('injected runner', () => {
  it('runs async snippets, exposes helpers and flushes logs before finishing', async () => {
    const messages = await execute(`await snippet.saveFile({ path: 'report.json', content: document.title, mimeType: 'text/plain' }); snippet.log('Saved');`);
    expect(messages.map(message => message.operation)).toEqual(['hello', 'saveFile', 'log', 'finish']);
    expect(messages[1].payload.content).toBe('Test page');
    expect(messages.every(message => message.runId === 'run-1' && message.token === 'token-1')).toBe(true);
    expect(messages.at(-1)?.payload.status).toBe('completed');
  });
  it('records save errors as failed runs', async () => {
    const messages = await execute(`await snippet.saveFile({ path: 'fail.txt', content: 'data' });`);
    expect(messages.at(-1)?.payload).toMatchObject({ status: 'failed', reason: 'Quota exhausted' });
  });
  it('preserves a partial outcome supplied by the recorder', async () => {
    const messages = await execute(`await snippet.setOutcome({ status: 'stopped', reason: 'History boundary unknown' });`);
    expect(messages.at(-1)?.payload).toEqual({ status: 'stopped', reason: 'History boundary unknown' });
  });
});
