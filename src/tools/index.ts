import { MailchimpService } from "../services/mailchimp.js";

// --- Runtime validation -----------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^[a-f0-9]{32}$/;
const STRING_ID_KEYS = new Set([
  "workflow_id",
  "email_id",
  "list_id",
  "campaign_id",
  "store_id",
  "product_id",
  "order_id",
  "folder_id",
  "file_id",
  "page_id",
  "conversation_id",
  "category_id",
  "interest_id",
  "webhook_id",
  "note_id",
  "goal_id",
  "customer_id",
  "variant_id",
  "cart_id",
  "promo_rule_id",
  "promo_code_id",
]);
const HASH_KEYS = new Set(["subscriber_hash"]);
const NUMERIC_ID_KEYS = new Set([
  "segment_id",
  "template_id",
  "merge_field_id",
  "tag_id",
]);

function validateArgs(args: any): void {
  if (args === undefined || args === null) return;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object");
  }
  for (const [key, raw] of Object.entries(args)) {
    if (raw === undefined || raw === null) continue;
    if (STRING_ID_KEYS.has(key)) {
      if (typeof raw !== "string" || !ID_RE.test(raw)) {
        throw new Error(`Invalid value for ${key}`);
      }
    } else if (HASH_KEYS.has(key)) {
      if (typeof raw !== "string" || !HASH_RE.test(raw)) {
        throw new Error(`Invalid value for ${key}`);
      }
    } else if (NUMERIC_ID_KEYS.has(key)) {
      if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
        throw new Error(`Invalid value for ${key}`);
      }
    }
  }
}

// --- Content sanitization ---------------------------------------------------

// Strip bidi overrides (U+202A–U+202E, U+2066–U+2069), zero-width chars
// (U+200B–U+200D, U+2060, U+FEFF) after NFKC normalization.
const SMUGGLE_RE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/gu;

function normalize(s: string): string {
  return s.normalize("NFKC").replace(SMUGGLE_RE, "");
}

function untrusted(kind: string, text: unknown, maxLen = 4000): string {
  const s = normalize(String(text ?? ""));
  const escaped = s.replace(/<\/?untrusted[^>]*>/gi, "");
  const capped =
    escaped.length > maxLen ? escaped.slice(0, maxLen) + "…[truncated]" : escaped;
  return `<untrusted kind="${kind}">${capped}</untrusted>`;
}

// --- PII projectors ---------------------------------------------------------

function wrapMergeFields(mf: any): any {
  if (!mf || typeof mf !== "object" || Array.isArray(mf)) return mf;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mf)) {
    out[k] =
      typeof v === "string" ? untrusted(`merge-field:${k}`, v) : v;
  }
  return out;
}

function redactAddress(addr: any): any {
  if (!addr || typeof addr !== "object") return addr;
  return typeof addr.country_code === "string"
    ? { country_code: addr.country_code }
    : {};
}

function projectMember(m: any): any {
  if (!m || typeof m !== "object") return m;
  const {
    ip_signup,
    ip_opt,
    location,
    unique_email_id,
    web_id,
    ...rest
  } = m;
  if (rest.email_address !== undefined) {
    rest.email_address = untrusted("email", rest.email_address);
  }
  if (rest.merge_fields !== undefined) {
    rest.merge_fields = wrapMergeFields(rest.merge_fields);
  }
  return rest;
}

function projectOrder(o: any): any {
  if (!o || typeof o !== "object") return o;
  const { billing_address, shipping_address, ...rest } = o;
  const result: any = { ...rest };
  if (billing_address !== undefined) {
    result.billing_address = redactAddress(billing_address);
  }
  if (shipping_address !== undefined) {
    result.shipping_address = redactAddress(shipping_address);
  }
  return result;
}

function projectConversation(c: any): any {
  if (!c || typeof c !== "object") return c;
  const {
    ip_signup,
    ip_opt,
    location,
    unique_email_id,
    web_id,
    ...rest
  } = c;
  if (rest.subject !== undefined) {
    rest.subject = untrusted("conversation-subject", rest.subject);
  }
  if (rest.from_email !== undefined) {
    rest.from_email = untrusted("conversation-from-email", rest.from_email);
  }
  if (rest.from_label !== undefined) {
    rest.from_label = untrusted("conversation-from-label", rest.from_label);
  }
  if (rest.message !== undefined) {
    rest.message = untrusted("conversation-message", rest.message, 8000);
  }
  return rest;
}

