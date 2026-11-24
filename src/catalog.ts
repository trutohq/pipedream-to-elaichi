// Pipedream action → Elaichi connector tool.
// Pipedream keys were read from the `key:` line of each component in PipedreamHQ/pipedream (master).
// Elaichi slugs and tool names were read from Elaichi's connector catalog (connector.list_tools).
// Both checked on 2026-11-24. Tool names can change: the draft validator names any that do not exist.

export interface ToolMapping {
  /** Pipedream component keys this entry covers, without `@version`. */
  pipedreamKeys: string[]
  /** Elaichi connector slug. */
  slug: string
  /** Elaichi tool name as a toolbox advertises it. */
  tool: string
  /**
   * Builds the tool's arguments from Pipedream's configured props, by name.
   * Only present where both sides' field names were checked. Without it the step needs its args written.
   */
  args?: (props: Record<string, unknown>) => Record<string, unknown> | null
  /** The Pipedream props `args` reads. Any other configured prop is reported as not carried over. */
  argProps?: string[]
  /** Said in the report for every step that uses this entry. */
  note?: string
  /** The tool's input schema was not visible in the catalog, or the action needs more than one call. */
  unverified?: boolean
}

const pick = (props: Record<string, unknown>, from: string, to: string, out: Record<string, unknown>) => {
  if (props[from] !== undefined) out[to] = props[from]
}

