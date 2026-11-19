import {loadCaptureDiagnostics} from './capture-diagnostics.mjs';
import { bindKronos, loadKronos } from "./kronos.mjs";
import {loadHermesSkills,bindHermesSkills} from './hermes-skills.mjs';
import { buildAuthorRegistrationRequest } from "./author-agent-draft.mjs";
import { bindDailyReviews } from "./daily-reviews.mjs";
import { bindNextDayReviews } from "./next-day-reviews.mjs";
import {bindLogicHistory,loadLogicHistory} from './logic-history.mjs';

const STATUS_LABELS = {
  active: "活跃",
  confirmed: "确认",
  partially_confirmed: "部分确认",
  contradicted: "反证",
  expired_unconfirmed: "到期未确认",
  posthoc_only: "事后标签",
  observed_author_action: "作者公开动作",
  invalidated_by_realtime_revalidation: "实时复核失效"
};

const OPERATION_LABELS = {
  adaptive_sync: "23:00 增量同步",
  signal_monitor: "盘中信号监控",
  delayed_evidence: "延迟评论证据（主帖优先）",
  history_backfill: "历史随机回补",
  candidate_report: "23:10 候选日报"
};

const COMMAND_STATUS_LABELS = {
  attention: "需关注",
  active: "活跃",
  scheduled: "已排期",
  idle: "待命",
  valid: "核验有效",
  invalid: "结果无效",
  failed: "执行失败",
  captured: "已完成采集",
  blocked: "已阻塞",
  locked: "等待其他工作",
  closed_date: "非交易日",
  outside_window: "非交易时段",
  not_due: "等待下次检查",
  stale: "盘中状态陈旧",
  error: "错误",
  ok: "正常",
  unknown: "未知"
};

const ERROR_REASON_LABELS = {
  timeout: "执行超时",
  rate_limit: "请求受限",
  invalid_result: "结果无效",
  validation: "结果校验失败",
  execution_failed: "执行失败",
  stale_inside_window: "交易时段内状态超过 5 分钟未更新"
};

const COMMAND_CENTER_REFRESH_MS = 30_000;
const DASHBOARD_TABS = new Set(["xiaomajia", "hermes", "authors", "foundation"]);
const XIAOMAJIA_VIEWS = new Set(["today", "next-day", "diagnostics", "kronos", "logic", "inspirations", "rag", "operations"]);
const HISTORY_PAGE_SIZE = 50;
const GLOBAL_ARCHIVE_SEARCH_LIMIT = 20;
const HISTORY_IMAGE_PATH = "data/history-image.svg";
const INSPIRATION_PREFERENCES_KEY = "xiaomajia-inspiration-preferences-v1";
const DASHBOARD_SNAPSHOT_STORAGE_KEY = "xiaomajia-dashboard-snapshot-v3";
const DASHBOARD_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CLOSED_CANDIDATE_STATUSES = new Set(["confirmed", "partially_confirmed", "contradicted", "expired_unconfirmed"]);

const state = {
  document: null,
  dashboardTab: "xiaomajia",
  xiaomajiaView: "today",
  status: "all",
  selectedCandidateId: null,
  historyFilter: "all",
  historyQuery: "",
  historyVisibleCount: HISTORY_PAGE_SIZE,
  historyPage: null,
  historyLoading: false,
  historyRequestId: 0,
  globalArchiveSearchQuery: "",
  globalArchiveSearchPage: null,
  globalArchiveSearchLoading: false,
  globalArchiveSearchRequestId: 0,
  inspirationPage: null,
  inspirationLoading: false,
  inspirationPreferences: loadInspirationPreferences(),
  commandCenterGeneratedAt: null,
  commandCenterRefreshError: false,
  ragReviewQueue: null,
  ragReviewPreview: null,
  ragReviewMessage: ""
};
let commandCenterTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function validSnapshotDocument(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof value.generated_at === "string" && Boolean(value.source) && typeof value.source === "object";
}

function snapshotNowIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function readDashboardSnapshot(storage = globalThis.localStorage, { now = () => new Date() } = {}) {
  try {
    const raw = storage?.getItem?.(DASHBOARD_SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    const storedAtMs = Date.parse(snapshot?.stored_at || "");
    const ageMs = Date.parse(snapshotNowIso(now)) - storedAtMs;
    if (snapshot?.version !== 3 || !validSnapshotDocument(snapshot.document) || !Number.isFinite(storedAtMs) || ageMs > DASHBOARD_SNAPSHOT_MAX_AGE_MS) {
      storage?.removeItem?.(DASHBOARD_SNAPSHOT_STORAGE_KEY);
      return null;
    }
    return { document: snapshot.document, stored_at: new Date(storedAtMs).toISOString() };
  } catch {
    return null;
  }
}

export function writeDashboardSnapshot(storage = globalThis.localStorage, documentData, { now = () => new Date() } = {}) {
  if (!validSnapshotDocument(documentData)) return null;
  const storedAt = snapshotNowIso(now);
  try {
    storage?.setItem?.(DASHBOARD_SNAPSHOT_STORAGE_KEY, JSON.stringify({ version: 3, stored_at: storedAt, document: documentData }));
    return storedAt;
  } catch {
    return null;
  }
}

export async function loadDashboardWithSnapshot({
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  render = () => {},
  report = () => {},
  onError = () => {}
} = {}) {
  const snapshot = readDashboardSnapshot(storage, { now });
  if (snapshot) {
    render(snapshot.document);
    report({ state: "loading_cached", stored_at: snapshot.stored_at });
  } else {
    report({ state: "loading", stored_at: null });
  }
  try {
    const response = await fetchImpl("/api/dashboard");
    if (!response?.ok) throw new Error(`HTTP ${response?.status || "error"}`);
    const documentData = await response.json();
    const storedAt = writeDashboardSnapshot(storage, documentData, { now }) || snapshotNowIso(now);
    render(documentData);
    report({ state: "fresh", stored_at: storedAt });
    return { source: "network", document: documentData, stored_at: storedAt };
  } catch (error) {
    const message = error?.message || "未知错误";
    if (snapshot) {
      report({ state: "stale_error", stored_at: snapshot.stored_at, error: message });
      onError(error, { hasSnapshot: true, stored_at: snapshot.stored_at });
      return { source: "cache_after_error", document: snapshot.document, stored_at: snapshot.stored_at, error: message };
    }
    report({ state: "error", stored_at: null, error: message });
    onError(error, { hasSnapshot: false, stored_at: null });
    return { source: "error", document: null, stored_at: null, error: message };
  }
}

export async function setRagActivation(mode, { fetchImpl = globalThis.fetch } = {}) {
  if (!["classic", "rag_active"].includes(mode)) throw new Error("invalid_rag_mode");
  const response = await fetchImpl("/api/rag/activation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode })
  });
  if (!response?.ok) throw new Error(`rag_activation_http_${response?.status || "error"}`);
  const payload = await response.json();
  if (!payload?.activation || payload.activation.mode !== mode) throw new Error("rag_activation_response_invalid");
  return payload.activation;
}

async function ragReviewRequest(url, { method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, method === "GET" ? undefined : {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  if (!response?.ok) throw new Error(`rag_eval_http_${response?.status || "error"}`);
  return response.json();
}

export function generateRagEvalReviewQueue({ fetchImpl = globalThis.fetch } = {}) {
  return ragReviewRequest("/api/rag/eval/generate", { method: "POST", body: {}, fetchImpl });
}

export function loadRagEvalReviewQueue({ fetchImpl = globalThis.fetch } = {}) {
  return ragReviewRequest("/api/rag/eval/review-queue?status=pending&limit=1", { fetchImpl });
}

export function loadRagEvalReviewPreview(caseId, { fetchImpl = globalThis.fetch } = {}) {
  const normalizedCaseId = String(caseId || "").trim();
  if (!normalizedCaseId) return Promise.reject(new Error("rag_eval_case_required"));
  return ragReviewRequest(`/api/rag/eval/review-preview?case_id=${encodeURIComponent(normalizedCaseId)}`, { fetchImpl });
}

export function submitRagEvalReview(review, { fetchImpl = globalThis.fetch } = {}) {
  return ragReviewRequest("/api/rag/eval/review", { method: "POST", body: review, fetchImpl });
}

export function runRagEvaluation({ fetchImpl = globalThis.fetch } = {}) {
  return ragReviewRequest("/api/rag/eval/run", { method: "POST", body: {}, fetchImpl });
}

function renderDashboardLoadStatus({ state: loadState, stored_at: storedAt, error } = {}) {
  const area = byId("dashboard-load-status");
  if (!area) return;
  area.dataset.state = loadState || "loading";
  if (loadState === "loading_cached") {
    area.textContent = `正在读取本机最新归档；当前展示上次成功快照（${formatDate(storedAt)}）。`;
    return;
  }
  if (loadState === "fresh") {
    area.textContent = `已更新为本机最新归档（读取于 ${formatDate(storedAt)}）。`;
    return;
  }
  if (loadState === "stale_error") {
    area.textContent = `最新归档暂未读取；继续展示上次成功快照（${formatDate(storedAt)}）。${error ? ` 原因：${error}` : ""}`;
    return;
  }
  if (loadState === "error") {
    area.textContent = `本机归档读取失败。${error ? ` 原因：${error}` : ""}`;
    return;
  }
  area.textContent = "正在读取本机最新归档…";
}

function setDashboardTab(tab) {
  state.dashboardTab = DASHBOARD_TABS.has(tab) ? tab : "xiaomajia";
  if(state.dashboardTab === "hermes") {bindHermesSkills();void loadHermesSkills();}
  for (const tabName of DASHBOARD_TABS) {
    const panel = byId(`tab-${tabName}`);
    if (panel) panel.hidden = state.dashboardTab !== tabName;
  }
  for (const button of byId("dashboard-tabs")?.querySelectorAll?.("button[data-dashboard-tab]") || []) {
    const selected = button.dataset.dashboardTab === state.dashboardTab;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  }
}

export function parseDashboardTab(hash) {
  const value = String(hash || "").replace(/^#/, "");
  return DASHBOARD_TABS.has(value) ? value : null;
}

function selectDashboardTab(tab, { updateHash = false } = {}) {
  setDashboardTab(tab);
  if (updateHash && typeof window !== "undefined" && window.location.hash !== `#${state.dashboardTab}`) {
    window.location.hash = `#${state.dashboardTab}`;
  }
}

function globalArchiveSearchElements() {
  const input = byId("global-archive-search-input");
  return {
    input,
    status: byId("global-archive-search-status"),
    results: byId("global-archive-search-results")
  };
}

function flattenSearchValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenSearchValue).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value).map(flattenSearchValue).filter(Boolean).join(" ");
  return "";
}

function markCurrentTabSearchRecord(element, value) {
  element.dataset.xiaomajiaSearchRecord = "true";
  const searchText = flattenSearchValue(value).trim();
  if (searchText) element.dataset.xiaomajiaSearchText = searchText;
  return element;
}

export function globalArchiveSearchRequestUrl(query) {
  const params = new URLSearchParams({
    mode: "archive",
    filter: "all",
    offset: "0",
    limit: String(GLOBAL_ARCHIVE_SEARCH_LIMIT)
  });
  const normalizedQuery = String(query || "").trim();
  if (normalizedQuery) params.set("query", normalizedQuery);
  return `/api/history?${params.toString()}`;
}

function archiveSearchResultCard(item) {
  const article = createElement("article", "history-item");
  const heading = createElement("div", "history-item-heading");
  heading.append(createElement("span", "history-date", formatDate(item.published_at)));
  heading.append(createElement("span", `history-chip ${item.trading_related ? "history-trading" : "history-non-trading"}`, item.trading_related ? "交易相关" : "非交易"));
  article.append(heading);
  const meta = [
    `原帖 ${item.post_id || "未记录"}`,
    item.classification_reasons?.length ? item.classification_reasons.join("、") : item.excluded_reason
  ].filter(Boolean).join(" · ");
  if (meta) article.append(createElement("div", "history-meta", meta));
  article.append(createElement("p", "history-text", item.text || item.text_preview || "原帖正文未归档。"));
  if (item.url) article.append(createExternalLink(item.url, "查看原帖"));
  return article;
}

function renderGlobalArchiveSearch() {
  const { input, status, results } = globalArchiveSearchElements();
  const query = String(state.globalArchiveSearchQuery || "").trim();
  if (input && input.value !== state.globalArchiveSearchQuery) input.value = state.globalArchiveSearchQuery;
  if (!status || !results) return;
  results.replaceChildren();
  if (!query) {
    results.hidden = true;
    status.textContent = "覆盖全部本地归档原帖；仅检索本机已有数据，不触发抓取。";
    return;
  }
  results.hidden = false;
  if (state.globalArchiveSearchLoading) {
    status.textContent = "正在检索本地归档…";
    results.append(createElement("p", "empty-state", "正在查找匹配原帖…"));
    return;
  }
  const page = state.globalArchiveSearchPage;
  if (!page?.available) {
    status.textContent = `本地归档检索失败：${page?.error || "暂不可用"}。`;
    results.append(createElement("p", "empty-state", "请稍后重试本地归档检索。"));
    return;
  }
  const items = Array.isArray(page.items) ? page.items : [];
  status.textContent = `本地归档匹配 ${page.total || 0} 条，展示前 ${items.length} 条；不触发抓取或改动归档。`;
  if (!items.length) {
    results.append(createElement("p", "empty-state", "没有匹配的本地归档原帖。"));
    return;
  }
  for (const item of items) results.append(archiveSearchResultCard(item));
}

export async function searchGlobalArchive(query, { fetchImpl = globalThis.fetch } = {}) {
  const normalizedQuery = String(query || "").trim();
  state.globalArchiveSearchQuery = String(query || "");
  const requestId = ++state.globalArchiveSearchRequestId;
  if (!normalizedQuery) {
    state.globalArchiveSearchPage = null;
    state.globalArchiveSearchLoading = false;
    renderGlobalArchiveSearch();
    return;
  }
  state.globalArchiveSearchLoading = true;
  state.globalArchiveSearchPage = null;
  renderGlobalArchiveSearch();
  try {
    const response = await fetchImpl(globalArchiveSearchRequestUrl(normalizedQuery));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = await response.json();
    if (requestId !== state.globalArchiveSearchRequestId) return;
    state.globalArchiveSearchPage = { ...page, items: Array.isArray(page.items) ? page.items : [] };
  } catch (error) {
    if (requestId !== state.globalArchiveSearchRequestId) return;
    state.globalArchiveSearchPage = { available: false, error: error?.message || "未知错误", items: [], total: 0 };
  } finally {
    if (requestId === state.globalArchiveSearchRequestId) state.globalArchiveSearchLoading = false;
  }
  if (requestId === state.globalArchiveSearchRequestId) renderGlobalArchiveSearch();
}

function bindGlobalArchiveSearch() {
  const { input } = globalArchiveSearchElements();
  if (!input) return;
  input.addEventListener("input", (event) => {
    const query = String(event.target?.value || "");
    state.globalArchiveSearchQuery = query;
    void searchGlobalArchive(query);
  });
}

export function bindDashboardTabs() {
  const tabs = byId("dashboard-tabs");
  if (!tabs) return;
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-dashboard-tab]");
    if (!button) return;
    selectDashboardTab(button.dataset.dashboardTab, { updateHash: true });
  });
  setDashboardTab(parseDashboardTab(window.location.hash) || state.dashboardTab);
}

export function parseXiaomajiaRoute(hash) {
  const parts = String(hash || "").replace(/^#/, "").split("/");
  return {view:parts[0] === "xiaomajia" && XIAOMAJIA_VIEWS.has(parts[1]) ? parts[1] : "today",candidateId:null};
}

function xiaomajiaHash(view, candidateId = null) {
  return candidateId ? `#xiaomajia/candidate/${encodeURIComponent(candidateId)}` : `#xiaomajia/${view}`;
}

export function setXiaomajiaView(view, candidateId = null, { updateHash = false, scroll = false } = {}) {
  const safeView = XIAOMAJIA_VIEWS.has(view) ? view : "today";
  state.xiaomajiaView = safeView;
  candidateId = null;
  const archiveSearch = byId("global-archive-search");
  if (archiveSearch) archiveSearch.hidden = ['today','next-day','logic','kronos'].includes(safeView);
  setDashboardTab("xiaomajia");
  for (const panel of document.querySelectorAll("[data-xiaomajia-view]")) {
    panel.hidden = panel.dataset.xiaomajiaView !== safeView;
  }
  const nav = byId("xiaomajia-secondary-nav");
  for (const button of nav.querySelectorAll("button[data-xiaomajia-route]")) {
    const selected = button.dataset.xiaomajiaRoute === safeView;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  if (safeView === "inspirations" && state.document) void ensureInspirationsLoaded({force:true});
  if (safeView === 'logic') void loadLogicHistory();
  if (safeView === 'diagnostics') void loadCaptureDiagnostics();
  if (safeView === 'kronos') void loadKronos();
  if (candidateId && state.document) showCandidate(candidateId, { scroll });
  if (updateHash && typeof window !== "undefined" && window.location.hash !== xiaomajiaHash(safeView, candidateId && safeView === "candidates" ? candidateId : null)) {
    window.location.hash = xiaomajiaHash(safeView, candidateId && safeView === "candidates" ? candidateId : null);
  }
}

export function bindXiaomajiaViews() {
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button[data-xiaomajia-route]");
    if (!button) return;
    setXiaomajiaView(button.dataset.xiaomajiaRoute, null, { updateHash: true });
  });
  window.addEventListener("hashchange", () => {
    const dashboardTab = parseDashboardTab(window.location.hash);
    if (dashboardTab && dashboardTab !== "xiaomajia") {
      setDashboardTab(dashboardTab);
      return;
    }
    const route = parseXiaomajiaRoute(window.location.hash);
    setXiaomajiaView(route.view, route.candidateId, { scroll: false });
  });
  const dashboardTab = parseDashboardTab(window.location.hash);
  if (dashboardTab && dashboardTab !== "xiaomajia") {
    setDashboardTab(dashboardTab);
    return;
  }
  const route = parseXiaomajiaRoute(window.location.hash);
  setXiaomajiaView(route.view, route.candidateId, { scroll: false });
}

function formatDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

export function dashboardReadHeader(documentData = {}) {
  const readAt = documentData?.data_freshness?.read_at || documentData?.generated_at;
  const source = documentData?.source?.name || documentData?.source?.id || "未知";
  return `本机读取于 ${formatDate(readAt)} · 来源 ${source}`;
}

