---
name: migrate-pipedream-to-elaichi
description: Move Pipedream workflows to Elaichi. Use when the user has a Pipedream project export (project_export-*.zip, an unzipped export folder, or a workflow .json) and wants Elaichi workflow drafts — converts it, then works through every TODO (toolboxes, tool arguments, porting Python/Go/Bash code to JavaScript, rebuilding HTTP calls as tool calls) until the drafts validate. Never publishes or turns a workflow on.
license: MIT
compatibility: Needs Bun (https://bun.sh) and Node's npx, or a clone of github.com/trutohq/pipedream-to-elaichi. The Elaichi MCP server or an Elaichi API token is needed to validate and create drafts.
metadata:
  repository: https://github.com/trutohq/pipedream-to-elaichi
---

# Migrate Pipedream workflows to Elaichi

Pipedream Workflows shuts down on 31 March 2027 and deletes all Workflows data by 30 April 2027. The `pipedream-to-elaichi` CLI turns a Pipedream project export into one Elaichi draft per workflow and a report. You, the agent, finish the work the CLI cannot do safely on its own: write tool arguments, port code, and check the result with Elaichi's validator.

## Hard rules

- **Never publish and never enable.** Not with MCP (`automation.publish`, `automation.enable`), not with the API. The person does that in Elaichi after a test run. Tell them so at the end.
- **Ask before you write to their Elaichi organization.** Creating drafts or toolboxes is a write. Validating (`automation.draft.validate` with no `id`, or `validate` below) saves nothing and needs no ask.
- **Never guess a secret.** Pipedream exports secrets as `<redacted>`. Ask the person, or leave the TODO.
- **Never mark work done that you did not check.** A step is done when `check` no longer lists it and the validator shows no error for it.
- **Keep the person's data private.** The export can hold customer data in props. Do not paste it into anything outside this session.
- **Never print or write a token.** If an Elaichi API token is used, it stays in the `ELAICHI_API_TOKEN` environment variable. Do not echo it, log it, or put it in a file.
- **Prefer the person's Elaichi MCP server** (tools named `elaichi__automation__…`) for validating, creating and dry-running drafts. It acts as them, with their permissions. Use an API token only when they have no MCP connection.

## 1. Convert

Run the CLI on the export the person gives you. No clone is needed (Bun must be installed):

```bash
npx -y github:trutohq/pipedream-to-elaichi <project_export.zip | folder | workflow.json> --out elaichi-drafts
```

If the repository is already checked out, `bun src/cli.ts …` from its root does the same. Do not add `--push` here: it creates the drafts in Elaichi before anyone has fixed or reviewed them.

You get `elaichi-drafts/<workflow>.elaichi.json` (each is `{ name, description, definition }`), `report.md` for people, `report.json`, and `migration-plan.json`: your work list. Show the person the summary line per workflow and the "Not converted" list from `report.md`.

## 2. Plan from migration-plan.json

`migration-plan.json` → `workflows[]` has, per draft: `draft_file`, `reconnect` (apps to connect again), `secrets` (props to enter again) and `items[]`. Each item is one piece of open work:

- `id` (`<draft_file>#<step key>`), `target` (`step`, `trigger` or `workflow`), `pipedream_step`, `elaichi_keys` (the draft steps to edit)
- `kinds`: what to do (table below). `reasons`: why, in plain words.
- `original`: the Pipedream code (`language`, `code`) or action (`component`, `props`), so you do not need the export again.
- `limits`: the Elaichi limits it hits. The top-level `limits` object explains each one and says what to do instead.

Work one workflow at a time. Tell the person the plan in a few lines first: which apps to connect, which code steps you will port, what you cannot do (for example, no Elaichi connector for an app). Trigger and `workflow` items are mostly for the person (new webhook URL, time zone, splitting a workflow over a limit): list them in your final summary.

## 3. Work each TODO kind

Edit the draft JSON file. Find the step by its key in `elaichi_keys`. When a step is fixed, rewrite its `name` and `description` so neither starts with `TODO:`: that marker is how `check` knows the work is open.

| `todo` kind | What to do |
|---|---|
| `set_toolbox` | The step names `tbx_REPLACE_<connector>`. Find or create a stored toolbox that holds the tool, then put its `tbx_…` id in `toolbox_id` and in the top-level `toolboxes` list (remove the placeholder). With MCP: `toolbox.list`, else ask before `toolbox.create` / `toolbox.set_entries`. Without MCP: ask the person for the id. (Re-running the CLI with `--toolbox <connector>=tbx_…` also works, but only before you edit the drafts: it needs `--force` and replaces them.) |
| `write_tool_args` | Read the tool's input schema (MCP: `connector.list_tools` or `connection.list_tools`; the tool name is in the step's `tool`). Write `args` as a **JSONata string** that builds the arguments object, using the Pipedream props quoted in the notes. Plain text inside JSONata is a quoted string. |
| `port_code` | Rewrite the code (kept in a comment in the step's `source`) as JavaScript, by the rules in [references/porting.md](references/porting.md). Delete the `throw` line. Set the step's `input` to pass what the code reads. |
| `fix_code` | The Node.js code runs in a wrapper but uses something Elaichi code cannot do. The notes say what. Fix that part only. Porting rules are in [references/porting.md](references/porting.md). |
| `rebuild_with_tools` | The step makes HTTP calls or uses connected-account credentials. Elaichi code has no network. Add a `call_tool` step for each call, with a tool from a connected app, before the code step; pass its `result` into the code step's `input`. If no connector has the call, say so and leave the TODO. |
| `find_tool` | The action is not in this importer's table. Search the connector's tools (MCP: `connector.list` then `connector.list_tools`) for one that does the same job, then replace the TODO `check` step with a `call_tool` step. If you find none, keep the TODO and say so. |
| `no_connector` | Elaichi has no connector for this app. Keep the TODO step and tell the person. They can ask Elaichi for the connector or bring their own MCP server. |
| `reenter_secret` | Ask the person for the value, or tell them to set it in the console. Never invent it. |
| `delete_step` | Remove the TODO step (Elaichi answers webhooks with 202 itself). |
| `rebuild_control_flow` | Pipedream branch arms came over switched off (`when: "false"`) at the end. Ask the person where each branch sat and its condition, then move the `branch` step and write each `when` as JSONata. |
| `manual` | Read the notes. Do it if it is clear; otherwise ask. |

Triggers: a `webhook` trigger gets a new URL and token after the draft is saved; tell the person to update every sender. Triggers with status `no_match` (app event sources, email, form) became a `manual` trigger: offer a `cron` trigger that polls the app, or a `webhook` the app posts to.

Elaichi step and expression shapes: [references/elaichi.md](references/elaichi.md). With the Elaichi MCP server, `automation.schema` with `part: "step:<type>"` gives the live schema; prefer it.

## 4. Check, validate, create

1. Local check after every round of edits. It lists every TODO still open and shape problems:

   ```bash
   npx -y github:trutohq/pipedream-to-elaichi check elaichi-drafts --json
   ```

   It exits 1 while any TODO is open, and 0 when only the review gate (`import_review`, the first step) is left. Read the exit code from the command itself, not through a pipe, or use the `ok` field of the `--json` output.

   With no Elaichi MCP connection and no API token, this is as far as you can go: stop here, and hand over the open items.

2. Elaichi's validator (also checks toolboxes, tools, connections and JSONata). It saves nothing:
   - MCP: `automation.draft.validate` with `definition` and **no** `id`.
   - API: `ELAICHI_API_TOKEN=elch_… npx -y github:trutohq/pipedream-to-elaichi validate elaichi-drafts --json`

   Fix every `error`. Fix `bp_` warnings when the fix is clear.

3. Show the person what changed and what is still open. Ask them to review. Once they say the draft is right, delete the `import_review` step (it fails every run on purpose until then).

4. With their yes, create the drafts:
   - MCP: `automation.draft.create` with `name`, `description`, `definition`.
   - API: `ELAICHI_API_TOKEN=elch_… npx -y github:trutohq/pipedream-to-elaichi push elaichi-drafts`

5. With MCP, offer `automation.dry_run` on each draft and run it once the person agrees: it reads from their real apps, and writes are only recorded. Use it to check the real shape of each tool's `result` and fix expressions.

6. Finish with: what was created (ids), what is still open, and the person's last steps: connect each app in `reconnect`, enter the secrets, update webhook senders, test-run, publish, turn on.

## When something does not fit

- An export shape the CLI does not read shows as a `manual` TODO that lists the step's fields. Port it by hand from the fields, and suggest the person opens an issue at github.com/trutohq/pipedream-to-elaichi with the shape (secrets removed).
- Elaichi limits: 50 steps, 10 code steps (64 KB each), 5 approve steps, 3 cron and 3 webhook triggers, waits up to 1 hour, cron at most every 5 minutes. The report notes say when a workflow is over a limit: split it, and join the parts with an `automation.call` step.
