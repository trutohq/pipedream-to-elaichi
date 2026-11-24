# Elaichi workflow definition: the parts a migration touches

With the Elaichi MCP server, `automation.schema` (`part: "definition"`, `"step:<type>"`, `"trigger:<type>"`, `"expression_context"`) returns the live schema and a valid example. Prefer it to this page. This page was checked against Elaichi on 24 November 2026.

## Top level

```json
{ "schema_version": 1, "triggers": [ … ], "toolboxes": ["tbx_…"], "steps": [ … ] }
```

- `toolboxes`: stored toolbox ids only (`tbx_…`), at most 10. Every `call_tool` step's `toolbox_id` must be listed.
- Steps run in order. Step keys match `^[a-z][a-z0-9_]{0,63}$` and are unique.
- Limits: 50 steps (nested ones count), 10 code steps, 5 approve steps, 1 to 5 triggers.
- Every step can have `name` (≤ 120), `description` (≤ 500), `run_if` (JSONata; the step is skipped when false), `retry`, `timeout_seconds`, `error_handling`.

## Expressions are JSONata strings

- Fields such as `args`, `input`, `condition`, `run_if`, `value`, `title` are **JSONata strings**, not JSON. `"args": "{\"channel\": \"C123\", \"text\": steps.build.text}"`.
- Plain text is a quoted string inside the expression: `"\"Done\""`. An unquoted `Done` is a field name.
- Read data with `trigger.payload…` (a webhook's payload has `body`, `headers`, `query`, `method`) and `steps.<key>…`.
- A `call_tool` result is at `steps.<key>.result`. A code step's return value is at `steps.<key>`.

## Steps

| Type | Fields | Notes |
|---|---|---|
| `call_tool` | `toolbox_id`, `tool`, `args`, optional `connection_id` | `tool` is the name the toolbox advertises. |
| `code` | `language: "javascript"`, `source`, `input` | See porting.md. |
| `transform` | `expression` | Shape data without code. Prefer it to a code step for plain mapping. |
| `filter` | `condition` | When false, the steps after it are skipped. |
| `check` | `assert`, `message`, `severity` | The importer uses `assert: "false"` for TODO steps. |
| `wait` | `seconds` (1 to 3600) or `until` | |
| `approve` | `title`, `approvers: { users, teams, include_owner }`, `on_reject`, `on_expire`, `expires_after_seconds` (300 to 2,592,000) | A destructive step with no approve step before it gets a `destructive_step` warning; it does not block publishing. Add an approval only if the Pipedream workflow had one ($.flow.suspend) or the person asks. |
| `state.get` | `keys` | Output is `{ "<key>": value }`. State belongs to one workflow. |
| `state.set` | `state_key`, `value` | |
| `branch` | `branches: [{ key, label, when, steps }]`, optional `else` | |
| `notify` | `channel: "slack" \| "email"`, `to`, `subject`, … | Use `automation.schema` for the full shape. |

## Triggers

| Type | Fields | Notes |
|---|---|---|
| `cron` | `cron` (5 fields), `timezone` (IANA) | Runs at most every 5 minutes. At most 3. |
| `webhook` | `auth: { scheme: "token" }`, `methods: ["POST"]` | URL and token come from the console after saving. Elaichi answers 202 at once. At most 3. |
| `manual` | | Run by hand or by `automation.run`. |

Elaichi has no trigger for an event inside a connected app, and no email or form trigger. Use the app's own webhook into a `webhook` trigger, or poll it on a `cron`.
