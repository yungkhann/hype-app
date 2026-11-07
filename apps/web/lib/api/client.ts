/**
 * Thin fetch wrapper for the local ATLAS API. The API runs on 127.0.0.1 only; nothing here
 * contacts any other host.
 */

export const API_ORIGIN = (process.env.NEXT_PUBLIC_ATLAS_API ?? "http://127.0.0.1:8000").replace(/\/$/, "");
export const API_BASE = `${API_ORIGIN}/api/v1`;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = "error",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Body = Record<string, unknown> | unknown[] | object;

async function parseError(response: Response): Promise<ApiError> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error body */
  }
  const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  if (error?.message) return new ApiError(error.message, response.status, error.code, error.details);
  const detail = (payload as { detail?: unknown } | null)?.detail;
  if (Array.isArray(detail)) {
    const first = detail[0] as { loc?: unknown[]; msg?: string } | undefined;
    const where = first?.loc?.filter((p) => p !== "body").join(".");
    return new ApiError(`${where ? `${where}: ` : ""}${first?.msg ?? "Invalid request"}`, response.status, "validation_error", detail);
  }
  if (typeof detail === "string") return new ApiError(detail, response.status);
  return new ApiError(`Request failed (${response.status} ${response.statusText})`, response.status);
}

export async function api<T>(path: string, init: { method?: string; body?: Body; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      cache: "no-store",
    });
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") throw cause;
    throw new ApiError(
      `Cannot reach the ATLAS API at ${API_ORIGIN}. Start it with "pnpm dev" (or "pnpm dev:api").`,
      0,
      "api_unreachable",
    );
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Fetch a binary/text export as a Blob (keeps the structured error handling). */
export async function apiBlob(path: string, init: { method?: string; body?: Body } = {}): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) throw await parseError(response);
  return response.blob();
}

/** Multipart upload with progress, via XHR (fetch has no upload progress). */
export function uploadFile<T>(
  path: string,
  file: File,
  fields: Record<string, string | undefined>,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${path}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T);
        return;
      }
      const error = (xhr.response as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      reject(new ApiError(error?.message ?? `Upload failed (${xhr.status})`, xhr.status, error?.code, error?.details));
    };
    xhr.onerror = () =>
      reject(new ApiError(`Cannot reach the ATLAS API at ${API_ORIGIN}. Is "pnpm dev" running?`, 0, "api_unreachable"));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0, "cancelled"));
    signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("file", file);
    for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value);
    xhr.send(form);
  });
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}
