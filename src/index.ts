#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { MailchimpService } from "./services/mailchimp.js";
import { getToolDefinitions, handleToolCall } from "./tools/index.js";

// Scrub control characters (incl. CR/LF) to prevent log injection (CWE-117).
function scrub(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, " ");
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.error(
      JSON.stringify({ event, ts: new Date().toISOString(), ...fields })
    );
  } catch {
    console.error(JSON.stringify({ event, ts: new Date().toISOString() }));
  }
}

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;

// Service is initialized lazily so the MCP transport can start and report
// configuration errors as protocol-level errors rather than a startup crash.
let mailchimpService: MailchimpService | null = null;
function getService(): MailchimpService {
  if (!mailchimpService) {
    if (!MAILCHIMP_API_KEY) {
      throw new McpError(
        ErrorCode.InternalError,
        "MAILCHIMP_API_KEY not configured"
      );
    }
    mailchimpService = new MailchimpService(MAILCHIMP_API_KEY);
  }
  return mailchimpService;
}

const server = new Server(
  {
    name: "mailchimp-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: getToolDefinitions(getService()),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName =
    typeof request.params.name === "string" ? request.params.name : "";
  try {
    return await handleToolCall(
      getService(),
      toolName,
      request.params.arguments
    );
  } catch (error: any) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    logEvent("tool_call_error", {
      tool: scrub(toolName).slice(0, 64),
      message: scrub(String(message)).slice(0, 500),
    });

    if (error instanceof McpError) {
      throw error;
    }

    // Mailchimp service errors are already sanitized (UUID ref, no body).
    if (typeof message === "string" && message.startsWith("Mailchimp API Error:")) {
      throw new McpError(ErrorCode.InternalError, message);
    }

    throw new McpError(ErrorCode.InternalError, "An unexpected error occurred");
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logEvent("server_started", { transport: "stdio" });
  if (!MAILCHIMP_API_KEY) {
    logEvent("config_missing", { key: "MAILCHIMP_API_KEY" });
  }
}

main().catch((error) => {
  logEvent("server_fatal", {
    message: scrub(
      error instanceof Error ? error.message : "Unexpected fatal error"
    ).slice(0, 500),
  });
  process.exit(1);
});
