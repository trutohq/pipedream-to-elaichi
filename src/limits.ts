// Elaichi limits a Pipedream workflow can run into, with what to do instead.
// Checked against Elaichi's workflow schema (src/automation/automationSchema.ts) on 2026-11-24.

export const LIMITS = {
  code_javascript_only: { limit: 'Code steps run JavaScript only.', instead: 'Rewrite Python, Go or Bash as JavaScript in the code step.' },
  code_no_network: { limit: 'Code steps have no network: fetch, axios, requests and curl do not work.', instead: 'Make each call with a call_tool step from a connected app before the code step, and pass its result in the code step input.' },
  code_no_packages: { limit: 'Code steps cannot load npm, pip or Go packages.', instead: 'Rewrite the code without the package, or move the work to a tool or an agent step.' },
  code_no_env: { limit: 'Code steps have no environment variables, and Pipedream exports none.', instead: 'Put the value in the code step input or in a workflow setting.' },
  code_no_files: { limit: 'Code steps have no file system (/tmp, File Store).', instead: 'Use parse or file.write steps, or a connected storage app.' },
  code_no_credentials: { limit: 'Code steps never see connected-account credentials.', instead: 'Call the app with a call_tool step.' },
  code_max_64kb: { limit: 'A code step holds at most 64 KB of source.', instead: 'Split the code over two steps, or move parts to transform steps.' },
  code_steps_max_10: { limit: 'A workflow has at most 10 code steps.', instead: 'Merge code steps, or replace plain data shaping with transform or map_fields steps.' },
  steps_max_50: { limit: 'A workflow has at most 50 steps, nested ones included.', instead: 'Split it into two workflows and join them with an automation.call step.' },
  wait_max_1_hour: { limit: 'A wait step waits at most 3600 seconds (1 hour).', instead: 'Split the workflow: end it, and start the rest with a schedule_once trigger or a cron that checks state.' },
  cron_min_5_minutes: { limit: 'A cron trigger runs at most every 5 minutes.', instead: 'Accept the 5-minute schedule, or have the app push events to a webhook trigger.' },
  webhook_always_202: { limit: 'Elaichi answers every webhook with 202 at once; a workflow cannot set the HTTP response.', instead: 'Remove $.respond. If the caller needs data back, send it with a tool call.' },
  no_app_event_trigger: { limit: 'Elaichi has no trigger for an event inside a connected app, and no email or form trigger.', instead: 'Point the app’s own webhook at a webhook trigger, or poll the app on a cron schedule.' },
  state_per_workflow: { limit: 'Workflow state belongs to one workflow, and its keys are fixed strings.', instead: 'Use a collection when several workflows share the data, or when keys are computed at run time.' },
} as const

export type LimitId = keyof typeof LIMITS
