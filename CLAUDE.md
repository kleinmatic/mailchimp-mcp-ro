# CLAUDE.md

Read this before making changes to the service layer or the tool catalog.

The patterns below are **not stylistic conventions** — they're security
invariants enforced by a recent hardening pass. Removing them as
"over-engineering" or "simplification" reopens specific risks, listed
under each section. When in doubt, prefer keeping the helper and asking.

## Layout

- `src/index.ts` — MCP server bootstrap, stdio transport, request handlers.
- `src/services/mailchimp.ts` — single class wrapping Mailchimp Marketing
  API v3. All outbound HTTP lives here.
- `src/tools/index.ts` — MCP tool catalog (`getToolDefinitions`) and the
  `handleToolCall` dispatch.
- `src/types/index.ts` — Mailchimp response shapes.

## Authentication context

The server runs under a single `MAILCHIMP_API_KEY` that has **full
read+write** access to the Mailchimp account. The "read-only" framing of
this MCP server is enforced only by which methods exist on
`MailchimpService` and which endpoints they hit. There is no API-side
scoping. Treat the service layer as the security boundary.

## URL path segments — `enc()` in `src/services/mailchimp.ts`

Every variable interpolated into a Mailchimp URL must go through
`enc()`. It rejects `/`, `\`, `..`, CR/LF, empty strings, and segments
over 128 chars, then returns `encodeURIComponent`.

**Why it's load-bearing:** tool arguments come from an LLM. Without
encoding+rejection, an ID like `abc/../lists/<id>/members/<hash>`
escapes its path segment and reaches arbitrary endpoints under a
full-scope API key — including write/delete endpoints the tool catalog
never exposes.

**Don't:**

- Don't write `${id}` directly into a URL template, even if you "know"
  the ID is safe.
- Don't replace `enc()` with bare `encodeURIComponent` — `enc()` also
  rejects traversal sequences before encoding.
- Don't bypass `enc()` for "trusted" args from your own handler;
  trust does not propagate across an LLM call.

## Outbound HTTP — `makeRequest` / `makePaginatedRequest`

These are the **only** call sites for `fetch` in this codebase. Both
pin `method: "GET"` and `redirect: "error"` and use a single
`AbortSignal` timeout (currently 60s; calibrated to Mailchimp's
`/reports` p95).

**Why it's load-bearing:** the API key has full write scope. Any
caller-controlled `method`, `body`, `redirect`, `agent`, or `signal`
breaks the read-only contract. `redirect: "error"` keeps the hardcoded
host from being bounced. The timeout bounds a slow upstream from
hanging the worker.

**Don't:**

- Don't add a new `fetch` call somewhere else. Add a method to
  `MailchimpService` instead.
- Don't add a generic `options` parameter to `makeRequest`. The
  earlier version had one; it's gone for a reason.
- Don't accept caller-supplied `headers` — the merge order would let a
  caller override `Authorization`.
- Don't loosen `redirect: "error"` to `"follow"`.

## Errors — UUID ref, never the upstream body

Non-2xx responses from Mailchimp throw
`Mailchimp API Error: <status> (ref: <uuid>)`. The full upstream body
is written to stderr keyed by that ref via `console.error(JSON.stringify(...))`.

**Why it's load-bearing:** Mailchimp error bodies echo request URLs,
sometimes header fragments, and resource details. Surfacing them
through `McpError` to the client gives an attacker an
endpoint-enumeration oracle and could leak secrets in misconfig
scenarios.

**Don't:**

- Don't put the upstream body, response status text beyond the code,
  or the requested URL into the user-facing `McpError` message.
- Don't change the error message shape — `src/index.ts` does a string
  prefix match (`startsWith("Mailchimp API Error:")`) on it.

## Tool argument validation — `validateArgs` + JSON schema

`handleToolCall` calls `validateArgs(args)` first. Every tool's
`inputSchema` has `additionalProperties: false` and uses the shared
fragments `S_STR_ID`, `S_SUB_HASH`, `S_NUM_ID`, `S_COUNT`, `S_OFFSET`.

To add a new ID-shaped argument:

1. Use the right schema fragment in `inputSchema.properties`.
2. Add the key name to the matching `STRING_ID_KEYS` / `HASH_KEYS` /
   `NUMERIC_ID_KEYS` / `PAGINATION_KEYS` set so `validateArgs`
   enforces it at runtime.
3. Keep `additionalProperties: false`.

The schema and the runtime validator must always agree. The runtime
check is the authoritative one — JSON Schema is advisory at the MCP
layer.

**Why it's load-bearing:** the schema-only check is not enforced by
the MCP SDK; an MCP client (or a prompt-injected one) can send
arguments that violate the schema. Runtime regex+type validation is
the actual gate.

**Don't:**

- Don't drop `additionalProperties: false` because "it's annoying."
- Don't widen the ID regex (`/^[A-Za-z0-9_-]{1,64}$/`). Mailchimp IDs
  fit it; a wider character class lets traversal payloads back in.
- Don't trust JSON-Schema validation in lieu of `validateArgs`.

## Tool output — `untrusted()` + projectors

Anything authored by a subscriber, marketer, or third party that ends
up in tool output goes through one of these helpers in
`src/tools/index.ts`:

- `untrusted(kind, text, maxLen=4000)` — NFKC-normalizes, strips bidi
  overrides / zero-width / BOM, strips nested `<untrusted>` tags so
  the wrapper can't be closed early, truncates, then wraps in
  `<untrusted kind="…">…</untrusted>`.
- Per-type projectors (`projectMember`, `projectOrder`,
  `projectConversation`, `projectCampaign`, `projectAutomation`,
  `projectAutomationEmail`, `projectTemplate`) drop fields the
  operator doesn't need (IPs, geo, full address blocks, internal IDs)
  and apply `untrusted()` to the free-text fields they keep.

**Why it's load-bearing:** Mailchimp content includes data authored by
subscribers (inbound replies, merge fields, names) and marketers
(subject lines, campaign HTML). Concatenating that into a tool
response that an LLM reads is the indirect prompt-injection pattern.
The projectors also strip PII (email IPs, lat/long, billing/shipping
addresses) that the operator does not need to do their job — the
fewer of those that reach the model, the better the GDPR posture.

**Don't:**

- Don't dump full member/order/conversation/campaign/automation/
  template objects with `JSON.stringify(obj)`. Use the projector.
- Don't surface a new free-text field unwrapped because "it's a
  one-liner." Wrap with `untrusted("kind", value)`.
- Don't widen what the projectors keep without thinking about whose
  hands the field passes through.
- Don't add `ip_signup`, `ip_opt`, `unique_email_id`, `web_id`,
  `location.*`, or full address blocks back into a projection.

## Pagination — clamped count/offset

`makePaginatedRequest` accepts optional `count` and `offset`.
Defaults: 50 and 0. Clamps: `count ∈ [1, 500]`,
`offset ∈ [0, 1_000_000]`.

Every paginated tool's schema declares `count: S_COUNT, offset: S_OFFSET`,
the handler forwards `a.count, a.offset` to the service, and both are
validated by `validateArgs` (which rejects out-of-range values rather
than clamping silently — so the user gets a clear error).

**Why it's load-bearing:** without bounds, a single `list_members` or
`list_orders` call returns the entire audience as JSON in the LLM
context — both a PII-egress vector and a fast way to blow out the
context window and token budget.

**Don't:**

- Don't bump the default `count` past 50 to "match the old behavior."
  The old behavior (1000) is the bug.
- Don't add a list endpoint that bypasses the clamps. New paginated
  service methods must call `makePaginatedRequest`.
- Don't validate `count`/`offset` only at the schema layer.

## Logging — `logEvent` + `scrub`

Use `logEvent(event, fields)` in `src/index.ts` rather than
`console.error` directly. Strings derived from user input go through
`scrub()` (strips C0 control characters and DEL) and a length cap
before they hit the log.

**Why it's load-bearing:** MCP hosts persist subprocess stderr to log
files. User-supplied IDs flowing through unscrubbed can contain CR/LF
to forge log lines (CWE-117) or carry PII into an unrotated on-disk
trail.

**Don't:**

- Don't `console.error(error)` — `error.message` may carry untrusted
  text. Log specific scrubbed fields.
- Don't log full Mailchimp response bodies in `src/index.ts`. The
  service layer already logs them once, keyed by ref.
- Don't drop the length cap. Logs are not unbounded.

## Dependencies

Direct deps in `package.json` are pinned to exact versions (no
carets). `package-lock.json` ships in the npm tarball via `files[]`.

**Why it's load-bearing:** `npx @agentx-ai/mailchimp-mcp-server` does a
fresh resolution on each install. Without exact pins and a shipped
lockfile, every user gets whatever npm picked at install time — and
this process holds a full-scope Mailchimp API key.

**Don't:**

- Don't reintroduce caret ranges on direct deps.
- Don't remove `package-lock.json` from `files[]`.
- Don't bump `@modelcontextprotocol/sdk` past 0.6.x in a routine
  change — that's a breaking upgrade and needs its own pass.

## Build

```
npm install
npm run build      # tsc + chmod
npx tsc --noEmit   # typecheck only
```

There are no tests yet. If you add one, run it before each push.
