import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// Uses a disposable profile and a synthetic chat. Never opens the user's browser profile.
const output = resolve('artifacts/browser-smoke');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(resolve(output, 'profile-'));
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>Sample chat</title><h1 data-tid="chat-header-title">Sample chat</h1><div data-tid="message-pane-list-viewport" style="height:400px;overflow:auto"><div data-testid="message-wrapper"><span data-tid="message-author-name">Alex</span><time datetime="2026-10-29T00:00:00Z"></time><div data-tid="chat-pane-message" data-mid="1"><div data-message-content>Hello from the synthetic chat.</div></div></div></div>`);
});
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = process.env.E2E_BROWSER || 'chromium';
const context = await chromium.launchPersistentContext(profile, {
  ...(browser === 'edge' ? { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : { channel: 'chromium' }),
  headless: true,
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--enable-unsafe-extension-debugging'],
  acceptDownloads: true,
});
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
try {
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${id}`);
  await settings.waitForTimeout(1000);
  // These are the same switches users enable on the extension details page.
  const devMode = settings.locator('#devMode');
  if (await devMode.count() && await devMode.getAttribute('aria-pressed') !== 'true') await devMode.click();
  await writeFile(resolve(output, `${browser}-extension-settings.txt`), await settings.locator('body').innerText());
  const userScriptsToggle = settings.locator('#allow-user-scripts').locator('cr-toggle');
  if (await userScriptsToggle.count()) {
    if (await userScriptsToggle.getAttribute('aria-pressed') !== 'true') await userScriptsToggle.click();
  }
  // Obtain required optional site access through Chrome's own extension management UI API.
  await settings.evaluate(async ({ extensionId, host }) => {
    await chrome.developerPrivate.addHostPermission(extensionId, host);
  }, { extensionId: id, host: 'http://127.0.0.1/*' });
  const target = await context.newPage();
  await target.goto(url);
  const targetId = await worker.evaluate(async pageUrl => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(pageUrl))?.id, url);
  assert.ok(targetId, 'Fixture tab has an ID');
  const library = await context.newPage();
  await library.goto(`chrome-extension://${id}/library.html?tab=${targetId}`);
  await library.locator('#notice').filter({ hasText: 'Ready.' }).waitFor();
  await library.screenshot({ path: resolve(output, `${browser}-library.png`), fullPage: true });
  await library.locator('#new').click();
  await library.locator('#name').fill('Browser smoke test');
  await library.locator('#source').fill(`await snippet.saveFile({ path: 'reports/nested/page.json', content: JSON.stringify({title: document.title, unicode: '🙂'}), mimeType: 'application/json' }); snippet.log('Saved output');`);
  await library.getByRole('button', { name: 'Save snippet', exact: true }).click();
  await library.locator('#notice').filter({ hasText: 'Snippet saved.' }).waitFor();
  await library.locator('#run').click();
  await library.locator('.badge.completed').waitFor({ timeout: 20000 });
  await library.getByRole('button', { name: 'page.json', exact: true }).click();
  assert.match(await library.locator('#preview-content').innerText(), /Sample chat/);
  const downloadEvent = library.waitForEvent('download');
  await library.locator('#preview-download').click();
  const downloaded = await downloadEvent;
  await downloaded.saveAs(resolve(output, `${browser}-page.json`));
  assert.equal(await downloaded.failure(), null);
  await library.locator('#close-preview').click();
  await library.reload();
  await library.locator('#notice').filter({ hasText: 'Ready.' }).waitFor();
  await library.locator('[data-select]').filter({ hasText: 'Browser smoke test' }).click();
  await library.locator('.badge.completed').waitFor();
  assert.equal(await library.locator('.file').count(), 1, 'Artifact survives extension UI reload');
  // Run the actual starter against the synthetic Teams DOM.
  await library.locator('[data-select="teams-chat-recorder"]').click();
  await library.locator('#run').click();
  await library.locator('.badge.stopped').waitFor({ timeout: 25000 });
  assert.equal(await library.locator('.file').count(), 3, 'Recorder exports three files');
  await library.getByRole('button', { name: 'messages.json', exact: true }).click();
  assert.match(await library.locator('#preview-content').innerText(), /Hello from the synthetic chat/);
  await library.locator('#close-preview').click();
  await library.screenshot({ path: resolve(output, `${browser}-recorded.png`), fullPage: true });
  assert.deepEqual(errors, [], 'No uncaught page errors');
  console.log(`${browser}: create, save, execute, preview, download, persistence, and Teams recorder passed.`);
} finally {
  await context.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
