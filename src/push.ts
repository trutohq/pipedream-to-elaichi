import type { DraftBody } from './types.ts'

export interface PushResult {
  file: string
  ok: boolean
  id?: string
  issues?: number
  errors?: number
  error?: string
}

/**
 * Creates each draft with `POST /automation`. That route only saves a draft (issues and all);
 * this function never calls publish or enable, so nothing runs.
 */
export async function pushDrafts(
  drafts: { file: string; body: DraftBody }[],
  opts: { token: string; apiUrl?: string; fetch?: typeof fetch },
): Promise<PushResult[]> {
  const doFetch = opts.fetch ?? fetch
  const base = (opts.apiUrl ?? 'https://api.elaichi.ai').replace(/\/+$/, '')
  const results: PushResult[] = []
  for (const d of drafts) {
    try {
      const res = await doFetch(`${base}/automation`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(d.body),
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
        results.push({ file: d.file, ok: false, error: `${res.status} ${err?.code ?? ''} ${err?.message ?? text.slice(0, 200)}`.trim() })
        continue
      }
      const body = json as { automation?: { id?: string }; issues?: { severity?: string }[] } | undefined
      const issues = body?.issues ?? []
      results.push({ file: d.file, ok: true, id: body?.automation?.id, issues: issues.length, errors: issues.filter(i => i.severity === 'error').length })
    } catch (e) {
      results.push({ file: d.file, ok: false, error: (e as Error).message })
    }
  }
  return results
}