export function freshnessWarningMessages(documentData = {}) {
  const freshness = documentData?.data_freshness || {};
  const archive = freshness.archive || {};
  const calculations = freshness.calculations || {};
  const readAt = Date.parse(freshness.read_at || documentData?.generated_at || "");
  const stale = (value, maxAgeMs) => Number.isFinite(readAt) && Number.isFinite(Date.parse(value || ""))
    && readAt - Date.parse(value) > maxAgeMs;
  const warnings = [];
  if (archive.possible_gap === true) warnings.push("归档游标可能存在缺口");
  if (stale(archive.last_success_at, 6 * 60 * 60 * 1000)) warnings.push("归档采集超过 6 小时未成功");
  if (stale(calculations.candidate_snapshot_at, 24 * 60 * 60 * 1000)) warnings.push("候选计算快照超过 24 小时未刷新");
  if (freshness.browser_identity && freshness.browser_identity.status !== "available") warnings.push("浏览器身份不可用或尚未登录");
  return warnings;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function createExternalLink(url, text) {
  const link = createElement("a", null, text);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知";
}

function posthocCandidateRecord(item = {}) {
  const disclosureId = item.post_id || item.topic || item.label_id || "unknown";
  const summary = item.summary || item.evidence || "未保存公开披露摘要。";
  return {
    ...item,
    candidate_id: `posthoc:${disclosureId}`,
    audit_only: true,
    security_name: item.security_name || null,
    status: "posthoc_only",
    direction: null,
    score: null,
    initial_evidence_chain: [],
    evidence_chain: [{
      post_id: item.post_id || null,
      url: item.url || null,
      published_at: item.published_at || null,
      kind: item.label_type || "posthoc",
      label: item.topic || null,
      summary
    }]
  };
}

function allCandidateRecords(candidates = {}) {
  const pool = Array.isArray(candidates.pool) ? candidates.pool : [];
  const posthoc = (Array.isArray(candidates.posthoc_only) ? candidates.posthoc_only : []).map(posthocCandidateRecord);
  const timeline = Array.isArray(candidates.trade_timeline) ? candidates.trade_timeline : [];
  if (timeline.length) return timeline;
  return [...pool, ...posthoc];
}

export function candidateRecordsForStatus(candidates = {}, status = "all") {
  const pool = Array.isArray(candidates.pool) ? candidates.pool : [];
  const posthoc = (Array.isArray(candidates.posthoc_only) ? candidates.posthoc_only : []).map(posthocCandidateRecord);
  const timeline = Array.isArray(candidates.trade_timeline) ? candidates.trade_timeline : [];
  if (timeline.length) {
    if (status === "all") return timeline;
    if (status === "posthoc_only") return timeline.filter((candidate) => candidate.audit_only || candidate.status === "posthoc_only");
    if (status === "closed") return timeline.filter((candidate) => !candidate.audit_only && CLOSED_CANDIDATE_STATUSES.has(candidate.status));
    return timeline.filter((candidate) => candidate.status === status);
  }
  if (status === "all") return [...pool];
  if (status === "posthoc_only") return posthoc;
  if (status === "closed") return pool.filter((candidate) => CLOSED_CANDIDATE_STATUSES.has(candidate.status));
  return pool.filter((candidate) => candidate.status === status);
}

function candidateRecords() {
  return state.document ? allCandidateRecords(state.document.candidates || {}) : [];
}

export function filterCandidates(status) {
  return candidateRecordsForStatus(state.document?.candidates || {}, status);
}

export function candidateDisplayTitle(candidate = {}) {
  const symbol = candidate.symbol ? String(candidate.symbol) : null;
  const name = candidate.security_name ? String(candidate.security_name) : null;
  if (candidate.audit_only || candidate.status === "posthoc_only") {
    if (symbol && name) return `${symbol}｜${name}`;
    if (symbol) return symbol;
    if (candidate.topic) return `作者披露：${candidate.topic}（未点名标的）`;
    return "作者披露：未点名标的";
  }
  if (symbol && name) return `${symbol}｜${name}`;
  return symbol || "未映射标的";
}

function timelineSourceKey(evidence = {}) {
  if (evidence.post_id) return `post:${evidence.post_id}`;
  if (evidence.url) return `url:${evidence.url}`;
  return `time:${evidence.published_at || "unknown"}`;
}

function timelineSourceNode(evidence, stage, sequence) {
  return {
    key: timelineSourceKey(evidence),
    stage,
    sequence,
    post_id: evidence.post_id || null,
    url: evidence.url || null,
    published_at: evidence.published_at || null,
    timestamp_audit: evidence.timestamp_audit === "verified" ? "verified" : "unverified",
    label: evidence.label || null,
    kind: evidence.kind || null,
    summary: evidence.summary || evidence.evidence || "未保存文本摘要。"
  };
}

function timelineTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

export function candidateEvidenceTimeline(candidate = {}) {
  const auditOnly = candidate.audit_only === true || candidate.status === "posthoc_only";
  const sourceEvidence = auditOnly && !(candidate.evidence_chain || []).length
    ? [{
      post_id: candidate.post_id || null,
      url: candidate.url || null,
      published_at: candidate.published_at || null,
      label: candidate.topic || null,
      kind: candidate.label_type || "posthoc",
      summary: candidate.summary || candidate.evidence || "未保存公开披露摘要。"
    }]
    : null;
  const nodesBySource = new Map();
  let sequence = 0;
  const appendSources = (evidenceItems, stage) => {
    for (const evidence of Array.isArray(evidenceItems) ? evidenceItems : []) {
      const key = timelineSourceKey(evidence);
      if (nodesBySource.has(key)) continue;
      nodesBySource.set(key, timelineSourceNode(evidence, stage, sequence));
      sequence += 1;
    }
  };
  if (auditOnly) appendSources(sourceEvidence || candidate.evidence_chain, "posthoc");
  else {
    appendSources(candidate.initial_evidence_chain, "initial");
    appendSources(candidate.evidence_chain, "followup");
  }
  const nodes = [...nodesBySource.values()].sort((left, right) => timelineTimestamp(left.published_at) - timelineTimestamp(right.published_at) || left.sequence - right.sequence);
  if (!auditOnly) {
    nodes.push({
      key: "status",
      stage: "status",
      sequence,
      post_id: null,
      url: null,
      published_at: candidate.terminal_at || candidate.as_of || candidate.created_at || null,
      timestamp_audit: "not_applicable",
      label: "当前状态",
      kind: "status",
      status: candidate.status || "unknown",
      summary: candidate.terminal_reason || null
    });
  }
  const evidenceNodes = nodes.filter((node) => node.stage !== "status");
  return {
    auditOnly,
    nodes,
    chronologyVerified: evidenceNodes.length > 0 && evidenceNodes.every((node) => node.timestamp_audit === "verified")
  };
}

function historyRecords() {
  return state.historyPage?.items || [];
}

function normalizedLocalSearchQuery(query) {
  return String(query || "").trim().toLocaleLowerCase("zh-CN");
}

export function filterCurrentTabRecords(records, query) {
  const normalizedQuery = normalizedLocalSearchQuery(query);
  const safeRecords = Array.isArray(records) ? records : [];
  if (!normalizedQuery) return [...safeRecords];
  return safeRecords.filter((record) => String(record?.search_text || "").toLocaleLowerCase("zh-CN").includes(normalizedQuery));
}

function normalizedInspirationPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const preferences = {};
  for (const [postId, preference] of Object.entries(value)) {
    if (!postId || !preference || typeof preference !== "object" || Array.isArray(preference)) continue;
    const favorite = preference.favorite === true;
    const pinned = preference.pinned === true;
    if (favorite || pinned) preferences[postId] = { favorite, pinned };
  }
  return preferences;
}

function loadInspirationPreferences() {
  try {
    return normalizedInspirationPreferences(globalThis.localStorage?.getItem(INSPIRATION_PREFERENCES_KEY) ? JSON.parse(globalThis.localStorage.getItem(INSPIRATION_PREFERENCES_KEY)) : {});
  } catch {
    return {};
  }
}

function persistInspirationPreferences(preferences) {
  try {
    globalThis.localStorage?.setItem(INSPIRATION_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // 本地浏览器存储不可用时，当前页面内的选择仍然保留。
  }
}

export function updateInspirationPreferences(current, postId, kind) {
  const preferences = normalizedInspirationPreferences(current);
  if (!postId || !["favorite", "pinned"].includes(kind)) return preferences;
  const existing = preferences[postId] || { favorite: false, pinned: false };
  const next = { ...existing, [kind]: !existing[kind] };
  if (next.favorite || next.pinned) preferences[postId] = next;
  else delete preferences[postId];
  return preferences;
}

export function sortInspirationRecords(items, preferences = {}) {
  const normalizedPreferences = normalizedInspirationPreferences(preferences);
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.is_inspirational === true && item?.post_id)
    .map((item) => ({ ...item, reader_preference: normalizedPreferences[item.post_id] || { favorite: false, pinned: false } }))
    .sort((left, right) => {
      const pinDifference = Number(right.reader_preference.pinned) - Number(left.reader_preference.pinned);
      if (pinDifference) return pinDifference;
      const timeDifference = Date.parse(right.published_at || 0) - Date.parse(left.published_at || 0);
      return timeDifference || String(right.post_id).localeCompare(String(left.post_id));
    });
}

function inspirationRecords() {
  return sortInspirationRecords(state.inspirationPage?.items || [], state.inspirationPreferences);
}

export function filterHistory(filter = state.historyFilter, query = state.historyQuery) {
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-CN");
  return historyRecords().filter((item) => {
    if (filter === "trading" && item.trading_related !== true) return false;
    if (filter === "non_trading" && item.trading_related === true) return false;
    if (!normalizedQuery) return true;
    const searchable = [
      item.post_id,
      item.text,
      item.text_preview,
      item.excluded_reason,
      ...(item.classification_reasons || [])
    ].filter(Boolean).join("\n").toLocaleLowerCase("zh-CN");
    return searchable.includes(normalizedQuery);
  });
}

export function visibleHistoryRecords() {
  return filterHistory().slice(0, state.historyVisibleCount);
}

function resetHistoryVisibleCount() {
  state.historyVisibleCount = HISTORY_PAGE_SIZE;
}

function historyRequestUrl({ mode = "archive", filter = state.historyFilter, query = state.historyQuery, offset = 0, limit = HISTORY_PAGE_SIZE } = {}) {
  const params = new URLSearchParams({ mode, filter, offset: String(offset), limit: String(limit) });
  if (String(query || "").trim()) params.set("query", String(query).trim());
  return `/api/history?${params.toString()}`;
}

async function loadHistoryPage({ append = false } = {}) {
  if (!state.document?.history?.available || (append && state.historyLoading)) return state.historyPage;
  state.historyLoading = true;
  const requestId = ++state.historyRequestId;
  if (!append) state.historyPage = null;
  if (state.document) renderHistory(state.document);
  try {
    const offset = append ? state.historyPage?.items?.length || 0 : 0;
    const response = await fetch(historyRequestUrl({ offset }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = await response.json();
    if (requestId !== state.historyRequestId) return state.historyPage;
    state.historyPage = append && state.historyPage
      ? { ...page, items: [...state.historyPage.items, ...(page.items || [])] }
      : { ...page, items: page.items || [] };
    state.historyVisibleCount = state.historyPage.items.length;
  } catch (error) {
    if (requestId === state.historyRequestId) state.historyPage = { available: false, error: error?.message || "未知错误", items: [], total: 0 };
  } finally {
    if (requestId === state.historyRequestId) state.historyLoading = false;
  }
  if (state.document && requestId === state.historyRequestId) renderHistory(state.document);
  return state.historyPage;
}

function ensureHistoryLoaded() {
  if (state.historyPage || state.historyLoading) return Promise.resolve(state.historyPage);
  return loadHistoryPage();
}

export async function ensureInspirationsLoaded({force=false}={}) {
  if (!state.document?.history?.available || (!force && state.inspirationPage) || state.inspirationLoading) return state.inspirationPage;
  state.inspirationLoading = true;
  if (state.document) renderInspirations(state.document);
  try {
    const response = await fetch(historyRequestUrl({ mode: "inspirations", limit: 100 })+(force?'&refresh=1':''));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = await response.json();
    state.inspirationPage = { ...page, items: page.items || [],loadedAt:new Date().toISOString() };
  } catch (error) {
    state.inspirationPage = { available: false, error: error?.message || "未知错误", items: [], total: 0 };
  } finally {
    state.inspirationLoading = false;
  }
  if (state.document) renderInspirations(state.document);
  return state.inspirationPage;
}

export function increaseHistoryVisibleCount() {
  const page = state.historyPage;
  if (page?.items?.length >= page.total) {
    state.historyVisibleCount = Math.min(page.total, state.historyVisibleCount + HISTORY_PAGE_SIZE);
    if (state.document) renderHistory(state.document);
    return Promise.resolve(visibleHistoryRecords());
  }
  return loadHistoryPage({ append: true }).then(() => visibleHistoryRecords());
}

export function latestThinkingItems(documentData, limit = 5) {
  const evidenceByPostId = new Map();
  for (const candidate of documentData?.candidates?.pool || []) {
    if (!candidate?.candidate_id) continue;
    for (const evidence of [...(candidate.initial_evidence_chain || []), ...(candidate.evidence_chain || [])]) {
      if (!evidence?.post_id) continue;
      const ids = evidenceByPostId.get(evidence.post_id) || [];
      if (!ids.includes(candidate.candidate_id)) ids.push(candidate.candidate_id);
      evidenceByPostId.set(evidence.post_id, ids);
    }
  }
  return [...(documentData?.history?.latest_trading_items || documentData?.history?.items || [])]
    .filter((item) => item?.post_id && item.trading_related === true)
    .sort((left, right) => Date.parse(right.published_at || 0) - Date.parse(left.published_at || 0))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((item) => ({ ...item, candidateIds: evidenceByPostId.get(item.post_id) || [] }));
}

function metricCard(label, value, note = "") {
  const card = createElement("article", "metric-card");
  card.append(createElement("span", "metric-label", label));
  card.append(createElement("strong", "metric-value", value));
  card.append(createElement("span", "metric-note", note));
  return card;
}

function formatDuration(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return "暂无";
  const milliseconds = Number(value);
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

function commandStatusLabel(status) {
  return COMMAND_STATUS_LABELS[status] || "未知";
}

function commandStatusClass(status) {
  if (["attention", "failed", "invalid", "blocked", "stale", "error"].includes(status)) return "danger";
  if (["scheduled", "idle", "closed_date", "outside_window", "not_due", "unknown"].includes(status)) return "muted";
  if (["captured", "active", "valid", "ok"].includes(status)) return "positive";
  return "warning";
}

function commandStatusChip(status) {
  return createElement("span", `status-chip command-status-${commandStatusClass(status)}`, commandStatusLabel(status));
}

function errorReasonLabel(reason) {
  return ERROR_REASON_LABELS[reason] || "未提供安全的错误分类";
}

function marketStatusLabel(market) {
  if (market?.in_trading_window) return "交易时段内";
  if (market?.is_trading_date) return "交易日，非盘中时段";
  return "非交易日";
}

function renderDecisionPipeline(documentData) {
  const panel = byId("decision-pipeline");
  const center = documentData.command_center || {};
  const market = center.market || {};
  const live = center.live_signal || {};
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "P0 · DECISION PIPELINE"));
  headingText.append(createElement("h2", null, "小马甲实时信号链路"));
  heading.append(headingText, commandStatusChip(live.status || "unknown"));
  panel.append(heading);
  panel.append(createElement("p", "command-copy", "只观察明确的买入、卖出、加仓或减仓信号。这里显示采集与规则链路健康度，不会执行交易或修改规则。"));
  const refreshText = state.commandCenterGeneratedAt
    ? `状态快照 ${formatDate(state.commandCenterGeneratedAt)} · 每 30 秒自动刷新`
    : "状态快照尚未读取";
  panel.append(createElement("p", "command-refresh-meta", state.commandCenterRefreshError ? `${refreshText} · 最近一次刷新失败，保留上次数据` : refreshText));
  const metrics = createElement("div", "command-metric-grid");
  metrics.append(
    metricCard("当前市场状态", marketStatusLabel(market), market.trading_date || "日期未知"),
    metricCard("实时监控", commandStatusLabel(live.status), live.next_due_at ? `下次计划 ${formatDate(live.next_due_at)}` : "下次计划未记录"),
    metricCard("最近完成", formatDate(live.last_finished_at || live.last_success_at), live.latency_ms === null ? "耗时未记录" : `耗时 ${formatDuration(live.latency_ms)}`),
    metricCard("本轮新增", String(live.captured_count || 0), `连续失败 ${live.consecutive_failures || 0} 次`)
  );
  panel.append(metrics);
  if (live.error_reason) panel.append(createElement("p", "command-note", `安全错误分类：${errorReasonLabel(live.error_reason)}`));
}

function renderHermesWorkbench(documentData) {
  const panel = byId("hermes-workbench");
  const hermes = documentData.command_center?.hermes || {};
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "P0 · HERMES SHADOW"));
  headingText.append(createElement("h2", null, "Hermes 工作台"));
  heading.append(headingText, commandStatusChip(hermes.status || "unknown"));
  panel.append(heading);
  panel.append(createElement("p", "command-copy", "影子评估只复核公开帖子与规则结论；它不发送消息、不执行交易，也不会改动生产规则。"));
  const metrics = createElement("div", "hermes-metric-grid");
  metrics.append(
    metricCard("最近完成", formatDate(hermes.finished_at), hermes.started_at ? `开始 ${formatDate(hermes.started_at)}` : "开始时间未记录"),
    metricCard("本次耗时", formatDuration(hermes.latency_ms), `连续失败 ${hermes.consecutive_failures || 0} 次`),
    metricCard("输入帖子", String(hermes.input_post_count || 0), `已复核 ${hermes.reviewed_post_count || 0} 条`),
    metricCard("动作候选", String(hermes.action_candidate_count || 0), "仅用于影子核验")
  );
  panel.append(metrics);
  if (hermes.error_reason) panel.append(createElement("p", "command-note", `安全错误分类：${errorReasonLabel(hermes.error_reason)}`));
}

export function renderDailyInterview(documentData) {
  const panel = byId("daily-interview");
  if (!panel) return;
  const interview = documentData.command_center?.daily_interview || {};
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "DAILY INTERVIEW"));
  headingText.append(createElement("h2", null, "每日面试题"));
  heading.append(headingText, commandStatusChip(interview.latest_status || "unknown"));
  panel.append(heading);

  if (!interview.available || !interview.content) {
    panel.append(createElement("p", "empty-state", "尚未找到可展示的完整每日面试题。"));
    return;
  }

  const latestFailed = interview.latest_status === "error" || interview.latest_status === "failed";
  const statusText = latestFailed
    ? "今日生成失败，当前展示最近一次成功保存的完整题目。"
    : "当前展示最近一次成功生成的完整题目。";
  const successAt = interview.last_success_at ? `最近成功：${formatDate(interview.last_success_at)}` : "最近成功时间未记录";
  panel.append(createElement("p", "daily-interview-meta", `${statusText} ${successAt}`));
  const details = createElement("details", "daily-interview-details");
  details.open = true;
  details.append(createElement("summary", null, "展开完整题目、参考要点与追问"));
  details.append(createElement("pre", "daily-interview-content", interview.content));
  panel.append(details);
}

function renderCommandAlerts(documentData) {
  const list = byId("command-alerts");
  const alerts = documentData.command_center?.alerts || [];
  list.replaceChildren();
  if (!alerts.length) {
    list.append(createElement("p", "empty-state", "当前没有需要跟进的启用任务或影子评估异常。"));
    return;
  }
  for (const alert of alerts) {
    const item = createElement("article", "command-alert-item");
    const heading = createElement("div", "command-item-heading");
    heading.append(createElement("strong", null, alert.name || "未命名任务"), commandStatusChip(alert.status || "unknown"));
    item.append(heading);
    const details = [
      alert.agent_id ? `Agent ${alert.agent_id}` : null,
      Number.isFinite(Number(alert.consecutive_errors)) ? `连续异常 ${alert.consecutive_errors} 次` : null,
      alert.last_run_at ? `最近执行 ${formatDate(alert.last_run_at)}` : null,
      alert.last_error_reason ? errorReasonLabel(alert.last_error_reason) : null
    ].filter(Boolean).join(" · ");
    item.append(createElement("p", "command-item-meta", details || "等待新的状态记录。"));
    list.append(item);
  }
}

function renderAgentActivity(documentData) {
  const list = byId("agent-activity");
  const agents = documentData.command_center?.agents || [];
  list.replaceChildren();
  if (!agents.length) {
    list.append(createElement("p", "empty-state", "Agent 活动状态文件当前不可读取。"));
    return;
  }
  for (const agent of agents) {
    const card = createElement("article", "agent-activity-card");
    const heading = createElement("div", "command-item-heading");
    heading.append(createElement("strong", null, agent.id), commandStatusChip(agent.status || "unknown"));
    card.append(heading);
    card.append(createElement("p", "command-item-meta", `启用任务 ${agent.enabled_job_count || 0} · 异常 ${agent.alert_count || 0}`));
    card.append(createElement("p", "command-item-meta", agent.last_activity_at ? `最近活动 ${formatDate(agent.last_activity_at)}` : "暂无可观察到的任务活动"));
    if (agent.latest_job?.name) card.append(createElement("p", "command-item-meta", `最近任务：${agent.latest_job.name}`));
    list.append(card);
  }
}

const AUTHOR_CAPABILITY_LABELS = {
  history_rag: "历史 RAG",
  implicit_signal: "隐含信号",
  long_term_tracking: "长期跟踪",
  image_ocr: "图片 OCR"
};

const AUTHOR_LIFECYCLE_LABELS = {
  draft: "草稿",
  shadow: "Shadow",
  active: "已启用",
  paused: "已暂停"
};

const AUTHOR_LIFECYCLE_TARGETS = {
  draft: [["shadow", "进入 Shadow"] , ["paused", "暂停"]],
  shadow: [["active", "启用"], ["paused", "暂停"]],
  active: [["paused", "暂停"]],
  paused: [["shadow", "恢复 Shadow"]]
};

function safeAuthorErrorCode(value, fallback) {
  const code = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9][a-z0-9_:.-]{0,119}$/i.test(code) ? code : fallback;
}

async function authorControlRequest(url, body, { fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("author_agent_local_request_failed");
  }
  let payload = null;
  try { payload = await response?.json?.(); } catch { /* safe generic code below */ }
  if (!response?.ok || payload?.ok !== true) throw new Error(safeAuthorErrorCode(payload?.error, "author_agent_local_request_failed"));
  return payload;
}

export async function registerAuthorAgent(input, options = {}) {
  const payload = await authorControlRequest("/api/author-agents/register", buildAuthorRegistrationRequest(input), options);
  return payload.author_agent;
}

export async function changeAuthorLifecycle({ sourceId, target, actor, reason } = {}, options = {}) {
  const payload = await authorControlRequest("/api/author-agents/lifecycle", { source_id: sourceId, target, actor, reason }, options);
  return payload.author_agent;
}

export async function setAuthorRuntimePause({ paused, actor, reason } = {}, options = {}) {
  const payload = await authorControlRequest("/api/author-agents/pause", { paused, actor, reason }, options);
  return { paused: payload.paused === true };
}

