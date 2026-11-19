import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs');
const ASSETS = path.join(OUT, 'assets');
const SRC = process.env.DASHBOARD_SRC || path.join(os.homedir(), '.openclaw/workspace/xueqiu-insight-agent/dashboard');

const SNAPSHOT_LABEL = '2026/11/15 22:45';

function patchHtml(source) {
  let html = source;
  const replace = (from, to) => {
    if (!html.includes(from)) throw new Error(`HTML anchor not found: ${from.slice(0, 80)}`);
    html = html.replace(from, to);
  };
  replace('<title>小马甲决策指挥台</title>', '<title>小马甲决策指挥台 · 静态演示</title>');
  replace(
    '<meta name="color-scheme" content="dark">',
    '<meta name="color-scheme" content="dark">\n    <meta name="robots" content="noindex,nofollow">'
  );
  replace(
    '<link rel="stylesheet" href="/assets/styles.css">',
    '<link rel="stylesheet" href="assets/styles.css">\n    <link rel="stylesheet" href="assets/demo.css">'
  );
  replace('LOCAL · READ ONLY', 'STATIC · READ ONLY');
  replace(
    '<body>',
    `<body>\n    <div class="demo-banner" role="status">\n      <span><strong>静态数据快照</strong> · 本机读取于 ${SNAPSHOT_LABEL} · 来源 小马甲（雪球用户 xxxx）</span>\n      <span class="demo-banner-note">非实时 · 已脱敏 · 交互仅作前端模拟 · 不构成投资建议</span>\n    </div>`
  );
  replace(
    '</p>\n        <p id="generated-at"',
    '当前页面为静态数据快照，交互只在前端模拟，不连接本机服务。</p>\n        <p id="generated-at"'
  );
  replace(
    '<footer>仅供研究，不构成投资建议。</footer>',
    `<footer>仅供研究，不构成投资建议。 · 静态演示快照 ${SNAPSHOT_LABEL} · 雪球用户 xxxx</footer>`
  );
  replace(
    '<script type="module" src="/assets/app.js"></script>',
    '<script src="assets/static-api.js"></script>\n    <script src="assets/demo-ui.js"></script>\n    <script type="module" src="assets/app.js"></script>'
  );
  return html;
}

async function main() {
  await rm(ASSETS, { recursive: true, force: true });
  await mkdir(ASSETS, { recursive: true });
  for (const entry of await readdir(SRC, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await cp(path.join(SRC, entry.name), path.join(ASSETS, entry.name));
  }

  let appJs = await readFile(path.join(ASSETS, 'app.js'), 'utf8');
  appJs = appJs.replace(
    'const HISTORY_IMAGE_PATH = ["/api", "history-image"].join("/");',
    'const HISTORY_IMAGE_PATH = "data/history-image.svg";'
  );
  appJs = appJs.replaceAll('1234567890', 'xxxx');
  await writeFile(path.join(ASSETS, 'app.js'), appJs);

  let dailyReviews = await readFile(path.join(ASSETS, 'daily-reviews.mjs'), 'utf8');
  dailyReviews = dailyReviews.replace(
    "panel.scrollIntoView?.({ block: 'start' });",
    'void 0;'
  );
  await writeFile(path.join(ASSETS, 'daily-reviews.mjs'), dailyReviews);

  let authorDraft = await readFile(path.join(ASSETS, 'author-agent-draft.mjs'), 'utf8');
  authorDraft = authorDraft.replaceAll('1234567890', 'xxxx');
  await writeFile(path.join(ASSETS, 'author-agent-draft.mjs'), authorDraft);

  let kronos = await readFile(path.join(ASSETS, 'kronos.mjs'), 'utf8');
  kronos = kronos.replace(
    'img.src=`/api/kronos/jobs/${encodeURIComponent(job.id)}/forecast.png`;',
    "img.src='data/kronos-forecast.png';"
  );
  kronos = kronos.replace(
    'a.href=`/api/kronos/jobs/${encodeURIComponent(job.id)}/${file}`;',
    "a.href='data/'+file;"
  );
  await writeFile(path.join(ASSETS, 'kronos.mjs'), kronos);

  for (const name of ['static-api.js', 'demo-ui.js', 'demo.css', 'history-image.svg']) {
    await cp(path.join(ROOT, 'demo-assets', name), path.join(ASSETS, name));
  }

  const sourceHtml = await readFile(path.join(SRC, 'index.html'), 'utf8');
  await writeFile(path.join(OUT, 'index.html'), patchHtml(sourceHtml));
  await writeFile(path.join(OUT, '.nojekyll'), '');

  // Keep the Kronos download filenames used by the frontend.
  const aliases = [
    ['kronos-forecast_summary.csv', 'forecast_summary.csv'],
    ['kronos-backtest.csv', 'backtest.csv'],
    ['kronos-run_metadata.json', 'run_metadata.json']
  ];
  for (const [from, to] of aliases) {
    try { await cp(path.join(OUT, 'data', from), path.join(OUT, 'data', to)); } catch {}
  }

  async function sanitize(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await sanitize(file); continue; }
      if (!/\.(html|js|mjs|css|svg)$/.test(entry.name)) continue;
      const source = await readFile(file, 'utf8');
      const clean = source
        .replace(/https:\/\/xueqiu\.com\/\d{10}\//g, 'https://xueqiu.com/xxxx/')
        .replace(/\b\d{10}\b/g, 'xxxx');
      if (clean !== source) await writeFile(file, clean);
    }
  }
  await sanitize(OUT);

  console.log('Built static demo into docs');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