function wrapCampaignSettings(settings: any): any {
  if (!settings || typeof settings !== "object") return settings;
  const out: any = { ...settings };
  if (out.subject_line !== undefined) {
    out.subject_line = untrusted("campaign-subject-line", out.subject_line);
  }
  if (out.preview_text !== undefined) {
    out.preview_text = untrusted("campaign-preview-text", out.preview_text);
  }
  if (out.title !== undefined) {
    out.title = untrusted("campaign-title", out.title);
  }
  if (out.from_name !== undefined) {
    out.from_name = untrusted("campaign-from-name", out.from_name);
  }
  if (out.reply_to !== undefined) {
    out.reply_to = untrusted("campaign-reply-to", out.reply_to);
  }
  return out;
}

function projectCampaign(c: any): any {
  if (!c || typeof c !== "object") return c;
  const out: any = { ...c };
  if (out.settings !== undefined) {
    out.settings = wrapCampaignSettings(out.settings);
  }
  return out;
}

function projectTemplate(t: any): any {
  if (!t || typeof t !== "object") return t;
  const out: any = { ...t };
  if (out.name !== undefined) {
    out.name = untrusted("template-name", out.name);
  }
  if (out.content !== undefined) {
    if (typeof out.content === "string") {
      out.content = untrusted("template-content", out.content, 8000);
    } else if (typeof out.content === "object" && out.content !== null) {
      const inner: any = { ...out.content };
      if (typeof inner.html === "string") {
        inner.html = untrusted("template-html", inner.html, 8000);
      }
      if (typeof inner.plain_text === "string") {
        inner.plain_text = untrusted(
          "template-plain-text",
          inner.plain_text,
          8000
        );
      }
      out.content = inner;
    }
  }
  return out;
}

function wrapAutomationSettings(settings: any): any {
  if (!settings || typeof settings !== "object") return settings;
  const out: any = { ...settings };
  if (out.subject_line !== undefined) {
    out.subject_line = untrusted("automation-subject-line", out.subject_line);
  }
  if (out.from_name !== undefined) {
    out.from_name = untrusted("automation-from-name", out.from_name);
  }
  if (out.reply_to !== undefined) {
    out.reply_to = untrusted("automation-reply-to", out.reply_to);
  }
  return out;
}

function projectAutomation(a: any): any {
  if (!a || typeof a !== "object") return a;
  const out: any = { ...a };
  if (out.settings !== undefined) {
    out.settings = wrapAutomationSettings(out.settings);
  }
  return out;
}

function projectAutomationEmail(ae: any): any {
  return projectAutomation(ae);
}

// --- JSON schema fragments --------------------------------------------------

const S_STR_ID = (description: string) => ({
  type: "string",
  pattern: "^[A-Za-z0-9_-]{1,64}$",
  maxLength: 64,
  description,
});
const S_SUB_HASH = {
  type: "string",
  pattern: "^[a-f0-9]{32}$",
  minLength: 32,
  maxLength: 32,
  description: "The subscriber hash",
};
const S_NUM_ID = (description: string) => ({
  type: "integer",
  minimum: 0,
  description,
});

// --- Tool definitions -------------------------------------------------------

