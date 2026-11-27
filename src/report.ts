import type { ProjectReport, Status, WorkflowReport } from './types.ts'

const LABEL: Record<Status, string> = { mapped: 'Mapped', needs_work: 'Needs work', no_match: 'No match' }
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

function workflowSection(w: WorkflowReport): string {
  const lines: string[] = []
  lines.push(`## ${w.name}`, '')
  lines.push(`From \`${w.input_file}\`${w.pipedream_id ? ` (${w.pipedream_id})` : ''}. Draft: \`${w.output_file}\`.`, '')
  lines.push(`Mapped ${w.summary.mapped}, needs work ${w.summary.needs_work}, no match ${w.summary.no_match}.`, '')

  lines.push('### Triggers', '', '| Pipedream | Elaichi | Status | Notes |', '|---|---|---|---|')
  if (w.triggers.length === 0) lines.push('| (none in the export) | manual | Needs work | Add the real trigger. |')
  for (const t of w.triggers) lines.push(`| ${cell(t.source)} | ${cell(t.became)} | ${LABEL[t.status]} | ${cell(t.notes.join(' '))} |`)
  lines.push('')

  lines.push('### Steps', '', '| Pipedream step | Was | Became | Status | What to do |', '|---|---|---|---|---|')
  for (const s of w.steps) {
    const name = s.branch ? `${s.namespace} (branch ${s.branch})` : s.namespace
    lines.push(`| ${cell(name)} | ${cell(s.source)} | ${cell(s.became)} \`${s.elaichi_keys.join('`, `')}\` | ${LABEL[s.status]} | ${cell(s.notes.join(' ')) || '—'} |`)
  }
  lines.push('')

  if (w.reconnect.length > 0) lines.push(`Apps this workflow uses: ${w.reconnect.join(', ')}. The export holds no credentials. Run \`pipedream-to-elaichi connections\` to move the accounts Pipedream's API returns credentials for, then connect the rest again in Elaichi.`, '')
  if (w.secrets.length > 0) lines.push(`Re-enter these redacted secrets: ${w.secrets.join('; ')}.`, '')
  for (const n of w.notes) lines.push(`- ${n}`)
  if (w.notes.length > 0) lines.push('')
  if (w.shape_issues.length > 0) {
    lines.push('Shape problems this importer found in its own output (please report them):', '')
    for (const i of w.shape_issues) lines.push(`- ${i}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function renderMarkdown(r: ProjectReport): string {
  const total: Record<Status, number> = { mapped: 0, needs_work: 0, no_match: 0 }
  for (const w of r.workflows) for (const k of Object.keys(total) as Status[]) total[k] += w.summary[k]
  const out: string[] = []
  out.push('# Pipedream to Elaichi migration report', '')
  out.push(`Input: \`${r.input}\`. Generated ${r.generated_at}.`, '')
  out.push(`${r.workflows.length} workflow${r.workflows.length === 1 ? '' : 's'} converted to drafts. Triggers and steps: mapped ${total.mapped}, needs work ${total.needs_work}, no match ${total.no_match}.`, '')
  out.push('Every draft with something to fix starts with a step named "TODO: review this import, then delete this step". It fails each run on purpose. Nothing here is published or turned on.', '')
  out.push('Next: move connected accounts with `pipedream-to-elaichi connections` and connect the rest again in Elaichi, create a toolbox for the tools the drafts call, fix each TODO, validate, test-run, publish, then turn the workflow on.', '')

  if (r.workflows.length > 0) {
    out.push('| Workflow | Draft | Mapped | Needs work | No match |', '|---|---|---|---|---|')
    for (const w of r.workflows) out.push(`| ${cell(w.name)} | \`${w.output_file}\` | ${w.summary.mapped} | ${w.summary.needs_work} | ${w.summary.no_match} |`)
    out.push('')
  }
  if (r.not_converted.length > 0) {
    out.push('## Not converted', '')
    for (const n of r.not_converted) out.push(`- ${n.name}: ${n.reason}`)
    out.push('')
  }
  for (const n of r.notes) out.push(`- ${n}`)
  if (r.notes.length > 0) out.push('')
  out.push('Not in any Pipedream export: credentials, environment variables, data store contents, File Store files, event history and private component code.', '')
  for (const w of r.workflows) out.push(workflowSection(w))
  return out.join('\n')
}
