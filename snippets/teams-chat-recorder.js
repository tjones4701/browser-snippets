// Teams Chat Recorder. Adjust these limits before pasting into the snippet editor.
const CONFIG = { waitMs: 1200, pollMs: 100, maxIterations: 500, maxDurationMs: 900000, noProgressLimit: 5, checkpointEvery: 5 };
const viewportSelector = '[data-tid="message-pane-list-viewport"]';
const messageSelector = '[data-tid="chat-pane-message"][data-mid]';
const startedAt = new Date().toISOString();
const initialUrl = location.href;
const viewport = document.querySelector(viewportSelector);
if (!viewport || !viewport.querySelector(messageSelector)) throw new Error('No supported Teams chat messages found. Open a chat and wait for messages to load before running this snippet.');
const titleNode = document.querySelector('[data-tid="chat-header-title"], [data-tid="chat-title"]');
const title = titleNode?.textContent?.trim() || document.title || 'Teams chat';
const initialTitle = titleNode?.textContent?.trim() || null;
const folder = (title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'Teams chat');
const base = `chats/${folder}`;
const messages = new Map();
const errors = [];
const limitations = ['Only rendered messages are captured; Teams may omit history or message variants.', 'Threaded replies, rich cards, reactions and attachment contents are not fully supported.', 'History completeness cannot be established from the available Teams layout.'];
let reason = 'Capture in progress';
let iterations = 0;
let noProgress = 0;
const savedPaths = new Set();
let stopped = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => value?.trim() || null;
function collect() {
  for (const node of viewport.querySelectorAll(messageSelector)) {
    const id = node.getAttribute('data-mid');
    if (!id) continue;
    const wrapper = node.closest('[data-testid="message-wrapper"]') || node.closest('[data-tid="chat-pane-item"]') || node.parentElement;
    const content = node.querySelector('[data-message-content]');
    const time = wrapper?.querySelector('time[datetime]');
    const author = wrapper?.querySelector('[data-tid="message-author-name"]');
    const links = [...node.querySelectorAll('a[href]')].map(a => ({ text: clean(a.textContent), url: a.href }));
    const indicators = [...(wrapper || node).querySelectorAll('[id^="edited-"], [data-tid*="deleted"], [data-tid*="edited"]')].map(el => clean(el.textContent) || clean(el.getAttribute('aria-label'))).filter(Boolean);
    const record = { id, author: clean(author?.textContent), timestamp: time?.getAttribute('datetime') || null, body: clean(content?.innerText || content?.textContent), links, indicators };
    const old = messages.get(id);
    if (!old) messages.set(id, record);
    else messages.set(id, { ...old, ...record, author: record.author || old.author, timestamp: record.timestamp || old.timestamp, body: record.body, links: record.links, indicators: record.indicators });
  }
}
function ordered() {
  // Missing or invalid times make a global chronological order unknowable.
  const list = [...messages.values()];
  if (list.every(m => m.timestamp && Number.isFinite(Date.parse(m.timestamp)))) {
    return list.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }
  return list;
}
async function checkpoint() {
  const list = ordered();
  const dates = list.map(m => m.timestamp).filter(x => x && Number.isFinite(Date.parse(x))).sort((a, b) => Date.parse(a) - Date.parse(b));
  const summary = { chat: { title, url: initialUrl }, startedAt, capturedAt: new Date().toISOString(), messageCount: list.length, ordering: list.every(m => m.timestamp && Number.isFinite(Date.parse(m.timestamp))) ? 'chronological by timestamp' : 'discovery order; chronology unknown because timestamps are missing or invalid', observedDateRange: { earliest: dates[0] || null, latest: dates.at(-1) || null }, stopReason: reason, completeness: 'partial', limitations, errors, iterations };
  const markdown = [`# ${title.replace(/[\r\n]+/g, ' ')}`, '', `Capture status: ${reason}`, `Ordering: ${summary.ordering}`, '', ...list.flatMap(m => [`## ${m.timestamp || 'Time unavailable'} — ${m.author || 'Author unavailable'}`, '', m.body || '[Message content unavailable]', '', ...m.links.map(link => `- Link: ${link.text || link.url} (${link.url})`), ...(m.indicators.length ? [`- Indicators: ${m.indicators.join(', ')}`] : []), ''])].join('\n');
  for (const [name, content, mimeType] of [['messages.json', JSON.stringify({ metadata: summary, messages: list }, null, 2), 'application/json'], ['transcript.md', markdown, 'text/markdown'], ['capture-summary.json', JSON.stringify(summary, null, 2), 'application/json']]) {
    const path = `${base}/${name}`;
    await snippet.saveFile({ path, content, mimeType, overwrite: savedPaths.has(path) });
    savedPaths.add(path);
  }
}
function chatChanged() {
  return location.href !== initialUrl || !viewport.isConnected || document.querySelector(viewportSelector) !== viewport || (initialTitle !== null && clean(document.querySelector('[data-tid="chat-header-title"], [data-tid="chat-title"]')?.textContent) !== initialTitle);
}
try {
  collect();
  await checkpoint();
  while (true) {
    if (snippet.signal.aborted) { reason = 'Stopped by user'; stopped = true; break; }
    if (chatChanged()) { reason = 'Chat changed during capture'; stopped = true; break; }
    if (iterations >= CONFIG.maxIterations || Date.now() - Date.parse(startedAt) >= CONFIG.maxDurationMs) { reason = 'Capture limit reached'; stopped = true; break; }
    const before = messages.size;
    viewport.scrollTop = Math.max(0, viewport.scrollTop - Math.max(viewport.clientHeight * 0.8, 300));
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    iterations++;
    // Re-read throughout the wait: virtualised rows can disappear before the next iteration.
    for (let elapsed = 0; elapsed < CONFIG.waitMs; elapsed += CONFIG.pollMs) {
      await pause(Math.min(CONFIG.pollMs, CONFIG.waitMs - elapsed));
      if (snippet.signal.aborted || chatChanged()) break;
      collect();
    }
    if (snippet.signal.aborted) { reason = 'Stopped by user'; stopped = true; break; }
    if (chatChanged()) { reason = 'Chat changed during capture'; stopped = true; break; }
    noProgress = messages.size === before ? noProgress + 1 : 0;
    snippet.progress({ current: messages.size, message: `Collected ${messages.size} messages; scrolling through history` });
    if (iterations % CONFIG.checkpointEvery === 0) await checkpoint();
    if (noProgress >= CONFIG.noProgressLimit) { reason = 'No additional messages loaded; the beginning of history could not be confirmed'; stopped = true; break; }
  }
  await checkpoint();
  snippet.log(`Saved ${messages.size} messages. ${reason}`);
  if (stopped && typeof snippet.setOutcome === 'function') await snippet.setOutcome({ status: 'stopped', reason });
} catch (error) {
  errors.push(String(error?.message || error));
  reason = 'Capture failed: ' + errors[errors.length - 1];
  try { await checkpoint(); } catch (saveError) { snippet.log('Could not save final checkpoint: ' + String(saveError?.message || saveError)); }
  throw error;
}

