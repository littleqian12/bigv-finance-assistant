import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(DOCS, 'data');

async function json(name) {
  return JSON.parse(await readFile(path.join(DATA, name), 'utf8'));
}

const dashboard = await json('dashboard.json');
const commandCenter = await json('command-center.json');
const daily = await json('daily-reviews.json');
const nextDay = await json('next-day-reviews.json');
const history = await json('history-archive.json');
const inspirations = await json('history-inspirations.json');
const logic = await json('logic-history.json');
const kronos = await json('kronos-jobs.json');

if (!dashboard.source?.name?.includes('雪球用户 xxxx')) throw new Error('dashboard source not masked');
if (!dashboard.data_freshness?.read_at?.startsWith('2026-11-15')) throw new Error('snapshot read_at missing');
if (!commandCenter.command_center?.daily_interview) throw new Error('command center daily interview missing');
if (!daily.report?.markdown) throw new Error('daily review report missing');
if ((daily.reports || []).length < 50) throw new Error('daily review list too small');
if (!nextDay.report?.markdown) throw new Error('next-day report missing');
if ((history.items || []).length < 400) throw new Error('history snapshot too small');
if ((inspirations.items || []).length < 50) throw new Error('inspiration snapshot too small');
if (!logic.rows?.length) throw new Error('logic history missing');
if (!kronos.jobs?.length) throw new Error('kronos jobs missing');

const html = await readFile(path.join(DOCS, 'index.html'), 'utf8');
if (!html.includes('雪球用户 xxxx')) throw new Error('masked source missing');
if (!html.includes('2026/11/15 22:45')) throw new Error('snapshot label missing');
if (!html.includes('assets/static-api.js')) throw new Error('static API shim missing');
if (/xueqiu\.com\/(?:u\/)?\d{6,}/.test(html)) throw new Error('xueqiu account path leaked');
if (/雪球用户\s*\d{6,}/.test(html)) throw new Error('xueqiu account label leaked');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  }));
  return nested.flat();
}

for (const file of await walk(DOCS)) {
  if (!/\.(html|js|mjs|css|json|svg|md|txt)$/.test(file)) continue;
  const source = await readFile(file, 'utf8');
  if (source.includes('/Users/jingqian')) throw new Error(`absolute user path leaked in ${path.relative(ROOT, file)}`);
  if (/xueqiu\.com\/(?:u\/)?\d{6,}/.test(source)) throw new Error(`xueqiu account path leaked in ${path.relative(ROOT, file)}`);
  if (/雪球用户\s*\d{6,}/.test(source)) throw new Error(`xueqiu account label leaked in ${path.relative(ROOT, file)}`);
}

console.log(JSON.stringify({
  dailyReports: (daily.reports || []).length,
  nextDayReports: (nextDay.reports || []).length,
  historyItems: (history.items || []).length,
  inspirationItems: (inspirations.items || []).length,
  logicRows: (logic.rows || []).length,
  kronosJobs: (kronos.jobs || []).length,
  snapshot: dashboard.data_freshness.read_at,
  masked: true
}, null, 2));
