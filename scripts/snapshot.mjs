import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'data');
const BASE = process.env.SNAPSHOT_BASE || 'http://127.0.0.1:8788';
const READ_AT = '2026-11-15T14:45:00.000Z';
const GENERATED_AT = '2026-11-15T14:46:00.000Z';

function maskString(value) {
  return String(value ?? '')
    .replaceAll('/Users/jingqian', '/Users/xxxx')
    .replace(/https:\/\/xueqiu\.com\/u\/\d+/g, 'https://xueqiu.com/u/xxxx')
    .replace(/https:\/\/xueqiu\.com\/\d+\//g, 'https://xueqiu.com/xxxx/')
    .replace(/xueqiu-\d+/g, 'xueqiu-xxxx')
    .replace(/\b\d{10}\b/g, 'xxxx');
}

function deepMask(value) {
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(deepMask);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepMask(item)]));
  }
  return value;
}

function capArrays(value, max = 10) {
  if (Array.isArray(value)) return value.slice(0, max).map((item) => capArrays(item, max));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capArrays(item, max)]));
  }
  return value;
}

async function getJson(pathname) {
  const response = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}`);
  return response.json();
}

async function getBuffer(pathname) {
  const response = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function writeJson(name, value) {
  const file = path.join(OUT, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(deepMask(value)));
}

async function writeRaw(name, buffer) {
  const file = path.join(OUT, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const dashboard = capArrays(await getJson('/api/dashboard'), 6);
  dashboard.generated_at = GENERATED_AT;
  if (dashboard.data_freshness) {
    dashboard.data_freshness.read_at = READ_AT;
    if (dashboard.data_freshness.archive) {
      dashboard.data_freshness.archive.possible_gap = false;
      dashboard.data_freshness.archive.last_success_at = READ_AT;
    }
    if (dashboard.data_freshness.calculations) dashboard.data_freshness.calculations.candidate_snapshot_at = READ_AT;
    if (dashboard.data_freshness.browser_identity) dashboard.data_freshness.browser_identity.status = 'available';
  }
  await writeJson('dashboard.json', dashboard);

  const commandCenter = await getJson('/api/command-center');
  commandCenter.generated_at = GENERATED_AT;
  await writeJson('command-center.json', commandCenter);

  const dailyIndex = await getJson('/api/daily-reviews');
  dailyIndex.today = '2026-11-15';
  dailyIndex.selectedDate = '2026-11-11';
  dailyIndex.available = true;
  const latestDaily = await getJson('/api/daily-reviews?date=2026-11-11');
  dailyIndex.report = latestDaily.report;
  await writeJson('daily-reviews.json', dailyIndex);
  for (const report of dailyIndex.reports || []) {
    const data = await getJson(`/api/daily-reviews?date=${encodeURIComponent(report.date)}`);
    await writeJson(`daily-review/${report.date}.json`, { report: data.report });
  }

  const nextDay = await getJson('/api/next-day-reviews');
  await writeJson('next-day-reviews.json', nextDay);
  for (const report of nextDay.reports || []) {
    const [mode, date, format] = String(report.key).split(':');
    const query = new URLSearchParams({ date, mode, format: format || 'daily_framework' });
    const data = await getJson(`/api/next-day-reviews?${query}`);
    await writeJson(`next-day/${String(report.key).replaceAll(':', '_')}.json`, data);
  }

  await writeJson('logic-history.json', await getJson('/api/logic-history'));
  await writeJson('buy-verification.json', await getJson('/api/buy-verification'));
  await writeJson('capture-diagnostics.json', await getJson('/api/capture-diagnostics'));
  await writeJson('rag-eval-queue.json', await getJson('/api/rag/eval/review-queue?status=pending&limit=1'));

  const skills = await getJson('/api/hermes/skills');
  await writeJson('hermes-skills.json', skills);
  const firstSkill = skills.skills?.[0]?.id;
  if (firstSkill) {
    const detail = await getJson(`/api/hermes/skills?skill=${encodeURIComponent(firstSkill)}&file=SKILL.md`);
    await writeJson('hermes-skill.json', detail);
  }

  const kronos = await getJson('/api/kronos/jobs');
  await writeJson('kronos-jobs.json', kronos);
  const firstJob = kronos.jobs?.[0]?.id;
  if (firstJob) {
    await writeJson('kronos-job.json', await getJson(`/api/kronos/jobs/${encodeURIComponent(firstJob)}`));
    await writeRaw('kronos-forecast.png', await getBuffer(`/api/kronos/jobs/${encodeURIComponent(firstJob)}/forecast.png`));
    for (const file of ['forecast_summary.csv', 'backtest.csv', 'run_metadata.json']) {
      try { await writeRaw(`kronos-${file}`, await getBuffer(`/api/kronos/jobs/${encodeURIComponent(firstJob)}/${file}`)); } catch {}
    }
  }

  const archiveItems = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await getJson(`/api/history?mode=archive&filter=all&limit=50&offset=${offset}`);
    archiveItems.push(...(page.items || []));
    if ((page.items || []).length < 50) break;
  }
  await writeJson('history-archive.json', {
    available: true, error: null, mode: 'archive', filter: 'all', query: '',
    limit: archiveItems.length, offset: 0, total: archiveItems.length,
    archived_post_count: archiveItems.length, invalid_post_count: 0,
    items: archiveItems
  });

  const inspirations = await getJson('/api/history?mode=inspirations&limit=100');
  inspirations.total = (inspirations.items || []).length;
  await writeJson('history-inspirations.json', inspirations);

  await writeJson('rag-activation.json', {
    activation: {
      mode: 'classic',
      updated_at: READ_AT,
      updated_by: 'static-demo',
      reason: '展示快照'
    }
  });

  console.log(JSON.stringify({
    dashboard: Buffer.byteLength(JSON.stringify(deepMask(dashboard))),
    dailyReports: (dailyIndex.reports || []).length,
    nextDayReports: (nextDay.reports || []).length,
    historyItems: archiveItems.length,
    inspirationItems: (inspirations.items || []).length,
    snapshot: READ_AT
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
