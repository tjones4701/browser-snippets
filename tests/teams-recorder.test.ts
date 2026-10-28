import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const source = readFileSync('snippets/teams-chat-recorder.js', 'utf8').replace('waitMs: 1200, pollMs: 100', 'waitMs: 2, pollMs: 1').replace('noProgressLimit: 5', 'noProgressLimit: 2');
const row = (id: string, author: string, time: string, body: string) => `<div data-testid="message-wrapper"><span data-tid="message-author-name">${author}</span><time datetime="${time}"></time><div data-tid="chat-pane-message" data-mid="${id}"><div data-message-content>${body}</div></div></div>`;
async function run(html: string, setup?: (window: any, api: any) => void) {
  const dom = new JSDOM(html, { url: 'https://teams.microsoft.com/chat/example', runScripts: 'outside-only' });
  const files = new Map<string, string>();
  const outcome: any[] = [];
  const api = { signal: { aborted: false }, log: () => {}, progress: () => {}, setOutcome: async (o: any) => outcome.push(o), saveFile: async (f: any) => { if (files.has(f.path) && !f.overwrite) throw Error('duplicate'); files.set(f.path, f.content); } };
  setup?.(dom.window, api);
  await (dom.window.eval(`(async (snippet) => { ${source}\n})`) as (api: any) => Promise<void>)(api);
  return { files, outcome };
}
describe('Teams recorder', () => {
  it('collects virtualised windows, deduplicates, orders, and reports uncertainty', async () => {
    const newer = row('2', 'Casey', '2026-01-02T00:00:00Z', 'Later');
    const older = row('1', 'Alex', '2026-01-01T00:00:00Z', 'Earlier');
    const result = await run(`<title>Test chat</title><div data-tid="message-pane-list-viewport">${newer}</div>`, (window) => {
      const viewport = window.document.querySelector('[data-tid="message-pane-list-viewport"]');
      viewport.addEventListener('scroll', () => { viewport.innerHTML = older + newer; }, { once: true });
    });
    const data = JSON.parse([...result.files.entries()].find(([p]) => p.endsWith('messages.json'))![1]);
    expect(data.messages.map((m: any) => m.id)).toEqual(['1', '2']);
    expect(data.messages[0]).toMatchObject({ author: 'Alex', body: 'Earlier' });
    expect(data.metadata.completeness).toBe('partial');
    expect(result.outcome[0].status).toBe('stopped');
    expect(result.files.size).toBe(3);
  });
  it('exports a partial capture when stopped', async () => {
    const result = await run(`<title>Test</title><div data-tid="message-pane-list-viewport">${row('1', 'A', '2026-01-01T00:00:00Z', 'Hello')}</div>`, (_window, api) => { api.signal.aborted = true; });
    expect(result.outcome[0].reason).toBe('Stopped by user');
    expect([...result.files.values()].some(v => v.includes('Hello'))).toBe(true);
  });
  it('rejects an unsupported page', async () => {
    await expect(run('<title>Empty</title>')).rejects.toThrow('No supported Teams chat');
  });
});
  it('stops during scrolling without collecting the newly rendered window', async () => {
    const result = await run(`<title>Test</title><div data-tid="message-pane-list-viewport">${row('1', 'A', '2026-01-01T00:00:00Z', 'Original')}</div>`, (window, api) => {
      const viewport = window.document.querySelector('[data-tid="message-pane-list-viewport"]');
      viewport.addEventListener('scroll', () => { viewport.innerHTML = row('2', 'B', '2026-01-02T00:00:00Z', 'New'); api.signal.aborted = true; }, { once: true });
    });
    const data = JSON.parse([...result.files.entries()].find(([p]) => p.endsWith('messages.json'))![1]);
    expect(data.messages.map((m: any) => m.id)).toEqual(['1']);
    expect(result.outcome[0].reason).toBe('Stopped by user');
  });
  it('does not mix messages when the chat changes in place', async () => {
    const result = await run(`<div data-tid="chat-header-title">First</div><div data-tid="message-pane-list-viewport">${row('1', 'A', '2026-01-01T00:00:00Z', 'First')}</div>`, (window) => {
      const viewport = window.document.querySelector('[data-tid="message-pane-list-viewport"]');
      viewport.addEventListener('scroll', () => { window.document.querySelector('[data-tid="chat-header-title"]').textContent = 'Second'; viewport.innerHTML = row('2', 'B', '2026-01-02T00:00:00Z', 'Second'); }, { once: true });
    });
    const data = JSON.parse([...result.files.entries()].find(([p]) => p.endsWith('messages.json'))![1]);
    expect(data.messages.map((m: any) => m.id)).toEqual(['1']);
    expect(result.outcome[0].reason).toBe('Chat changed during capture');
  });
  it('updates a previously captured message after deletion', async () => {
    const result = await run(`<title>Test</title><div data-tid="message-pane-list-viewport">${row('1', 'A', '2026-01-01T00:00:00Z', 'Original')}</div>`, (window) => {
      const viewport = window.document.querySelector('[data-tid="message-pane-list-viewport"]');
      viewport.addEventListener('scroll', () => { viewport.innerHTML = `<div data-testid="message-wrapper"><span data-tid="message-author-name">A</span><time datetime="2026-01-01T00:00:00Z"></time><div data-tid="chat-pane-message" data-mid="1"><span data-tid="message-deleted">Deleted</span></div></div>`; }, { once: true });
    });
    const data = JSON.parse([...result.files.entries()].find(([p]) => p.endsWith('messages.json'))![1]);
    expect(data.messages[0].body).toBeNull();
    expect(data.messages[0].indicators).toContain('Deleted');
  });
  it('records uncertain ordering and sanitizes dot-only titles', async () => {
    const result = await run(`<title>..</title><div data-tid="message-pane-list-viewport">${row('1', 'A', '', 'No date')}</div>`);
    const [path, content] = [...result.files.entries()].find(([p]) => p.endsWith('messages.json'))!;
    expect(path).toBe('chats/Teams chat/messages.json');
    expect(JSON.parse(content).metadata.ordering).toContain('chronology unknown');
  });
  it('preserves a prior checkpoint and reports a save failure', async () => {
    let calls = 0;
    const logs: string[] = [];
    let saved = '';
    await expect(run(`<title>Test</title><div data-tid="message-pane-list-viewport">${row('1', 'A', '2026-01-01T00:00:00Z', 'Original')}</div>`, (_window, api) => {
      api.log = (s: string) => logs.push(s);
      api.saveFile = async (file: any) => { calls++; if (calls === 1) saved = file.content; else throw Error('quota exceeded'); };
    })).rejects.toThrow('quota exceeded');
    expect(saved).toContain('Original');
    expect(logs.join(' ')).toContain('quota exceeded');
  });

