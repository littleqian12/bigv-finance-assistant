const XUEQIU_HOSTS = new Set(["xueqiu.com", "www.xueqiu.com"]);
const AUTHOR_CAPABILITIES = new Set(["history_rag", "implicit_signal", "long_term_tracking", "image_ocr"]);
const DELIVERY_POLICIES = new Set(["never", "digest_only", "high_confidence_only"]);

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function extractXueqiuUserId(homepage) {
  const value = asText(homepage);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !XUEQIU_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const userId = parts[0] === "u" ? parts[1] : parts[0];
    return /^\d{4,20}$/.test(userId || "") ? userId : null;
  } catch {
    return null;
  }
}

export function buildAuthorAgentDraft({ homepage, authorName } = {}) {
  const userId = extractXueqiuUserId(homepage);
  if (!userId) throw new Error("author_agent_draft_supported_xueqiu_homepage_required");
  const sourceId = `xueqiu-${userId}`;
  const name = asText(authorName) || `雪球用户 ${userId}`;
  return {
    version: 1,
    kind: "author_agent_draft",
    source_id: sourceId,
    lifecycle: "draft",
    author: {
      name,
      user_id: userId,
      homepage: `https://xueqiu.com/u/${userId}`
    },
    storage_root: `archives/${sourceId}`,
    rag_namespace: sourceId,
    capabilities: ["history_rag", "implicit_signal", "long_term_tracking"],
    scheduling: {
      live_capture: { every_minutes: 5, windows: [["09:30", "11:30"], ["13:00", "15:00"]] },
      archive_capture: { every_minutes: 60, outside_trading_hours: true }
    },
    delivery: { policy: "never", requires_explicit_evidence: true },
    runtime: { starts_jobs: false, calls_cdp: false, writes_sources_json: false, sends_delivery: false },
    onboarding: { next_step: "access_validation" }
  };
}

export function buildAuthorRegistrationRequest({
  homepage, authorName, authorizationConfirmed, capabilities,
  liveCaptureMinutes, archiveCaptureMinutes, deliveryPolicy, browserIdentityId, actor
} = {}) {
  const userId = extractXueqiuUserId(homepage);
  if (!userId) throw new Error("author_agent_draft_supported_xueqiu_homepage_required");
  const normalizedCapabilities = Array.isArray(capabilities) ? capabilities.filter((value) => typeof value === "string") : [];
  if (!normalizedCapabilities.length || normalizedCapabilities.some((value) => !AUTHOR_CAPABILITIES.has(value))) throw new Error("author_agent_capabilities_invalid");
  if (new Set(normalizedCapabilities).size !== normalizedCapabilities.length) throw new Error("author_agent_capabilities_invalid");
  if (authorizationConfirmed !== true) throw new Error("author_agent_authorization_confirmation_required");
  if (!Number.isInteger(liveCaptureMinutes) || liveCaptureMinutes < 2 || liveCaptureMinutes > 15) throw new Error("author_agent_live_capture_minutes_invalid");
  if (!Number.isInteger(archiveCaptureMinutes) || archiveCaptureMinutes < 10 || archiveCaptureMinutes > 240) throw new Error("author_agent_archive_capture_minutes_invalid");
  if (!DELIVERY_POLICIES.has(deliveryPolicy)) throw new Error("author_agent_delivery_policy_invalid");
  const normalizedBrowserIdentityId = asText(browserIdentityId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(normalizedBrowserIdentityId)) throw new Error("author_agent_browser_identity_required");
  const normalizedActor = asText(actor);
  if (!normalizedActor) throw new Error("author_agent_actor_required");
  return {
    homepage: `https://xueqiu.com/u/${userId}`,
    author_name: asText(authorName) || `雪球用户 ${userId}`,
    authorization_confirmed: true,
    capabilities: normalizedCapabilities,
    live_capture_minutes: liveCaptureMinutes,
    archive_capture_minutes: archiveCaptureMinutes,
    delivery_policy: deliveryPolicy,
    browser_identity_id: normalizedBrowserIdentityId,
    actor: normalizedActor
  };
}
