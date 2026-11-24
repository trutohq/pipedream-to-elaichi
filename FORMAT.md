# The Pipedream export format

This file records what this importer knows about the export format, and where each fact comes from. Checked on 24 November 2026.

## Confirmed by Pipedream's docs

Source: [Export Workflows](https://pipedream.com/docs/workflows/export-workflows).

- An export covers one project. It is the file `project_export-<project_id>.zip` in the project's File Store.
- The archive keeps the project's folders. It holds one JSON file for each workflow, plus `manifest.json`.
- `manifest.json` has `schema` (`project-export/2026.01`), `workflow_schema` (`workflow.json/2026.01`), `project_hashid`, `exported_at`, `truncated`, `truncated_reason`, `limits`, and `workflows[]`. Each workflow entry has `hashid`, `name`, `path`, `status` and `warnings`.
- `status` is one of `exported`, `skipped_never_deployed` or `skipped_export_limit`.
- A workflow file has `name`, `description`, `inactive`, `settings`, `triggers`, `steps` and `deployments`.
- A trigger's type is one of `source`, `http`, `timer`, `email` or `form`.
- A step has a name, a type, either its code (for a code step) or its component key and version (for an action), and its configured props.
- `deployments` holds the steps inside each control-flow branch.
- Secret values are `<redacted>`. A connected account keeps only its `authProvisionId`.
- The export does not include credentials, environment variables, event history, data store contents, File Store files, or the code of private components.
- One export holds at most 500 workflows or 256 MB.

The importer reports every manifest warning, every skipped workflow, each file the manifest lists but the archive lacks, and a truncated export.

## Inferred from files Pipedream wrote

Pipedream's GitHub Sync writes a `workflow.yaml` file for each workflow (`schema: workflow/2022.04`). Public repositories have real ones. They use these fields:

- `steps[].namespace`
- `steps[].runtime`, for example `nodejs20.x` or `python3.12`
- `steps[].uses`, which is `component-key@version` for an action, or `./<step>/entry.js` for code that GitHub Sync keeps in its own file
- `steps[].props`, where connected accounts are `{ authProvisionId }` and select values are `{ __lv: { label, value } }`
- Templates such as `{{steps.<namespace>.$return_value}}` and `{{steps.trigger.event...}}`
- Trigger `id` prefixes: `ti_` (timer), `hi_` (HTTP), `dc_` (source)

## Seen only in other converters

Two other open-source converters for the 2026 export, [pd2n8n](https://github.com/kamilkaczmareksolutions/pipedream-to-n8n) and [migrateflows](https://github.com/davobene/migrateflows), use these fields. Their examples are hand-written too:

- `steps[].lang`
- `steps[].uses` as an object: `{ registry, key, version }` for an action, or `{ registry: false, code }` for a code step
- `steps[].disabled` and `steps[].component_key`
- `triggers[]` as `{ type, disabled, props }`, where a timer's props hold `cron` and `timezone`
- `deployments` as `{ "<id>": { steps: [...] } }`

## Not confirmed

- The exact field names inside a step and a trigger in a real `workflow.json/2026.01` file.
- How a timer stores an interval. The importer reads `interval_seconds`, `intervalSeconds`, and a nested `timer` object.
- How `deployments` links a branch to the step where it sat, and where its condition is stored. The importer brings branch steps over with every arm switched off.
- How control-flow steps such as if/else or switch appear in `steps`. The importer turns any step it does not recognize into a TODO that lists the step's fields.

The parser in [`src/parse.ts`](src/parse.ts) accepts every spelling above. One real export would settle the open points.
