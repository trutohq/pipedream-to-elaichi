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

interface ApiOpts {
  token: string
  apiUrl?: string
  fetch?: typeof fetch
}

async function post(path: string, body: unknown, opts: ApiOpts): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const base = (opts.apiUrl ?? 'https://api.elaichi.ai').replace(/\/+$/, '')
  try {
    const res = await (opts.fetch ?? fetch)(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error
      return { ok: false, error: `${res.status} ${err?.code ?? ''} ${err?.message ?? text.slice(0, 200)}`.trim() }
    }
    return { ok: true, json }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
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
