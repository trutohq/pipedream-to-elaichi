# pipedream-to-elaichi

Turn Pipedream workflow exports into [Elaichi](https://elaichi.ai) workflow drafts, with a report of what still needs work.

**Paste this into Claude Code, Codex, Cursor or any coding agent:**

```text
Migrate my Pipedream export at ~/Downloads/project_export-<id>.zip to Elaichi. Follow https://github.com/trutohq/pipedream-to-elaichi/blob/main/skills/migrate-pipedream-to-elaichi/SKILL.md
```

Pipedream Workflows shuts down on 31 March 2027, and Pipedream deletes all Workflows data by 30 April 2027. Pipedream lets you [export each project](https://pipedream.com/docs/workflows/export-workflows) as a ZIP file with one JSON file per workflow. This tool reads that export. It writes one Elaichi draft per workflow and one migration report.

It never publishes a workflow and never turns one on. Every step it cannot convert stays in the draft as a TODO step, so nothing is dropped without a record.

## Let your coding agent do it

The fastest way is to give your AI coding agent this repo's skill and ask it to do the migration. The CLI does the safe, mechanical part. The agent does the rest: it writes tool arguments, ports Python, Go and Bash code to JavaScript, rebuilds HTTP calls as tool calls, and checks every draft with Elaichi's validator. It asks you before it creates anything, and it never publishes.

Add the skill:

```bash
npx skills add trutohq/pipedream-to-elaichi
```

That works for Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and [other agents](https://github.com/vercel-labs/skills). In Claude Code you can also add it as a plugin:

```text
/plugin marketplace add trutohq/pipedream-to-elaichi
/plugin install pipedream-to-elaichi@pipedream-to-elaichi
```

Or clone this repo and open your agent in it: `AGENTS.md` (and `CLAUDE.md`) point it at the same playbook.

Then ask:

> Migrate my Pipedream export ~/Downloads/project_export-proj_abc123.zip to Elaichi.

For the best result, connect your agent to the [Elaichi MCP server](https://elaichi.ai) too. The agent can then look up each tool's arguments, create toolboxes, validate drafts and test-run them. Without it, the agent uses an Elaichi API token (`ELAICHI_API_TOKEN`) with the `validate` and `push` commands below.

The playbook the agent follows is [skills/migrate-pipedream-to-elaichi/SKILL.md](skills/migrate-pipedream-to-elaichi/SKILL.md). Its work list is `migration-plan.json`, which the CLI writes next to the drafts: every open item with its reason, the original Pipedream code, the Elaichi limit it hits and what to do instead, and a `kinds` list (`set_toolbox`, `write_tool_args`, `port_code`, `rebuild_with_tools`, and so on). The CLI stays deterministic; all AI work happens in your own agent, under your eyes.

## Use it yourself

You need [Bun](https://bun.sh) 1.3 or later. No clone is needed:

```bash
npx -y github:trutohq/pipedream-to-elaichi ~/Downloads/project_export-proj_abc123.zip --out ./elaichi-drafts
```

From a clone, `bun src/cli.ts …` does the same.

The input can be the export `.zip`, the unzipped folder, or one workflow `.json` file.

The output folder gets:

- `<workflow>.elaichi.json` for each workflow. Each file is `{ name, description, definition }`, which is the body of Elaichi's `POST /automation`.
- `report.md`, which lists each trigger and step as mapped, needs work, or no match, and what to do about each.
- `report.json`, the same report as data.
- `migration-plan.json`, the work list for an AI coding agent: each open item, why, the original code, and the Elaichi limit it hits.

### Check your edits

After you (or your agent) edit the drafts:

```bash
npx -y github:trutohq/pipedream-to-elaichi check ./elaichi-drafts
ELAICHI_API_TOKEN=elch_... npx -y github:trutohq/pipedream-to-elaichi validate ./elaichi-drafts
```

`check` runs on your computer. It lists each TODO still open and each shape problem, and exits 0 when only the review gate is left. `validate` asks Elaichi's own validator, which also checks toolboxes, tools and expressions. It saves nothing. Both take `--json`.

### Point steps at your toolboxes

An Elaichi `call_tool` step names a stored toolbox (`tbx_…`). The importer cannot know yours, so it writes `tbx_REPLACE_<connector>` placeholders. Create a toolbox in Elaichi with the tools the report names, then run the importer again with that toolbox. The CLI will not overwrite drafts already in the output folder unless you add `--force`, because that throws away edits:

```bash
npx -y github:trutohq/pipedream-to-elaichi export.zip --toolbox slack=tbx_123 --toolbox notion=tbx_456 --force
```

### Create the drafts in Elaichi (optional)

```bash
ELAICHI_API_TOKEN=elch_... npx -y github:trutohq/pipedream-to-elaichi push ./elaichi-drafts
```

`push` creates the drafts from a folder you edited. To convert and create in one go, add `--push` to the convert command instead. Both call `POST https://api.elaichi.ai/automation` once for each workflow. That call only saves a draft. Elaichi keeps a draft even when it has problems and lists them, so you can fix them in the console. The tool never calls publish or enable. Create the token in Elaichi under **Settings → API tokens**. The token acts as you, so the drafts are yours.

Then, for each draft in Elaichi:

1. Bring each app's account over: [move it](#move-connected-accounts) with `connections`, or connect it again in Elaichi. The export holds no credentials.
2. Fix each TODO step, then delete the first step, "TODO: review this import, then delete this step". That step fails every run on purpose until you delete it.
3. Validate the draft, test-run it, publish it, then turn it on.

### Move connected accounts

The export holds no credentials. But Pipedream's API returns them for some accounts, and Elaichi can create a connection from them. Then you do not connect those apps again.

```bash
# Dry run: reads your accounts, prints a table, writes elaichi-connections/connections-plan.json. Creates nothing.
PIPEDREAM_CLIENT_ID=… PIPEDREAM_CLIENT_SECRET=… ELAICHI_API_TOKEN=elch_… \
  npx -y github:trutohq/pipedream-to-elaichi connections

# Create the importable connections, one at a time. Writes elaichi-connections/connections-result.json.
… npx -y github:trutohq/pipedream-to-elaichi connections --apply
```

Where the accounts come from:

- Live: `GET https://api.pipedream.com/v1/accounts?include_credentials=true`, every page. Set `PIPEDREAM_CLIENT_ID` and `PIPEDREAM_CLIENT_SECRET` (an OAuth client from your workspace's [API settings](https://pipedream.com/settings/api)). Or set `PIPEDREAM_API_KEY` and `PIPEDREAM_ORG_ID` (your workspace id, `o_…`).
- A file: `--accounts-file accounts.json`, a saved answer from that call (one `{ "data": [...] }`, an array of those pages, or an array of accounts). A Pipedream Connect `GET /v1/connect/{project_id}/accounts` answer works too. **A file with credentials holds live secrets.** Keep it private and delete it when you are done.

What each status means:

| Status | Meaning | What to do |
|---|---|---|
| importable | Credentials are present and fit an Elaichi auth method. | `--apply` creates the connection. |
| org OAuth app needed | An OAuth token. Pipedream returns those only for accounts on your own OAuth client, and Elaichi needs that same client. | In Elaichi, set that client as the organization's own OAuth app for the connector. Run again. |
| needs mapping | Credentials are present, but their key names do not match the connector's fields. | Add a `--map` entry. The plan lists both key lists (names only). |
| no connector | No Elaichi connector matched the app's slug. | Add a `--map` entry if Elaichi has it under another slug. |
| reconnect | Pipedream returned no credentials, or the account is dead. | Connect it again in Elaichi. |

`--map map.json` overrides the match:

```json
{
  "google_sheets": "googlesheets",
  "acme_crm": { "connector": "acme-crm", "authentication_method": "api_key", "fields": { "token": "api_token" } }
}
```

OAuth keys map by themselves: `oauth_access_token` → `access_token`, `oauth_refresh_token` → `refresh_token`, the account's `expires_at` and `authorized_scopes` → `expires_at` and `scope`. The tool never prints or writes a credential value: the plan and result hold key names only. `--apply` writes the result after each account. Run it again in the same `--out` folder after you fix something: it skips the accounts it already created. `--force` ignores the earlier result, which can create connections twice.

## What maps to what

| Pipedream | Elaichi | Status |
|---|---|---|
| Schedule (cron) | `cron` trigger, with its time zone | Mapped. If two runs were under 5 minutes apart, the schedule is thinned to Elaichi's 5-minute limit, and this is flagged. |
| Schedule (interval) | `cron` trigger, where the interval divides evenly | Mapped. An interval that does not divide evenly gets the closest schedule, and this is flagged. |
| HTTP trigger | `webhook` trigger with token auth, POST | Needs work. You need the new URL and token from Elaichi. Elaichi answers 202 at once, and a workflow cannot set the HTTP response. |
| App event source, email, form | A `manual` trigger as a placeholder | No match. Point the app's own webhook at a webhook trigger, or poll the app on a cron schedule. |
| App action with a known Elaichi tool | `call_tool` | Mapped when every configured prop was carried into the arguments and you gave the toolbox. Otherwise it needs work, and the report lists the props left over. |
| App action with no known Elaichi tool | A TODO `check` step | No match. The report says whether Elaichi has no connector for that app, or whether this tool's table just does not cover the action. |
| Node.js code | A `code` step that wraps the original component, with its props and methods bound to `this` | Mapped, unless the code uses npm packages, network calls, `process.env`, connected accounts, data stores, `$.export`, `$.respond`, or files. Each of those is flagged. Check each code step in a dry run. |
| Python, Go, Bash | A JavaScript `code` step that keeps the original in a comment and fails until it is ported | Needs work. The report says if the code is plain logic (your agent can port it) or also calls the network or uses packages (those parts must become tool calls). |
| `$.flow.delay(ms)` | A `wait` step after the code step | Mapped. Elaichi waits at most 1 hour, so a longer delay is capped and flagged. |
| `$.flow.suspend()` | An `approve` step after the code step | Mapped. Code that sends the `resume_url` somewhere is flagged. |
| `$.flow.exit()` | The code returns a marker, and a `filter` step after it skips the rest | Mapped. |
| `$.respond()`, `http-return-http-response` | Flagged, or a TODO step | Needs work. Elaichi always answers 202. |
| Data store get or set with a fixed key | `state.get` or `state.set` | Mapped. Data store contents are not exported, and Elaichi state belongs to one workflow. |
| Other data store actions | A TODO step | Needs work. Use a collection. |
| `{{steps.x.$return_value.y}}` in props | JSONata, such as `steps.x.y` | Mapped for plain paths. JavaScript inside `{{ }}`, such as `.length`, is flagged, never guessed. |
| Control-flow branches (`deployments`) | One `branch` step at the end, with each arm switched off | Needs work. The export does not say where each branch sat or what its condition was. |
| Disabled step | Kept, with `run_if: "false"` on it and on any wait, filter or approve step made from it | Noted. |
| Disabled trigger | Not added | Needs work. Add it in the console if you want it. |
| Workflow settings (retries, concurrency) | Not converted | Listed in the report notes. |

The action table is in [`src/catalog.ts`](src/catalog.ts). It covers common actions for Slack, Discord, Google Sheets, Gmail, Notion, Airtable, Jira, Google Calendar, OpenAI, Salesforce, Stripe, Asana, ClickUp, HubSpot, GitHub, Linear and Google Drive. Pull requests are welcome.

## What is not certain

Pipedream documents the export's ZIP layout, `manifest.json` and the top-level fields of each workflow file. It does not document the field names inside a step or trigger. This tool accepts every spelling seen so far. [FORMAT.md](FORMAT.md) lists what is confirmed and what is not. If your export has a shape this tool does not read, the step becomes a TODO that lists the step's fields. Please open an issue with that list, with your secrets removed.

## Develop

```bash
bun install
bun test
bunx tsc --strict --noEmit -p .
```

The fixtures in `test/fixtures` are hand-built, not real exports.

## License

MIT