function authorLifecycleChip(lifecycle) {
  const status = ["active", "shadow", "draft", "paused"].includes(lifecycle) ? lifecycle : "draft";
  const className = status === "active" ? "positive" : status === "shadow" ? "warning" : "muted";
  return createElement("span", `status-chip command-status-${className}`, AUTHOR_LIFECYCLE_LABELS[status]);
}

function authorAgentRuntimeCopy(agent) {
  const runtime = agent?.runtime || {};
  if (runtime.shadow_only) return "Shadow：通用 Author Agent 不采集、不调用 CDP、不写状态、不推送；现有小马甲链路保持独立。";
  if (agent?.lifecycle === "draft") return "草稿：尚未接入来源、任务或推送。";
  if (agent?.lifecycle === "paused") return "已暂停：不应采集或推送。";
  return runtime.allows_capture ? "已启用：仅在后续显式启用流程完成后执行。" : "当前没有可执行的通用 Author Agent 动作。";
}

function authorAgentScheduleCopy(agent) {
  const live = agent?.scheduling?.live_capture || {};
  const archive = agent?.scheduling?.archive_capture || {};
  const windows = Array.isArray(live.windows) ? live.windows.map((window) => Array.isArray(window) ? window.join("–") : "").filter(Boolean).join("、") : "未配置";
  return `盘中每 ${live.every_minutes || "–"} 分钟（${windows}） · 非交易时间每 ${archive.every_minutes || "–"} 分钟`;
}

function authorAgentReadinessCopy(agent) {
  const blockers = Array.isArray(agent?.shadow_readiness?.blockers) ? agent.shadow_readiness.blockers : [];
  return blockers.length ? `Shadow 就绪阻塞：${blockers.join(" · ")}` : "Shadow 就绪：无固定阻塞项";
}

function browserIdentityStatusLabel(identity) {
  const status = identity?.status;
  if (status === "available") return "可用";
  if (status === "starting") return "启动中";
  if (status === "needs_login") return "待手动登录";
  return "不可用";
}

async function reloadAuthorAgents() {
  try {
    const response = await globalThis.fetch("/api/dashboard");
    if (!response?.ok) throw new Error("author_agent_dashboard_reload_failed");
    renderDashboard(await response.json());
  } catch (error) {
    const feedback = byId("author-agent-operation-feedback");
    if (feedback) feedback.textContent = `本机看板刷新未完成：${safeAuthorErrorCode(error?.message, "author_agent_dashboard_reload_failed")}`;
  }
}

function authorOperationFeedback() {
  const feedback = createElement("p", "author-agent-operation-feedback");
  feedback.id = "author-agent-operation-feedback";
  feedback.setAttribute("aria-live", "polite");
  return feedback;
}

function lifecycleActions(agent) {
  const actions = createElement("div", "author-agent-actions");
  for (const [target, label] of AUTHOR_LIFECYCLE_TARGETS[agent?.lifecycle] || []) {
    const button = createElement("button", "author-agent-draft-button", label);
    button.type = "button";
    button.addEventListener("click", async () => {
      const sourceId = String(agent?.source_id || "");
      if (!globalThis.confirm?.(`确认将 ${sourceId} 切换为 ${target}？`)) return;
      const feedback = byId("author-agent-operation-feedback");
      if (feedback) feedback.textContent = "正在提交本机生命周期操作…";
      try {
        await changeAuthorLifecycle({ sourceId, target, actor: "local-admin", reason: "dashboard_confirmed" });
        if (feedback) feedback.textContent = "本机生命周期操作已完成；正在刷新看板。";
        await reloadAuthorAgents();
      } catch (error) {
        if (feedback) feedback.textContent = `本机生命周期操作未完成：${safeAuthorErrorCode(error?.message, "author_agent_lifecycle_failed")}`;
      }
    });
    actions.append(button);
  }
  return actions;
}

function authorPauseControl(registry) {
  const banner = createElement("section", "author-agent-pause-banner", registry.globally_paused ? "全局运行已暂停：不会启动 Author Agent 工作。" : "全局运行未暂停。");
  const button = createElement("button", "author-agent-draft-button", registry.globally_paused ? "恢复全局运行" : "暂停全局运行");
  button.type = "button";
  button.addEventListener("click", async () => {
    const paused = !registry.globally_paused;
    if (!globalThis.confirm?.(`确认${paused ? "暂停" : "恢复"}所有 Author Agent 运行？`)) return;
    const feedback = byId("author-agent-operation-feedback");
    if (feedback) feedback.textContent = "正在提交本机全局运行操作…";
    try {
      await setAuthorRuntimePause({ paused, actor: "local-admin", reason: "dashboard_confirmed" });
      if (feedback) feedback.textContent = "本机全局运行操作已完成；正在刷新看板。";
      await reloadAuthorAgents();
    } catch (error) {
      if (feedback) feedback.textContent = `本机全局运行操作未完成：${safeAuthorErrorCode(error?.message, "author_agent_pause_failed")}`;
    }
  });
  banner.append(button);
  return banner;
}

function renderAuthorAgentDraftWizard(registry = {}) {
  const section = createElement("section", "author-agent-draft");
  const heading = createElement("div", "panel-heading");
  const headingCopy = createElement("div");
  headingCopy.append(createElement("p", "eyebrow", "LOCAL ONBOARDING"), createElement("h2", null, "注册已获授权的 Author Agent"));
  heading.append(headingCopy);
  section.append(heading);
  section.append(createElement("p", "command-copy", "仅可注册已获授权的雪球作者主页。提交仅请求本机看板服务；注册后保持 Draft，不会启动采集或投递。下方 JSON 仅作本机审计预览，并非运行操作。"));

  const form = createElement("form", "author-agent-draft-form");
  const homepageLabel = createElement("label", null, "雪球作者主页");
  const homepage = createElement("input", "author-agent-draft-input");
  homepage.type = "url";
  homepage.placeholder = "https://xueqiu.com/u/xxxx";
  homepage.required = true;
  homepageLabel.append(homepage);
  const nameLabel = createElement("label", null, "显示名称（可选）");
  const name = createElement("input", "author-agent-draft-input");
  name.type = "text";
  name.placeholder = "例如：某作者";
  nameLabel.append(name);
  const actorLabel = createElement("label", null, "本机操作人");
  const actor = createElement("input", "author-agent-draft-input");
  actor.value = "local-admin";
  actor.required = true;
  actorLabel.append(actor);
  const browserIdentities = Array.isArray(registry.browser_identities)
    ? registry.browser_identities.filter((identity) => identity?.platform === "xueqiu" && typeof identity?.id === "string")
    : [];
  const browserIdentityLabel = createElement("label", null, "浏览器身份");
  const browserIdentity = createElement("select", "author-agent-draft-input");
  if (!browserIdentities.length) {
    const option = createElement("option", null, "暂无可用的雪球浏览器身份");
    option.value = "";
    browserIdentity.append(option);
    browserIdentity.disabled = true;
  } else {
    for (const identity of browserIdentities) {
      const option = createElement("option", null, `${identity.id} · ${browserIdentityStatusLabel(identity)}`);
      option.value = identity.id;
      browserIdentity.append(option);
    }
  }
  browserIdentity.required = true;
  browserIdentityLabel.append(browserIdentity);
  const capabilityLabel = createElement("label", null, "能力");
  const capability = createElement("select", "author-agent-draft-input");
  for (const [value, label] of Object.entries(AUTHOR_CAPABILITY_LABELS)) { const option = createElement("option", null, label); option.value = value; capability.append(option); }
  capabilityLabel.append(capability);
  const liveLabel = createElement("label", null, "盘中采集间隔（2–15 分钟）");
  const live = createElement("input", "author-agent-draft-input"); live.type = "number"; live.min = "2"; live.max = "15"; live.value = "5"; liveLabel.append(live);
  const archiveLabel = createElement("label", null, "归档采集间隔（10–240 分钟）");
  const archive = createElement("input", "author-agent-draft-input"); archive.type = "number"; archive.min = "10"; archive.max = "240"; archive.value = "60"; archiveLabel.append(archive);
  const deliveryLabel = createElement("label", null, "交付策略");
  const delivery = createElement("select", "author-agent-draft-input");
  for (const [value, label] of [["never", "永不投递"], ["digest_only", "仅摘要"], ["high_confidence_only", "仅高置信度"]]) { const option = createElement("option", null, label); option.value = value; delivery.append(option); }
  deliveryLabel.append(delivery);
  const confirmationLabel = createElement("label", "author-agent-authorization", "我确认此来源已获授权");
  const confirmation = createElement("input"); confirmation.type = "checkbox"; confirmation.id = "author-agent-authorization-confirmation"; confirmation.required = true;
  confirmationLabel.append(confirmation);
  const submit = createElement("button", "author-agent-draft-button", "注册为 Draft"); submit.type = "submit"; submit.setAttribute("aria-describedby", "author-agent-authorization-confirmation");
  form.append(homepageLabel, nameLabel, actorLabel, browserIdentityLabel, capabilityLabel, liveLabel, archiveLabel, deliveryLabel, confirmationLabel, submit);

  const status = createElement("p", "author-agent-draft-status", browserIdentities.length
    ? "仅支持 https://xueqiu.com/u/<用户ID> 或 https://xueqiu.com/<用户ID>；请选择受控浏览器身份。"
    : "暂无可选的雪球浏览器身份；请先在本机配置并完成手动登录。");
  const output = createElement("pre", "author-agent-draft-output"); output.hidden = true;

  form.addEventListener("submit", async (event) => {
    event.preventDefault?.();
    try {
      const request = buildAuthorRegistrationRequest({ homepage: homepage.value, authorName: name.value, authorizationConfirmed: confirmation.checked, capabilities: [capability.value], liveCaptureMinutes: Number(live.value), archiveCaptureMinutes: Number(archive.value), deliveryPolicy: delivery.value, browserIdentityId: browserIdentity.value, actor: actor.value });
      output.textContent = JSON.stringify(request, null, 2);
      output.hidden = false;
      status.textContent = "正在向本机看板服务注册 Draft…";
      await registerAuthorAgent({ homepage: homepage.value, authorName: name.value, authorizationConfirmed: confirmation.checked, capabilities: [capability.value], liveCaptureMinutes: Number(live.value), archiveCaptureMinutes: Number(archive.value), deliveryPolicy: delivery.value, browserIdentityId: browserIdentity.value, actor: actor.value });
      status.textContent = "已注册为 Draft；未启动采集或投递。正在刷新本机看板。";
      await reloadAuthorAgents();
    } catch (error) {
      output.hidden = true;
      status.textContent = `本机操作未完成：${safeAuthorErrorCode(error?.message, "author_agent_local_request_failed")}`;
    }
  });
  section.append(form, status, output);
  return section;
}

export function renderAuthorAgents(documentData) {
  const panel = byId("author-agents");
  if (!panel) return;
  const registry = documentData?.author_agents || {};
  const summary = registry.summary || {};
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingCopy = createElement("div");
  headingCopy.append(createElement("p", "eyebrow", "AUTHOR AGENT CONTROL PLANE"), createElement("h2", null, "作者 Agent 总览"));
  heading.append(headingCopy);
  panel.append(heading, createElement("p", "command-copy", "这里的通用能力与小马甲研究数据隔离。只展示已配置的 Author Profile；新作者必须先生成草稿、完成授权与访问校验，才可进入后续审核。"));
  if (registry.available !== true) {
    panel.append(createElement("p", "empty-state", "Author Agent 注册表暂不可读取。"), renderAuthorAgentDraftWizard(registry));
    return;
  }
  const metrics = createElement("div", "author-agent-summary-grid");
  metrics.append(
    metricCard("已注册", String(summary.total_count || 0), "可读取的 Author Profile"),
    metricCard("Shadow", String(summary.shadow_count || 0), "不触发通用运行"),
    metricCard("草稿", String(summary.draft_count || 0), "等待授权校验"),
    metricCard("已启用", String(summary.active_count || 0), "需明确审核后启用")
  );
  panel.append(metrics);
  panel.append(authorPauseControl(registry), authorOperationFeedback());
  const list = createElement("div", "author-agent-list");
  const items = Array.isArray(registry.items) ? registry.items : [];
  if (!items.length) list.append(createElement("p", "empty-state", "尚无可展示的 Author Profile。"));
  for (const agent of items) {
    const card = createElement("article", "author-agent-card");
    const cardHeading = createElement("div", "command-item-heading");
    const title = createElement("strong", null, agent.author?.name || agent.source_id || "未命名作者");
    const titleWrap = createElement("div", "author-agent-title");
    titleWrap.append(title);
    if (agent.author?.homepage) titleWrap.append(createExternalLink(agent.author.homepage, "雪球主页"));
    cardHeading.append(titleWrap, authorLifecycleChip(agent.lifecycle));
    card.append(cardHeading);
    card.append(createElement("p", "command-item-meta", `来源 ${agent.source_id || "–"} · 用户 ${agent.author?.user_id || "–"}`));
    const capabilities = (agent.capabilities || []).map((capability) => AUTHOR_CAPABILITY_LABELS[capability] || capability).join(" · ");
    card.append(createElement("p", "command-item-meta", `能力：${capabilities || "未配置"} · 推理：${agent.reasoning_profile?.style || "未配置"}`));
    card.append(createElement("p", "command-item-meta", authorAgentScheduleCopy(agent)));
    card.append(createElement("p", "author-agent-runtime", authorAgentRuntimeCopy(agent)));
    if (agent.capture_identity?.id) {
      card.append(createElement("p", "command-item-meta", `浏览器身份：${agent.capture_identity.id} · ${browserIdentityStatusLabel(agent.capture_identity)}`));
    }
    card.append(createElement("p", "author-agent-readiness", authorAgentReadinessCopy(agent)));
    const runtime = agent.runtime || {};
    card.append(createElement("p", "command-item-meta", `租约：${runtime.lease_held ? "持有" : "未持有"} · 最近执行：${runtime.last_execution_at ? formatDate(runtime.last_execution_at) : "未记录"} · 全局暂停：${registry.globally_paused ? "是" : "否"}`));
    card.append(lifecycleActions(agent));
    const monitor = agent.existing_source_monitor || {};
    if (monitor.available) {
      const monitorDetails = [
        `现有来源监控（独立）：${commandStatusLabel(monitor.status)}`,
        monitor.last_finished_at ? `最近 ${formatDate(monitor.last_finished_at)}` : null,
        monitor.next_due_at ? `下次 ${formatDate(monitor.next_due_at)}` : null
      ].filter(Boolean).join(" · ");
      card.append(createElement("p", "command-item-meta", monitorDetails));
    }
    list.append(card);
  }
  panel.append(list, renderAuthorAgentDraftWizard(registry));
}

function renderScheduledTasks(documentData) {
  const list = byId("scheduled-tasks");
  const jobs = documentData.command_center?.jobs || [];
  list.replaceChildren();
  if (!jobs.length) {
    list.append(createElement("p", "empty-state", "没有可展示的启用任务。"));
    return;
  }
  for (const job of jobs) {
    const item = createElement("article", "scheduled-task-item");
    const heading = createElement("div", "command-item-heading");
    heading.append(createElement("strong", null, job.name), commandStatusChip(job.last_status || "unknown"));
    item.append(heading);
    const schedule = [job.agent_id ? `Agent ${job.agent_id}` : null, job.schedule, job.timezone].filter(Boolean).join(" · ");
    item.append(createElement("p", "command-item-meta", schedule || "计划未记录"));
    const runtime = job.last_duration_ms === null ? null : `耗时 ${formatDuration(job.last_duration_ms)}`;
    const status = [
      job.last_run_at ? `最近执行 ${formatDate(job.last_run_at)}` : null,
      runtime,
      job.consecutive_errors ? `连续异常 ${job.consecutive_errors} 次` : null,
      job.next_run_at ? `下次计划 ${formatDate(job.next_run_at)}` : null
    ].filter(Boolean).join(" · ");
    item.append(createElement("p", "command-item-meta", status || "等待首次执行"));
    list.append(item);
  }
}

function renderCommandCenter(documentData) {
  if (byId("intraday-narratives")) renderIntradayNarratives(documentData);
  if (byId("long-term-tracking")) renderLongTermTracking(documentData);
  if (byId("paper-trading")) renderPaperTrading(documentData);
  renderDecisionPipeline(documentData);
  renderHermesWorkbench(documentData);
  renderDailyInterview(documentData);
  renderCommandAlerts(documentData);
  renderAgentActivity(documentData);
  renderScheduledTasks(documentData);
}

async function refreshCommandCenter() {
  try {
    const response = await fetch("/api/command-center");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const refreshed = await response.json();
    state.document = {
      ...(state.document || {}),
      command_center: refreshed.command_center,
      author_agents: refreshed.author_agents || state.document?.author_agents
    };
    state.commandCenterGeneratedAt = refreshed.generated_at || new Date().toISOString();
    state.commandCenterRefreshError = false;
    renderAuthorAgents(state.document);
    renderCommandCenter(state.document);
  } catch {
    state.commandCenterRefreshError = true;
    if (state.document?.command_center) renderCommandCenter(state.document);
  }
}

function startCommandCenterRefresh() {
  if (commandCenterTimer !== null) return;
  commandCenterTimer = window.setInterval(() => {
    if (!document.hidden) refreshCommandCenter();
  }, COMMAND_CENTER_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCommandCenter();
  });
}

function renderSummary(documentData) {
  const summary = documentData.summary || {};
  const metrics = summary.metrics || {};
  const counts = summary.candidate_counts || {};
  const validation = documentData.historical_validation?.summary || {};
  const active = validation.active_candidate_count ?? counts.active ?? 0;
  const closed = validation.closed_candidate_count || 0;
  const reviewed = metrics.reviewed_count || 0;
  const hitRate = metrics.hit_rate === null || metrics.hit_rate === undefined ? "暂无" : `${(metrics.hit_rate * 100).toFixed(1)}%`;
  const corroboratedRate = metrics.topic_corroborated_rate === null || metrics.topic_corroborated_rate === undefined ? "暂无" : `${(metrics.topic_corroborated_rate * 100).toFixed(1)}%`;
  const calibration = summary.calibration || {};
  const calibrationText = calibration.applied ? "已更新" : "未更新";
  const container = byId("summary");
  container.replaceChildren(
    metricCard("当前可研究候选", String(active), "不等同于买卖指令"),
    metricCard("已结案候选", String(closed), `已复核 ${reviewed}`),
    metricCard("旧规则严格命中率", hitRate, "旧研究同标的确认率，非本人买入概率"),
    metricCard("主题级佐证率", corroboratedRate, "不能替代个股命中"),
    metricCard("事后标签", String(counts.posthoc_only || 0), "仅用于回放校验"),
    metricCard("旧研究权重校准", calibrationText, calibration.reason || "暂无校准记录")
  );
}

