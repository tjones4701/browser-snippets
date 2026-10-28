import './style.css';
import type { Artifact, Reply, Run, Snippet } from './types';
import { errorText } from './types';

type ArtifactMeta = Omit<Artifact, 'content'>;
type PublicRun = Omit<Run, 'token' | 'sourceSnapshot'>;
interface Library { snippets: Snippet[]; runs: PublicRun[]; artifacts: ArtifactMeta[] }
const app = document.querySelector<HTMLDivElement>('#app')!;
const popup = document.body.classList.contains('popup');
let library: Library = { snippets: [], runs: [], artifacts: [] };
let selected = '';
let target: chrome.tabs.Tab | undefined;
let dirty = false;
let busy = false;
const escape = (text: unknown): string => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const date = (text: string): string => new Date(text).toLocaleString();
const bytes = (count: number): string => count < 1024 ? `${count} B` : `${(count / 1024).toFixed(1)} KB`;
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
async function request<T>(operation: string, data: object = {}): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage({ channel: 'ui', operation, ...data });
  if (!reply?.ok) throw new Error(reply?.error || 'Extension service is unavailable. Reload the extension.');
  return reply.value;
}
function notice(message: string, error = false): void {
  const node = el('notice');
  node.textContent = message;
  node.classList.toggle('error', error);
}

app.innerHTML = `
  <header><div class="brand"><span class="logo">{ }</span><div><h1>Browser Code Snippets</h1><p>Your code. Your page. Your outputs.</p></div></div><button id="open-library" class="quiet">Open library ↗</button></header>
  <div id="notice" role="status" aria-live="polite">Loading your library…</div>
  <div class="layout">
    <aside><div class="section-head"><h2>Snippets</h2><button id="new" class="primary small">+ New snippet</button></div><label class="search-label">Search snippets<input id="search" type="search" placeholder="Find a snippet…"></label><nav id="snippet-list" aria-label="Saved snippets"></nav><p class="aside-note">Saved locally in this browser profile.</p></aside>
    <main><section class="editor-section"><div class="section-head"><h2 id="editor-title">Snippet editor</h2><span id="saved-state" class="muted"></span></div>
      <form id="editor"><label>Name<input id="name" required maxlength="100" placeholder="Give your snippet a name"></label><label>Description<input id="description" maxlength="2000" placeholder="What does this snippet do?"></label><label>Restrict to site <span class="muted">(optional origin)</span><input id="site" type="url" placeholder="https://teams.microsoft.com"></label><label>JavaScript <span class="muted">— top-level await supported</span><textarea id="source" spellcheck="false" aria-describedby="code-help"></textarea></label><p id="code-help" class="muted">Use snippet.saveFile({ path, content }) to keep outputs. Only run code you have reviewed.</p>
      <div class="actions"><button type="submit" class="primary">Save snippet</button><button type="button" id="run">▶ Run saved snippet</button><button type="button" id="delete" class="danger quiet">Delete</button></div></form>
      <div class="target"><span class="eyebrow">TARGET PAGE</span><p id="target">Select a page using the toolbar popup.</p></div>
      <details class="api-help"><summary>Snippet API & browser setup</summary><p>Enable <strong>Allow User Scripts</strong> in this extension’s browser details page. Older browsers use Developer mode. Run requests access to the target site.</p><pre>await snippet.saveFile({
  path: 'reports/page.json',
  content: JSON.stringify({ title: document.title }, null, 2),
  mimeType: 'application/json'
});
snippet.log('Saved a report');
snippet.progress({ current: 1, message: 'Done' });
// Check snippet.signal.aborted in long loops.
// Use overwrite: true for checkpoint files.
// Text, Blob, ArrayBuffer and typed arrays supported (8 MiB/file).</pre><p>Runs continue when this popup closes. Stop is cooperative; code must yield and check its signal. Reloading the target tab interrupts the run. Downloads preserve folders under your browser’s Downloads location.</p></details>
    </section><section class="history"><div class="section-head"><h2>Runs & artifacts</h2><span id="run-count" class="muted"></span></div><div id="runs"></div></section></main>
  </div>
  <dialog id="preview"><div class="section-head"><h2 id="preview-title">Artifact</h2><button id="close-preview">Close</button></div><pre id="preview-content"></pre><button id="preview-download" class="primary">Download file</button></dialog>
`;

