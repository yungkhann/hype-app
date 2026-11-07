// ATLAS backend client. Conversations are imported and stored by the backend (/api/v1/cqa); the browser never
// calls the organizers' API itself, so its signed URL stays on the server.

import { hasKey, t } from "./i18n.js?v=tape7";

export const GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Where the API lives: <meta name="cqa-api"> when set, else :8000 on localhost, else /api/v1 on this origin
 * (the web container's nginx proxies it to the api service, see docker/nginx-web.conf).
 */
export function apiBase() {
  const configured = document.querySelector('meta[name="cqa-api"]')?.content?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const { hostname, origin } = location;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return `http://${hostname}:8000/api/v1`;
  }
  return `${origin}/api/v1`;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", details = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = "GET", body, raw = false } = {}) {
  const base = apiBase();
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(t("error.api_unreachable", { base }), { code: "api_unreachable" });
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = data?.error;
    throw new ApiError(error?.message || t("error.http", { status: response.status }), {
      status: response.status,
      code: error?.code || "",
      details: error?.details ?? null,
    });
  }
  return raw ? text : data;
}

/**
 * A readable message: a translation for the error codes people act on, else the API's own message; for a rejected
 * request body, the first field errors instead of "Request validation failed."
 */
export function errorText(err) {
  if (err?.code && hasKey(`error.${err.code}`)) return t(`error.${err.code}`, { base: apiBase() });
  if (err?.code === "invalid_request" && Array.isArray(err.details)) {
    const messages = err.details.slice(0, 3).map((d) => String(d?.msg ?? "").replace(/^Value error, /, "")).filter(Boolean);
    if (messages.length) return messages.join(" ");
  }
  return err?.message || t("error.generic");
}

export const listChecklists = () => request("/cqa/checklists");
export const getChecklist = (id) => request(`/cqa/checklists/${encodeURIComponent(id)}`);
export const createChecklist = (body) => request("/cqa/checklists", { method: "POST", body });
/** Saves a changed configuration as a new version; base_version guards against overwriting someone else's save. */
export const updateChecklist = (id, body) => request(`/cqa/checklists/${encodeURIComponent(id)}`, { method: "PUT", body });

export const listChecklistVersions = (id) => request(`/cqa/checklists/${encodeURIComponent(id)}/versions`);

/** Queue a backend (GPT) evaluation; the response lists the queued evaluations, poll getEvaluation for the result. */
export const startEvaluation = (body) => request("/cqa/evaluations", { method: "POST", body });
/** A new evaluation like the given one; after a failure in a mode only the failed provider is asked again. */
export const rerunEvaluation = (id) => request(`/cqa/evaluations/${encodeURIComponent(id)}/rerun`, { method: "POST" });
export const getEvaluation = (id) => request(`/cqa/evaluations/${encodeURIComponent(id)}`);
export const listEvaluations = (params) => request(`/cqa/evaluations?${new URLSearchParams(params)}`);

/** Playable source for a call recording (the stored audio_url is the organizers' player page, not an audio file). */
export const getAudio = (conversationId) => request(`/cqa/conversations/${encodeURIComponent(conversationId)}/audio`);

// Appeals: submitting one makes the backend ask GPT for a separate reassessment; the manager then decides.
export const listAppeals = (params = {}) => request(`/cqa/appeals?${new URLSearchParams(params)}`);
export const getAppeal = (id) => request(`/cqa/appeals/${encodeURIComponent(id)}`);
export const createAppeal = (body) => request("/cqa/appeals", { method: "POST", body });
/** Retry GPT's reassessment after it failed (the backend limits the number of attempts). */
export const reassessAppeal = (id) => request(`/cqa/appeals/${encodeURIComponent(id)}/reassess`, { method: "POST" });
/** {decision: "confirm" | "accept" | "override", explanation, reviewer, override?: {value, is_na, severe_error}} */
export const decideAppeal = (id, body) => request(`/cqa/appeals/${encodeURIComponent(id)}/decision`, { method: "POST", body });

export const cqaInfo = () => request("/cqa/info");
export const listConversationRecords = () => request("/cqa/conversation-records");
export const importGroup = (groupId) => request("/cqa/imports", { method: "POST", body: { group_id: groupId } });
export const importJson = (payload) => request("/cqa/imports/json", { method: "POST", body: payload });

// Organizers' results file (JSON 1.0), built by the backend from stored evaluations; checking it evaluates nothing.
export const cqaOverview = () => request("/cqa/overview");
export const resultsReport = (params) => request(`/cqa/results/export?${new URLSearchParams(params)}`);
/** The results.json text exactly as the backend renders it (409 with the reasons while it is not ready). */
export const resultsFile = (params) => request(`/cqa/results/export/download?${new URLSearchParams(params)}`, { raw: true });