function latestThinkingPreview(item, limit = 180) {
  const text = String(item?.text_preview || item?.text || "").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function routeButton(text, view, candidateId = null, className = "overview-link") {
  const button = createElement("button", className, text);
  button.type = "button";
  button.addEventListener("click", () => setXiaomajiaView(view, candidateId, { updateHash: true, scroll: Boolean(candidateId) }));
  return button;
}

function continuousActionLabel(action) {
  return ({ entry: "建仓", add: "加仓", hold: "持有", reduce: "减仓", exit: "退出", watch: "观察", do_not_chase: "不追高" })[action] || "未解析";
}

function continuousEvidenceLabel(level) {
  return ({ observed: "观察到的明确动作", inferred_from_context: "上下文推断", unresolved: "未解析" })[level] || "未解析";
}

function continuousGradeLabel(grade) {
  return ({ largest: "第一大仓", heavy: "重仓", core: "核心仓", base: "底仓", light: "轻仓" })[grade] || "未披露";
}

function continuousPortfolioStatusLabel(status) {
  return ({ eligible: "模型模拟仓位已校准", not_calibrated: "模型尚未校准", insufficient_evidence: "模型证据不足" })[status] || "模型尚未校准";
}

function continuousSourceUrl(value) {
  return /^https:\/\/xueqiu\.com\/xxxx\/\d{6,}$/.test(String(value || "")) ? value : null;
}

function continuousPanelHeading(eyebrow, title, copy) {
  const heading = createElement("div", "panel-heading");
  const text = createElement("div");
  text.append(createElement("p", "eyebrow", eyebrow), createElement("h2", null, title));
  heading.append(text);
  const section = createElement("section", "distillation-panel-content");
  section.append(heading, createElement("p", "distillation-copy", copy));
  return section;
}

function appendContinuousEvidence(card, evidence) {
  for (const item of evidence || []) {
    const url = continuousSourceUrl(item?.url);
    if (!url) continue;
    const row = createElement("p", "distillation-evidence");
    row.append(createElement("span", null, `“${item.quote || "原帖证据"}” · `), createExternalLink(url, "查看原帖"));
    card.append(row);
  }
}

export function renderContinuousDistillation(documentData) {
  const panels = {
    latest: byId("distillation-latest"),
    state: byId("distillation-state"),
    portfolio: byId("distillation-portfolio"),
    calibration: byId("distillation-calibration")
  };
  if (!Object.values(panels).some(Boolean)) return;
  const distillation = documentData?.continuous_distillation || {};
  for (const panel of Object.values(panels)) panel?.replaceChildren();
  if (distillation.available !== true) {
    for (const panel of Object.values(panels)) {
      if (!panel) continue;
      panel.append(createElement("p", "empty-state", "持续炼化工件尚未生成；归档到可校验交易证据后会自动重建。"));
    }
    return;
  }

  const latest = distillation.latest || null;
  if (panels.latest) {
    const section = continuousPanelHeading("JUST PROCESSED", "刚刚发生", "归档完成后立即由同一状态层裁决；此处不补造标的或仓位。");
    if (!latest) {
      section.append(createElement("p", "empty-state", "尚无可展示的持续炼化事件。"));
    } else {
      const card = createElement("article", "distillation-latest-card");
      card.append(createElement("h3", null, `${continuousActionLabel(latest.action)} · ${latest.target || "未解析标的"}`));
      card.append(createElement("p", "distillation-meta", `${formatDate(latest.published_at)} · 当前状态 ${continuousActionLabel(latest.state_after)} · ${continuousEvidenceLabel(latest.evidence_level)}`));
      if (Number.isFinite(latest.processing_latency_ms)) card.append(createElement("p", "distillation-meta", `处理延迟 ${formatDuration(latest.processing_latency_ms)}`));
      if (latest.quote) card.append(createElement("p", "distillation-quote", `“${latest.quote}”`));
      const url = continuousSourceUrl(latest.url);
      if (url) card.append(createExternalLink(url, `原帖 ${latest.post_id || "链接"}`));
      section.append(card);
    }
    panels.latest.append(section);
  }

  if (panels.state) {
    const section = continuousPanelHeading("CURRENT STATE", "当前小马甲状态", "仅展示当前有效的公开证据；同一标的的旧状态保留在归档审计中。\n");
    const items = Array.isArray(distillation.states?.items) ? distillation.states.items : [];
    if (!items.length) {
      section.append(createElement("p", "empty-state", "尚无有效状态。"));
    } else {
      const list = createElement("div", "distillation-state-grid");
      for (const item of items) {
        const card = markCurrentTabSearchRecord(createElement("article", "distillation-state-card"), item);
        card.append(createElement("h3", null, `${item.subject} · ${continuousActionLabel(item.status)}`));
        card.append(createElement("p", "distillation-meta", `${item.horizon === "intraday" ? "日内" : "波段"} · ${formatDate(item.valid_from)} · ${continuousEvidenceLabel(item.evidence_level)} · 置信度 ${item.confidence === "high" ? "高" : item.confidence === "medium" ? "中" : "低"}`));
        appendContinuousEvidence(card, item.evidence);
        list.append(card);
      }
      section.append(list);
    }
    panels.state.append(section);
  }

  if (panels.portfolio) {
    const section = continuousPanelHeading("POSITION EVIDENCE", "仓位证据", "作者公开明示比例、作者仓位等级与模型模拟仓位严格分开；模型数值不是作者真实持仓。\n");
    const items = Array.isArray(distillation.portfolio?.items) ? distillation.portfolio.items : [];
    if (!items.length) {
      section.append(createElement("p", "empty-state", "没有可展示的仓位证据；这不表示作者没有持仓。"));
    } else {
      const list = createElement("div", "distillation-portfolio-grid");
      for (const item of items) {
        const card = markCurrentTabSearchRecord(createElement("article", "distillation-portfolio-card"), item);
        card.append(createElement("h3", null, item.subject));
        card.append(createElement("p", "distillation-position-line", `作者公开明示仓位：${item.public_disclosed_allocation_pct === null || item.public_disclosed_allocation_pct === undefined ? "未披露" : `${item.public_disclosed_allocation_pct}%`}`));
        card.append(createElement("p", "distillation-position-line", `作者仓位等级：${continuousGradeLabel(item.author_position_grade?.value)}`));
        const simulated = item.model_allocation_pct === null || item.model_allocation_pct === undefined
          ? (item.model_allocation_label || "模型尚未校准")
          : `${item.model_allocation_pct}%（模型模拟，非作者真实持仓）`;
        card.append(createElement("p", "distillation-position-line", `小马甲模型模拟仓位：${simulated}`));
        appendContinuousEvidence(card, item.evidence);
        list.append(card);
      }
      section.append(list);
    }
    panels.portfolio.append(section);
  }

  if (panels.calibration) {
    const calibration = distillation.calibration || {};
    const section = continuousPanelHeading("MODEL CALIBRATION", "模型校准", "只有完整历史和严格时间外回放同时达标，模型模拟仓位才会解锁。\n");
    const summary = createElement("div", "distillation-calibration-grid");
    summary.append(
      metricCard("历史覆盖", calibration.history_coverage_complete ? "已完成" : "未完成", calibration.cutoff_at ? `截至 ${formatDate(calibration.cutoff_at)}` : "尚未记录截止时间"),
      metricCard("动作样本", String(calibration.action_sample_count || 0), `时间外评测 ${calibration.holdout_evaluations || 0}`),
      metricCard("动作一致率", Number.isFinite(calibration.action_match_rate) ? `${(calibration.action_match_rate * 100).toFixed(1)}%` : "暂无", `陈旧状态泄漏 ${calibration.stale_state_leakage || 0}`),
      metricCard("模拟仓位", continuousPortfolioStatusLabel(calibration.status), (distillation.portfolio?.unmet_thresholds || []).join(" · ") || "全部门槛已达标")
    );
    section.append(summary);
    panels.calibration.append(section);
  }
}

function renderLatestThinking(documentData) {
  const panel = byId("latest-thinking");
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "LATEST THINKING"));
  headingText.append(createElement("h2", null, "小马甲最新思路动态"));
  heading.append(headingText, routeButton("查看全部原帖", "history"));
  panel.append(heading);
  panel.append(createElement("p", "latest-thinking-copy", "仅展示已归档且标记为交易相关的公开内容；是否形成预测候选，以原帖证据链和准入状态为准。"));
  const items = latestThinkingItems(documentData);
  if (!items.length) {
    panel.append(createElement("p", "empty-state", "当前没有已归档的交易相关思路。"));
    return;
  }
  const list = createElement("div", "latest-thinking-list");
  for (const item of items) {
    const article = markCurrentTabSearchRecord(createElement("article", "latest-thinking-item"), item);
    const itemHeading = createElement("div", "latest-thinking-heading");
    itemHeading.append(createElement("span", "history-date", formatDate(item.published_at)));
    itemHeading.append(createElement("span", "history-chip history-trading", "交易相关"));
    article.append(itemHeading);
    article.append(createElement("p", "latest-thinking-text", latestThinkingPreview(item)));
    const meta = createElement("div", "latest-thinking-meta");
    meta.append(createElement("span", null, `原帖 ${item.post_id}`));
    if (item.url) meta.append(createExternalLink(item.url, "查看原帖"));
    article.append(meta);
    if (item.candidateIds.length) {
      const candidateLinks = createElement("div", "latest-thinking-candidates");
      candidateLinks.append(createElement("span", null, "已进入候选线索："));
      for (const candidateId of item.candidateIds) {
        const candidate = candidateRecords().find((record) => record.candidate_id === candidateId);
        candidateLinks.append(routeButton(candidate ? candidateTitle(candidate) : candidateId, "candidates", candidateId, "inline-route-button"));
      }
      article.append(candidateLinks);
    }
    list.append(article);
  }
  panel.append(list);
}

function todayClassificationLabel(classification) {
  return {
    explicit_action: "明确动作（已观测）",
    position_clue: "仓位线索",
    intent_review: "意图回顾（执行未确认）",
    market_observation: "市场观察",
    security_observation: "标的观察",
    unresolved_theme: "未映射主题",
    non_trading: "非交易原帖"
  }[classification] || "研究线索";
}

function todayClassificationCopy(classification) {
  return {
    explicit_action: "公开帖同时出现已点名证券与明确买卖表述；仅记录已观测内容，不构成交易指令。",
    position_clue: "作者披露仓位或持仓状态，但未给出可执行的进出条件。",
    intent_review: "作者回顾曾考虑参与后作罢；这段话没有确认买入，也不能确认当前账户是否持有。",
    market_observation: "市场或表现反馈；没有据此确认具体证券及本人买卖动作。",
    security_observation: "作者对标的或产业链强弱的观察；尚未形成明确交易动作。",
    unresolved_theme: "出现研究方向但没有可核验证券代码，保留为主题线索，等待后续点名或公开催化。",
    non_trading: "该条已验证的本人公开原帖不含交易信息，保留以完整呈现当天发帖记录。"
  }[classification] || "该条公开内容仅作为研究线索保留。";
}

function todayPriceText(price) {
  if (!price?.available || !Number.isFinite(Number(price.close)) || !price.date) return "本地日线未缓存；不展示或推断价格。";
  const adjustment = price.adjustment ? ` · ${price.adjustment}` : "";
  return `本地日线：${price.date} 收盘 ${Number(price.close).toFixed(2)}${adjustment}`;
}

function todayCandidatePathText(candidate) {
  const path = candidate?.price_path;
  if (!path?.available || !Number.isFinite(Number(path.return_pct))) return "线索至后续提示的本地日线路径暂不可用。";
  const value = Number(path.return_pct);
  return `线索至后续提示的本地日线路径：${value >= 0 ? "+" : ""}${value.toFixed(2)}%（仅作历史观察）`;
}

export function renderTodayWarRoom(documentData) {
  const today = documentData?.today_war_room || {};
  const predictionPanel = byId("today-predictions");
  const postPanel = byId("today-posts");
  for (const panel of [predictionPanel, postPanel]) panel.replaceChildren();
  if (!today.available) {
    predictionPanel.append(createElement("p", "empty-state", "今日归档当前不可用；不会以其他来源内容替代。"));
    postPanel.append(createElement("p", "empty-state", "等待可读取的本地归档。"));
    return;
  }

  const posts = today.posts || [];
  const postHeading = createElement("div", "panel-heading");
  const postHeadingText = createElement("div");
  postHeadingText.append(createElement("p", "eyebrow", "POST-BY-POST"));
  postHeadingText.append(createElement("h2", null, "今日逐帖解读"));
  postHeading.append(postHeadingText, routeButton("查看全部原帖", "history"));
  postPanel.append(postHeading, createElement("p", "today-panel-copy", "分类说明的是证据强度与可解释性，不代表买卖建议或预测已经成立。"));
  if (!posts.length) {
    postPanel.append(createElement("p", "empty-state", "今日没有通过来源校验的本人公开帖。"));
  } else {
    const list = createElement("div", "today-post-list");
    for (const post of posts) {
      const card = markCurrentTabSearchRecord(createElement("article", "today-post-card"), post);
      const heading = createElement("div", "today-card-heading");
      heading.append(createElement("span", "history-date", formatDate(post.published_at)));
      heading.append(createElement("span", `status-chip today-classification-${post.classification || "unknown"}`, todayClassificationLabel(post.classification)));
      card.append(heading);
      card.append(createElement("p", "today-post-text", post.text || "未保存原帖文本。"));
      card.append(createElement("p", "today-interpretation", `解读：${todayClassificationCopy(post.classification)}`));
      const meta = createElement("div", "today-post-meta");
      meta.append(createElement("span", null, `原帖 ${post.post_id || "未记录"}`));
      if (post.symbols?.length) meta.append(createElement("span", null, `已点名：${post.symbols.map((item) => item.security_name ? `${item.symbol} ${item.security_name}` : item.symbol).join("、")}`));
      if (post.themes?.length) meta.append(createElement("span", null, `主题：${post.themes.join("、")}`));
      if (post.url) meta.append(createExternalLink(post.url, "查看原帖"));
      card.append(meta);
      list.append(card);
    }
    postPanel.append(list);
  }

  const candidates = today.prediction_candidates || [];
  const predictionHeading = createElement("div", "panel-heading");
  const predictionHeadingText = createElement("div");
  predictionHeadingText.append(createElement("p", "eyebrow", "TODAY'S RESEARCH CLUES"));
  predictionHeadingText.append(createElement("h2", null, "今日线索与旧研究候选"));
  predictionHeading.append(predictionHeadingText, routeButton("查看候选库", "candidates"));
  predictionPanel.append(predictionHeading, createElement("p", "today-panel-copy", "本人买入判断以上方每日验证为准。下列旧研究候选仅供审阅证据，不代表本人买入概率。"));
  if (today.prediction_snapshot_stale) {
    predictionPanel.append(createElement("p", "coverage-warning", `预测候选快照${today.prediction_snapshot_at ? `停留在 ${formatDate(today.prediction_snapshot_at)}` : "尚未生成"}，未覆盖今天。下方提及股票独立读取今日归档；没有预测候选不代表没有关注线索。`));
  }
  const candidateSection = createElement("details", "today-prediction-section");
  candidateSection.append(createElement("summary", null, "旧研究候选（非本人买入概率）"));
  if (!candidates.length) {
    candidateSection.append(createElement("p", "empty-state", "今日暂无新生成的预测候选。"));
  } else {
    const list = createElement("div", "today-history-list");
    for (const candidate of candidates) {
      const card = markCurrentTabSearchRecord(createElement("article", "today-history-card"), candidate);
      const heading = createElement("div", "today-card-heading");
      heading.append(createElement("h3", null, candidateTitle(candidate)), statusChip(candidate.status));
      card.append(heading);
      card.append(createElement("p", "today-history-meta", [candidate.topic || "未分类", `生成 ${formatDate(candidate.created_at)}`, candidate.terminal_at ? `结案 ${formatDate(candidate.terminal_at)}` : null].filter(Boolean).join(" · ")));
      card.append(createElement("p", "today-history-path", todayCandidatePathText(candidate)));
      if (candidate.candidate_id) card.append(routeButton("查看候选推理链", "candidates", candidate.candidate_id, "tracking-route-button"));
      list.append(card);
    }
    candidateSection.append(list);
  }
  predictionPanel.append(candidateSection);

  const signalGrid = createElement("div", "today-prediction-signal-grid");
  const symbols = today.symbols || [];
  const symbolSection = createElement("section", "today-prediction-section today-prediction-signal");
  symbolSection.append(createElement("h3", null, "明确点名与引用股票"));
  if (!symbols.length) {
    symbolSection.append(createElement("p", "empty-state", "今日原帖没有显式点名且可识别代码的 A 股标的。"));
  } else {
    const list = createElement("div", "today-symbol-list");
    for (const item of symbols) {
      const card = markCurrentTabSearchRecord(createElement("article", "today-symbol-card"), item);
      const heading = createElement("div", "today-card-heading");
      heading.append(createElement("h3", null, item.security_name ? `${item.symbol}｜${item.security_name}` : item.symbol));
      heading.append(createElement("span", "status-chip today-source-chip", `出现 ${item.post_count || 0} 条`));
      card.append(heading);
      card.append(createElement("p", "today-panel-copy", "已核验原文点名或本人引用关系；属于研究观察，尚不表示实际买卖或合格预测。"));
      card.append(createElement("p", "today-symbol-price", todayPriceText(item.price)));
      const meta = createElement("p", "today-post-meta", `最近点名 ${formatDate(item.latest_post?.published_at)} · 原帖 ${item.latest_post?.post_id || "未记录"}`);
      if (item.latest_post?.url) meta.append(document.createTextNode(" · "), createExternalLink(item.latest_post.url, "查看原帖"));
      card.append(meta);
      list.append(card);
    }
    symbolSection.append(list);
  }

  const themes = today.unresolved_themes || [];
  const themeSection = createElement("section", "today-prediction-section today-prediction-signal");
  themeSection.append(createElement("h3", null, "暗示题材板块"));
  if (!themes.length) {
    themeSection.append(createElement("p", "empty-state", "今日没有可保留的暗示题材板块。"));
  } else {
    const list = createElement("div", "today-theme-list");
    for (const item of themes) {
      const card = markCurrentTabSearchRecord(createElement("article", "today-theme-card"), item);
      const heading = createElement("div", "today-card-heading");
      heading.append(createElement("h3", null, item.topic || "未命名主题"), createElement("span", "status-chip today-theme-chip", "待后续点名"));
      card.append(heading);
      card.append(createElement("p", "today-theme-copy", `公开证据 ${item.evidence_count || 0} 条 · 不反推具体证券。`));
      const meta = createElement("p", "today-post-meta", `最近线索 ${formatDate(item.latest_post?.published_at)} · 原帖 ${item.latest_post?.post_id || "未记录"}`);
      if (item.latest_post?.url) meta.append(document.createTextNode(" · "), createExternalLink(item.latest_post.url, "查看原帖"));
      card.append(meta);
      list.append(card);
    }
    themeSection.append(list);
  }
  signalGrid.append(symbolSection, themeSection);
  predictionPanel.append(signalGrid);
}

function longTermDirectionLabel(direction) {
  return { positive: "正向跟踪", neutral: "持续跟踪", cautious: "谨慎跟踪" }[direction] || "持续跟踪";
}

function narrativeDirectionLabel(direction) {
  return { strengthening: "方向强化", cooling: "方向降温", mixed: "证据冲突", to_verify: "待验证" }[direction] || "待验证";
}

function narrativeAttributionLabel(attribution) {
  return { historical_confirmation: "作者历史验证", research_expansion: "系统研究延展", insufficient_evidence: "证据不足" }[attribution] || "证据不足";
}

function narrativeResearchStatusLabel(status) {
  return { valid: "公开资料已核验", retrying: "公开资料重试中", invalid: "公开资料结果无效", empty: "暂无待研究主题", dry_run: "研究预演" }[status] || "研究状态未记录";
}

function narrativeEvidenceLine(label, evidence) {
  const line = createElement("p", "intraday-narrative-evidence");
  line.append(document.createTextNode(`${label}：${evidence?.summary || "未保存摘要"} · `));
  if (evidence?.url) line.append(createExternalLink(evidence.url, `原帖 ${evidence.post_id || "链接"}`));
  else line.append(document.createTextNode(`原帖 ${evidence?.post_id || "未记录"}`));
  return line;
}

function renderIntradayNarratives(documentData) {
  const panel = byId("intraday-narratives");
  const narratives = documentData.command_center?.intraday_narratives || {};
  const items = narratives.items || [];
  const research = narratives.research || {};
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "INTRADAY NARRATIVE"));
  headingText.append(createElement("h2", null, "盘中叙事｜历史关联"));
  heading.append(headingText, createElement("span", "status-chip long-term-status-neutral", "仅观察"));
  panel.append(heading);
  panel.append(createElement("p", "intraday-narratives-copy", "先关联小马甲本人更早的公开帖子；历史不足时才显示系统的公开资料研究。两者均不代表持仓，不构成交易指令，也不会生成模拟订单。"));
  if (research.status || research.pending_count) {
    panel.append(createElement("p", "intraday-narratives-meta", `公开资料研究：${narrativeResearchStatusLabel(research.status)} · 待处理 ${research.pending_count || 0} 个${research.finished_at ? ` · 最近 ${formatDate(research.finished_at)}` : ""}`));
  }
  if (!narratives.available) {
    panel.append(createElement("p", "empty-state", "盘中叙事工件尚未生成；仅在交易日交易时间的新增授权帖子触发。"));
    return;
  }
  if (!items.length) {
    panel.append(createElement("p", "empty-state", "当前没有可回链到作者历史的盘中主题。未点名主题会进入受限的公开资料研究队列。"));
    return;
  }
  const list = createElement("div", "intraday-narrative-list");
  for (const narrative of items) {
    const card = markCurrentTabSearchRecord(createElement("article", "intraday-narrative-card"), narrative);
    const cardHeading = createElement("div", "long-term-tracking-heading");
    cardHeading.append(
      createElement("h3", null, narrative.topic_name || narrative.topic || "未分类主题"),
      createElement("span", `status-chip long-term-status-${narrative.direction === "cooling" ? "cautious" : "neutral"}`, narrativeDirectionLabel(narrative.direction))
    );
    card.append(cardHeading);
    card.append(createElement("p", "intraday-narratives-meta", `${narrativeAttributionLabel(narrative.attribution)} · 置信度 ${Math.round(Number(narrative.confidence || 0) * 100)}% · ${formatDate(narrative.current_evidence?.published_at)}`));
    card.append(narrativeEvidenceLine("当前原帖", narrative.current_evidence));
    const support = narrative.historical_evidence?.[0];
    const counter = narrative.counterevidence?.[0];
    if (support) card.append(narrativeEvidenceLine("历史支持", support));
    if (counter) card.append(narrativeEvidenceLine("历史反证", counter));
    if (narrative.symbols?.length) card.append(createElement("p", "intraday-narratives-meta", `原帖点名：${narrative.symbols.join("、")}`));
    const systemResearch = narrative.system_research;
    if (systemResearch) {
      const researchSection = createElement("section", "intraday-system-research");
      researchSection.append(createElement("h4", null, "系统研究延展（不代表作者观点）"));
      researchSection.append(createElement("p", "intraday-narrative-evidence", systemResearch.summary));
      for (const candidate of systemResearch.candidates || []) {
        researchSection.append(createElement("p", "intraday-narratives-meta", `${candidate.label}：${candidate.symbol} · ${candidate.rationale}`));
      }
      for (const source of systemResearch.sources || []) {
        const sourceLine = createElement("p", "intraday-narratives-meta");
        sourceLine.append(document.createTextNode(`${source.category}｜${source.publisher}：${source.fact} · `));
        sourceLine.append(createExternalLink(source.url, "公开来源"));
        researchSection.append(sourceLine);
      }
      card.append(researchSection);
    }
    list.append(card);
  }
  panel.append(list);
}