export const TOOL_MAP: ToolMapping[] = [
  {
    pipedreamKeys: ['slack_v2-send-message-to-channel', 'slack_v2-send-message', 'slack-send-message-to-channel', 'slack-send-message'],
    slug: 'slack',
    tool: 'create_a_slack_chat',
    argProps: ['conversation', 'text', 'mrkdwn'],
    args: props => {
      if (props.conversation === undefined || props.text === undefined) return null
      const out: Record<string, unknown> = {}
      pick(props, 'conversation', 'channel', out)
      pick(props, 'text', 'text', out)
      pick(props, 'mrkdwn', 'mrkdwn', out)
      return out
    },
    note: 'Posts as the person who connected Slack. To post as the app instead, use create_a_slack_bot_message (same arguments).',
  },
  {
    pipedreamKeys: ['discord_bot-send-message'],
    slug: 'discord',
    tool: 'create_a_discord_message',
    argProps: ['channelId', 'message'],
    args: props => {
      if (props.channelId === undefined || props.message === undefined) return null
      const out: Record<string, unknown> = {}
      pick(props, 'channelId', 'channel_id', out)
      pick(props, 'message', 'content', out)
      return out
    },
    note: 'Elaichi\'s Discord connector needs your own Discord app (bring your own OAuth app).',
  },
  {
    pipedreamKeys: ['google_sheets-add-single-row', 'google_sheets-add-multiple-rows'],
    slug: 'googlesheets',
    tool: 'create_a_googlesheets_spreadsheets_value',
    note: 'Appends rows. Arguments: spreadsheet_id, range, and values as a list of rows ([[...]]). Google Sheets needs your own Google OAuth app.',
  },
  {
    pipedreamKeys: ['gmail-send-email'],
    slug: 'gmail',
    tool: 'create_a_gmail_message',
    note: 'Takes the whole email as RFC 2822 text in `raw`, not separate to/subject/body fields.',
  },
  {
    pipedreamKeys: ['notion-create-page', 'notion-create-page-from-database'],
    slug: 'notion',
    tool: 'create_a_notion_page',
    note: 'Arguments: parent ({ data_source_id } or { page_id }) and properties.',
  },
  {
    pipedreamKeys: ['airtable_oauth-create-single-record', 'airtable_oauth-create-multiple-records'],
    slug: 'airtable',
    tool: 'create_a_airtable_record',
    note: 'Arguments: base_id, table_id_or_name and fields (or records, up to 10).',
  },
  {
    pipedreamKeys: ['jira-create-issue'],
    slug: 'jira',
    tool: 'create_a_jira_issue',
    note: 'Arguments: a `fields` object with project, issuetype and summary inside.',
  },
  {
    pipedreamKeys: ['google_calendar-create-event', 'google_calendar-quick-add-event'],
    slug: 'googlecalendar',
    tool: 'create_a_googlecalendar_event',
    note: 'Arguments: calendar_id, summary, and start/end as { dateTime or date, timeZone }.',
  },
  {
    pipedreamKeys: ['openai-chat'],
    slug: 'openai',
    tool: 'create_a_openai_chat_completion',
    note: 'Arguments: model and messages. An Elaichi `agent` step is another option when the step reasons over data.',
  },
  {
    pipedreamKeys: ['salesforce_rest_api-create-contact'],
    slug: 'salesforce',
    tool: 'create_a_salesforce_contact',
    note: 'LastName is required.',
  },
  {
    pipedreamKeys: ['salesforce_rest_api-create-record', 'salesforce_rest_api-create-crm-record'],
    slug: 'salesforce',
    tool: 'create_a_salesforce_record',
    note: 'Takes object_name plus the record fields. Custom __c fields are sent only when the tool schema declares them.',
  },
  {
    pipedreamKeys: ['stripe-create-customer'],
    slug: 'stripe',
    tool: 'create_a_stripe_customer',
    note: 'Arguments: email, name, phone, description, address, metadata (all optional).',
  },
  {
    pipedreamKeys: ['asana-create-task'],
    slug: 'asana',
    tool: 'create_a_asana_task',
    note: 'Arguments are wrapped: { data: { name, workspace, projects, ... } }.',
  },
  {
    pipedreamKeys: ['clickup-create-task'],
    slug: 'clickup',
    tool: 'create_a_clickup_task',
    note: 'Arguments: list_id and name.',
  },
  {
    pipedreamKeys: ['hubspot-create-or-update-contact'],
    slug: 'hubspot',
    tool: 'create_a_hubspot_contact',
    unverified: true,
    note: 'Elaichi has no single create-or-update contact tool: use update_a_hubspot_contact_by_id (idProperty=email) and create_a_hubspot_contact when it is not found.',
  },
  {
    pipedreamKeys: ['github-create-issue'],
    slug: 'github-mcp',
    tool: 'issue_write',
    unverified: true,
    note: 'GitHub is a remote MCP connector in Elaichi; issue_write creates or updates (method "create", owner, repo, title). Check its schema in the toolbox.',
  },
  {
    pipedreamKeys: ['linear_app-create-issue'],
    slug: 'linear',
    tool: 'save_issue',
    unverified: true,
    note: 'Linear is a remote MCP connector in Elaichi; save_issue creates when no id is given (team and title). Check its schema in the toolbox.',
  },
  {
    pipedreamKeys: ['google_drive-upload-file'],
    slug: 'googledrive',
    tool: 'googledrive_files_upload',
    unverified: true,
    note: 'Two calls in Elaichi: googledrive_files_upload, then update_a_googledrive_file_by_id to set the name and folder.',
  },
]

/** Apps checked in Elaichi's catalog on 2026-11-24 with no connector. */
export const NO_ELAICHI_CONNECTOR: Record<string, string> = {
  trello: 'Trello',
  telegram_bot_api: 'Telegram',
  zoom: 'Zoom',
}

const BY_KEY = new Map<string, ToolMapping>()
for (const m of TOOL_MAP) for (const k of m.pipedreamKeys) BY_KEY.set(k, m)

export function findTool(componentKey: string): ToolMapping | undefined {
  return BY_KEY.get(componentKey)
}

/** The app part of a component key: `slack_v2-send-message` → `slack_v2`. */
export function appOf(componentKey: string): string {
  const k = componentKey.replace(/^@[^/]+\//, '')
  return k.split('-')[0] ?? k
}
