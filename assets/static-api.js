(() => {
  const nativeFetch = window.fetch.bind(window);
  const dataBase = new URL('data/', document.baseURI);
  const cache = new Map();
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
  const load = (name) => {
    if (!cache.has(name)) {
      cache.set(name, (async () => {
        try {
          const compressed = await nativeFetch(new URL(`${name}.gz`, dataBase), { cache: 'no-store' });
          if (compressed.ok) {
            const buffer = await compressed.arrayBuffer();
            try {
              if (typeof DecompressionStream === 'function') {
                const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
                return JSON.parse(await new Response(stream).text());
              }
            } catch {}
            try { return JSON.parse(new TextDecoder().decode(buffer)); } catch {}
          }
        } catch {}
        const response = await nativeFetch(new URL(name, dataBase), { cache: 'no-store' });
        if (!response.ok) throw new Error(`snapshot unavailable: ${name}`);
        return response.json();
      })().catch((error) => { cache.delete(name); throw error; }));
    }
    return cache.get(name);
  };
  const binary = async (name, type) => {
    const response = await nativeFetch(new URL(name, dataBase), { cache: 'no-store' });
    if (!response.ok) throw new Error(`snapshot unavailable: ${name}`);
    return new Response(await response.arrayBuffer(), { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  };
  const text = async (name, type = 'text/csv; charset=utf-8') => {
    const response = await nativeFetch(new URL(name, dataBase), { cache: 'no-store' });
    if (!response.ok) throw new Error(`snapshot unavailable: ${name}`);
    return new Response(await response.text(), { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  };

  async function dailyReviews(url) {
    const index = await load('daily-reviews.json');
    const date = url.searchParams.get('date');
    if (!date) return index;
    try {
      const detail = await load(`daily-review/${date}.json`);
      return { ...index, selectedDate: date, available: true, report: detail.report };
    } catch {
      return { ...index, selectedDate: date, available: false, report: null };
    }
  }

  async function nextDayReviews(url) {
    const index = await load('next-day-reviews.json');
    const date = url.searchParams.get('date');
    if (!date) return index;
    const mode = url.searchParams.get('mode') || 'replay';
    const format = url.searchParams.get('format') || 'daily_framework';
    const key = `${mode}:${date}:${format}`;
    try {
      return await load(`next-day/${key.replaceAll(':', '_')}.json`);
    } catch {
      return { ...index, selectedKey: null, available: false, report: null };
    }
  }

  async function history(url) {
    const mode = url.searchParams.get('mode') || 'archive';
    const base = await load(mode === 'inspirations' ? 'history-inspirations.json' : 'history-archive.json');
    const filter = url.searchParams.get('filter') || 'all';
    const query = String(url.searchParams.get('query') || '').trim().toLocaleLowerCase('zh-CN');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    let items = Array.isArray(base.items) ? base.items : [];
    if (filter === 'trading') items = items.filter((item) => item.trading_related === true);
    if (filter === 'non_trading') items = items.filter((item) => item.trading_related !== true);
    if (query) {
      items = items.filter((item) => [
        item.post_id, item.text, item.text_preview, item.excluded_reason,
        ...(item.classification_reasons || [])
      ].filter(Boolean).join('\n').toLocaleLowerCase('zh-CN').includes(query));
    }
    return { ...base, mode, filter, query, limit, offset, total: items.length, items: items.slice(offset, offset + limit) };
  }

  async function hermesSkills(url) {
    const index = await load('hermes-skills.json');
    const skillId = url.searchParams.get('skill');
    if (!skillId) return index;
    const detail = await load('hermes-skill.json');
    const selected = (index.skills || []).find((skill) => skill.id === skillId);
    return {
      ...detail,
      available: true,
      skills: index.skills,
      skill: detail.skill ? { ...detail.skill, id: skillId, name: selected?.name || detail.skill.name } : detail.skill
    };
  }

  async function ragPreview(url) {
    const queue = await load('rag-eval-queue.json');
    const item = queue.items?.[0];
    const caseId = url.searchParams.get('case_id') || item?.case_id || 'demo-case';
    return {
      case_id: caseId,
      candidates: item ? [
        { post_id: item.query?.post_id || '240896571', published_at: item.query?.published_at || '2023-01-31T03:10:13.000Z', text: item.query?.text || '静态演示候选证据', url: item.query?.url || '' },
        { post_id: '416393050', published_at: '2026-11-11T03:10:12.000Z', text: '静态演示：历史关联证据片段，仅用于界面展示。', url: 'https://xueqiu.com/xxxx/416393050' }
      ] : []
    };
  }

  window.fetch = async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input.url;
    const url = new URL(href, location.href);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return nativeFetch(input, init);
    const method = String(init.method || input.method || 'GET').toUpperCase();
    const requestJson = async () => {
      try { return JSON.parse(String(init.body || '{}')); } catch { return {}; }
    };
    try {
      switch (pathname) {
        case '/api/dashboard': return json(await load('dashboard.json'));
        case '/api/command-center': return json(await load('command-center.json'));
        case '/api/daily-reviews': return json(await dailyReviews(url));
        case '/api/next-day-reviews': return json(await nextDayReviews(url));
        case '/api/logic-history': return json(await load('logic-history.json'));
        case '/api/buy-verification': return json(await load('buy-verification.json'));
        case '/api/capture-diagnostics': return json(await load('capture-diagnostics.json'));
        case '/api/hermes/skills': return json(await hermesSkills(url));
        case '/api/history': return json(await history(url));
        case '/api/history-image': return binary('history-image.svg', 'image/svg+xml');
        case '/api/kronos/jobs': {
          if (method === 'POST') {
            const detail = await load('kronos-job.json');
            return json({ job: { ...detail.job, id: 'demo-job', status: 'completed', message: '静态演示：已模拟完成' } }, 202);
          }
          return json(await load('kronos-jobs.json'));
        }
        case '/api/rag/activation': {
          if (method === 'POST') {
            const body = await requestJson();
            return json({ activation: { mode: body.mode || 'classic', updated_at: '2026-11-15T14:45:00.000Z', updated_by: 'static-demo', reason: '展示快照' } });
          }
          return json(await load('rag-activation.json'));
        }
        case '/api/rag/eval/review-queue': return json(await load('rag-eval-queue.json'));
        case '/api/rag/eval/review-preview': return json(await ragPreview(url));
        case '/api/rag/eval/generate': return json(await load('rag-eval-queue.json'));
        case '/api/rag/eval/review': return json({ ok: true, saved: true, mode: 'static-demo' });
        case '/api/rag/eval/run': return json({ ok: true, available: true, status: 'completed', mode: 'static-demo' });
        case '/api/logic-history/refresh-market': return json({ results: [], mode: 'static-demo' });
        case '/api/author-agents/register':
        case '/api/author-agents/lifecycle': {
          const dashboard = await load('dashboard.json');
          return json({ ok: true, author_agent: dashboard.author_agents?.items?.[0] || null, mode: 'static-demo' });
        }
        case '/api/author-agents/pause': {
          const body = await requestJson();
          return json({ ok: true, paused: body.paused === true, mode: 'static-demo' });
        }
        default: break;
      }
      if (pathname.startsWith('/api/kronos/jobs/')) {
        const rest = pathname.slice('/api/kronos/jobs/'.length);
        if (rest.endsWith('/forecast.png')) return binary('kronos-forecast.png', 'image/png');
        if (rest.endsWith('/forecast_summary.csv')) return text('kronos-forecast_summary.csv');
        if (rest.endsWith('/backtest.csv')) return text('kronos-backtest.csv');
        if (rest.endsWith('/run_metadata.json')) return text('kronos-run_metadata.json', 'application/json; charset=utf-8');
        const detail = await load('kronos-job.json');
        return json({ job: { ...detail.job, id: decodeURIComponent(rest.split('/')[0]) } });
      }
      return json({ error: 'not_found', mode: 'static-demo' }, 404);
    } catch (error) {
      return json({ error: 'demo_snapshot_unavailable', detail: String(error?.message || error) }, 503);
    }
  };
})();