function renderLongTermTracking(documentData) {
  const panel = byId("long-term-tracking");
  const tracking = documentData.command_center?.long_term_tracking || {};
  const items = tracking.items || [];
  const themes = tracking.theme_updates || [];
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "LONG-TERM WATCHLIST"));
  headingText.append(createElement("h2", null, "长期跟踪标的"));
  heading.append(headingText);
  panel.append(heading);
  panel.append(createElement("p", "long-term-tracking-copy", "仅记录小马甲本人公开帖中的可回链观点与后续反证，不是个股交易指令；行业动作未点名个股时不会补全标的。"));
  if (!tracking.available) {
    panel.append(createElement("p", "empty-state", "长期跟踪工件尚未生成；下一次已归档的监控或候选周期会自动重建。"));
    return;
  }
  if (!items.length && !themes.length) {
    panel.append(createElement("p", "empty-state", "当前没有满足来源与代码映射条件的长期跟踪内容。"));
    return;
  }
  if (items.length) {
    const grid = createElement("div", "long-term-tracking-grid");
    for (const item of items) {
      const card = markCurrentTabSearchRecord(createElement("article", "long-term-tracking-card"), item);
      const cardHeading = createElement("div", "long-term-tracking-heading");
      cardHeading.append(
        createElement("h3", null, `${item.symbol}｜${item.security_name}`),
        createElement("span", `status-chip long-term-status-${item.direction || "neutral"}`, longTermDirectionLabel(item.direction))
      );
      card.append(cardHeading);
      card.append(createElement("p", "long-term-tracking-meta", `公开证据 ${item.evidence_count || 0} 条 · 最近 ${formatDate(item.last_seen_at || item.latest_evidence?.published_at)}`));
      const source = item.latest_evidence || {};
      const evidence = createElement("p", "long-term-tracking-evidence");
      evidence.append(document.createTextNode(`最新依据：${source.summary || "未保存摘要"} · `));
      if (source.url) evidence.append(createExternalLink(source.url, `原帖 ${source.post_id || "链接"}`));
      else evidence.append(document.createTextNode(`原帖 ${source.post_id || "未记录"}`));
      card.append(evidence);
      const counter = item.counter_evidence?.[0];
      if (counter) card.append(createElement("p", "long-term-counter", `反证/约束：${counter.summary || "作者后续给出谨慎条件"}`));
      grid.append(card);
    }
    panel.append(grid);
  }
  if (themes.length) {
    const section = createElement("section", "theme-update-section");
    section.append(createElement("h3", null, "行业风险更新"));
    const list = createElement("div", "theme-update-list");
    for (const theme of themes) {
      const card = markCurrentTabSearchRecord(createElement("article", "theme-update-card"), theme);
      const cardHeading = createElement("div", "long-term-tracking-heading");
      cardHeading.append(
        createElement("strong", null, `${theme.topic_name || theme.topic || "行业"} · ${theme.action === "theme_reduce" ? "减仓观察" : "题材观察"}`),
        createElement("span", "status-chip long-term-status-cautious", "未指定个股")
      );
      card.append(cardHeading);
      card.append(createElement("p", "long-term-tracking-evidence", theme.evidence || "未保存行业依据。"));
      const meta = createElement("p", "long-term-tracking-meta", `仅观察 · ${formatDate(theme.source?.published_at)}`);
      if (theme.source?.url) meta.append(document.createTextNode(" · "), createExternalLink(theme.source.url, `原帖 ${theme.source.post_id || "链接"}`));
      card.append(meta);
      list.append(card);
    }
    section.append(list);
    panel.append(section);
  }
}

