import fetch from "node-fetch";
import { randomUUID } from "crypto";
import {
  MailchimpAutomation,
  MailchimpAutomationEmail,
  MailchimpAutomationSubscriber,
  MailchimpAutomationQueue,
  MailchimpList,
  MailchimpCampaign,
  MailchimpMember,
  MailchimpSegment,
  MailchimpTemplate,
  MailchimpCampaignReport,
  MailchimpAccount,
  MailchimpFolder,
  MailchimpFile,
  MailchimpLandingPage,
  MailchimpStore,
  MailchimpProduct,
  MailchimpOrder,
  MailchimpConversation,
  MailchimpMergeField,
} from "../types/index.js";

const FETCH_TIMEOUT_MS = 30_000;
const DATA_CENTER_RE = /^[a-z]{2}\d{1,3}$/;
const API_KEY_RE = /^[a-f0-9]{32}-[a-z]{2}\d{1,3}$/i;

function enc(v: string | number): string {
  const s = String(v);
  if (s.length === 0 || s.length > 128) {
    throw new Error("Invalid path segment");
  }
  if (s.includes("/") || s.includes("\\") || s.includes("..") || /[\r\n]/.test(s)) {
    throw new Error("Invalid path segment");
  }
  return encodeURIComponent(s);
}

export class MailchimpService {
  private apiKey: string;
  private dataCenter: string;
  private baseUrl: string;