export const getToolDefinitions = (service: MailchimpService) => [
  {
    name: "list_automations",
    description: "List all automations in your Mailchimp account",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_automation",
    description: "Get details of a specific automation by workflow ID",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: S_STR_ID("The workflow ID of the automation"),
      },
      required: ["workflow_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_automation_emails",
    description: "List all emails in an automation",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: S_STR_ID("The workflow ID of the automation"),
      },
      required: ["workflow_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_automation_email",
    description: "Get details of a specific email in an automation",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: S_STR_ID("The workflow ID of the automation"),
        email_id: S_STR_ID("The email ID within the automation"),
      },
      required: ["workflow_id", "email_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_automation_subscribers",
    description: "List subscribers in an automation email queue",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: S_STR_ID("The workflow ID of the automation"),
        email_id: S_STR_ID("The email ID within the automation"),
      },
      required: ["workflow_id", "email_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_automation_queue",
    description: "Get the automation email queue",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: S_STR_ID("The workflow ID of the automation"),
        email_id: S_STR_ID("The email ID within the automation"),
      },
      required: ["workflow_id", "email_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_lists",
    description:
      "List all lists in your Mailchimp account (for automation recipients)",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_list",
    description: "Get details of a specific list",
    inputSchema: {
      type: "object",
      properties: {
        list_id: S_STR_ID("The list ID"),
      },
      required: ["list_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_automation_report",
    description: "Get automation report data",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: S_STR_ID("The workflow ID of the automation"),
      },
      required: ["workflow_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_automation_email_report",
    description: "Get automation email report data",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: S_STR_ID("The workflow ID of the automation"),
        email_id: S_STR_ID("The email ID within the automation"),
      },
      required: ["workflow_id", "email_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_subscriber_activity",
    description: "Get subscriber activity for an automation email",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: S_STR_ID("The workflow ID of the automation"),
        email_id: S_STR_ID("The email ID within the automation"),
        subscriber_hash: S_SUB_HASH,
      },
      required: ["workflow_id", "email_id", "subscriber_hash"],
      additionalProperties: false,
    },
  },
  // Campaign Management
  {
    name: "list_campaigns",
    description: "List all campaigns in your Mailchimp account",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_campaign",
    description: "Get details of a specific campaign",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: S_STR_ID("The campaign ID"),
      },
      required: ["campaign_id"],
      additionalProperties: false,
    },
  },
  // Member Management
  {
    name: "list_members",
    description: "List all members in a specific list",
    inputSchema: {
      type: "object",
      properties: {
        list_id: S_STR_ID("The list ID"),
      },
      required: ["list_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_member",
    description: "Get details of a specific member",
    inputSchema: {
      type: "object",
      properties: {
        list_id: S_STR_ID("The list ID"),
        subscriber_hash: S_SUB_HASH,
      },
      required: ["list_id", "subscriber_hash"],
      additionalProperties: false,
    },
  },
  // Segment Management
  {
    name: "list_segments",
    description: "List all segments in a specific list",
    inputSchema: {
      type: "object",
      properties: {
        list_id: S_STR_ID("The list ID"),
      },
      required: ["list_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_segment",
    description: "Get details of a specific segment",
    inputSchema: {
      type: "object",
      properties: {
        list_id: S_STR_ID("The list ID"),
        segment_id: S_NUM_ID("The segment ID"),
      },
      required: ["list_id", "segment_id"],
      additionalProperties: false,
    },
  },
  // Template Management
  {
    name: "list_templates",
    description: "List all templates in your Mailchimp account",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_template",
    description: "Get details of a specific template",
    inputSchema: {
      type: "object",
      properties: {
        template_id: S_NUM_ID("The template ID"),
      },
      required: ["template_id"],
      additionalProperties: false,
    },
  },
  // Campaign Reports
  {
    name: "list_campaign_reports",
    description: "List all campaign reports",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_campaign_report",
    description: "Get detailed report for a specific campaign",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: S_STR_ID("The campaign ID"),
      },
      required: ["campaign_id"],
      additionalProperties: false,
    },
  },
  // Account Information
  {
    name: "get_account",
    description: "Get account information",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  // Folder Management
  {
    name: "list_folders",
    description: "List all campaign folders",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_folder",
    description: "Get details of a specific folder",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: S_STR_ID("The folder ID"),
      },
      required: ["folder_id"],
      additionalProperties: false,
    },
  },
  // Merge Fields
  {
    name: "list_merge_fields",
    description: "List all merge fields in a specific list",
    inputSchema: {
      type: "object",
      properties: {
        list_id: S_STR_ID("The list ID"),
      },
      required: ["list_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_merge_field",
    description: "Get details of a specific merge field",
    inputSchema: {
      type: "object",
      properties: {
        list_id: S_STR_ID("The list ID"),
        merge_field_id: S_NUM_ID("The merge field ID"),
      },
      required: ["list_id", "merge_field_id"],
      additionalProperties: false,
    },
  },
  // File Manager
  {
    name: "list_files",
    description: "List all files in the File Manager",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_file",
    description: "Get details of a specific file",
    inputSchema: {
      type: "object",
      properties: {
        file_id: S_STR_ID("The file ID"),
      },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
  // Landing Pages
  {
    name: "list_landing_pages",
    description: "List all landing pages",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_landing_page",
    description: "Get details of a specific landing page",
    inputSchema: {
      type: "object",
      properties: {
        page_id: S_STR_ID("The landing page ID"),
      },
      required: ["page_id"],
      additionalProperties: false,
    },
  },
  // E-commerce Stores
  {
    name: "list_stores",
    description: "List all e-commerce stores",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_store",
    description: "Get details of a specific store",
    inputSchema: {
      type: "object",
      properties: {
        store_id: S_STR_ID("The store ID"),
      },
      required: ["store_id"],
      additionalProperties: false,
    },
  },
  // E-commerce Products
  {
    name: "list_products",
    description: "List all products in a store",
    inputSchema: {
      type: "object",
      properties: {
        store_id: S_STR_ID("The store ID"),
      },
      required: ["store_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_product",
    description: "Get details of a specific product",
    inputSchema: {
      type: "object",
      properties: {
        store_id: S_STR_ID("The store ID"),
        product_id: S_STR_ID("The product ID"),
      },
      required: ["store_id", "product_id"],
      additionalProperties: false,
    },
  },
  // E-commerce Orders
  {
    name: "list_orders",
    description: "List all orders in a store",
    inputSchema: {
      type: "object",
      properties: {
        store_id: S_STR_ID("The store ID"),
      },
      required: ["store_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_order",
    description: "Get details of a specific order",
    inputSchema: {
      type: "object",
      properties: {
        store_id: S_STR_ID("The store ID"),
        order_id: S_STR_ID("The order ID"),
      },
      required: ["store_id", "order_id"],
      additionalProperties: false,
    },
  },
  // Conversations
  {
    name: "list_conversations",
    description: "List all conversations",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_conversation",
    description: "Get details of a specific conversation",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: S_STR_ID("The conversation ID"),
      },
      required: ["conversation_id"],
      additionalProperties: false,
    },
  },
];

// --- Handler ----------------------------------------------------------------

export const handleToolCall = async (
  service: MailchimpService,
  name: string,
  args: any
) => {
  validateArgs(args);
  switch (name) {
    case "list_automations":
      const automations = await service.listAutomations();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              automations.automations.map((auto) => ({
                id: auto.id,
                name: auto.name,
                status: auto.status,
                type: auto.type,
                create_time: auto.create_time,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_automation":
      const automation = await service.getAutomation(args.workflow_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(projectAutomation(automation), null, 2),
          },
        ],
      };

    case "list_automation_emails":
      const emails = await service.listAutomationEmails(args.workflow_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              emails.emails.map((e) => ({
                id: e.id,
                position: e.position,
                status: e.status,
                subject_line: untrusted(
                  "automation-subject-line",
                  e.settings.subject_line
                ),
                emails_sent: e.emails_sent,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_automation_email":
      const email = await service.getAutomationEmail(
        args.workflow_id,
        args.email_id
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(projectAutomationEmail(email), null, 2),
          },
        ],
      };

    case "list_automation_subscribers":
      const subscribers = await service.listAutomationSubscribers(
        args.workflow_id,
        args.email_id
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              subscribers.subscribers.map((s) => ({
                email_address: untrusted("email", s.email_address),
                status: s.status,
                merge_fields: wrapMergeFields(s.merge_fields),
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_automation_queue":
      const queue = await service.getAutomationQueue(
        args.workflow_id,
        args.email_id
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(queue, null, 2),
          },
        ],
      };

    case "list_lists":
      const lists = await service.listLists();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              lists.lists.map((l) => ({
                id: l.id,
                name: l.name,
                member_count: l.stats.member_count,
                date_created: l.date_created,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_list":
      const list = await service.getList(args.list_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(list, null, 2),
          },
        ],
      };

    case "get_automation_report":
      const report = await service.getAutomationReport(args.workflow_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };

    case "get_automation_email_report":
      const emailReport = await service.getAutomationEmailReport(
        args.workflow_id,
        args.email_id
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(emailReport, null, 2),
          },
        ],
      };

    case "get_subscriber_activity":
      const activity = await service.getSubscriberActivity(
        args.workflow_id,
        args.email_id,
        args.subscriber_hash
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(activity, null, 2),
          },
        ],
      };

    // Campaign Management
    case "list_campaigns":
      const campaigns = await service.listCampaigns();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              campaigns.campaigns.map((c) => ({
                id: c.id,
                type: c.type,
                status: c.status,
                create_time: c.create_time,
                send_time: c.send_time,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_campaign":
      const campaign = await service.getCampaign(args.campaign_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(projectCampaign(campaign), null, 2),
          },
        ],
      };

    // Member Management
    case "list_members":
      const members = await service.listMembers(args.list_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              members.members.map((m) => ({
                id: m.id,
                email_address: untrusted("email", m.email_address),
                status: m.status,
                member_rating: m.member_rating,
                last_changed: m.last_changed,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_member":
      const member = await service.getMember(
        args.list_id,
        args.subscriber_hash
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(projectMember(member), null, 2),
          },
        ],
      };

    // Segment Management
    case "list_segments":
      const segments = await service.listSegments(args.list_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              segments.segments.map((s) => ({
                id: s.id,
                name: s.name,
                member_count: s.member_count,
                type: s.type,
                created_at: s.created_at,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_segment":
      const segment = await service.getSegment(args.list_id, args.segment_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(segment, null, 2),
          },
        ],
      };

    // Template Management
    case "list_templates":
      const templates = await service.listTemplates();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              templates.templates.map((t) => ({
                id: t.id,
                name: untrusted("template-name", t.name),
                type: t.type,
                drag_and_drop: t.drag_and_drop,
                responsive: t.responsive,
                active: t.active,
                date_created: t.date_created,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_template":
      const template = await service.getTemplate(args.template_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(projectTemplate(template), null, 2),
          },
        ],
      };

    // Campaign Reports
    case "list_campaign_reports":
      const campaignReports = await service.listCampaignReports();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              campaignReports.reports.map((r) => ({
                id: r.id,
                campaign_title: r.campaign_title,
                type: r.type,
                emails_sent: r.emails_sent,
                send_time: r.send_time,
                opens: r.opens,
                clicks: r.clicks,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_campaign_report":
      const campaignReport = await service.getCampaignReport(args.campaign_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(campaignReport, null, 2),
          },
        ],
      };

    // Account Information
    case "get_account":
      const account = await service.getAccount();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(account, null, 2),
          },
        ],
      };

    // Folder Management
    case "list_folders":
      const folders = await service.listFolders();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              folders.folders.map((f) => ({
                id: f.id,
                name: f.name,
                count: f.count,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_folder":
      const folder = await service.getFolder(args.folder_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(folder, null, 2),
          },
        ],
      };

    // Merge Fields
    case "list_merge_fields":
      const mergeFields = await service.listMergeFields(args.list_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              mergeFields.merge_fields.map((mf) => ({
                id: mf.id,
                name: mf.name,
                type: mf.type,
                required: mf.required,
                public: mf.public,
                display_order: mf.display_order,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_merge_field":
      const mergeField = await service.getMergeField(
        args.list_id,
        args.merge_field_id
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(mergeField, null, 2),
          },
        ],
      };

    // File Manager
    case "list_files":
      const files = await service.listFiles();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              files.files.map((f) => ({
                id: f.id,
                name: f.name,
                size: f.size,
                created_at: f.created_at,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_file":
      const file = await service.getFile(args.file_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(file, null, 2),
          },
        ],
      };

    // Landing Pages
    case "list_landing_pages":
      const landingPages = await service.listLandingPages();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              landingPages.landing_pages.map((lp) => ({
                id: lp.id,
                name: lp.name,
                type: lp.type,
                created_at: lp.created_at,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_landing_page":
      const landingPage = await service.getLandingPage(args.page_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(landingPage, null, 2),
          },
        ],
      };

    // E-commerce Stores
    case "list_stores":
      const stores = await service.listStores();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              stores.stores.map((s) => ({
                id: s.id,
                name: s.name,
                domain: s.domain,
                created_at: s.created_at,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_store":
      const store = await service.getStore(args.store_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(store, null, 2),
          },
        ],
      };

    // E-commerce Products
    case "list_products":
      const products = await service.listProducts(args.store_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              products.products.map((p) => ({
                id: p.id,
                title: p.title,
                type: p.type,
                vendor: p.vendor,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_product":
      const product = await service.getProduct(args.store_id, args.product_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(product, null, 2),
          },
        ],
      };

    // E-commerce Orders
    case "list_orders":
      const orders = await service.listOrders(args.store_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              orders.orders.map((o) => ({
                id: o.id,
                order_total: o.order_total,
                currency_code: o.currency_code,
                financial_status: o.financial_status,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_order":
      const order = await service.getOrder(args.store_id, args.order_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(projectOrder(order), null, 2),
          },
        ],
      };

    // Conversations
    case "list_conversations":
      const conversations = await service.listConversations();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              conversations.conversations.map((c) => ({
                id: c.id,
                subject: untrusted("conversation-subject", c.subject),
                from_email: untrusted(
                  "conversation-from-email",
                  c.from_email
                ),
                timestamp: c.timestamp,
              })),
              null,
              2
            ),
          },
        ],
      };

    case "get_conversation":
      const conversation = await service.getConversation(args.conversation_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(projectConversation(conversation), null, 2),
          },
        ],
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};