function centsText(value) {
  if (!Number.isFinite(Number(value))) return "暂无";
  return `¥${(Number(value) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function paperActionLabel(action) {
  return {
    simulated_entry: "模拟建仓",
    add: "模拟加仓",
    reduce: "模拟减仓",
    exit: "模拟退出"
  }[action] || "模拟订单";
}

function paperStatusLabel(status) {
  if (status === "filled") return "已模拟成交";
  if (status === "pending_price") return "等待完整分钟行情";
  if (status === "rejected_no_position") return "拒绝：无可用持仓";
  if (status === "unsupported_market") return "拒绝：行情市场未支持";
  return status?.startsWith("rejected_") ? "拒绝：证据或成交条件不满足" : "等待处理";
}

function renderPaperTrading(documentData) {
  const panel = byId("paper-trading");
  const paper = documentData.command_center?.paper_trading || {};
  const positions = paper.positions || [];
  const orders = paper.recent_orders || [];
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "PAPER TRADING"));
  headingText.append(createElement("h2", null, "模拟账户｜非真实委托"));
  heading.append(headingText, createElement("span", "status-chip paper-trading-chip", "本地模拟"));
  panel.append(heading);
  panel.append(createElement("p", "paper-trading-copy", "仅在小马甲本人新增且可验证的明确交易动作出现后写入本地账本；不会连接券商、真实账户或自动下单。"));
  if (!paper.available) {
    panel.append(createElement("p", "empty-state", "模拟账户尚未初始化；初始化后会从新捕获的严格信号开始记录，不回放历史帖子。"));
    return;
  }
  const metrics = createElement("div", "paper-trading-metrics");
  metrics.append(
    metricCard("可用现金", centsText(paper.cash_cents), "虚拟人民币"),
    metricCard("已实现盈亏", centsText(paper.realized_pnl_cents), "不含未实现盈亏"),
    metricCard("已成交", String(paper.counters?.filled || 0), `待价 ${paper.counters?.pending || 0} · 拒绝 ${paper.counters?.rejected || 0}`)
  );
  panel.append(metrics);
  const positionSection = createElement("section", "paper-trading-section");
  positionSection.append(createElement("h3", null, "当前虚拟持仓"));
  if (!positions.length) positionSection.append(createElement("p", "empty-state", "当前没有虚拟持仓。"));
  else {
    const list = createElement("div", "paper-position-list");
    for (const position of positions) {
      const item = markCurrentTabSearchRecord(createElement("article", "paper-position-item"), position);
      item.append(
        createElement("strong", null, position.symbol),
        createElement("span", null, `${Number(position.quantity || 0).toLocaleString("zh-CN")} 股`),
        createElement("span", "paper-position-cost", `成本 ${centsText(position.average_cost_cents)}`)
      );
      list.append(item);
    }
    positionSection.append(list);
  }
  panel.append(positionSection);
  const orderSection = createElement("section", "paper-trading-section");
  orderSection.append(createElement("h3", null, "最近模拟订单"));
  if (!orders.length) orderSection.append(createElement("p", "empty-state", "尚无可展示的模拟订单。"));
  else {
    const list = createElement("div", "paper-order-list");
    for (const order of orders) {
      const item = markCurrentTabSearchRecord(createElement("article", "paper-order-item"), order);
      const title = createElement("div", "paper-order-heading");
      title.append(
        createElement("strong", null, `${paperActionLabel(order.action)}｜${order.symbol}`),
        createElement("span", `status-chip paper-order-${order.status === "filled" ? "filled" : "pending"}`, paperStatusLabel(order.status))
      );
      item.append(title);
      const details = [
        order.quantity ? `${Number(order.quantity).toLocaleString("zh-CN")} 股` : null,
        order.fill_price_cents ? `成交 ${centsText(order.fill_price_cents)}` : null,
        order.detected_at ? `检测 ${formatDate(order.detected_at)}` : null
      ].filter(Boolean).join(" · ");
      if (details) item.append(createElement("p", "paper-order-meta", details));
      if (order.source?.url) item.append(createExternalLink(order.source.url, `查看原帖 ${order.source.post_id || "链接"}`));
      list.append(item);
    }
    orderSection.append(list);
  }
  panel.append(orderSection);
}

function renderOverviewPredictions(documentData) {
  renderTrackingOverview(documentData);
}

function renderOverviewAccuracy(documentData) {
  renderSummary(documentData);
}

function formatPercent(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "暂无" : `${(Number(value) * 100).toFixed(1)}%`;
}

function observedReturnText(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "暂无" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
}

function observationReason(reason) {
  return {
    next_trading_session_not_cached: "线索后没有下一交易日缓存",
    market_cache_missing: "本地日线缓存尚未回填",
    market_cache_invalid: "本地日线缓存无效",
    missing_or_invalid_cache: "本地日线缓存不可用",
    missing_anchor_timestamp: "缺少可验证的公开时间",
    no_valid_cached_bar_before_as_of: "观察时点前没有有效日线"
  }[reason] || "尚无可用的缓存价格观察";
}

function appendHorizonSummary(container, observation, emptyText) {
  const horizons = observation?.summary?.horizons || [];
  if (!horizons.length) {
    container.append(createElement("p", "empty-state", emptyText));
    return;
  }
  const list = createElement("ul", "validation-horizon-list");
  for (const horizon of horizons) {
    list.append(createElement(
      "li",
      null,
      `${horizon.trading_days}日：样本 ${horizon.observed_count} · 正收益 ${horizon.positive_count} · 正收益观察率 ${formatPercent(horizon.positive_rate)} · 平均 ${observedReturnText(horizon.mean_return_pct)}`
    ));
  }
  container.append(list);
}

function appendValidationEvidence(container, candidate) {
  const evidence = [...(candidate.initial_evidence_chain || []), ...(candidate.evidence_chain || [])]
    .filter((item) => item?.post_id || item?.url)
    .sort((left, right) => Date.parse(left.published_at || 0) - Date.parse(right.published_at || 0));
  if (!evidence.length) return;
  const first = evidence[0];
  const last = evidence.at(-1);
  const line = createElement("p", "validation-meta");
  line.append(document.createTextNode(`线索 ${formatDate(first.published_at)} · `));
  if (first.url) line.append(createExternalLink(first.url, `原帖 ${first.post_id || "链接"}`));
  else line.append(document.createTextNode(`原帖 ${first.post_id || "暂无"}`));
  if (last.post_id !== first.post_id || last.url !== first.url) {
    line.append(document.createTextNode(` · 后续证据 ${formatDate(last.published_at)} · `));
    if (last.url) line.append(createExternalLink(last.url, `原帖 ${last.post_id || "链接"}`));
    else line.append(document.createTextNode(`原帖 ${last.post_id || "暂无"}`));
  }
  container.append(line);
}

function priceObservationForCandidate(candidate, validation) {
  return (validation.candidate_price_observation?.evaluations || [])
    .find((item) => item.candidate_id === candidate.candidate_id) || null;
}

function renderHistoricalValidation(documentData) {
  const list = byId("historical-validation-list");
  const validation = documentData.historical_validation || {};
  list.replaceChildren();
  if (!validation.available) {
    list.append(createElement("p", "empty-state", "候选验证归档当前不可读取。"));
    return;
  }
  const summary = validation.summary || {};
  const strict = summary.strict_match || {};
  const topic = summary.topic_corroboration || {};
  const metricGrid = createElement("div", "validation-metric-grid");
  metricGrid.append(
    metricCard("当前可研究", String(summary.active_candidate_count || 0), "公开线索仍未结案"),
    metricCard("历史已结案", String(summary.closed_candidate_count || 0), "已由后续公开信息或到期结案"),
    metricCard("严格同标的", formatPercent(strict.rate), `${strict.confirmed_count || 0} / ${strict.reviewed_count || 0}`),
    metricCard("主题级佐证", formatPercent(topic.rate), `${topic.corroborated_count || 0} / ${topic.reviewed_count || 0}；不能替代个股命中`)
  );
  list.append(metricGrid);

  const candidatePrice = createElement("section", "validation-section");
  candidatePrice.append(createElement("h3", null, "候选价格正收益观察率（缓存日线，非实盘）"));
  candidatePrice.append(createElement("p", "validation-meta", "仅统计在公开线索形成后、按下一交易日开盘进入的成熟候选窗口；不代表实际成交或收益。"));
  appendHorizonSummary(candidatePrice, validation.candidate_price_observation, "暂无成熟候选价格观察样本。未成熟或缺缓存记录不进入统计分母。");
  list.append(candidatePrice);

  const closedSection = createElement("section", "validation-section");
  closedSection.append(createElement("h3", null, "已结案候选"));
  const closed = validation.closed_candidates || [];
  if (!closed.length) {
    closedSection.append(createElement("p", "empty-state", "暂无已结案候选。"));
  } else {
    const records = createElement("div", "validation-record-list");
    for (const candidate of closed) {
      const record = markCurrentTabSearchRecord(createElement("article", "validation-record"), candidate);
      const header = createElement("div", "validation-record-heading");
      header.append(createElement("strong", null, candidateTitle(candidate)));
      header.append(statusChip(candidate.status));
      record.append(header);
      record.append(createElement("p", "validation-meta", `${candidate.topic || "未分类"} · 结案 ${formatDate(candidate.terminal_at)}${candidate.outcome_post_id ? ` · 结果帖 ${candidate.outcome_post_id}` : ""}`));
      appendValidationEvidence(record, candidate);
      const observation = priceObservationForCandidate(candidate, validation);
      record.append(createElement("p", "validation-meta", observation?.status === "available"
        ? `缓存价格观察已生成：${(observation.windows || []).filter((item) => item.status === "available").map((item) => `${item.trading_days}日 ${observedReturnText(item.return_pct)}`).join(" · ") || "暂无成熟窗口"}`
        : `缓存价格观察：${observationReason(observation?.reason)}`));
      records.append(record);
    }
    closedSection.append(records);
  }
  list.append(closedSection);

  const posthocSection = createElement("section", "validation-section posthoc-observation");
  posthocSection.append(createElement("h3", null, "后验交易观察（不计入预测准确率）"));
  posthocSection.append(createElement("p", "validation-meta", validation.disclaimer || "这些记录发生在合格候选形成之后，只供复盘。"));
  const posthoc = validation.posthoc_trade_observations || [];
  if (!posthoc.length) {
    posthocSection.append(createElement("p", "empty-state", "暂无带已识别 A 股代码的后验公开披露。"));
  } else {
    const records = createElement("div", "validation-record-list");
    for (const observation of posthoc) {
      const record = markCurrentTabSearchRecord(createElement("article", "validation-record"), observation);
      record.append(createElement("strong", null, observation.security_name ? `${observation.symbol}｜${observation.security_name}` : observation.symbol || "未映射标的"));
      const disclosure = createElement("p", "validation-meta");
      disclosure.append(document.createTextNode(`公开披露 ${formatDate(observation.published_at)} · `));
      if (observation.url) disclosure.append(createExternalLink(observation.url, `原帖 ${observation.post_id || "链接"}`));
      else disclosure.append(document.createTextNode(`原帖 ${observation.post_id || "暂无"}`));
      record.append(disclosure);
      record.append(createElement("p", "validation-meta", observation.status === "available"
        ? `缓存后验观察：${(observation.windows || []).filter((item) => item.status === "available").map((item) => `${item.trading_days}日 ${observedReturnText(item.return_pct)}`).join(" · ") || "暂无成熟窗口"}`
        : `缓存后验观察：${observationReason(observation.reason)}`));
      records.append(record);
    }
    posthocSection.append(records);
  }
  list.append(posthocSection);
}

function renderCoverageWarning(documentData) {
  const warning = byId("coverage-warning");
  const messages = freshnessWarningMessages(documentData);
  if (!messages.length) {
    warning.hidden = true;
    warning.textContent = "";
    return;
  }
  warning.hidden = false;
  warning.textContent = messages.join(" · ");
}

function historicalStatusLabel(item) {
  return item.trading_related ? "交易相关" : "非交易";
}

function safeHistoryImageUrl(postId, imageId) {
  const safePostId = String(postId || "");
  const safeImageId = String(imageId || "");
  if (!/^\d{1,20}$/.test(safePostId) || !/^[a-f0-9]{64}$/i.test(safeImageId)) return null;
  return `${HISTORY_IMAGE_PATH}?${new URLSearchParams({ post_id: safePostId, image_id: safeImageId }).toString()}`;
}

function renderHistoryEvidence(item) {
  const images = Array.isArray(item.images) ? item.images : [];
  const revisions = Array.isArray(item.evidence_revisions) ? [...item.evidence_revisions] : [];
  const snapshotAt = item.realtime_snapshot_at;
  const posthoc = item.push_eligibility?.reason === "late_reply_posthoc_only";
  if (!images.length && !snapshotAt && !revisions.length && !posthoc) return null;
  const section = createElement("section", "history-evidence");
  if (images.length) {
    const gallery = createElement("div", "history-thumbnail-list");
    images.forEach((image, index) => {
      const url = image?.status === "ok" ? safeHistoryImageUrl(item.post_id, image.image_id) : null;
      if (!url) return;
      const figure = createElement("figure", "history-thumbnail");
      const thumbnail = createElement("img");
      const dimensions = Number.isFinite(image.width) && Number.isFinite(image.height) ? `${image.width}×${image.height}` : "尺寸未记录";
      thumbnail.setAttribute("src", url);
      thumbnail.setAttribute("alt", `原图 ${index + 1} · ${dimensions}`);
      thumbnail.setAttribute("loading", "lazy");
      figure.append(thumbnail, createElement("figcaption", null, dimensions));
      gallery.append(figure);
    });
    if (gallery.children.length) section.append(gallery);
  }
  if (snapshotAt || revisions.length || posthoc) {
    const timeline = createElement("ol", "history-evidence-timeline");
    if (snapshotAt) {
      const snapshot = createElement("li", "history-evidence-event history-evidence-realtime");
      snapshot.append(
        createElement("strong", null, "实时快照"),
        createElement("span", null, `首次采集：${formatDate(snapshotAt)}`)
      );
      timeline.append(snapshot);
    }
    revisions
      .sort((left, right) => Date.parse(left?.observed_at || 0) - Date.parse(right?.observed_at || 0) || Number(left?.sequence || 0) - Number(right?.sequence || 0))
      .forEach((revision) => {
        const event = createElement("li", "history-evidence-event history-evidence-posthoc");
        const lateCount = Math.max(0, Number(revision?.late_reply_count) || 0);
        event.append(
          createElement("strong", null, lateCount ? "事后证据" : "证据修订"),
          createElement("span", null, `第 ${revision?.sequence || "?"} 次 · ${formatDate(revision?.observed_at)}`),
          createElement("span", "history-evidence-detail", lateCount ? `延迟回复 ${lateCount} 条${revision?.author_late_reply_count ? `（作者 ${revision.author_late_reply_count} 条）` : ""}` : "未发现延迟回复")
        );
        timeline.append(event);
      });
    if (posthoc) {
      const noPush = createElement("li", "history-evidence-event history-evidence-no-push");
      noPush.append(
        createElement("strong", null, "事后证据"),
        createElement("span", null, "仅研究解析，不补发交易推送")
      );
      timeline.append(noPush);
    }
    section.append(timeline);
  }
  return section;
}

function renderHistory(documentData) {
  const summary = byId("history-summary");
  const list = byId("history-list");
  const loadMore = byId("history-load-more");
  const history = documentData.history || {};
  list.replaceChildren();
  if (!history.available) {
    summary.textContent = "本地历史原帖归档当前不可读取。";
    list.append(createElement("p", "empty-state", "历史归档目录尚未生成或不可读取。"));
    if (loadMore) loadMore.hidden = true;
    return;
  }
  const page = state.historyPage;
  if (state.historyLoading) {
    summary.textContent = `正在从本地归档检索；本地归档共 ${history.archived_post_count || 0} 条。`;
    list.append(createElement("p", "empty-state", "正在加载匹配原帖…"));
    if (loadMore) loadMore.hidden = true;
    return;
  }
  if (!page) {
    summary.textContent = `本地归档共 ${history.archived_post_count || 0} 条；进入本页后按需读取匹配结果。`;
    list.append(createElement("p", "empty-state", "等待本地历史检索。"));
    if (loadMore) loadMore.hidden = true;
    return;
  }
  if (!page.available) {
    summary.textContent = `本地历史检索失败：${page.error || "未知错误"}。`;
    list.append(createElement("p", "empty-state", "请稍后重试本地历史检索。"));
    if (loadMore) loadMore.hidden = true;
    return;
  }
  const visibleRecords = visibleHistoryRecords();
  summary.textContent = `当前显示 ${visibleRecords.length} / ${page.total || 0} 条匹配原帖；本地归档共 ${history.archived_post_count || 0} 条。检索只读取本机归档，不触发抓取。`;
  if (!visibleRecords.length) {
    list.append(createElement("p", "empty-state", "没有匹配当前筛选条件的历史原帖。"));
    if (loadMore) loadMore.hidden = true;
    return;
  }
  for (const item of visibleRecords) {
    const article = createElement("article", "history-item");
    const heading = createElement("div", "history-item-heading");
    heading.append(createElement("span", "history-date", formatDate(item.published_at)));
    const chip = createElement("span", `history-chip ${item.trading_related ? "history-trading" : "history-non-trading"}`, historicalStatusLabel(item));
    heading.append(chip);
    article.append(heading);
    const meta = [
      `原帖 ${item.post_id}`,
      item.classification_score === null || item.classification_score === undefined ? null : `分类分 ${Number(item.classification_score).toFixed(2)}`,
      item.classification_reasons?.length ? item.classification_reasons.join("、") : item.excluded_reason,
      item.image_count ? `已归档图片 ${item.image_count}` : null
    ].filter(Boolean).join(" · ");
    if (meta) article.append(createElement("div", "history-meta", meta));
    article.append(createElement("p", "history-text", item.text));
    if (item.url) article.append(createExternalLink(item.url, "查看原帖"));
    const evidence = renderHistoryEvidence(item);
    if (evidence) article.append(evidence);
    list.append(article);
  }
  if (loadMore) {
    const remaining = Math.max(0, (page.total || 0) - visibleRecords.length);
    loadMore.hidden = remaining <= 0;
    loadMore.textContent = remaining > 0 ? `加载更多原帖（剩余 ${remaining} 条）` : "已显示全部原帖";
  }
}

function inspirationActionButton(item, kind) {
  const active = item.reader_preference?.[kind] === true;
  const label = kind === "favorite"
    ? active ? "已收藏" : "收藏"
    : active ? "取消置顶" : "置顶";
  const button = createElement("button", `inspiration-action${active ? " is-active" : ""}`, label);
  button.type = "button";
  button.setAttribute("aria-pressed", String(active));
  button.addEventListener("click", () => {
    state.inspirationPreferences = updateInspirationPreferences(state.inspirationPreferences, item.post_id, kind);
    persistInspirationPreferences(state.inspirationPreferences);
    if (state.document) renderInspirations(state.document);
  });
  return button;
}

function renderInspirations(documentData) {
  const summary = byId("inspiration-summary");
  const list = byId("inspiration-list");
  if (!summary || !list) return;
  list.replaceChildren();
  const history = documentData.history || {};
  if (!history.available) {
    summary.textContent = "本地历史原帖归档当前不可读取。";
    list.append(createElement("p", "empty-state", "历史归档目录尚未生成或不可读取。"));
    return;
  }
  if (state.inspirationLoading) {
    summary.textContent = "正在从本地归档读取随笔…";
    list.append(createElement("p", "empty-state", "正在加载随笔沉淀…"));
    return;
  }
  if (!state.inspirationPage) {
    summary.textContent = "进入本页后按需读取本地随笔。";
    list.append(createElement("p", "empty-state", "等待本地随笔检索。"));
    return;
  }
  if (!state.inspirationPage.available) {
    summary.textContent = `本地随笔检索失败：${state.inspirationPage.error || "未知错误"}。`;
    list.append(createElement("p", "empty-state", "请稍后重试本地随笔检索。"));
    return;
  }
  const records = inspirationRecords();
  const pinnedCount = records.filter((item) => item.reader_preference.pinned).length;
  const favoriteCount = records.filter((item) => item.reader_preference.favorite).length;
  summary.textContent = `已读取 ${records.length} / ${state.inspirationPage.total || records.length} 条非交易随笔；最新原帖 ${state.inspirationPage.latestMatchedAt ? formatDate(state.inspirationPage.latestMatchedAt) : '未记录'}${state.inspirationPage.loadedAt ? ` · 读取于 ${formatDate(state.inspirationPage.loadedAt)}` : ''}；按原帖时间倒序，${pinnedCount ? `${pinnedCount} 条置顶显示在最前` : "可将重要内容置顶"}。已收藏 ${favoriteCount} 条；收藏和置顶仅保存于当前浏览器。`;
  if (!records.length) {
    list.append(createElement("p", "empty-state", "当前归档中没有符合励志／感悟规则的非交易随笔。"));
    return;
  }
  for (const item of records) {
    const article = markCurrentTabSearchRecord(createElement("article", "history-item inspiration-item"), item);
    const heading = createElement("div", "history-item-heading");
    heading.append(createElement("span", "history-date", formatDate(item.published_at)));
    if (item.reader_preference.pinned) heading.append(createElement("span", "history-chip inspiration-pin", "已置顶"));
    if (item.reader_preference.favorite) heading.append(createElement("span", "history-chip inspiration-favorite", "已收藏"));
    for (const tag of item.inspiration_tags || []) heading.append(createElement("span", "history-chip inspiration-tag", tag));
    article.append(heading);
    article.append(createElement("p", "history-text", item.text));
    const footer = createElement("div", "inspiration-footer");
    footer.append(createElement("span", "history-meta", `原帖 ${item.post_id}`));
    const actions = createElement("div", "inspiration-actions");
    actions.append(inspirationActionButton(item, "favorite"), inspirationActionButton(item, "pinned"));
    footer.append(actions);
    article.append(footer);
    if (item.url) article.append(createExternalLink(item.url, "查看原帖"));
    list.append(article);
  }
}

function statusChip(status) {
  return createElement("span", `status-chip status-${status || "unknown"}`, statusLabel(status));
}

function candidateTitle(candidate) {
  return candidateDisplayTitle(candidate);
}

function firstCandidateText(values, fallback) {
  return Array.isArray(values) && values.find((item) => typeof item === "string" && item.trim()) || fallback;
}

function renderTrackingOverview(documentData) {
  const panel = byId("tracking-overview");
  const candidates = documentData.candidates || {};
  const tracking = candidates.tracking || { active_count: 0, items: [] };
  const items = tracking.items || [];
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "PREDICTION CANDIDATES"));
  headingText.append(createElement("h2", null, "当前研究候选（旧规则）"));
  heading.append(headingText, routeButton("查看全部候选", "candidates"));
  panel.append(heading);
  panel.append(createElement("p", "tracking-copy", "只展示已形成候选池的公开线索；不构成买卖指令，事后标签不进入本区。"));
  const freshness = candidates.freshness || {};
  if (freshness.source_is_stale) {
    panel.append(createElement("p", "tracking-copy", `数据源陈旧：最近成功 ${formatDate(freshness.source_last_success_at)}；${freshness.source_stale_reason || "需检查采集链路"}。候选快照刷新于 ${formatDate(freshness.candidate_refreshed_at || freshness.as_of)}。`));
  }
  if (!candidates.available) {
    panel.append(createElement("p", "empty-state", "候选归档当前不可读取。"));
    return;
  }
  if (tracking.active_count === 0) {
    panel.append(createElement("p", "tracking-empty", "当前没有仍在观察期内的合格候选；以下仅展示最近已结案的跟踪记录，不能视为新的买入建议。"));
  }
  if (!items.length) {
    panel.append(createElement("p", "empty-state", "当前没有可展示的合格跟踪候选。"));
    return;
  }
  const grid = createElement("div", "tracking-grid");
  for (const candidate of items) {
    const card = markCurrentTabSearchRecord(createElement("article", "tracking-card"), candidate);
    const cardHeading = createElement("div", "tracking-card-heading");
    cardHeading.append(createElement("h3", null, candidateTitle(candidate)), statusChip(candidate.status));
    card.append(cardHeading);
    const dates = [
      candidate.topic || "未分类",
      candidate.score === null || candidate.score === undefined ? "无候选评分" : `证据评分 ${Number(candidate.score).toFixed(2)}`,
      `线索 ${formatDate(candidate.created_at || candidate.as_of || candidate.published_at)}`,
      candidate.terminal_at ? `结案 ${formatDate(candidate.terminal_at)}` : null
    ].filter(Boolean).join(" · ");
    card.append(createElement("p", "tracking-meta", dates));
    card.append(createElement("p", "tracking-note", `触发：${firstCandidateText(candidate.trigger_conditions, candidate.initial_evidence_chain?.[0]?.summary || "未保存简要触发条件。")}`));
    card.append(createElement("p", "tracking-note", `约束：${firstCandidateText([...(candidate.counterevidence || []), ...(candidate.blockers || [])], "未记录额外反证或约束。")}`));
    card.append(createElement("p", "tracking-note", `失效：${firstCandidateText(candidate.invalidation_conditions, "未保存失效条件。")}`));
    const evidence = candidate.initial_evidence_chain?.[0];
    const evidenceLine = createElement("p", "tracking-evidence");
    evidenceLine.append(document.createTextNode(`原帖证据：${formatDate(evidence?.published_at)} · `));
    if (evidence?.url) evidenceLine.append(createExternalLink(evidence.url, evidence.label || `原帖 ${evidence.post_id || "链接"}`));
    else evidenceLine.append(document.createTextNode(evidence?.label || "未保存原帖链接"));
    card.append(evidenceLine);
    card.append(routeButton("查看完整证据链", "candidates", candidate.candidate_id, "tracking-route-button"));
    grid.append(card);
  }
  panel.append(grid);
}

function renderCandidateList() {
  const list = byId("candidate-list");
  const candidates = filterCandidates(state.status);
  list.replaceChildren();
  if (!candidates.length) {
    list.append(createElement("p", "empty-state", "当前筛选条件下没有候选。"));
    return;
  }
  for (const candidate of candidates) {
    const row = markCurrentTabSearchRecord(createElement("article", "candidate-row"), candidate);
    const selectButton = createElement("button", "candidate-select-button");
    selectButton.type = "button";
    selectButton.dataset.candidateId = candidate.candidate_id;
    if (candidate.candidate_id === state.selectedCandidateId) {
      row.classList.add("is-selected");
      selectButton.classList.add("is-selected");
    }
    const top = createElement("span", "candidate-row-main");
    top.append(createElement("span", "candidate-symbol", candidateTitle(candidate)));
    top.append(statusChip(candidate.status));
    selectButton.append(top);
    const meta = candidate.audit_only
      ? (candidate.prediction_status === "linked_prior_prediction"
        ? "作者公开动作 · 已关联更早预测（不作为该预测的证据）"
        : "作者公开动作 · 未形成更早预测")
      : [candidate.topic || "未分类", candidate.score === null || candidate.score === undefined ? "无候选评分" : `证据评分 ${Number(candidate.score).toFixed(2)}`, formatDate(candidate.created_at || candidate.as_of || candidate.published_at)].join(" · ");
    selectButton.append(createElement("span", "candidate-meta", meta));
    const selectCandidate = () => setXiaomajiaView("candidates", candidate.candidate_id, { updateHash: true, scroll: true });
    selectButton.addEventListener("click", selectCandidate);
    row.addEventListener("click", (event) => {
      if (event.target?.closest?.("a")) return;
      selectCandidate();
    });
    row.append(selectButton);
    if (candidate.audit_only && candidate.url) {
      const sourceLink = createExternalLink(candidate.url, `查看原帖 ${candidate.post_id || "链接"}`);
      sourceLink.className = "candidate-audit-link";
      row.append(sourceLink);
    }
    list.append(row);
  }
}

function detailCell(label, value) {
  const cell = createElement("div", "detail-cell");
  cell.append(createElement("span", null, label));
  cell.append(createElement("strong", null, value || "暂无"));
  return cell;
}

const EVIDENCE_STRENGTH_COMPONENTS = [
  ["named_security", "明确点名标的"],
  ["catalyst", "公开催化"],
  ["author_research_depth", "作者研究深度"],
  ["relative_strength", "相对强度"],
  ["multi_post_context", "多帖上下文"]
];

function boundedRate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0;
}

function candidateTimeIntegrity(candidate = {}) {
  const integrity = candidate.time_integrity || {};
  const total = Math.max(0, Math.floor(Number(integrity.total_count) || 0));
  const verified = Math.max(0, Math.min(total, Math.floor(Number(integrity.verified_count) || 0)));
  return { verified, total, fullyVerified: total > 0 && verified === total };
}

function calibrationReadiness(summary = {}) {
  const calibration = summary.calibration || {};
  const reviewed = Math.max(0, Math.floor(Number(calibration.reviewed_count) || 0));
  const minimum = Math.max(1, Math.floor(Number(calibration.minimum_reviewed_count) || 20));
  return {
    reviewed,
    minimum,
    applied: calibration.applied === true,
    historyCovered: summary.history_coverage_complete === true
  };
}

function calibrationProgressRow(label, value, ratio, complete = false) {
  const row = createElement("div", "calibration-progress-row");
  const labelLine = createElement("div", "calibration-progress-label");
  labelLine.append(createElement("span", null, label), createElement("strong", null, value));
  const track = createElement("div", "calibration-progress-track");
  track.setAttribute("aria-hidden", "true");
  const fill = createElement("span", `calibration-progress-fill${complete ? " is-complete" : ""}`);
  fill.setAttribute("style", `--calibration-progress:${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`);
  track.append(fill);
  row.append(labelLine, track);
  return row;
}

export function renderCandidateDecisionCharts(candidate = {}, summary = {}) {
  const section = createElement("section", "candidate-decision-charts");
  const evidenceChart = createElement("section", "detail-section decision-chart evidence-strength-section");
  evidenceChart.append(createElement("h3", null, "证据强度构成"));
  const score = boundedRate(candidate.evidence_strength ?? candidate.score);
  evidenceChart.append(createElement("p", "decision-chart-copy", `规则证据强度 ${Math.round(score * 100)} / 100 · 规则加总，不是胜率或概率。`));
  const bars = createElement("div", "evidence-strength-chart");
  bars.setAttribute("role", "img");
  bars.setAttribute("aria-label", `规则证据强度 ${Math.round(score * 100)} 分，不是胜率或概率`);
  for (const [key, label] of EVIDENCE_STRENGTH_COMPONENTS) {
    const value = boundedRate(candidate.score_breakdown?.[key]);
    const row = createElement("div", "evidence-strength-row");
    const labelLine = createElement("div", "evidence-strength-label");
    labelLine.append(createElement("span", null, label), createElement("strong", null, `${Math.round(value * 100)}`));
    const track = createElement("div", "evidence-strength-track");
    const fill = createElement("span", "evidence-strength-fill");
    fill.setAttribute("style", `--evidence-strength:${Math.round(value * 100)}%`);
    track.append(fill);
    row.append(labelLine, track);
    bars.append(row);
  }
  evidenceChart.append(bars);

  const probabilityChart = createElement("section", "detail-section decision-chart probability-status-section");
  probabilityChart.append(createElement("h3", null, "本人当日买入概率"));
  probabilityChart.append(createElement("p", "probability-unavailable", "暂无法可靠量化"));
  probabilityChart.append(createElement("p", "decision-chart-copy", "目标是本人在信号对应日是否实际买入，不是涨跌胜率。旧研究权重校准不能证明本人口径；需冻结原始判断，再用后续同标的、同日期的本人确认或成交核验进行时间留出验证。"));
  // Legacy calibration remains an internal research diagnostic and does not
  // establish readiness of a different target, the author's actual purchase.
  section.append(evidenceChart, probabilityChart);
  return section;
}

function pricePathReason(reason) {
  return {
    symbol_unrecognized: "未识别为 A 股证券代码。",
    no_linked_evidence: "没有可关联到该标的的线索帖子。",
    market_cache_missing: "本地行情缓存尚未回填。",
    market_cache_invalid: "本地行情缓存无效或没有有效日线。",
    cache_missing_for_start: "线索帖日期之前没有可用的缓存交易日。",
    cache_missing_for_end: "后续暗示帖日期之前没有可用的缓存交易日。",
    no_cached_bars_in_window: "线索与后续暗示之间没有可用的缓存日线。"
  }[reason] || "该价格路径当前不可用。";
}

function pricePathRelation(relation) {
  return { direct: "直接关联", topic: "主题关联", inferred: "推断关联" }[relation] || "未分类关联";
}

function compactPrice(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "暂无";
}

function createSvgElement(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function appendSvgText(svg, attributes, text) {
  const element = createSvgElement("text");
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  element.textContent = text;
  svg.append(element);
  return element;
}

function renderPricePath(candidate) {
  const section = createElement("section", "detail-section price-path");
  section.append(createElement("h3", null, "线索至后续暗示的股价路径"));
  const pricePath = candidate.price_path;
  if (!pricePath) {
    section.append(createElement("p", "price-path-gap", "该记录没有可读取的本地价格路径。"));
    return section;
  }
  const metadata = [
    pricePath.symbol || candidate.symbol,
    pricePath.start_bar_date && pricePath.end_bar_date ? `${pricePath.start_bar_date} → ${pricePath.end_bar_date}` : null,
    pricePath.return_pct === null || pricePath.return_pct === undefined ? null : `区间 ${pricePath.return_pct >= 0 ? "+" : ""}${Number(pricePath.return_pct).toFixed(2)}%`,
    pricePath.adjustment ? `复权：${pricePath.adjustment === "none" ? "不复权" : pricePath.adjustment}` : null,
    pricePath.cache_updated_at ? `缓存：${formatDate(pricePath.cache_updated_at)}` : null
  ].filter(Boolean).join(" · ");
  if (metadata) section.append(createElement("p", "price-path-meta", metadata));
  if (!pricePath.available || !Array.isArray(pricePath.bars) || !pricePath.bars.length) {
    section.append(createElement("p", "price-path-gap", pricePathReason(pricePath.reason)));
    if (pricePath.gaps?.length) {
      const list = createElement("ul", "price-evidence-list");
      for (const gap of pricePath.gaps) list.append(createElement("li", null, gap));
      section.append(list);
    }
    return section;
  }

  const bars = pricePath.bars;
  const width = 640;
  const height = 220;
  const padding = { top: 24, right: 20, bottom: 34, left: 50 };
  const closes = bars.map((bar) => Number(bar.close));
  const minimum = Math.min(...closes);
  const maximum = Math.max(...closes);
  const range = maximum - minimum || Math.max(maximum * 0.02, 1);
  const xForIndex = (index) => padding.left + ((width - padding.left - padding.right) * (bars.length === 1 ? 0.5 : index / (bars.length - 1)));
  const yForPrice = (price) => padding.top + ((maximum - price) / range) * (height - padding.top - padding.bottom);
  const barIndex = new Map(bars.map((bar, index) => [bar.date, index]));
  const chart = createSvgElement("svg");
  chart.classList.add("price-chart");
  chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", `${pricePath.symbol || candidate.symbol} 从线索帖到后续暗示帖的缓存日线收盘价走势`);
  const axis = createSvgElement("path");
  axis.classList.add("price-axis");
  axis.setAttribute("d", `M ${padding.left} ${padding.top} V ${height - padding.bottom} H ${width - padding.right}`);
  chart.append(axis);
  const line = createSvgElement("path");
  line.classList.add("price-line");
  line.setAttribute("d", bars.map((bar, index) => `${index === 0 ? "M" : "L"} ${xForIndex(index).toFixed(2)} ${yForPrice(Number(bar.close)).toFixed(2)}`).join(" "));
  chart.append(line);
  appendSvgText(chart, { x: padding.left, y: 14, class: "price-axis-label" }, compactPrice(maximum));
  appendSvgText(chart, { x: padding.left, y: height - 10, class: "price-axis-label" }, compactPrice(minimum));
  appendSvgText(chart, { x: padding.left, y: height - 10, dx: 40, class: "price-axis-label price-axis-date" }, bars[0].date);
  appendSvgText(chart, { x: width - padding.right, y: height - 10, "text-anchor": "end", class: "price-axis-label price-axis-date" }, bars.at(-1).date);
  for (const evidence of pricePath.evidence || []) {
    const index = barIndex.get(evidence.bar_date);
    if (index === undefined) continue;
    const link = createSvgElement("a");
    if (evidence.url) {
      link.setAttribute("href", evidence.url);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
    const point = createSvgElement("circle");
    point.classList.add(`price-point-${evidence.relation || "inferred"}`);
    point.setAttribute("cx", xForIndex(index).toFixed(2));
    point.setAttribute("cy", yForPrice(Number(bars[index].close)).toFixed(2));
    point.setAttribute("r", "5");
    const title = createSvgElement("title");
    title.textContent = `${pricePathRelation(evidence.relation)} · ${formatDate(evidence.published_at)} · ${evidence.label || "原帖证据"}`;
    point.append(title);
    link.append(point);
    chart.append(link);
  }
  section.append(chart);

  const evidenceList = createElement("ol", "price-evidence-list");
  for (const evidence of pricePath.evidence || []) {
    const item = createElement("li", `price-evidence-${evidence.relation || "inferred"}`);
    item.append(createElement("span", "price-evidence-relation", pricePathRelation(evidence.relation)));
    item.append(document.createTextNode(` · ${formatDate(evidence.published_at)}${evidence.bar_date ? ` → ${evidence.bar_date}` : " · 缓存缺口"} · `));
    if (evidence.url) item.append(createExternalLink(evidence.url, evidence.label || `原帖 ${evidence.post_id || "链接"}`));
    else item.append(document.createTextNode(evidence.label || `原帖 ${evidence.post_id || "链接"}`));
    evidenceList.append(item);
  }
  section.append(evidenceList);
  return section;
}

function appendStringList(container, title, values, emptyText) {
  const section = createElement("section", "detail-section");
  section.append(createElement("h3", null, title));
  if (!values?.length) {
    section.append(createElement("p", "empty-state", emptyText));
  } else {
    const list = createElement("ul", "detail-list");
    for (const value of values) list.append(createElement("li", null, value));
    section.append(list);
  }
  container.append(section);
}

function evidenceTimelineStageLabel(stage) {
  return {
    initial: "初始线索",
    followup: "后续佐证",
    status: "当前状态",
    posthoc: "后验公开披露"
  }[stage] || "公开证据";
}

function evidenceTimelineRelation(node) {
  if (node.stage === "status") return statusLabel(node.status);
  return node.label || node.kind || "公开原帖";
}

export function renderCandidateEvidenceTimeline(candidate) {
  const section = createElement("section", "detail-section evidence-timeline-section");
  section.append(createElement("h3", null, "证据时间轴"));
  const timeline = candidateEvidenceTimeline(candidate);
  section.append(createElement("p", "evidence-timeline-copy", timeline.auditOnly
    ? "后验公开披露，不计入预测准确率；它不是事前交易信号。"
    : (timeline.chronologyVerified
      ? "按已核验的原帖发布时间从早到晚排列；每条来源只显示一次。"
      : "存在原帖时间待核验的记录；下列仅展示归档记录顺序，不用于时序推理。")));
  const rail = createElement("div", "evidence-timeline");
  rail.setAttribute("role", "list");
  rail.setAttribute("aria-label", "候选证据时间轴");
  for (const node of timeline.nodes) {
    const item = createElement("article", `evidence-timeline-node evidence-stage-${node.stage}`);
    item.setAttribute("role", "listitem");
    const heading = createElement("div", "evidence-timeline-heading");
    heading.append(createElement("span", "evidence-stage-chip", evidenceTimelineStageLabel(node.stage)));
    const timeLabel = node.stage === "status"
      ? formatDate(node.published_at)
      : node.timestamp_audit === "verified"
        ? `原帖 ${formatDate(node.published_at)}`
        : `待核验 · 归档 ${formatDate(node.published_at)}`;
    heading.append(createElement("time", "evidence-timeline-time", timeLabel));
    item.append(heading);
    item.append(createElement("p", "evidence-timeline-relation", evidenceTimelineRelation(node)));
    const summary = node.stage === "status"
      ? (node.summary || `当前记录状态：${statusLabel(node.status)}。`)
      : node.summary;
    if (summary) item.append(createElement("p", "evidence-timeline-summary", summary));
    if (node.url) item.append(createExternalLink(node.url, `查看原帖 ${node.post_id || "链接"}`));
    rail.append(item);
  }
  section.append(rail);
  return section;
}

export function showCandidate(candidateId, { scroll = true } = {}) {
  state.selectedCandidateId = candidateId;
  const candidate = candidateRecords().find((item) => item.candidate_id === candidateId);
  const panel = byId("candidate-detail");
  panel.replaceChildren();
  if (!candidate) {
    panel.append(createElement("p", "empty-state", "未找到该候选。"));
    return;
  }
  panel.append(createElement("p", "eyebrow", statusLabel(candidate.status)));
  panel.append(createElement("h2", null, candidateTitle(candidate)));
  panel.append(createElement("p", "detail-subtitle", candidate.audit_only
    ? (candidate.prediction_status === "linked_prior_prediction"
      ? "作者公开动作 · 已关联更早预测，但不作为该预测的事前证据"
      : "作者公开动作 · 未形成更早预测")
    : `${candidate.topic || "未分类"} · ${candidate.direction === "bullish_candidate" ? "看多研究候选" : candidate.direction || "研究记录"}`));
  const grid = createElement("div", "detail-grid");
  if (candidate.audit_only) {
    grid.append(
      detailCell("记录性质", "作者公开动作"),
      detailCell("披露时间", formatDate(candidate.published_at)),
      detailCell("状态", statusLabel(candidate.status))
    );
  } else {
    grid.append(
      detailCell("规则证据强度", candidate.evidence_strength === null || candidate.evidence_strength === undefined ? "暂无" : `${Math.round(Number(candidate.evidence_strength) * 100)} / 100`),
      detailCell("创建时间", formatDate(candidate.created_at || candidate.as_of || candidate.published_at)),
      detailCell("结案时间", formatDate(candidate.terminal_at)),
      detailCell("状态", statusLabel(candidate.status))
    );
  }
  panel.append(grid);
  if (candidate.audit_only) {
    const provenance = createElement("section", "detail-section audit-provenance");
    provenance.append(createElement("h3", null, "记录说明"));
    provenance.append(createElement("p", null, candidate.prediction_status === "linked_prior_prediction"
      ? "该作者公开动作关联到更早预测，但不会反向进入该预测证据链。"
      : "该作者公开动作没有更早的合格预测，标为事后观察，不计入预测命中。"));
    panel.append(provenance);
  } else {
    panel.append(renderCandidateDecisionCharts(candidate, state.document?.summary || {}));
    panel.append(renderPricePath(candidate));
    appendStringList(panel, "触发条件", candidate.trigger_conditions, "未保存触发条件。");
    appendStringList(panel, "反证与约束", [...(candidate.counterevidence || []), ...(candidate.blockers || [])], "未发现已记录的反证或约束。");
    appendStringList(panel, "失效条件", candidate.invalidation_conditions, "未保存失效条件。");
  }
  panel.append(renderCandidateEvidenceTimeline(candidate));
  renderCandidateList();
  if (scroll) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function qualityGateLabel(status) {
  return {
    ready_for_human_review: "可供人工复核",
    suppressed: "已抑制",
    not_generated: "未生成"
  }[status] || status || "未知";
}

function renderEvaluation(documentData) {
  const panel = byId("evaluation");
  const evaluation = documentData.evaluation || {};
  const qualityGate = evaluation.quality_gate || {};
  const funnel = evaluation.funnel || {};
  const price = evaluation.price_observation || {};
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "RESEARCH QUALITY"));
  headingText.append(createElement("h2", null, "研究质量与观察结果"));
  heading.append(headingText, statusChip(qualityGate.research_delivery_status));
  panel.append(heading);
  panel.append(createElement("p", "evaluation-copy", "研究漏斗用于保留早期线索；仅现有明确动作规则可以进入盘中信号。缓存日线观察不等同于可成交收益。"));

  const funnelSummary = funnel.summary || {};
  const priceSummary = price.summary || {};
  const grid = createElement("div", "evaluation-grid");
  grid.append(
    metricCard("研究方向", String(funnelSummary.research_direction_count || 0), "公开研究主题"),
    metricCard("板块观察", String(funnelSummary.theme_watch_count || 0), "有催化或多帖佐证"),
    metricCard("标的假设", String(funnelSummary.security_hypothesis_count || 0), "仅已出现的证券代码"),
    metricCard("缓存日线可观察", String(priceSummary.available_count || 0), `共 ${priceSummary.total_candidate_count || 0} 条候选`)
  );
  panel.append(grid);

  const gateSection = createElement("section", "evaluation-detail");
  gateSection.append(createElement("h3", null, `研究候选推送门：${qualityGateLabel(qualityGate.research_delivery_status)}`));
  if (qualityGate.blocking_reasons?.length) {
    const reasons = createElement("ul", "detail-list");
    for (const reason of qualityGate.blocking_reasons) reasons.append(createElement("li", null, reason));
    gateSection.append(reasons);
  } else {
    gateSection.append(createElement("p", "empty-state", "只允许进入人工复核；该状态不改变盘中明确动作的独立投递规则。"));
  }
  const freshness = qualityGate.freshness?.status ? `数据新鲜度：${qualityGate.freshness.status}` : "数据新鲜度：未记录";
  gateSection.append(createElement("p", "evaluation-meta", freshness));
  panel.append(gateSection);

  const priceSection = createElement("section", "evaluation-detail");
  priceSection.append(createElement("h3", null, "缓存日线观察契约"));
  priceSection.append(createElement("p", "evaluation-meta", "下一可用交易日开盘进入、观察窗口末收盘；按缓存声明的复权状态，不含滑点，也不主张涨跌停或流动性能够成交。"));
  const evaluated = price.evaluations || [];
  if (evaluated.length) {
    const list = createElement("ul", "evaluation-list");
    for (const item of evaluated.slice(0, 12)) {
      const firstWindow = (item.windows || []).find((window) => window.status === "available");
      const text = [item.symbol || "未映射标的", item.status || "未知", firstWindow ? `${firstWindow.trading_days}日 ${firstWindow.return_pct >= 0 ? "+" : ""}${Number(firstWindow.return_pct).toFixed(2)}%` : null].filter(Boolean).join(" · ");
      list.append(createElement("li", null, text));
    }
    priceSection.append(list);
  } else {
    priceSection.append(createElement("p", "empty-state", "暂无可读取的缓存日线观察。"));
  }
  panel.append(priceSection);
}

function researchGateLabel(gate) {
  return {
    observation: "观察",
    paper_eligible: "模拟资格",
    human_review_required: "人工复核",
    blocked: "已阻断",
    expired: "已到期"
  }[gate] || "研究观察";
}

export function renderResearchLoop(documentData) {
  const panel = byId("research-loop");
  if (!panel) return;
  const loop = documentData.research_loop || {};
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "RESEARCH LOOP"));
  headingText.append(createElement("h2", null, "研究闭环"));
  heading.append(headingText, statusChip(loop.available ? (loop.run?.status || "ready") : "unavailable"));
  panel.append(heading);
  if (!loop.available) {
    panel.append(createElement("p", "empty-state", "研究闭环工件当前不可用；不会以零结果代替缺失数据。"));
    return;
  }
  panel.append(createElement("p", "evaluation-copy", "由本地归档、证据图与缓存价格构成。模拟资格只是研究标签，不生成订单或自动投递。"));
  const counts = loop.summary?.gate_counts || {};
  const grid = createElement("div", "evaluation-grid");
  grid.append(
    metricCard("观察", String(counts.observation || 0), "待补证据的研究线索"),
    metricCard("模拟资格", String(counts.paper_eligible || 0), "非真实委托"),
    metricCard("人工复核", String(counts.human_review_required || 0), "须人工判定"),
    metricCard("已阻断", String(counts.blocked || 0), "负向证据或风险缺口")
  );
  panel.append(grid);

  const queueSection = createElement("section", "evaluation-detail");
  queueSection.append(createElement("h3", null, `优先研究队列 · ${loop.summary?.queue_count || 0} 项`));
  if (loop.queue?.length) {
    const list = createElement("ul", "evaluation-list");
    for (const item of loop.queue.slice(0, 10)) {
      const risk = item.risk_review?.status === "clear" ? "风险已清" : "仍有待核风险";
      list.append(createElement("li", null, `${item.symbol || "未映射标的"} · ${item.topic || "未分类"} · ${researchGateLabel(item.gate)} · 优先级 ${Number(item.priority?.score || 0).toFixed(0)} · ${risk}`));
    }
    queueSection.append(list);
  } else {
    queueSection.append(createElement("p", "empty-state", "当前没有可进入研究队列的案例。"));
  }
  panel.append(queueSection);

  const calibrationSection = createElement("section", "evaluation-detail");
  calibrationSection.append(createElement("h3", null, "时间点回放与校准"));
  if (loop.calibration?.length) {
    const list = createElement("ul", "evaluation-list");
    for (const group of loop.calibration.slice(0, 8)) {
      const coverage = group.coverage_rate === null || group.coverage_rate === undefined ? "覆盖率未记录" : `覆盖率 ${(Number(group.coverage_rate) * 100).toFixed(0)}%`;
      list.append(createElement("li", null, `${group.key || "研究分组"} · ${group.status === "calibrated" ? "样本已校准" : "样本不足"} · ${coverage}`));
    }
    calibrationSection.append(list);
  } else {
    calibrationSection.append(createElement("p", "empty-state", "暂无可用的时间点回放校准样本。"));
  }
  panel.append(calibrationSection);
  panel.append(createElement("p", "evaluation-meta", loop.disclaimer || "研究与模拟辅助，不构成投资建议。"));
}

function renderEvents(documentData) {
  const list = byId("event-list");
  list.replaceChildren();
  const events = documentData.events?.items || [];
  if (!events.length) {
    list.append(createElement("p", "empty-state", documentData.events?.available ? "尚无回放事件。" : "回放事件文件当前不可用。"));
    return;
  }
  for (const event of events.slice(0, 80)) {
    const item = markCurrentTabSearchRecord(createElement("article", "event-item"), event);
    const title = event.kind === "posthoc_only"
      ? `事后标签：${event.symbol || event.topic || "未映射"}`
      : `${statusLabel(event.status)}：${event.candidate_id || "候选"}`;
    item.append(createElement("div", "event-title", title));
    item.append(createElement("div", "event-meta", `${formatDate(event.as_of)}${event.reason ? ` · ${event.reason}` : ""}`));
    if (event.url) item.append(createExternalLink(event.url, "查看原帖"));
    list.append(item);
  }
}

function renderOperations(documentData) {
  const list = byId("operations");
  list.replaceChildren();
  for (const [key, operation] of Object.entries(documentData.operations || {})) {
    const item = markCurrentTabSearchRecord(createElement("article", "operation-item"), { key, label: OPERATION_LABELS[key] || key, operation });
    item.append(createElement("div", "operation-title", OPERATION_LABELS[key] || key));
    const status = operation.available ? (operation.status || "可用") : "不可用";
    const times = [operation.last_success_at ? `最近成功 ${formatDate(operation.last_success_at)}` : null, operation.next_due_at ? `下次计划 ${formatDate(operation.next_due_at)}` : null].filter(Boolean).join(" · ");
    item.append(createElement("div", "operation-meta", `${status}${times ? ` · ${times}` : ""}`));
    if (operation.note) item.append(createElement("div", "operation-meta", operation.note));
    list.append(item);
  }
}

function ragModeLabel(mode) {
  return mode === "rag_active" ? "已开启：RAG 正式参与盘中叙事" : "已关闭：仅使用现有规则链路";
}

function ragIndexStatusLabel(status) {
  return { ready: "索引就绪", degraded: "索引降级", not_indexed: "尚未建立索引" }[status] || "状态未知";
}

function ragOptimizationStatusLabel(status) {
  return {
    ready: "压实完成",
    pending: "等待压实",
    degraded: "压实维护降级",
    not_indexed: "尚未建立索引",
    not_run: "尚未运行压实"
  }[status] || "压实状态未知";
}

function ragEvaluationStatusLabel(evaluation) {
  if (!evaluation?.available) return "尚未生成离线评测报告";
  if (evaluation.acceptance_status === "passed") return "评测验收已通过";
  if (evaluation.acceptance_status === "not_met") return "评测尚未达到门槛";
  if (evaluation.status === "degraded") return "评测运行降级";
  return `样本不足：${evaluation.reviewed_case_count || 0} / ${evaluation.minimum_reviewed_cases || 120} 条人工复核`;
}

function ragReviewBucketLabel(bucket) {
  return {
    named_security: "点名标的",
    implicit_theme: "隐含主题",
    conflicting_attitude: "态度冲突",
    expected_no_evidence: "预期无证据",
    image_or_ocr: "图片／OCR",
    long_research: "长研究帖",
    fallback: "补足样本"
  }[bucket] || "待分类";
}

function updateRagReviewSummary(summary) {
  if (!state.document || !summary || typeof summary !== "object") return;
  state.document = {
    ...state.document,
    rag_optimization: {
      ...(state.document.rag_optimization || {}),
      evaluation: {
        ...(state.document.rag_optimization?.evaluation || {}),
        review: { ...(state.document.rag_optimization?.evaluation?.review || {}), ...summary }
      }
    }
  };
}

function rerenderRagOptimization() {
  if (state.document) renderRagOptimization(state.document);
}

async function loadNextRagEvalReview() {
  state.ragReviewMessage = "正在读取下一条本地待复核样本…";
  rerenderRagOptimization();
  try {
    const queue = await loadRagEvalReviewQueue();
    state.ragReviewQueue = queue;
    updateRagReviewSummary(queue.summary);
    const item = queue.items?.[0];
    state.ragReviewPreview = item ? await loadRagEvalReviewPreview(item.case_id) : null;
    state.ragReviewMessage = item ? "请根据候选证据填写人工判断；不会自动采纳系统结论。" : "当前没有待复核样本。可生成或刷新分层队列。";
  } catch {
    state.ragReviewPreview = null;
    state.ragReviewMessage = "无法读取本地复核队列；请确认看板服务仍在运行。";
  }
  rerenderRagOptimization();
}

async function generateRagEvalReviews() {
  state.ragReviewMessage = "正在从本地历史档案生成分层待复核队列…";
  rerenderRagOptimization();
  try {
    const result = await generateRagEvalReviewQueue();
    updateRagReviewSummary(result?.review?.summary);
    state.ragReviewQueue = null;
    state.ragReviewPreview = null;
    await loadNextRagEvalReview();
  } catch {
    state.ragReviewMessage = "复核队列未生成；本地归档或服务当前不可用。";
    rerenderRagOptimization();
  }
}

async function runLocalRagEvaluation() {
  state.ragReviewMessage = "正在运行本地冻结评测；仅使用已经人工确认的样本。";
  rerenderRagOptimization();
  try {
    const result = await runRagEvaluation();
    const report = result?.report || {};
    if (state.document?.rag_optimization?.evaluation) {
      state.document.rag_optimization.evaluation = { ...state.document.rag_optimization.evaluation, ...report };
    }
    state.ragReviewMessage = `本地评测已完成：${ragEvaluationStatusLabel(report)}。`;
  } catch {
    state.ragReviewMessage = "本地评测未完成；请确认本地索引和冻结样本均可读取。";
  }
  rerenderRagOptimization();
}

async function saveRagEvalReview({ caseId, reviewerInput, noEvidenceInput, candidateInputs }) {
  const reviewer = String(reviewerInput?.value || "").trim();
  const expectedNoEvidence = noEvidenceInput?.checked === true;
  const labels = expectedNoEvidence ? [] : candidateInputs
    .filter((entry) => entry.selected?.checked)
    .map((entry) => ({
      post_id: entry.post_id,
      relevance: entry.relevance.value,
      evidence_quote: String(entry.quote.value || "").trim(),
      rationale: String(entry.rationale.value || "").trim()
    }));
  state.ragReviewMessage = "正在保存本地人工复核和审计记录…";
  rerenderRagOptimization();
  try {
    const result = await submitRagEvalReview({
      case_id: caseId,
      reviewer,
      expected_no_evidence: expectedNoEvidence,
      labels
    });
    updateRagReviewSummary(result?.review?.summary);
    state.ragReviewQueue = null;
    state.ragReviewPreview = null;
    state.ragReviewMessage = "人工复核已保存，并已更新冻结评测集。";
    await loadNextRagEvalReview();
  } catch {
    state.ragReviewMessage = "未保存：请填写复核人、逐条原文引用与判断理由，并只选择早于查询帖的证据。";
    rerenderRagOptimization();
  }
}

function renderRagReviewWorkbench(panel, review) {
  const section = createElement("section", "rag-review-workbench");
  section.append(createElement("h3", null, "人工复核队列"));
  section.append(createElement("p", "rag-review-copy", "系统只提供历史候选；是否相关、引用哪段原文、以及无证据结论均由本地复核人确认。未经人工确认的条目不会计入 RAG 指标。"));
  const summary = createElement("div", "rag-review-summary");
  summary.append(
    metricCard("队列", `${review.total_count || 0} / ${review.target || 120}`, review.generated_at ? `生成于 ${formatDate(review.generated_at)}` : "尚未生成"),
    metricCard("待复核", String(review.pending_count || 0), `已确认 ${review.approved_count || 0} · 已拒绝 ${review.rejected_count || 0}`),
    metricCard("样本覆盖", Object.entries(review.bucket_counts || {}).map(([bucket, count]) => `${ragReviewBucketLabel(bucket)} ${count}`).join(" · ") || "生成后显示", "分层抽样，不自动标注")
  );
  section.append(summary);

  const controls = createElement("div", "rag-controls");
  const generate = createElement("button", "rag-mode-button", "生成／刷新 120 条复核队列");
  generate.type = "button";
  generate.addEventListener("click", () => { void generateRagEvalReviews(); });
  const next = createElement("button", "rag-mode-button", "读取下一条待复核");
  next.type = "button";
  next.addEventListener("click", () => { void loadNextRagEvalReview(); });
  const evaluate = createElement("button", "rag-mode-button", "运行本地冻结评测");
  evaluate.type = "button";
  evaluate.addEventListener("click", () => { void runLocalRagEvaluation(); });
  controls.append(generate, next, evaluate);
  section.append(controls);
  section.append(createElement("p", "rag-action-status", state.ragReviewMessage || "先生成队列，再逐条人工复核。"));

  const item = state.ragReviewQueue?.items?.[0];
  const preview = state.ragReviewPreview;
  if (!item || preview?.case_id !== item.case_id) {
    section.append(createElement("p", "rag-review-empty", "尚未载入待复核样本。该操作只读取本地归档和本地索引。"));
    panel.append(section);
    return;
  }

  const caseCard = markCurrentTabSearchRecord(createElement("article", "rag-review-case"), item);
  caseCard.append(createElement("h4", null, `${ragReviewBucketLabel(item.bucket)} · ${formatDate(item.query?.published_at)}`));
  caseCard.append(createElement("p", "rag-review-query", item.query?.text || "查询原帖不可用。"));
  if (item.query?.url) caseCard.append(createExternalLink(item.query.url, "打开查询原帖"));
  const form = createElement("form", "rag-review-form");
  const reviewerLabel = createElement("label", "rag-review-field", "本地复核人");
  const reviewerInput = createElement("input", "rag-review-input");
  reviewerInput.type = "text";
  reviewerInput.maxLength = 80;
  reviewerInput.required = true;
  reviewerInput.placeholder = "填写姓名或固定代号";
  reviewerLabel.append(reviewerInput);
  form.append(reviewerLabel);
  const noEvidenceLabel = createElement("label", "rag-review-checkbox");
  const noEvidenceInput = createElement("input");
  noEvidenceInput.type = "checkbox";
  noEvidenceLabel.append(noEvidenceInput, document.createTextNode("确认：严格早于本帖的本地历史中，没有应保留的关联证据"));
  form.append(noEvidenceLabel);
  const candidateInputs = [];
  const candidates = Array.isArray(preview.candidates) ? preview.candidates : [];
  if (candidates.length) {
    const candidateList = createElement("div", "rag-review-candidates");
    candidateList.append(createElement("h5", null, "系统候选（需人工逐条确认）"));
    for (const candidate of candidates) {
      const candidateCard = createElement("article", "rag-review-candidate");
      const selected = createElement("input");
      selected.type = "checkbox";
      const selectedLabel = createElement("label", "rag-review-checkbox");
      selectedLabel.append(selected, document.createTextNode(`${formatDate(candidate.published_at)} · 原帖 ${candidate.post_id}`));
      candidateCard.append(selectedLabel);
      candidateCard.append(createElement("p", "rag-review-candidate-text", candidate.text));
      if (candidate.url) candidateCard.append(createExternalLink(candidate.url, "打开历史原帖"));
      const relevance = createElement("select", "rag-review-select");
      for (const [value, label] of [["support", "支持"], ["counter", "反证"], ["context", "语境"], ["irrelevant", "不相关"]]) {
        const option = createElement("option", null, label);
        option.value = value;
        relevance.append(option);
      }
      const quote = createElement("input", "rag-review-input");
      quote.type = "text";
      quote.maxLength = 800;
      quote.placeholder = "从上方原帖摘取能原样匹配的短引用";
      const rationale = createElement("textarea", "rag-review-textarea");
      rationale.maxLength = 800;
      rationale.placeholder = "说明为何该证据支持、反驳或构成语境";
      candidateCard.append(relevance, quote, rationale);
      candidateList.append(candidateCard);
      candidateInputs.push({ post_id: candidate.post_id, selected, relevance, quote, rationale });
    }
    form.append(candidateList);
  } else {
    form.append(createElement("p", "rag-review-empty", "本地检索未返回可审候选；可确认无证据，或稍后检查本地索引。"));
  }
  const save = createElement("button", "rag-mode-button", "保存人工复核");
  save.type = "submit";
  form.append(save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveRagEvalReview({ caseId: item.case_id, reviewerInput, noEvidenceInput, candidateInputs });
  });
  caseCard.append(form);
  section.append(caseCard);
  panel.append(section);
}

export function renderRagOptimization(documentData) {
  const panel = byId("rag-optimization");
  if (!panel) return;
  const rag = documentData.rag_optimization || { mode: "classic", index: {}, retrieval: {} };
  const index = rag.index || {};
  const optimization = index.optimization || {};
  const evaluation = rag.evaluation || {};
  const retrieval = rag.retrieval || {};
  panel.replaceChildren();
  const heading = createElement("div", "panel-heading");
  const headingText = createElement("div");
  headingText.append(createElement("p", "eyebrow", "OFFICIAL NARRATIVE CAPABILITY"));
  headingText.append(createElement("h2", null, "本地 RAG 历史关联"));
  heading.append(headingText, createElement("span", `status-chip ${rag.mode === "rag_active" ? "long-term-status-positive" : "long-term-status-neutral"}`, rag.mode === "rag_active" ? "已开启" : "已关闭"));
  panel.append(heading);
  panel.append(createElement("p", "rag-mode-copy", ragModeLabel(rag.mode)));

  const controls = createElement("div", "rag-controls");
  for (const [mode, label] of [["classic", "关闭并回退规则链路"], ["rag_active", "开启并纳入正式叙事"]]) {
    const button = createElement("button", `rag-mode-button${rag.mode === mode ? " is-selected" : ""}`, label);
    button.type = "button";
    button.dataset.ragMode = mode;
    button.disabled = rag.mode === mode;
    button.addEventListener("click", () => { void applyRagActivation(mode); });
    controls.append(button);
  }
  panel.append(controls);
  const status = createElement("p", "rag-action-status", "");
  status.id = "rag-action-status";
  panel.append(status);

  const metrics = createElement("div", "rag-metric-grid");
  metrics.append(
    metricCard("索引", ragIndexStatusLabel(index.status), `${index.indexed_post_count || 0} 帖 · ${index.indexed_chunk_count || 0} 段`),
    metricCard("本地模型", index.embedding_model || "等待首次索引", index.last_success_at ? `最近成功 ${formatDate(index.last_success_at)}` : "不使用外部推理"),
    metricCard("候选召回", "80 / 80 / 40", "向量／全文／标的主题"),
    metricCard("最终证据", retrieval.final_top_k || "3–8", "经过加权 RRF 与严格时序过滤")
  );
  panel.append(metrics);
  const maintenance = createElement("div", "rag-maintenance-grid");
  maintenance.append(
    metricCard("索引压实", ragOptimizationStatusLabel(optimization.status), `已入索引 ${optimization.indexed_row_count || 0} 段 · 待压实 ${optimization.unindexed_row_count || 0} 段${optimization.duration_ms ? ` · 最近耗时 ${formatDuration(optimization.duration_ms)}` : ""}`),
    metricCard("离线评测", ragEvaluationStatusLabel(evaluation), evaluation.generated_at ? `最近报告 ${formatDate(evaluation.generated_at)}` : "只统计人工复核的冻结样本")
  );
  panel.append(maintenance);
  const evaluationSection = createElement("section", "rag-evaluation-summary");
  evaluationSection.append(createElement("h3", null, "Top-K 历史关联评测"));
  const evaluationMetrics = evaluation.metrics || {};
  const evaluationGrid = createElement("div", "rag-evaluation-grid");
  evaluationGrid.append(
    metricCard("Recall@10", formatPercent(evaluationMetrics.recall_at_10), `人工复核 ${evaluation.reviewed_case_count || 0} / ${evaluation.minimum_reviewed_cases || 120}`),
    metricCard("nDCG@10", formatPercent(evaluationMetrics.ndcg_at_10), `MRR@10 ${formatPercent(evaluationMetrics.mrr_at_10)}`),
    metricCard("Top-5 有效证据", formatPercent(evaluationMetrics.top_5_precision), `引用可解析 ${formatPercent(evaluationMetrics.citation_parse_rate)}`),
    metricCard("安全拦截", `时间穿越 ${evaluationMetrics.temporal_leakage_count || 0}`, `非作者来源 ${evaluationMetrics.source_leakage_count || 0}`)
  );
  evaluationSection.append(evaluationGrid);
  if (evaluation.unmet_thresholds?.length) {
    evaluationSection.append(createElement("p", "rag-guardrail", `未达到门槛：${evaluation.unmet_thresholds.join("、")}。该结果不会改变盘中硬交易规则。`));
  }
  panel.append(evaluationSection);
  renderRagReviewWorkbench(panel, evaluation.review || {});
  panel.append(createElement("p", "rag-guardrail", retrieval.temporal_guard || "只使用当前帖之前、且来源已校验的历史帖子"));
  panel.append(createElement("p", "rag-guardrail", `检索链路：${(retrieval.channels || []).join(" → ")}；RRF 权重 ${retrieval.rrf || "0.45 / 0.30 / 0.25"}。仅提供叙事证据，不会创建交易或模拟订单。`));
}

function possibleHoldingsConfidenceLabel(confidence) {
  return { high: "高", medium: "中", low: "低" }[confidence] || "未知";
}

function possibleHoldingsPercent(value) {
  return value === null || value === undefined || value === "" ? null : `${value}%`;
}

function possibleHoldingsEvidenceUrl(value) {
  const url = String(value || "");
  return /^https:\/\/xueqiu\.com\/\d+\/\d+$/.test(url) ? url : null;
}

function possibleHoldingsInfo(definition) {
  const info = createElement("span", "possible-holdings-info", "ⓘ");
  info.title = definition;
  info.tabIndex = 0;
  info.setAttribute("data-tooltip", definition);
  info.setAttribute("aria-label", definition);
  return info;
}

function possibleHoldingsDataLine(className, label, value, definition) {
  const line = createElement("p", className);
  line.append(document.createTextNode(`${label}：${value}`), possibleHoldingsInfo(definition));
  return line;
}

const PUBLIC_TRADE_EVIDENCE_DEFINITIONS = Object.freeze({
  status: "当前持有状态只根据最近公开原帖中的明确自述判断。历史买入、提及、沉默或未指明标的的卖出，均不会被推断为当前持有或已退出。",
  latest: "最近可核验交易/持有自述的时间来自该标的所有已校验原帖证据中的最新一条；它不等于真实账户的最后成交时间。",
  disclosed: "本人公开自述仓位只展示同一条已校验原帖中、明确指向该标的的百分比。它是原帖陈述，不是经账户核验的真实持仓。",
  history: "历史交易证据仅收录小马甲本人明确陈述的买入、建仓、加仓、抄底或与该标的直接关联的盈利结果；点击原帖可核对。",
  current: "近期持有自述仅收录小马甲本人明确称仍持有、持仓或重仓的原帖，并只在原帖发布后的设定期限内显示为“最近公开自述持有”。",
  counter: "减仓、卖出、止盈等非最终退出表述会保留为约束，但不会被解释为已清仓。",
  exit: "只有小马甲本人明确写出清仓、卖光、全部卖出、全部退出或不再持有，才标记为已见明确退出。"
});

const PUBLIC_TRADE_EVIDENCE_RULE_LABELS = Object.freeze({
  direct_position: "本人明确持有或重仓",
  public_action: "本人明确买入、建仓或加仓",
  implicit_past_action: "作者以过去时明确记录买入或抄底",
  historical_outcome: "作者明确记录该标的盈利结果",
  explicit_exit: "本人明确清仓或不再持有",
  partial_exit: "本人明确卖出或减仓，但未说明已清仓"
});

function possibleHoldingsRuleLabel(rule) {
  return PUBLIC_TRADE_EVIDENCE_RULE_LABELS[rule] || "未记录可验证规则";
}

function possibleHoldingsEvidenceSection(title, evidence, emptyText, definition) {
  const section = createElement("section", "possible-holdings-evidence");
  const heading = createElement("h4");
  heading.append(document.createTextNode(title), possibleHoldingsInfo(definition));
  section.append(heading);
  if (!evidence?.length) {
    section.append(createElement("p", "possible-holdings-meta", emptyText));
    return section;
  }
  const list = createElement("ul", "possible-holdings-evidence-list");
  for (const source of evidence) {
    const item = createElement("li", "possible-holdings-evidence-item");
    if (source.quote) item.append(createElement("p", "possible-holdings-quote", source.quote));
    const meta = createElement("p", "possible-holdings-meta");
    meta.append(document.createTextNode(`${formatDate(source.published_at)} · ${possibleHoldingsRuleLabel(source.rule)} · `));
    const url = possibleHoldingsEvidenceUrl(source.url);
    if (url) meta.append(createExternalLink(url, `原帖 ${source.post_id || "链接"}`));
    else meta.append(document.createTextNode(`原帖 ${source.post_id || "未记录"}`));
    item.append(meta);
    list.append(item);
  }
  section.append(list);
  return section;
}

export function renderPossibleHoldings(documentData) {
  const panel = byId("holdings-list");
  if (!panel) return;
  const holdings = documentData?.possible_holdings || {};
  const items = Array.isArray(holdings.items) ? holdings.items : [];
  const recentExits = Array.isArray(holdings.recent_exits) ? holdings.recent_exits : [];
  panel.replaceChildren();

  if (items.length || recentExits.length) {
    const methodology = createElement("section", "possible-holdings-methodology");
    methodology.append(createElement("h3", null, "公开交易证据口径"));
    methodology.append(createElement("p", "possible-holdings-copy", holdings.methodology || "仅展示可回溯的公开交易证据，不推断真实持仓、仓位比例或重仓程度。"));
    methodology.append(createElement("p", "possible-holdings-meta", `截至 ${formatDate(holdings.as_of)} · 回看 ${holdings.lookback_days ?? "暂无"} 天 · 最近持有自述有效期 ${holdings.current_statement_days ?? "暂无"} 天。历史证据不自动推断当前持仓。`));
    panel.append(methodology);
  }

  if (!items.length) {
    panel.append(createElement("p", "empty-state", "没有可核验的历史交易或明确退出证据；这不表示作者没有持仓。"));
  } else {
    const list = createElement("div", "possible-holdings-list");
    for (const holding of items) {
      const support = Array.isArray(holding.supporting_evidence) ? holding.supporting_evidence : [];
      const historical = Array.isArray(holding.historical_evidence) ? holding.historical_evidence : support;
      const current = Array.isArray(holding.current_evidence) ? holding.current_evidence : [];
      const counter = Array.isArray(holding.counter_evidence) ? holding.counter_evidence : [];
      const card = markCurrentTabSearchRecord(createElement("article", "possible-holdings-card"), {
        ...holding,
        historical_evidence: historical,
        current_evidence: current,
        counter_evidence: counter
      });
      const heading = createElement("div", "possible-holdings-heading");
      heading.append(createElement("h3", null, `${holding.security_name || "未命名标的"} · ${holding.symbol || "未记录代码"}`));
      const chips = createElement("div", "possible-holdings-chips");
      const statusClass = holding.current_status === "recent_self_reported_holding"
        ? "possible-holdings-chip-direct"
        : "possible-holdings-chip-insufficient";
      chips.append(createElement("span", `status-chip possible-holdings-chip ${statusClass}`, holding.current_status_label || "当前是否持有未知"));
      chips.append(possibleHoldingsInfo(PUBLIC_TRADE_EVIDENCE_DEFINITIONS.status));
      heading.append(chips);
      card.append(heading);
      card.append(possibleHoldingsDataLine("possible-holdings-meta", "最近可核验交易/持有自述", holding.latest_verified_trade_at ? formatDate(holding.latest_verified_trade_at) : "未记录", PUBLIC_TRADE_EVIDENCE_DEFINITIONS.latest));
      const disclosed = possibleHoldingsPercent(holding.public_disclosed_allocation_pct);
      if (disclosed) card.append(possibleHoldingsDataLine("possible-holdings-meta", "本人公开自述仓位", disclosed, PUBLIC_TRADE_EVIDENCE_DEFINITIONS.disclosed));
      card.append(
        possibleHoldingsEvidenceSection("历史交易证据", historical, "未记录历史交易原帖。", PUBLIC_TRADE_EVIDENCE_DEFINITIONS.history),
        possibleHoldingsEvidenceSection("近期持有自述", current, "未记录近期本人持有自述。", PUBLIC_TRADE_EVIDENCE_DEFINITIONS.current),
        possibleHoldingsEvidenceSection("减仓/卖出等非最终退出证据", counter.filter((item) => item.rule !== "explicit_exit"), "未记录非最终退出原帖。", PUBLIC_TRADE_EVIDENCE_DEFINITIONS.counter)
      );
      list.append(card);
    }
    panel.append(list);
  }

  if (recentExits.length) {
    const exits = createElement("section", "possible-holdings-exits");
    exits.append(createElement("h3", null, "已见明确退出（不计入当前状态）"));
    exits.append(createElement("p", "possible-holdings-copy", "仅为中性历史公开证据，不构成操作建议。"));
    const list = createElement("div", "possible-holdings-exit-list");
    for (const exit of recentExits) {
      const counter = Array.isArray(exit.counter_evidence) ? exit.counter_evidence : [];
      const card = markCurrentTabSearchRecord(createElement("article", "possible-holdings-exit-card"), { ...exit, counter_evidence: counter });
      card.append(createElement("h4", null, `${exit.security_name || "未命名标的"} · ${exit.symbol || "未记录代码"}`));
      card.append(possibleHoldingsDataLine("possible-holdings-meta", "明确退出时间", exit.exit_at ? formatDate(exit.exit_at) : "未记录", PUBLIC_TRADE_EVIDENCE_DEFINITIONS.exit));
      const disclosed = possibleHoldingsPercent(exit.public_disclosed_allocation_pct);
      if (disclosed) card.append(possibleHoldingsDataLine("possible-holdings-meta", "本人公开自述仓位", disclosed, PUBLIC_TRADE_EVIDENCE_DEFINITIONS.disclosed));
      card.append(possibleHoldingsEvidenceSection("明确退出证据", counter.filter((item) => item.rule === "explicit_exit"), "未记录退出原帖。", PUBLIC_TRADE_EVIDENCE_DEFINITIONS.exit));
      list.append(card);
    }
    exits.append(list);
    panel.append(exits);
  }
}

async function applyRagActivation(mode) {
  const status = byId("rag-action-status");
  if (status) status.textContent = "正在保存本地模式…";
  try {
    const activation = await setRagActivation(mode);
    if (state.document) {
      state.document = {
        ...state.document,
        rag_optimization: {
          ...(state.document.rag_optimization || {}),
          mode: activation.mode,
          activation: { ...(state.document.rag_optimization?.activation || {}), ...activation }
        }
      };
      renderRagOptimization(state.document);
    }
  } catch {
    if (status) status.textContent = "本地模式未保存；请确认看板服务仍在运行。";
  }
}

function bindRagOptimization() {
  // Buttons are intentionally attached during render so that their displayed
  // enabled state always follows the latest persisted local mode.
}

function renderError(message, { hasSnapshot = false } = {}) {
  const area = byId("dashboard-error");
  area.hidden = false;
  area.textContent = hasSnapshot
    ? `最新本地看板数据暂未读取：${message}。当前仍显示上次成功快照；确认本地服务后可手动刷新页面。`
    : `无法读取本地看板数据：${message}。请确认本地服务正在运行后手动刷新页面。`;
}

export function renderDashboard(documentData) {
  state.document = documentData;
  byId("dashboard-error").hidden = true;
  if (documentData.history?.page_loaded === false) {
    state.historyPage = null;
    state.inspirationPage = null;
  } else if (Array.isArray(documentData.history?.items) && !state.historyPage) {
    state.historyPage = {
      available: documentData.history.available === true,
      total: documentData.history.items.length,
      items: documentData.history.items
    };
    state.inspirationPage = {
      available: documentData.history.available === true,
      total: documentData.history.items.filter((item) => item?.is_inspirational === true).length,
      items: documentData.history.items
    };
  }
  state.commandCenterGeneratedAt = documentData.generated_at || state.commandCenterGeneratedAt;
  state.commandCenterRefreshError = false;
  byId("generated-at").textContent = dashboardReadHeader(documentData);
  renderCoverageWarning(documentData);
  renderAuthorAgents(documentData);
  renderCommandCenter(documentData);
  renderInspirations(documentData);
  renderOperations(documentData);
  renderRagOptimization(documentData);
  renderGlobalArchiveSearch();
  if (state.xiaomajiaView === "inspirations") void ensureInspirationsLoaded();
}

function bindFilters() {
  byId("candidate-filters")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-status]");
    if (!button) return;
    state.status = button.dataset.status;
    for (const item of byId("candidate-filters").querySelectorAll("button[data-status]")) {
      item.classList.toggle("is-selected", item === button);
    }
    renderCandidateList();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindDailyReviews();
  bindNextDayReviews();
  bindKronos();
  bindLogicHistory();
  byId('inspiration-refresh')?.addEventListener('click',()=>{void ensureInspirationsLoaded({force:true});});
  bindDashboardTabs();
  bindXiaomajiaViews();
  bindFilters();
  bindGlobalArchiveSearch();
  bindRagOptimization();
  const dashboardLoad = loadDashboardWithSnapshot({
    render: (documentData) => renderDashboard({ ...documentData, command_center: state.document?.command_center || documentData.command_center }),
    report: renderDashboardLoadStatus,
    onError: (error, context) => renderError(error?.message || "未知错误", context)
  });
  void refreshCommandCenter();
  startCommandCenterRefresh();
  await dashboardLoad;
});
