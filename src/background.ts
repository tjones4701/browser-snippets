import teamsSource from '../snippets/teams-chat-recorder.js?raw';
import { db, deleteSnippet, patchRun, saveArtifact } from './store';
import { downloadPath } from './paths';
import { runnerSource } from './runner';
import { errorText, type Artifact, type Run, type SaveFile, type Snippet } from './types';

const builtInId = 'teams-chat-recorder';
const init = (async () => {
  const database = await db;
  // Add the starter once. Deleting it should not cause it to reappear on every worker wake.
  const seeded = await chrome.storage.local.get('seeded');
  if (!seeded.seeded) {
    if (!await database.get('snippets', builtInId)) {
      await database.put('snippets', {
        id: builtInId, name: 'Teams Chat Recorder', description: 'Collect an open Teams web chat while loading older messages. Saves JSON, Markdown and a capture summary.',
        source: teamsSource, site: '', updatedAt: new Date().toISOString(),
      });
    }
    await chrome.storage.local.set({ seeded: true });
  }
  await chrome.alarms.create('reconcile', { periodInMinutes: 1 });
})();

async function finish(id: string, status: Run['status'], reason: string): Promise<void> {
  await patchRun(id, run => {
    if (run.status !== 'running') return;
    run.status = status;
    run.reason = reason.slice(0, 4000);
    run.finishedAt = new Date().toISOString();
    run.token = '';
  });
}

async function interruptTab(tabId: number, reason: string): Promise<void> {
  await init;
  for (const run of await (await db).getAll('runs')) {
    if (run.tabId === tabId && run.status === 'running') await finish(run.id, 'interrupted', reason);
  }
}

chrome.tabs.onRemoved.addListener(tabId => { void interruptTab(tabId, 'Target tab was closed. Latest saved artifacts are available.'); });
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === 'loading') void interruptTab(tabId, 'Target tab navigated or reloaded. Latest saved artifacts are available.');
});
chrome.runtime.onStartup.addListener(() => {
  void init.then(async () => {
    for (const run of await (await db).getAll('runs')) {
      if (run.status === 'running') await finish(run.id, 'interrupted', 'Browser restarted. Latest saved artifacts are available.');
    }
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'reconcile') return;
  void init.then(async () => {
    for (const run of await (await db).getAll('runs')) {
      if (run.status === 'running' && Date.now() - run.heartbeat > 180_000) {
        await finish(run.id, 'interrupted', 'Runner stopped responding for three minutes. Saved artifacts are available.');
      }
    }
  });
});

async function download(artifact: Artifact): Promise<number> {
  const run = await (await db).get('runs', artifact.runId);
  if (!run) throw new Error('Run not found.');
  const dataUrl = artifact.encoding === 'base64'
    ? `data:${artifact.mimeType};base64,${artifact.content}`
    : `data:${artifact.mimeType};charset=utf-8,${encodeURIComponent(artifact.content)}`;
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: downloadPath(run.snippetName, run.snippetId, run.startedAt, run.id, artifact.path),
    conflictAction: 'uniquify', saveAs: false,
  });
  const database = await db;
  const tx = database.transaction('artifacts', 'readwrite');
  const current = await tx.store.get(artifact.id);
  if (current) await tx.store.put({ ...current, downloadId, downloadState: 'in_progress' });
  await tx.done;
  // Completion may race the event listener, so also reconcile the current state.
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (item) await updateDownload(downloadId, item.state);
  return downloadId;
}

async function updateDownload(id: number, state: string): Promise<void> {
  const database = await db;
  const tx = database.transaction('artifacts', 'readwrite');
  for (const artifact of await tx.store.getAll()) {
    if (artifact.downloadId === id) await tx.store.put({ ...artifact, downloadState: state });
  }
  await tx.done;
}
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current) void updateDownload(delta.id, delta.state.current);
});

// Serialize run creation so rapid repeated clicks cannot launch overlapping jobs in one tab.
let launchQueue: Promise<unknown> = Promise.resolve();
function startRun(snippetId: string, tabId: number): Promise<Run> {
  const task = launchQueue.then(() => launch(snippetId, tabId));
  launchQueue = task.catch(() => {});
  return task;
}
async function launch(snippetId: string, tabId: number): Promise<Run> {
  const database = await db;
  const saved = await database.get('snippets', snippetId);
  if (!saved) throw new Error('Save the snippet before running it.');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//.test(tab.url)) throw new Error('Select a regular HTTP or HTTPS web page in the popup.');
  if (saved.site && new URL(tab.url).origin !== saved.site) throw new Error(`This snippet is restricted to ${saved.site}.`);
  if ((await database.getAll('runs')).some(run => run.tabId === tabId && run.status === 'running')) throw new Error('A snippet is already running on this tab.');
  try {
    if (!chrome.userScripts?.execute) throw new Error('Unsupported browser');
    await chrome.userScripts.getScripts();
    await chrome.userScripts.configureWorld({ messaging: true });
  } catch {
    throw new Error('Enable “Allow User Scripts” on this extension’s details page (or Developer mode on older browsers). Chrome/Edge 135+ with userScripts.execute is required.');
  }
  const run: Run = {
    id: crypto.randomUUID(), token: crypto.randomUUID(), snippetId, snippetName: saved.name,
    sourceSnapshot: saved.source, tabId, pageUrl: tab.url,
    startedAt: new Date().toISOString(), heartbeat: Date.now(), status: 'running', stopRequested: false, logs: [], reason: '',
  };
  await database.put('runs', run);
  try {
    const results = await chrome.userScripts.execute({ target: { tabId, frameIds: [0] }, js: [{ code: runnerSource(run.id, run.token, saved.source) }] });
    const error = results.find(result => result.error)?.error;
    if (error) throw new Error(error);
  } catch (error) {
    await finish(run.id, 'failed', errorText(error));
    throw error;
  }
  return run;
}