function renderList(): void {
  const query = el<HTMLInputElement>('search').value.toLowerCase();
  el('snippet-list').innerHTML = library.snippets.filter(snippet => `${snippet.name} ${snippet.description}`.toLowerCase().includes(query)).map(snippet => {
    const active = library.runs.some(run => run.snippetId === snippet.id && run.status === 'running');
    return `<button class="snippet-card ${snippet.id === selected ? 'selected' : ''}" data-select="${escape(snippet.id)}" ${snippet.id === selected ? 'aria-current="true"' : ''}><strong>${escape(snippet.name)}</strong><span>${escape(snippet.description || 'JavaScript snippet')}</span><small>${active ? '● Running' : `${library.artifacts.filter(artifact => library.runs.some(run => run.id === artifact.runId && run.snippetId === snippet.id)).length} artifacts`}</small></button>`;
  }).join('') || '<p class="empty">No snippets found. Create one to get started.</p>';
}
function setEditor(id: string): void {
  selected = id;
  const snippet = library.snippets.find(item => item.id === id);
  el<HTMLInputElement>('name').value = snippet?.name || '';
  el<HTMLInputElement>('description').value = snippet?.description || '';
  el<HTMLInputElement>('site').value = snippet?.site || '';
  el<HTMLTextAreaElement>('source').value = snippet?.source || `await snippet.saveFile({
  path: 'reports/page.json',
  content: JSON.stringify({ title: document.title, url: location.href }, null, 2),
  mimeType: 'application/json'
});
snippet.log('Page report saved');`;
  dirty = false;
  el('editor-title').textContent = snippet ? snippet.name : 'New code snippet';
  el('saved-state').textContent = snippet ? 'Saved' : 'Not saved';
  el<HTMLButtonElement>('run').disabled = !snippet;
  el<HTMLButtonElement>('delete').disabled = !snippet;
  renderList(); renderRuns();
}

function folders(artifacts: ArtifactMeta[], prefix = ''): string {
  const direct = artifacts.filter(artifact => !artifact.path.slice(prefix.length).includes('/'));
  const children = [...new Set(artifacts.map(artifact => artifact.path.slice(prefix.length).split('/')).filter(parts => parts.length > 1).map(parts => parts[0]))].sort();
  return children.map(name => {
    const next = `${prefix}${name}/`;
    return `<details open class="folder"><summary>▸ ${escape(name)}</summary>${folders(artifacts.filter(artifact => artifact.path.startsWith(next)), next)}</details>`;
  }).join('') + direct.sort((a, b) => a.path.localeCompare(b.path)).map(artifact => `<div class="artifact"><button class="file" data-preview="${escape(artifact.id)}" title="${escape(artifact.path)}">${escape(artifact.path.slice(prefix.length))}</button><span class="muted">${bytes(artifact.sizeBytes)}</span><button class="small" data-download="${escape(artifact.id)}" aria-label="Download ${escape(artifact.path)}">↓</button>${artifact.downloadState ? `<small>${escape(artifact.downloadState.replaceAll('_', ' '))}</small>` : ''}</div>`).join('');
}
function renderRuns(): void {
  const runs = library.runs.filter(run => run.snippetId === selected).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  el('run-count').textContent = `${runs.length} runs`;
  const container = el('runs');
  const expanded = new Set([...container.querySelectorAll<HTMLDetailsElement>('details[data-run]')].filter(detail => detail.open).map(detail => detail.dataset.run));
  container.innerHTML = runs.map((run, index) => {
    const artifacts = library.artifacts.filter(artifact => artifact.runId === run.id);
    return `<details class="run" data-run="${escape(run.id)}" ${expanded.has(run.id) || (index === 0 && !container.children.length) || run.status === 'running' ? 'open' : ''}><summary><span class="badge ${run.status}">${escape(run.status)}</span><span>${escape(date(run.startedAt))}</span><small>${artifacts.length} files</small></summary><div class="run-body"><p class="run-url">${escape(run.pageUrl)}</p>${run.progress ? `<p>${escape(run.progress.message)} <span class="muted">(${run.progress.current}${run.progress.total !== undefined ? ` / ${run.progress.total}` : ''})</span></p>` : ''}${run.reason ? `<p class="reason">${escape(run.reason)}</p>` : ''}<div class="actions">${run.status === 'running' ? `<button data-stop="${escape(run.id)}" ${run.stopRequested ? 'disabled' : ''}>${run.stopRequested ? 'Stop requested…' : 'Stop run'}</button>` : ''}${artifacts.length ? `<button class="small" data-download-run="${escape(run.id)}">Download outputs</button>` : ''}</div>${artifacts.length ? `<div class="artifact-tree">${folders(artifacts)}</div>` : '<p class="muted">No artifacts saved yet.</p>'}${run.logs.length ? `<pre class="logs">${escape(run.logs.join('\n'))}</pre>` : ''}</div></details>`;
  }).join('') || '<div class="empty"><span class="empty-icon">↳</span><h3>Outputs live here</h3><p>Run this snippet to start a history of artifacts.<br>Each run keeps its own folders and files.</p></div>';
}
async function refresh(): Promise<void> {
  library = await request<Library>('list');
  renderList(); renderRuns();
}
async function action(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try { await work(); }
  catch (error) { notice(errorText(error), true); }
  finally { busy = false; document.body.classList.remove('busy'); }
}

