// ATLAS backend client. Conversations are imported and stored by the backend (/api/v1/cqa); the browser never
// calls the organizers' API itself, so its signed URL stays on the server.

export const GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Where the API lives: <meta name="cqa-api"> when set, else :8000 on localhost, else api.<this domain>. */
export function apiBase() {
  const configured = document.querySelector('meta[name="cqa-api"]')?.content?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const { protocol, hostname } = location;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return `http://${hostname}:8000/api/v1`;
  }
  return `${protocol}//api.${hostname.replace(/^www\./, "")}/api/v1`;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", details = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = "GET", body } = {}) {
  const base = apiBase();
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`Cannot reach the ATLAS API at ${base}. Check that the API is running.`, { code: "api_unreachable" });
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
    throw new ApiError(error?.message || `The ATLAS API answered HTTP ${response.status}.`, {
      status: response.status,
      code: error?.code || "",
      details: error?.details ?? null,
    });
  }
  return data;
}

/** The API's message; for a rejected request body, the first field errors instead of "Request validation failed." */
export function errorText(err) {
  if (err?.code === "invalid_request" && Array.isArray(err.details)) {
    const messages = err.details.slice(0, 3).map((d) => String(d?.msg ?? "").replace(/^Value error, /, "")).filter(Boolean);
    if (messages.length) return messages.join(" ");
  }
  return err?.message || "Something went wrong.";
}

export const listChecklists = () => request("/cqa/checklists");
export const getChecklist = (id) => request(`/cqa/checklists/${encodeURIComponent(id)}`);
export const createChecklist = (body) => request("/cqa/checklists", { method: "POST", body });
/** Saves a changed configuration as a new version; base_version guards against overwriting someone else's save. */
export const updateChecklist = (id, body) => request(`/cqa/checklists/${encodeURIComponent(id)}`, { method: "PUT", body });

export const listChecklistVersions = (id) => request(`/cqa/checklists/${encodeURIComponent(id)}/versions`);

/** Queue a backend (GPT) evaluation; the response lists the queued evaluations, poll getEvaluation for the result. */
export const startEvaluation = (body) => request("/cqa/evaluations", { method: "POST", body });
export const getEvaluation = (id) => request(`/cqa/evaluations/${encodeURIComponent(id)}`);
export const listEvaluations = (params) => request(`/cqa/evaluations?${new URLSearchParams(params)}`);

export const cqaInfo = () => request("/cqa/info");
export const listConversationRecords = () => request("/cqa/conversation-records");
export const importGroup = (groupId) => request("/cqa/imports", { method: "POST", body: { group_id: groupId } });
export const importJson = (payload) => request("/cqa/imports/json", { method: "POST", body: payload });
