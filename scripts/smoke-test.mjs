import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9226);
const BASE = process.env.DEMO_URL || 'http://127.0.0.1:8021/';
const PROFILE = '/tmp/xmj-command-center-cdp';

rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-allow-origins=*', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, 'about:blank'
], { stdio: 'ignore' });

async function waitForUrl(url, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let socket;
try {
  await waitForUrl(`http://127.0.0.1:${PORT}/json/version`);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('No page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'exception');
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result.value;
  }
  async function waitFor(expression, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return true; } catch {}
      await sleep(300);
    }
    return false;
  }
  async function click(selector) {
    return evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  }
  async function textLength(selector) {
    return evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.length || 0`);
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(2500);
  await waitFor("document.getElementById('generated-at')?.textContent.includes('2026/11/15')", 20000);
  await waitFor("document.querySelectorAll('#daily-review-picker option').length > 1", 20000);
  await waitFor("document.getElementById('daily-review-body')?.textContent.length > 500", 20000);

  const checks = {};
  const initial = await evaluate(`({
    title: document.title,
    banner: document.querySelector('.demo-banner')?.innerText || '',
    generated: document.getElementById('generated-at')?.textContent || '',
    status: document.getElementById('dashboard-load-status')?.textContent || '',
    daily: document.getElementById('daily-review-body')?.textContent.length || 0,
    dailyOptions: document.querySelectorAll('#daily-review-picker option').length,
    warningHidden: document.getElementById('coverage-warning')?.hidden !== false,
    leak: /xueqiu\\.com\\/(?:u\\/)?\\d{6,}/.test(document.body.innerHTML) || /雪球用户\\s*\\d{6,}/.test(document.body.innerText)
  })`);
  checks.title = initial.title.includes('静态演示');
  checks.banner = initial.banner.includes('雪球用户 xxxx') && initial.banner.includes('2026/11/15 22:45');
  checks.generated = initial.generated.includes('2026/11/15 22:45') && initial.generated.includes('雪球用户 xxxx');
  checks.status = initial.status.includes('2026/11/15 22:46');
  checks.daily = initial.daily > 500 && initial.dailyOptions > 50;
  checks.warning = initial.warningHidden;
  checks.noLeak = initial.leak === false;

  await click('#route-next-day');
  checks.nextDay = await waitFor("document.getElementById('next-day-review-body')?.textContent.length > 200", 15000);
  await click('#route-diagnostics');
  checks.diagnostics = await waitFor("document.getElementById('capture-diagnostics-body')?.textContent.length > 50", 15000);
  await click('#route-kronos');
  checks.kronos = await waitFor("document.querySelectorAll('#kronos-jobs button').length > 0", 15000);
  await click('#route-logic');
  checks.logic = await waitFor("document.getElementById('logic-history-list')?.textContent.length > 100", 15000);
  await click('#route-inspirations');
  checks.inspirations = await waitFor("document.getElementById('inspiration-list')?.textContent.length > 100", 15000);
  await click('#route-rag');
  checks.rag = await waitFor("document.getElementById('rag-optimization')?.textContent.length > 100", 15000);
  await click('#route-operations');
  checks.operations = await waitFor("document.getElementById('operations')?.textContent.length > 20", 15000);

  await click('#dashboard-tab-authors');
  checks.authors = await waitFor("document.getElementById('author-agents')?.textContent.length > 100", 15000);
  await click('#dashboard-tab-hermes');
  checks.hermes = await waitFor("document.querySelectorAll('#hermes-skills-list button').length > 0", 15000);
  await click('#dashboard-tab-foundation');
  checks.foundation = await waitFor("document.getElementById('agent-activity')?.textContent.length > 50", 15000);

  const lengths = {
    nextDay: await textLength('#next-day-review-body'),
    diagnostics: await textLength('#capture-diagnostics-body'),
    kronos: await textLength('#kronos-jobs'),
    logic: await textLength('#logic-history-list'),
    inspirations: await textLength('#inspiration-list'),
    rag: await textLength('#rag-optimization'),
    operations: await textLength('#operations'),
    authors: await textLength('#author-agents'),
    hermes: await textLength('#hermes-skills-list'),
    foundation: await textLength('#agent-activity')
  };

  const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
  console.log(JSON.stringify({ checks, failures: failed, exceptions, lengths, initial }, null, 2));
  if (failed.length) throw new Error(`Smoke checks failed: ${failed.join(', ')}`);
  await send('Browser.close').catch(() => {});
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
}