  constructor(apiKey: string) {
    if (!API_KEY_RE.test(apiKey)) {
      throw new Error("Invalid Mailchimp API key format");
    }
    this.apiKey = apiKey;
    const keyParts = apiKey.split("-");
    this.dataCenter = keyParts[keyParts.length - 1];
    if (!DATA_CENTER_RE.test(this.dataCenter)) {
      throw new Error("Invalid Mailchimp API key data center");
    }
    this.baseUrl = `https://${this.dataCenter}.api.mailchimp.com/3.0`;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`anystring:${this.apiKey}`).toString("base64")}`;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal as any,
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const body = await response.text();
        const ref = randomUUID();
        console.error(
          JSON.stringify({
            event: "mailchimp_api_error",
            ref,
            status: response.status,
            statusText: response.statusText,
            body: body.slice(0, 4000),
          })
        );
        throw new Error(
          `Mailchimp API Error: ${response.status} (ref: ${ref})`
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async makeRequest<T = any>(endpoint: string): Promise<T> {
    return this.fetchJson<T>(`${this.baseUrl}${endpoint}`);
  }

  private async makePaginatedRequest<T = any>(
    endpoint: string,
    sortField: string = "create_time",
    sortDirection: "ASC" | "DESC" = "DESC"
  ): Promise<T> {
    const params = new URLSearchParams({
      count: "1000",
      sort_field: sortField,
      sort_dir: sortDirection,
    });
    return this.fetchJson<T>(
      `${this.baseUrl}${endpoint}?${params.toString()}`
    );
  }

  // Automation Management
  async listAutomations(): Promise<{ automations: MailchimpAutomation[] }> {
    return await this.makePaginatedRequest(
      "/automations",
      "create_time",
      "DESC"
    );
  }

  async getAutomation(workflowId: string): Promise<MailchimpAutomation> {
    return await this.makeRequest(`/automations/${enc(workflowId)}`);
  }

  // Automation Email Management
  async listAutomationEmails(
    workflowId: string
  ): Promise<{ emails: MailchimpAutomationEmail[] }> {
    return await this.makePaginatedRequest(
      `/automations/${enc(workflowId)}/emails`,
      "send_time",
      "DESC"
    );
  }

  async getAutomationEmail(
    workflowId: string,
    emailId: string
  ): Promise<MailchimpAutomationEmail> {
    return await this.makeRequest(
      `/automations/${enc(workflowId)}/emails/${enc(emailId)}`
    );
  }

  // Automation Subscriber Management
  async listAutomationSubscribers(
    workflowId: string,
    emailId: string
  ): Promise<{ subscribers: MailchimpAutomationSubscriber[] }> {
    return await this.makePaginatedRequest(
      `/automations/${enc(workflowId)}/emails/${enc(emailId)}/queue`,
      "timestamp_signup",
      "DESC"
    );
  }

  // Automation Queue Management
  async getAutomationQueue(
    workflowId: string,
    emailId: string
  ): Promise<{ queue: MailchimpAutomationQueue[] }> {
    return await this.makePaginatedRequest(
      `/automations/${enc(workflowId)}/emails/${enc(emailId)}/queue`,
      "timestamp_signup",
      "DESC"
    );
  }

  // List Management (for automation recipients)
  async listLists(): Promise<{ lists: MailchimpList[] }> {
    return await this.makePaginatedRequest("/lists", "date_created", "DESC");
  }

  async getList(listId: string): Promise<MailchimpList> {
    return await this.makeRequest(`/lists/${enc(listId)}`);
  }

  // Automation Reports
  async getAutomationReport(workflowId: string): Promise<any> {
    return await this.makeRequest(`/automations/${enc(workflowId)}/emails`);
  }

  async getAutomationEmailReport(
    workflowId: string,
    emailId: string
  ): Promise<any> {
    return await this.makeRequest(
      `/automations/${enc(workflowId)}/emails/${enc(emailId)}`
    );
  }

  // Automation Subscriber Activity
  async getSubscriberActivity(
    workflowId: string,
    emailId: string,
    subscriberHash: string
  ): Promise<any> {
    return await this.makeRequest(
      `/automations/${enc(workflowId)}/emails/${enc(emailId)}/queue/${enc(subscriberHash)}/activity`
    );
  }

  // Campaign Management
  async listCampaigns(): Promise<{ campaigns: MailchimpCampaign[] }> {
    return await this.makePaginatedRequest("/campaigns", "create_time", "DESC");
  }

  async getCampaign(campaignId: string): Promise<MailchimpCampaign> {
    return await this.makeRequest(`/campaigns/${enc(campaignId)}`);
  }

  // Member Management
  async listMembers(listId: string): Promise<{ members: MailchimpMember[] }> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/members`,
      "timestamp_signup",
      "DESC"
    );
  }

  async getMember(
    listId: string,
    subscriberHash: string
  ): Promise<MailchimpMember> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/members/${enc(subscriberHash)}`
    );
  }

  // Segment Management
  async listSegments(
    listId: string
  ): Promise<{ segments: MailchimpSegment[] }> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/segments`,
      "created_at",
      "DESC"
    );
  }

  async getSegment(
    listId: string,
    segmentId: number
  ): Promise<MailchimpSegment> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/segments/${enc(segmentId)}`
    );
  }

  // Template Management
  async listTemplates(): Promise<{ templates: MailchimpTemplate[] }> {
    return await this.makePaginatedRequest(
      "/templates",
      "date_created",
      "DESC"
    );
  }

  async getTemplate(templateId: number): Promise<MailchimpTemplate> {
    return await this.makeRequest(`/templates/${enc(templateId)}`);
  }

  // Campaign Reports
  async listCampaignReports(): Promise<{ reports: MailchimpCampaignReport[] }> {
    return await this.makePaginatedRequest("/reports", "send_time", "DESC");
  }

  async getCampaignReport(
    campaignId: string
  ): Promise<MailchimpCampaignReport> {
    return await this.makeRequest(`/reports/${enc(campaignId)}`);
  }

  // Account Information
  async getAccount(): Promise<MailchimpAccount> {
    return await this.makeRequest("/");
  }

  // Folder Management
  async listFolders(): Promise<{ folders: MailchimpFolder[] }> {
    return await this.makePaginatedRequest("/campaign-folders", "name", "ASC");
  }

  async getFolder(folderId: string): Promise<MailchimpFolder> {
    return await this.makeRequest(`/campaign-folders/${enc(folderId)}`);
  }

  // File Manager
  async listFiles(): Promise<{ files: MailchimpFile[] }> {
    return await this.makePaginatedRequest(
      "/file-manager/files",
      "created_at",
      "DESC"
    );
  }

  async getFile(fileId: string): Promise<MailchimpFile> {
    return await this.makeRequest(`/file-manager/files/${enc(fileId)}`);
  }

  // Landing Pages
  async listLandingPages(): Promise<{ landing_pages: MailchimpLandingPage[] }> {
    return await this.makePaginatedRequest(
      "/landing-pages",
      "created_at",
      "DESC"
    );
  }

  async getLandingPage(pageId: string): Promise<MailchimpLandingPage> {
    return await this.makeRequest(`/landing-pages/${enc(pageId)}`);
  }

  // E-commerce Stores
  async listStores(): Promise<{ stores: MailchimpStore[] }> {
    return await this.makePaginatedRequest(
      "/ecommerce/stores",
      "created_at",
      "DESC"
    );
  }

  async getStore(storeId: string): Promise<MailchimpStore> {
    return await this.makeRequest(`/ecommerce/stores/${enc(storeId)}`);
  }

  // E-commerce Products
  async listProducts(
    storeId: string
  ): Promise<{ products: MailchimpProduct[] }> {
    return await this.makePaginatedRequest(
      `/ecommerce/stores/${enc(storeId)}/products`,
      "created_at",
      "DESC"
    );
  }

  async getProduct(
    storeId: string,
    productId: string
  ): Promise<MailchimpProduct> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/products/${enc(productId)}`
    );
  }

  // E-commerce Orders
  async listOrders(storeId: string): Promise<{ orders: MailchimpOrder[] }> {
    return await this.makePaginatedRequest(
      `/ecommerce/stores/${enc(storeId)}/orders`,
      "processed_at_foreign",
      "DESC"
    );
  }

  async getOrder(storeId: string, orderId: string): Promise<MailchimpOrder> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/orders/${enc(orderId)}`
    );
  }

  // Conversations
  async listConversations(): Promise<{
    conversations: MailchimpConversation[];
  }> {
    return await this.makePaginatedRequest(
      "/conversations",
      "timestamp",
      "DESC"
    );
  }

  async getConversation(
    conversationId: string
  ): Promise<MailchimpConversation> {
    return await this.makeRequest(`/conversations/${enc(conversationId)}`);
  }

  // Merge Fields
  async listMergeFields(
    listId: string
  ): Promise<{ merge_fields: MailchimpMergeField[] }> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/merge-fields`,
      "display_order",
      "ASC"
    );
  }

  async getMergeField(
    listId: string,
    mergeFieldId: number
  ): Promise<MailchimpMergeField> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/merge-fields/${enc(mergeFieldId)}`
    );
  }

  // Interest Categories
  async listInterestCategories(listId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/interest-categories`,
      "display_order",
      "ASC"
    );
  }

  async getInterestCategory(listId: string, categoryId: string): Promise<any> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/interest-categories/${enc(categoryId)}`
    );
  }

  // Interests
  async listInterests(listId: string, categoryId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/interest-categories/${enc(categoryId)}/interests`,
      "display_order",
      "ASC"
    );
  }

  async getInterest(
    listId: string,
    categoryId: string,
    interestId: string
  ): Promise<any> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/interest-categories/${enc(categoryId)}/interests/${enc(interestId)}`
    );
  }

  // Tags
  async listTags(listId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/segments`,
      "created_at",
      "DESC"
    );
  }

  async getTag(listId: string, tagId: number): Promise<any> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/segments/${enc(tagId)}`
    );
  }

  // Webhooks
  async listWebhooks(listId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/webhooks`,
      "created_at",
      "DESC"
    );
  }

  async getWebhook(listId: string, webhookId: string): Promise<any> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/webhooks/${enc(webhookId)}`
    );
  }

  // Growth History
  async getGrowthHistory(listId: string): Promise<any> {
    return await this.makeRequest(`/lists/${enc(listId)}/growth-history`);
  }

  // Activity Feed
  async getActivityFeed(listId: string): Promise<any> {
    return await this.makeRequest(`/lists/${enc(listId)}/activity`);
  }

  // Client Statistics
  async getClientStats(listId: string): Promise<any> {
    return await this.makeRequest(`/lists/${enc(listId)}/clients`);
  }

  // Location Statistics
  async getLocationStats(listId: string): Promise<any> {
    return await this.makeRequest(`/lists/${enc(listId)}/locations`);
  }

  // Note Management
  async listMemberNotes(listId: string, subscriberHash: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/members/${enc(subscriberHash)}/notes`,
      "created_at",
      "DESC"
    );
  }

  async getMemberNote(
    listId: string,
    subscriberHash: string,
    noteId: string
  ): Promise<any> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/members/${enc(subscriberHash)}/notes/${enc(noteId)}`
    );
  }

  // Goal Management
  async listGoals(listId: string, subscriberHash: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/lists/${enc(listId)}/members/${enc(subscriberHash)}/goals`,
      "created_at",
      "DESC"
    );
  }

  async getGoal(
    listId: string,
    subscriberHash: string,
    goalId: string
  ): Promise<any> {
    return await this.makeRequest(
      `/lists/${enc(listId)}/members/${enc(subscriberHash)}/goals/${enc(goalId)}`
    );
  }

  // Campaign Content
  async getCampaignContent(campaignId: string): Promise<any> {
    return await this.makeRequest(`/campaigns/${enc(campaignId)}/content`);
  }

  // Campaign Feedback
  async getCampaignFeedback(campaignId: string): Promise<any> {
    return await this.makeRequest(`/campaigns/${enc(campaignId)}/feedback`);
  }

  // Campaign Send Checklist
  async getCampaignSendChecklist(campaignId: string): Promise<any> {
    return await this.makeRequest(
      `/campaigns/${enc(campaignId)}/send-checklist`
    );
  }

  // Campaign Recipients
  async getCampaignRecipients(campaignId: string): Promise<any> {
    return await this.makeRequest(`/campaigns/${enc(campaignId)}/recipients`);
  }

  // Campaign Opens
  async getCampaignOpens(campaignId: string): Promise<any> {
    return await this.makeRequest(`/reports/${enc(campaignId)}/opens`);
  }

  // Campaign Clicks
  async getCampaignClicks(campaignId: string): Promise<any> {
    return await this.makeRequest(`/reports/${enc(campaignId)}/click-details`);
  }

  // Campaign Unsubscribes
  async getCampaignUnsubscribes(campaignId: string): Promise<any> {
    return await this.makeRequest(`/reports/${enc(campaignId)}/unsubscribed`);
  }

  // Campaign Bounces
  async getCampaignBounces(campaignId: string): Promise<any> {
    return await this.makeRequest(`/reports/${enc(campaignId)}/bounces`);
  }

  // Campaign Abuse Reports
  async getCampaignAbuseReports(campaignId: string): Promise<any> {
    return await this.makeRequest(`/reports/${enc(campaignId)}/abuse-reports`);
  }

  // Campaign Forwards
  async getCampaignForwards(campaignId: string): Promise<any> {
    return await this.makeRequest(`/reports/${enc(campaignId)}/forwards`);
  }

  // Campaign Outbound Activity
  async getCampaignOutboundActivity(campaignId: string): Promise<any> {
    return await this.makeRequest(
      `/reports/${enc(campaignId)}/outbound-activity`
    );
  }

  // Campaign Email Activity
  async getCampaignEmailActivity(campaignId: string): Promise<any> {
    return await this.makeRequest(
      `/reports/${enc(campaignId)}/email-activity`
    );
  }

  // Campaign Subscriber Activity
  async getCampaignSubscriberActivity(
    campaignId: string,
    subscriberHash: string
  ): Promise<any> {
    return await this.makeRequest(
      `/reports/${enc(campaignId)}/email-activity/${enc(subscriberHash)}`
    );
  }

  // E-commerce Customers
  async listCustomers(storeId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/ecommerce/stores/${enc(storeId)}/customers`,
      "created_at",
      "DESC"
    );
  }

  async getCustomer(storeId: string, customerId: string): Promise<any> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/customers/${enc(customerId)}`
    );
  }

  // E-commerce Product Variants
  async listProductVariants(storeId: string, productId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/ecommerce/stores/${enc(storeId)}/products/${enc(productId)}/variants`,
      "created_at",
      "DESC"
    );
  }

  async getProductVariant(
    storeId: string,
    productId: string,
    variantId: string
  ): Promise<any> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/products/${enc(productId)}/variants/${enc(variantId)}`
    );
  }

  // E-commerce Order Lines
  async getOrderLines(storeId: string, orderId: string): Promise<any> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/orders/${enc(orderId)}/lines`
    );
  }

  // E-commerce Carts
  async listCarts(storeId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/ecommerce/stores/${enc(storeId)}/carts`,
      "created_at",
      "DESC"
    );
  }

  async getCart(storeId: string, cartId: string): Promise<any> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/carts/${enc(cartId)}`
    );
  }

  // E-commerce Cart Lines
  async getCartLines(storeId: string, cartId: string): Promise<any> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/carts/${enc(cartId)}/lines`
    );
  }

  // E-commerce Promo Rules
  async listPromoRules(storeId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/ecommerce/stores/${enc(storeId)}/promo-rules`,
      "created_at",
      "DESC"
    );
  }

  async getPromoRule(storeId: string, promoRuleId: string): Promise<any> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/promo-rules/${enc(promoRuleId)}`
    );
  }

  // E-commerce Promo Codes
  async listPromoCodes(storeId: string, promoRuleId: string): Promise<any> {
    return await this.makePaginatedRequest(
      `/ecommerce/stores/${enc(storeId)}/promo-rules/${enc(promoRuleId)}/promo-codes`,
      "created_at",
      "DESC"
    );
  }

  async getPromoCode(
    storeId: string,
    promoRuleId: string,
    promoCodeId: string
  ): Promise<any> {
    return await this.makeRequest(
      `/ecommerce/stores/${enc(storeId)}/promo-rules/${enc(promoRuleId)}/promo-codes/${enc(promoCodeId)}`
    );
  }
}
