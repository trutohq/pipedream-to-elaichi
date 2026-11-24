import { checkDefinition } from './check.ts'
import { convertWorkflow } from './convert.ts'
import { looksLikeWorkflow, parseWorkflow, type LoadedInput, type PdWorkflow } from './parse.ts'
import { buildPlan, type MigrationPlan } from './plan.ts'
import type { DraftBody, ProjectReport, WorkflowReport } from './types.ts'

export interface ConvertedProject {
  drafts: { file: string; body: DraftBody }[]
  report: ProjectReport
  plan: MigrationPlan
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workflow'

/** Turns every workflow in a loaded export into a draft body, and records everything it could not convert. */
export function convertProject(input: LoadedInput, inputLabel: string, toolboxes: Record<string, string> = {}, now = new Date()): ConvertedProject {
  const report: ProjectReport = { generated_at: now.toISOString(), input: inputLabel, workflows: [], not_converted: [], notes: [] }
  const drafts: ConvertedProject['drafts'] = []
  const usedNames = new Set<string>()
  const parsed: { wf: PdWorkflow; report: WorkflowReport }[] = []
  const manifest = input.manifest
  const byPath = new Map((manifest?.workflows ?? []).filter(w => w.path).map(w => [w.path as string, w]))

  if (manifest?.truncated) report.notes.push(`Pipedream stopped this export early (${manifest.truncatedReason ?? 'limit reached'}). Move some workflows to another project and export again.`)
  for (const w of manifest?.workflows ?? []) {
    if (w.status && w.status !== 'exported') {
      const reason = w.status === 'skipped_never_deployed' ? 'never deployed in Pipedream, so not exported' : w.status === 'skipped_export_limit' ? 'not exported: the export hit its limit' : `not exported (${w.status})`
      report.not_converted.push({ name: w.name ?? w.hashid ?? '(unnamed)', reason })
    } else if (w.path && !input.files.some(f => f.file === w.path || f.file.endsWith(`/${w.path}`))) {
      report.not_converted.push({ name: w.name ?? w.path, reason: `manifest.json lists ${w.path}, but the file is missing` })
    }
  }
  for (const u of input.unreadable) report.not_converted.push({ name: u.file, reason: u.reason })

  for (const f of input.files) {
    if (!looksLikeWorkflow(f.raw)) {
      report.not_converted.push({ name: f.file, reason: 'not a workflow file (no steps array)' })
      continue
    }
    const wf = parseWorkflow(f.raw, f.file)
    const entry = byPath.get(f.file) ?? [...byPath.entries()].find(([p]) => f.file.endsWith(`/${p}`))?.[1]
    wf.hashid ??= entry?.hashid
    let name = `${slug(wf.name)}${wf.hashid ? `-${slug(wf.hashid)}` : ''}`
    for (let n = 2; usedNames.has(name); n++) name = `${slug(wf.name)}-${n}`
    usedNames.add(name)
    const outFile = `${name}.elaichi.json`
    const { draft, report: wr } = convertWorkflow(wf, { toolboxes, manifestWarnings: entry?.warnings, outputFile: outFile })
    wr.shape_issues = checkDefinition(draft.definition)
    drafts.push({ file: outFile, body: draft })
    report.workflows.push(wr)
    parsed.push({ wf, report: wr })
  }
  if (report.workflows.length === 0 && report.not_converted.length === 0) report.notes.push('No workflow files found in the input.')
  return { drafts, report, plan: buildPlan(report, parsed) }
}
