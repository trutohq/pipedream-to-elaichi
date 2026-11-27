import type { DraftBody } from './types.ts'

export interface PushResult {
  file: string
  ok: boolean
  id?: string
  issues?: number
  errors?: number
  error?: string
}

export interface ValidateResult {
  file: string
  ok: boolean
  definition_valid?: boolean
  issues?: { severity?: string; code?: string; message?: string; path?: unknown }[]
  error?: string
}

export interface ApiOpts {
  token: string
  apiUrl?: string
  fetch?: typeof fetch
}

/** One Elaichi API answer. `code`, `message` and `details` come from the JSON error body (`{ error: { code, … } }` or a bare `{ code, … }`). */
export interface ApiResponse {
  ok: boolean
  /** HTTP status, or 0 when the request never got an answer. */
  status: number
  json: unknown
  /** The raw body. Callers whose request carried secrets must not write it anywhere. */
  text: string
  code?: string
  message?: string
  details?: unknown
  retryAfter?: number
  /** Network error message, when there was no answer. */
  networkError?: string
}

/** Calls the Elaichi API with the token. Never logs anything. No organization header: the token already names the organization. */
export async function request(method: string, path: string, body: unknown, opts: ApiOpts): Promise<ApiResponse> {
  const base = (opts.apiUrl ?? 'https://api.elaichi.ai').replace(/\/+$/, '')
  try {
    const res = await (opts.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    const j = (json && typeof json === 'object' ? json : {}) as { error?: unknown; code?: unknown; message?: unknown; details?: unknown }
    const e = (j.error && typeof j.error === 'object' ? j.error : j) as { code?: unknown; message?: unknown; details?: unknown }
    const retry = Number(res.headers.get('Retry-After'))
    return {
      ok: res.ok,
      status: res.status,
      json,
      text,
      ...(res.ok ? {} : { code: typeof e.code === 'string' ? e.code : undefined, message: typeof e.message === 'string' ? e.message : typeof j.error === 'string' ? j.error : undefined, details: e.details }),
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
    }
  } catch (e) {
    return { ok: false, status: 0, json: undefined, text: '', networkError: (e as Error).message }
  }
}

async function post(path: string, body: unknown, opts: ApiOpts): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const r = await request('POST', path, body, opts)
  if (r.networkError !== undefined) return { ok: false, error: r.networkError }
  if (!r.ok) return { ok: false, error: `${r.status} ${r.code ?? ''} ${r.message ?? r.text.slice(0, 200)}`.trim() }
  return { ok: true, json: r.json }
}

/**
 * Creates each draft with `POST /automation`. That route only saves a draft (issues and all);
 * this module never calls publish or enable, so nothing runs.
 */
export async function pushDrafts(drafts: { file: string; body: DraftBody }[], opts: ApiOpts): Promise<PushResult[]> {
  const results: PushResult[] = []
  for (const d of drafts) {
    const r = await post('/automation', d.body, opts)
    if (!r.ok) {
      results.push({ file: d.file, ok: false, error: r.error })
      continue
    }
    const body = r.json as { automation?: { id?: string }; issues?: { severity?: string }[] } | undefined
    const issues = body?.issues ?? []
    results.push({ file: d.file, ok: true, id: body?.automation?.id, issues: issues.length, errors: issues.filter(i => i.severity === 'error').length })
  }
  return results
}

/** Checks each draft with `POST /automation/validate`, which saves nothing. It also checks that toolboxes and tools exist. */
export async function validateDrafts(drafts: { file: string; body: DraftBody }[], opts: ApiOpts): Promise<ValidateResult[]> {
  const results: ValidateResult[] = []
  for (const d of drafts) {
    const r = await post('/automation/validate', { definition: d.body.definition }, opts)
    if (!r.ok) {
      results.push({ file: d.file, ok: false, error: r.error })
      continue
    }
    const body = r.json as { definition_valid?: boolean; issues?: ValidateResult['issues'] } | undefined
    const issues = body?.issues ?? []
    results.push({ file: d.file, ok: body?.definition_valid === true && !issues.some(i => i.severity === 'error'), definition_valid: body?.definition_valid, issues })
  }
  return results
}