async function uiMessage(message: Record<string, unknown>): Promise<unknown> {
  await init;
  const database = await db;
  switch (message.operation) {
    case 'list': {
      const [snippets, runs, artifacts] = await Promise.all([database.getAll('snippets'), database.getAll('runs'), database.getAll('artifacts')]);
      return {
        snippets, runs: runs.map(({ token: _token, sourceSnapshot: _source, ...run }) => run),
        artifacts: artifacts.map(({ content: _content, ...artifact }) => artifact),
      };
    }
    case 'saveSnippet': {
      const value = message.snippet as Snippet;
      if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new Error('Enter a name of 1–100 characters.');
      if (typeof value.source !== 'string' || !value.source.trim() || value.source.length > 500_000) throw new Error('Enter JavaScript code (up to 500,000 characters).');
      const site = value.site ? new URL(value.site).origin : '';
      if (site && !/^https?:\/\//.test(site)) throw new Error('Site restriction must be an HTTP or HTTPS origin.');
      const snippet: Snippet = { id: value.id || crypto.randomUUID(), name: value.name.trim(), description: String(value.description || '').slice(0, 2000), source: value.source, site, updatedAt: new Date().toISOString() };
      await database.put('snippets', snippet);
      return snippet;
    }
    case 'deleteSnippet': return deleteSnippet(String(message.id));
    case 'run': return startRun(String(message.id), Number(message.tabId));
    case 'stop': return patchRun(String(message.id), run => { if (run.status === 'running') run.stopRequested = true; });
    case 'artifact': {
      const artifact = await database.get('artifacts', String(message.id));
      if (!artifact) throw new Error('Artifact not found.');
      return artifact;
    }
    case 'download': {
      const artifact = await database.get('artifacts', String(message.id));
      if (!artifact) throw new Error('Artifact not found.');
      return download(artifact);
    }
    default: throw new Error('Unknown extension action.');
  }
}

async function runnerMessage(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await init;
  const id = String(message.runId);
  // Bind the token to the top frame and first document that greets this run.
  await patchRun(id, run => {
    if (run.status !== 'running' || run.token !== message.token || sender.id !== chrome.runtime.id || sender.tab?.id !== run.tabId || sender.frameId !== 0 || !sender.documentId) throw new Error('Unauthorised runner request.');
    if (run.documentId && sender.documentId !== run.documentId) throw new Error('The target document changed.');
    if (!run.documentId && message.operation !== 'hello') throw new Error('Runner has not connected.');
    run.documentId = sender.documentId;
    run.heartbeat = Date.now();
  });
  const payload = message.payload;
  switch (message.operation) {
    case 'hello': return null;
    case 'heartbeat': return { stopRequested: (await (await db).get('runs', id))?.stopRequested };
    case 'saveFile': {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid save payload.');
      const { content: _content, ...record } = await saveArtifact(id, payload as SaveFile);
      return record;
    }
    case 'log': return patchRun(id, run => { run.logs = [...run.logs, String(payload).slice(0, 4000)].slice(-200); });
    case 'progress': {
      const progress = payload as Run['progress'];
      if (!progress || !Number.isFinite(progress.current) || (progress.total !== undefined && !Number.isFinite(progress.total))) throw new Error('Invalid progress.');
      return patchRun(id, run => { run.progress = { current: progress.current, total: progress.total, message: String(progress.message || '').slice(0, 500) }; });
    }
    case 'download': {
      const artifact = await (await db).get('artifacts', String((payload as { id: string })?.id));
      if (!artifact || artifact.runId !== id) throw new Error('Artifact does not belong to this run.');
      return download(artifact);
    }
    case 'finish': {
      const result = payload as { status: Run['status']; reason: string };
      if (!result || !['completed', 'stopped', 'failed'].includes(result.status)) throw new Error('Invalid run outcome.');
      return finish(id, result.status, String(result.reason || ''));
    }
    default: throw new Error('Unknown runner action.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || message.channel !== 'ui') return;
  // Only our own extension pages may manage snippets or browse artifacts.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || sender.tab?.url?.startsWith('http')) {
    respond({ ok: false, error: 'Extension page required.' }); return;
  }
  void uiMessage(message).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: errorText(error) }));
  return true;
});
chrome.runtime.onUserScriptMessage.addListener((message, sender, respond) => {
  if (!message || message.channel !== 'runner') return;
  void runnerMessage(message, sender).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: errorText(error) }));
  return true;
});