el('search').addEventListener('input', renderList);
el('editor').addEventListener('input', () => { dirty = true; el('saved-state').textContent = 'Unsaved changes'; });
el('editor').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    const snippet = await request<Snippet>('saveSnippet', { snippet: { id: selected, name: el<HTMLInputElement>('name').value, description: el<HTMLInputElement>('description').value, site: el<HTMLInputElement>('site').value, source: el<HTMLTextAreaElement>('source').value } });
    await refresh(); setEditor(snippet.id); notice('Snippet saved.');
  });
});
function mayDiscard(): boolean { return !dirty || confirm('Discard unsaved edits?'); }
el('new').addEventListener('click', () => { if (mayDiscard()) { setEditor(''); el<HTMLInputElement>('name').focus(); } });
el('snippet-list').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-select]');
  if (button && button.dataset.select !== selected && mayDiscard()) setEditor(button.dataset.select!);
});
el('delete').addEventListener('click', () => {
  const snippet = library.snippets.find(item => item.id === selected);
  if (!snippet || !confirm(`Delete “${snippet.name}” and ALL its runs and stored artifacts? Downloaded files will remain.`)) return;
  void action(async () => { await request('deleteSnippet', { id: selected }); await refresh(); setEditor(library.snippets[0]?.id || ''); notice('Snippet and its saved history deleted.'); });
});
el('run').addEventListener('click', () => {
  if (busy) return;
  if (dirty) { notice('Save your edits before running this snippet.', true); return; }
  if (!target?.id || !target.url || !/^https?:\/\//.test(target.url)) { notice('Open the toolbar popup on the page where you want to run the snippet.', true); return; }
  const url = new URL(target.url);
  const origin = `${url.protocol}//${url.hostname}/*`;
  // Start the permission request inside the click gesture, before any other awaited work.
  const permission = chrome.permissions.request({ origins: [origin] });
  void action(async () => {
    if (!await permission) throw new Error('Site access was not granted. No code was run.');
    const current = await chrome.tabs.get(target!.id!);
    if (!current.url || new URL(current.url).origin !== url.origin) throw new Error('The target page changed. Reopen the toolbar popup.');
    await request('run', { id: selected, tabId: target!.id });
    await refresh(); notice('Snippet started. You can close this popup while it runs.');
  });
});
el('open-library').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`library.html${target?.id ? `?tab=${target.id}` : ''}`) });
});
let previewId = '';
async function preview(id: string): Promise<void> {
  const artifact = await request<Artifact>('artifact', { id });
  previewId = id;
  el('preview-title').textContent = artifact.path;
  el('preview-content').textContent = artifact.encoding === 'utf8' ? artifact.content.slice(0, 250_000) + (artifact.content.length > 250_000 ? '\n\n[Preview truncated. Download to view the complete file.]' : '') : `Binary file (${artifact.mimeType}, ${bytes(artifact.sizeBytes)}). Download to open.`;
  el<HTMLDialogElement>('preview').showModal();
}
el('close-preview').addEventListener('click', () => el<HTMLDialogElement>('preview').close());
el('preview-download').addEventListener('click', () => { void action(async () => { await request('download', { id: previewId }); notice('Download started.'); }); });
el('runs').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('button');
  if (!button) return;
  void action(async () => {
    if (button.dataset.stop) { await request('stop', { id: button.dataset.stop }); notice('Stop requested. The snippet will stop at its next cancellation check.'); }
    if (button.dataset.preview) await preview(button.dataset.preview);
    if (button.dataset.download) { await request('download', { id: button.dataset.download }); notice('Download started.'); }
    if (button.dataset.downloadRun) {
      for (const artifact of library.artifacts.filter(item => item.runId === button.dataset.downloadRun)) await request('download', { id: artifact.id });
      notice('Output downloads started.');
    }
    await refresh();
  });
});
// Editing code should behave like a code editor when the user presses Tab.
el<HTMLTextAreaElement>('source').addEventListener('keydown', event => {
  if (event.key !== 'Tab' || event.shiftKey) return;
  event.preventDefault();
  const textarea = event.currentTarget as HTMLTextAreaElement;
  textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
});
window.addEventListener('beforeunload', event => { if (dirty && !popup) { event.preventDefault(); event.returnValue = ''; } });

async function boot(): Promise<void> {
  const tabId = Number(new URL(location.href).searchParams.get('tab'));
  if (tabId) target = await chrome.tabs.get(tabId).catch(() => undefined);
  else if (popup) [target] = await chrome.tabs.query({ active: true, currentWindow: true });
  el('target').textContent = target?.url || 'Open the toolbar popup on your target web page, then choose Open library.';
  await refresh();
  setEditor(library.snippets[0]?.id || '');
  notice('Ready. Run a saved snippet on the target page.');
  setInterval(() => { if (!busy) void refresh().catch(error => notice(errorText(error), true)); }, 2000);
}
void boot().catch(error => notice(errorText(error), true));
