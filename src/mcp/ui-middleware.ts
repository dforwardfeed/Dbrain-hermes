/**
 * GenUI middleware — optional UI artifact creation hook for the MCP dispatch path.
 *
 * Flow:
 *   1. Operation handler returns a result (unchanged).
 *   2. dispatchToolCall calls `maybeRenderUi({ operation, params, result, ctx })`.
 *   3. Middleware decides (deterministic scoring) whether to render.
 *   4. If yes, POST an artifact to the Hermes/Railway GenUI portal with a short
 *      timeout. Portal responds with `{ id, url, status }` (or `{ artifact: {…} }`).
 *   5. Returns a small UiArtifactSummary the dispatcher folds into the final
 *      MCP text payload as `{ result, ui }`. On any failure, returns null —
 *      the dispatcher MUST keep returning the normal MCP result.
 *
 * Reliability rule: if anything in this module throws, the operation result
 * still ships. UI is strictly additive.
 *
 * Config is read at call time (not module load) so tests + Railway env updates
 * take effect without restarting the process. The artifact-POST client is
 * injectable via `setArtifactClient()` so tests can mock it without touching
 * `globalThis.fetch`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OperationContext } from '../core/operations.ts';
import { operations } from '../core/operations.ts';

// --- Debug logging ---
//
// Two channels, both always-on, both best-effort (errors swallowed):
//   1. stderr — human-readable `[genui-<event>] <json>` line per record.
//      Useful when stderr is captured by the parent process (Railway/Fly).
//   2. JSONL file — each record on its own line at GENUI_DEBUG_LOG (default:
//      /data/genui/gbrain-mcp-genui.log). Useful when stderr is NOT captured
//      because the gbrain subprocess is running headless under an agent like
//      Hermes — the user can `tail -f` the file from Telegram or shell.
//
// Never writes secret material. Token presence is signaled via length only.

const DEFAULT_DEBUG_LOG_PATH = '/data/genui/gbrain-mcp-genui.log';

let _fileLogReady: { path: string; ready: boolean } | null = null;

function resolveDebugLogPath(): string {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
  const override = env.GENUI_DEBUG_LOG?.trim();
  return override && override.length > 0 ? override : DEFAULT_DEBUG_LOG_PATH;
}

function ensureFileLogReady(path: string): boolean {
  if (_fileLogReady && _fileLogReady.path === path) return _fileLogReady.ready;
  let ready = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    ready = true;
  } catch {
    ready = false;
  }
  _fileLogReady = { path, ready };
  return ready;
}

function debugLogStderr(line: string): void {
  try { process.stderr.write(line.endsWith('\n') ? line : line + '\n'); } catch { /* swallow */ }
}

function debugLogFile(jsonLine: string): void {
  try {
    const path = resolveDebugLogPath();
    if (!ensureFileLogReady(path)) return;
    appendFileSync(path, jsonLine.endsWith('\n') ? jsonLine : jsonLine + '\n', { encoding: 'utf8' });
  } catch { /* swallow — file logging is best-effort */ }
}

/**
 * Emit one structured debug record. Writes to BOTH stderr (legacy `[genui-*]`
 * format) and the JSONL file at `GENUI_DEBUG_LOG`. Never throws.
 */
function recordDebug(event: string, fields: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), event, ...fields };
  let serialized: string;
  try { serialized = JSON.stringify(entry); }
  catch { serialized = JSON.stringify({ ts: entry.ts, event, _serialize_error: true }); }
  debugLogStderr(`[genui-${event}] ${serialized}`);
  debugLogFile(serialized);
}

/** Test-only seam: clear the cached "did we successfully mkdir?" memo. */
export function _resetDebugLogPathForTests(): void {
  _fileLogReady = null;
}

/**
 * Strip MCP-client-side display prefixes (e.g. Claude Desktop / Cursor render
 * tools as `mcp_<server>_<tool>`). On the wire the bare `<tool>` is what the
 * spec sends, but if any client-side rewriter or proxy passes the prefixed
 * name through unchanged, this normalizer keeps `UI_RULES['search']` matching.
 *
 * Pattern: `mcp_<lowercase-or-digit>_<rest>` → `<rest>`. Idempotent on bare names.
 */
export function normalizeOperationName(name: string): string {
  const m = /^mcp_[a-z0-9]+_(.+)$/i.exec(name);
  return m ? m[1] : name;
}

/**
 * Always-on boot log. Called by `src/mcp/server.ts` at MCP server startup so
 * Railway logs show — at the gbrain subprocess level, not Hermes — whether
 * GenUI is configured. If you don't see this line, the binary you're running
 * predates the GenUI patch.
 */
export function logGenuiBoot(): void {
  const cfg = loadGenuiConfig();
  recordDebug('boot', {
    enabled: cfg.enabled,
    mode: cfg.mode,
    base_url_set: !!cfg.baseUrl,
    token_len: cfg.apiToken ? cfg.apiToken.length : 0,
    render_for: [...cfg.renderFor],
    ttl_hours: cfg.ttlHours,
    max_payload_bytes: cfg.maxPayloadBytes,
    timeout_ms: cfg.timeoutMs,
    view_picker_enabled: cfg.viewPickerEnabled,
    view_picker_model: cfg.viewPickerModel ?? '<gateway-default>',
    line_chart_enabled: cfg.lineChartEnabled,
    debug_log_path: resolveDebugLogPath(),
  });
}

/**
 * Always-on per-call dispatch log. Called by `src/mcp/dispatch.ts` BEFORE
 * `maybeRenderUi` runs. Discriminates "wrong binary" / "env var missing" /
 * "operation name mismatch" / "shape mismatch" from "Hermes is unwrapping the
 * payload upstream."
 */
export function logGenuiDispatchEntry(operation: string, result: unknown): void {
  const cfg = loadGenuiConfig();
  const normalized = normalizeOperationName(operation);
  const isArr = Array.isArray(result);
  const len = isArr ? (result as unknown[]).length : -1;
  recordDebug('dispatch', {
    operation,
    normalized_operation: normalized,
    enabled: cfg.enabled,
    mode: cfg.mode,
    base_url_set: !!cfg.baseUrl,
    token_len: cfg.apiToken ? cfg.apiToken.length : 0,
    result_is_array: isArr,
    result_len: len,
    rule_hit: !!UI_RULES[normalized],
  });
}

// --- Public types ---

export type UiMode = 'off' | 'manual' | 'auto' | 'always';

export interface GenuiConfig {
  enabled: boolean;
  mode: UiMode;
  baseUrl: string | null;
  apiToken: string | null;
  ttlHours: number;
  renderFor: Set<string>;
  maxPayloadBytes: number;
  /** Total POST timeout (ms). */
  timeoutMs: number;
  /** Layer 2: opt-in LLM view-picker. Default off. */
  viewPickerEnabled: boolean;
  /** Optional model override for the view-picker call (e.g. "anthropic:claude-haiku-4-5"). */
  viewPickerModel: string | null;
  /** Total view-picker call timeout (ms). Tight cap so renders stay snappy. */
  viewPickerTimeoutMs: number;
  /**
   * Per-template feature flag. When true, `line_chart` is added to
   * TEMPLATE_CATALOG so the LLM picker may emit it AND the `render_chart`
   * MCP op routes through it. Off by default — flip on once the Hermes
   * portal renderer is ready (otherwise every line_chart artifact 400s).
   */
  lineChartEnabled: boolean;
}

export interface UiArtifactSummary {
  id: string;
  type: string;
  category: string;
  title: string;
  url: string;
  status: 'temporary' | 'saved';
}

export interface UiOverride {
  enabled?: boolean;
  preference?: string;
  title?: string;
}

export interface MaybeRenderUiInput {
  operation: string;
  params: Record<string, unknown>;
  result: unknown;
  ctx: OperationContext;
}

// --- UI rules per operation ---

interface UiRule {
  /** true: always renderable on shape match. 'conditional': only when shape detector agrees. false: never. */
  renderable: boolean | 'conditional';
  category: string;
  defaultView: string;
  template: string;
}

/**
 * MVP rule table. Names match `src/core/operations.ts` exactly.
 * `list_jobs` and `get_job` are the actual op names (not `jobs_list` / `jobs_get`).
 */
export const UI_RULES: Record<string, UiRule> = {
  search:         { renderable: true,          category: 'search',   defaultView: 'table',     template: 'search_table' },
  query:          { renderable: 'conditional', category: 'search',   defaultView: 'table',     template: 'search_table' },
  traverse_graph: { renderable: true,          category: 'graph',    defaultView: 'graph',     template: 'generic_cards' },
  get_timeline:   { renderable: true,          category: 'timeline', defaultView: 'timeline',  template: 'timeline_view' },
  get_stats:      { renderable: true,          category: 'stats',    defaultView: 'dashboard', template: 'stats_dashboard' },
  get_health:     { renderable: true,          category: 'stats',    defaultView: 'dashboard', template: 'stats_dashboard' },
  list_jobs:      { renderable: true,          category: 'jobs',     defaultView: 'status',    template: 'jobs_status' },
  get_job:        { renderable: true,          category: 'jobs',     defaultView: 'status',    template: 'jobs_status' },
  find_orphans:   { renderable: true,          category: 'graph',    defaultView: 'cards',     template: 'generic_cards' },
  get_backlinks:  { renderable: 'conditional', category: 'graph',    defaultView: 'cards',     template: 'generic_cards' },
  list_pages:     { renderable: 'conditional', category: 'search',   defaultView: 'table',     template: 'search_table' },
  // Explicit-render op: agent assembles {x, y} points (e.g. from web search
  // via Tavily/Exa or from an MCP that returns financial data) and calls
  // render_chart to produce a portal artifact URL. Skipped automatically by
  // decideRender's catalog check until GENUI_LINE_CHART=true on Hermes.
  render_chart:   { renderable: true,          category: 'finance',  defaultView: 'chart',     template: 'line_chart' },
};

// --- Config (read at call time) ---

function parseBool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function parseMode(v: string | undefined): UiMode {
  const t = (v || '').trim().toLowerCase();
  if (t === 'off' || t === 'manual' || t === 'auto' || t === 'always') return t;
  return 'auto';
}

function parseRenderFor(v: string | undefined): Set<string> {
  const defaults = ['search', 'graph', 'timeline', 'jobs', 'stats', 'briefing', 'finance'];
  const raw = (v || defaults.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  return new Set(raw);
}

function parseInt10(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadGenuiConfig(): GenuiConfig {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
  const enabled = parseBool(env.GENUI_ENABLED, false);
  const mode = parseMode(env.GENUI_MODE);
  const rawBase = (env.GENUI_BASE_URL || '').trim();
  const baseUrl = rawBase ? rawBase.replace(/\/+$/, '') : null;
  const apiToken = env.GENUI_API_TOKEN ? env.GENUI_API_TOKEN.trim() : null;
  const ttlHours = parseInt10(env.GENUI_TEMPORARY_TTL_HOURS, 72);
  const renderFor = parseRenderFor(env.GENUI_RENDER_FOR);
  const maxPayloadBytes = parseInt10(env.GENUI_MAX_PAYLOAD_BYTES, 250_000);
  const timeoutMs = parseInt10(env.GENUI_TIMEOUT_MS, 2500);
  const viewPickerEnabled = parseBool(env.GENUI_VIEW_PICKER, false);
  const viewPickerModel = env.GENUI_VIEW_PICKER_MODEL?.trim() || null;
  const viewPickerTimeoutMs = parseInt10(env.GENUI_VIEW_PICKER_TIMEOUT_MS, 3000);
  const lineChartEnabled = parseBool(env.GENUI_LINE_CHART, false);
  return {
    enabled, mode, baseUrl, apiToken: apiToken || null, ttlHours, renderFor,
    maxPayloadBytes, timeoutMs, viewPickerEnabled, viewPickerModel, viewPickerTimeoutMs,
    lineChartEnabled,
  };
}

// --- Shape detection ---

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

export function isSearchResults(result: unknown): boolean {
  if (!Array.isArray(result) || result.length === 0) return false;
  const first = result[0];
  if (!isPlainObject(first)) return false;
  // Match SearchResult shape: slug + (score OR chunk_text OR page_id).
  return typeof first.slug === 'string' && (
    typeof first.score === 'number' ||
    typeof first.chunk_text === 'string' ||
    typeof first.page_id === 'number' ||
    typeof first.title === 'string'
  );
}

export function isGraphPaths(result: unknown): boolean {
  if (!Array.isArray(result) || result.length === 0) return false;
  const first = result[0];
  if (!isPlainObject(first)) return false;
  // GraphPath: from_slug + to_slug. GraphNode (legacy): slug + depth.
  if (typeof first.from_slug === 'string' && typeof first.to_slug === 'string') return true;
  if (typeof first.slug === 'string' && typeof first.depth === 'number') return true;
  return false;
}

export function isTimelineEntries(result: unknown): boolean {
  if (!Array.isArray(result) || result.length === 0) return false;
  const first = result[0];
  if (!isPlainObject(first)) return false;
  return typeof first.date === 'string' && (
    typeof first.summary === 'string' ||
    typeof first.detail === 'string' ||
    typeof first.source === 'string'
  );
}

export function isStatsResult(result: unknown): boolean {
  if (!isPlainObject(result)) return false;
  // Heuristic: object with at least one numeric field that looks stats-y.
  const numericKeys = Object.entries(result).filter(([, v]) => typeof v === 'number');
  return numericKeys.length >= 1;
}

export function isJobResult(result: unknown): boolean {
  // Single job: { id, status, ... }
  if (isPlainObject(result) && typeof result.id === 'number' && typeof result.status === 'string') return true;
  // Job list: array of those.
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0];
    if (isPlainObject(first) && typeof first.id === 'number' && typeof first.status === 'string') return true;
  }
  return false;
}

export function isPortfolioResult(result: unknown): boolean {
  if (!isPlainObject(result)) return false;
  return 'holdings' in result || 'totalValue' in result || 'allocation' in result;
}

function shapeMatches(operation: string, result: unknown): boolean {
  const rule = UI_RULES[operation];
  if (!rule) return false;
  switch (rule.category) {
    case 'search':   return isSearchResults(result);
    case 'graph':    return isGraphPaths(result) || isSearchResults(result);
    case 'timeline': return isTimelineEntries(result);
    case 'stats':    return isStatsResult(result);
    case 'jobs':     return isJobResult(result);
    case 'finance':  return isPortfolioResult(result);
    default:         return false;
  }
}

function categoryAllowed(cfg: GenuiConfig, category: string): boolean {
  if (cfg.renderFor.size === 0) return true;
  return cfg.renderFor.has(category);
}

// --- Mutating-op detection ---

function isMutating(operation: string): boolean {
  const op = operations.find(o => o.name === operation);
  if (op?.mutating) return true;
  // Fallback heuristics for ops outside the registry (defensive).
  return /^(put_|delete_|remove_|add_|cancel_|retry_|pause_|resume_|replay_|revert_|sync_|submit_|restore_|purge_|send_|sources_add|sources_remove)/.test(operation);
}

// --- Redaction ---

const REDACT_KEY_RE = /(token|secret|password|api[_-]?key|authorization|cookie|bearer)/i;

/**
 * Compact, secret-stripped summary of the request params. Echoes the keys an
 * operation declares (for debug visibility) and counts unknown keys. Values
 * are never echoed. Keys that look like secrets are dropped entirely.
 */
export function redactParamsSummary(operation: string, params: Record<string, unknown>): Record<string, unknown> {
  const op = operations.find(o => o.name === operation);
  const allow = op ? new Set(Object.keys(op.params)) : new Set<string>();
  const declared: string[] = [];
  let unknown = 0;
  for (const key of Object.keys(params || {})) {
    if (REDACT_KEY_RE.test(key)) continue;
    if (allow.has(key)) declared.push(key);
    else unknown += 1;
  }
  declared.sort();
  return {
    operation,
    declared_keys: declared,
    unknown_key_count: unknown,
  };
}

// --- Artifact client (injectable) ---

interface ArtifactPostInput {
  baseUrl: string;
  apiToken: string | null;
  body: Record<string, unknown>;
  timeoutMs: number;
}

interface ArtifactPostResult {
  id: string;
  url?: string;
  status?: string;
}

export type ArtifactClient = (input: ArtifactPostInput) => Promise<ArtifactPostResult>;

let _artifactClient: ArtifactClient = defaultArtifactClient;

export function setArtifactClient(client: ArtifactClient | null): void {
  _artifactClient = client || defaultArtifactClient;
}

async function defaultArtifactClient(input: ArtifactPostInput): Promise<ArtifactPostResult> {
  const url = `${input.baseUrl}/api/ui/artifacts`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (input.apiToken) {
    headers.authorization = `Bearer ${input.apiToken}`;
    headers['x-genui-token'] = input.apiToken;
  }
  // AbortSignal.timeout is built-in in Bun >= 1.x and Node >= 17.3.
  const signal = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout?.(input.timeoutMs)
    ?? makeFallbackTimeoutSignal(input.timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      signal,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    recordDebug('error', { stage: 'artifact_post_fetch', message: msg });
    throw e;
  }
  if (!res.ok) {
    // Capture the portal's validation message body (truncated, never logs
    // request material). Critical for diagnosing 400/422 schema mismatches —
    // status code alone doesn't tell us which field the portal rejected.
    let bodyExcerpt = '';
    try {
      const text = await res.text();
      bodyExcerpt = text.length > 1000 ? text.slice(0, 1000) + '…[truncated]' : text;
    } catch (e: unknown) {
      bodyExcerpt = `<read-failed: ${e instanceof Error ? e.message : String(e)}>`;
    }
    recordDebug('artifact_post', {
      status: res.status,
      ok: false,
      url_created: false,
      response_body: bodyExcerpt,
    });
    throw new Error(`GenUI portal responded ${res.status}: ${bodyExcerpt.slice(0, 200)}`);
  }
  let json: Record<string, unknown>;
  try { json = await res.json() as Record<string, unknown>; }
  catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    recordDebug('error', { stage: 'artifact_post_parse', message: msg });
    throw new Error(`GenUI portal returned non-JSON: ${msg}`);
  }
  // Support both shapes: { id, url, status } and { artifact: { id, url, status } }.
  const inner = isPlainObject(json.artifact) ? json.artifact : json;
  const id = typeof inner.id === 'string' ? inner.id : undefined;
  if (!id) {
    recordDebug('error', { stage: 'artifact_post_response', message: 'missing id in response' });
    throw new Error('GenUI portal response missing id');
  }
  recordDebug('artifact_post', {
    status: res.status,
    ok: true,
    url_created: typeof inner.url === 'string' && (inner.url as string).length > 0,
  });
  return {
    id,
    url: typeof inner.url === 'string' ? inner.url : undefined,
    status: typeof inner.status === 'string' ? inner.status : undefined,
  };
}

function makeFallbackTimeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  // unref() only exists on Node/Bun timer handles, not in browsers. Defensive
  // call so the process can exit even if a test forgets to cancel.
  (t as { unref?: () => void } | undefined)?.unref?.();
  return ctrl.signal;
}

// --- Decision engine ---

export interface DecisionOutcome {
  shouldRender: boolean;
  score: number;
  rule: UiRule | null;
  category: string | null;
  view: string | null;
  template: string | null;
  reasons: string[];
  override: UiOverride | null;
}

function readOverride(params: Record<string, unknown>): UiOverride | null {
  const raw = (params as Record<string, unknown>).ui;
  if (!isPlainObject(raw)) return null;
  const out: UiOverride = {};
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.preference === 'string' && raw.preference.length < 64) out.preference = raw.preference;
  if (typeof raw.title === 'string' && raw.title.length < 256) out.title = raw.title;
  return out;
}

export function decideRender(
  cfg: GenuiConfig,
  operation: string,
  params: Record<string, unknown>,
  result: unknown,
): DecisionOutcome {
  const reasons: string[] = [];
  const override = readOverride(params);

  // 1. Master gate.
  if (!cfg.enabled || cfg.mode === 'off') {
    reasons.push(cfg.enabled ? 'mode_off' : 'genui_disabled');
    return empty(reasons, override);
  }
  if (!cfg.baseUrl) {
    reasons.push('no_base_url');
    return empty(reasons, override);
  }

  // 2. Manual override: explicit enabled=false suppresses everything.
  if (override?.enabled === false) {
    reasons.push('user_disabled');
    return empty(reasons, override);
  }

  // 3. Mode === manual: only render on explicit override.
  if (cfg.mode === 'manual' && override?.enabled !== true) {
    reasons.push('mode_manual_no_override');
    return empty(reasons, override);
  }

  // 4. Mutating operation guard: never auto-render unless explicit override.
  if (isMutating(operation) && override?.enabled !== true) {
    reasons.push('mutating_operation');
    return empty(reasons, override);
  }

  // 5. Renderer availability.
  const rule = UI_RULES[operation] ?? null;
  if (!rule) {
    if (override?.enabled === true) {
      // No rule but explicit-enabled — still refuse, no template available.
      reasons.push('unsupported_renderer');
    } else {
      reasons.push('no_render_rule');
    }
    return empty(reasons, override);
  }
  if (rule.renderable === false) {
    reasons.push('unsupported_renderer');
    return empty(reasons, override);
  }
  if (!categoryAllowed(cfg, rule.category)) {
    reasons.push('category_disabled');
    return empty(reasons, override);
  }
  // Reject early if the rule's template isn't in the effective catalog.
  // Stops a UI rule with `template: "line_chart"` from POSTing artifacts
  // before the portal-side renderer is enabled, which would 400 every time.
  const activeCatalog = getTemplateCatalog(cfg);
  if (!activeCatalog.some(t => t.template === rule.template)) {
    reasons.push('template_not_in_catalog');
    return empty(reasons, override);
  }

  // 6. Payload size limit.
  const approxBytes = approxResultBytes(result);
  const overSoftCap = approxBytes > cfg.maxPayloadBytes;
  const overHardCap = approxBytes > cfg.maxPayloadBytes * 4; // explicit override still capped.
  if (overSoftCap && override?.enabled !== true) {
    reasons.push('payload_too_large');
    return empty(reasons, override);
  }
  if (overHardCap) {
    reasons.push('payload_too_large');
    return empty(reasons, override);
  }

  // 7. Score.
  let score = 0;
  if (rule.renderable === true) score += 40;
  const shapeOk = shapeMatches(operation, result);
  if (shapeOk) score += 30;
  if (override?.enabled === true) score += 40;
  if (override?.preference) score += 10;
  if (cfg.mode === 'always') score += 100;
  if (overSoftCap) score -= 40;

  // Conditional rules require shape match.
  if (rule.renderable === 'conditional' && !shapeOk && override?.enabled !== true) {
    reasons.push('no_shape_match');
    return empty(reasons, override);
  }

  if (score < 30) {
    reasons.push('score_below_threshold');
    return { shouldRender: false, score, rule, category: rule.category, view: rule.defaultView, template: rule.template, reasons, override };
  }

  // Determine view (preference may override).
  const view = override?.preference || rule.defaultView;

  return {
    shouldRender: true,
    score,
    rule,
    category: rule.category,
    view,
    template: rule.template,
    reasons,
    override,
  };
}

function empty(reasons: string[], override: UiOverride | null): DecisionOutcome {
  return { shouldRender: false, score: 0, rule: null, category: null, view: null, template: null, reasons, override };
}

function approxResultBytes(result: unknown): number {
  try {
    return JSON.stringify(result ?? null).length;
  } catch {
    return 0;
  }
}

// --- Title derivation ---

function deriveTitle(operation: string, params: Record<string, unknown>, override: UiOverride | null): string {
  if (override?.title) return override.title.slice(0, 256);
  // Try operation-specific defaults.
  const slug = typeof params.slug === 'string' ? params.slug : undefined;
  const query = typeof params.query === 'string' ? params.query : undefined;
  if (operation === 'search' || operation === 'query') {
    return query ? `Search: ${query.slice(0, 80)}` : 'Search results';
  }
  if (operation === 'traverse_graph' && slug) return `Graph: ${slug}`;
  if (operation === 'get_timeline' && slug) return `Timeline: ${slug}`;
  if (operation === 'get_backlinks' && slug) return `Backlinks: ${slug}`;
  if (operation === 'find_orphans') return 'Orphan pages';
  if (operation === 'get_stats') return 'Brain stats';
  if (operation === 'get_health') return 'Brain health';
  if (operation === 'list_jobs') return 'Jobs';
  if (operation === 'get_job') {
    const id = params.id;
    return typeof id === 'number' ? `Job ${id}` : 'Job';
  }
  if (operation === 'list_pages') return 'Pages';
  return operation;
}

// --- Portal payload shapers ---
//
// The MCP `result` returned to the agent is always the raw operation output.
// The artifact `payload` sent to the portal is normalized per template so each
// renderer can pluck `columns`/`rows`/`entries`/etc. directly. If a shaper
// can't recognize the input, it falls back to the raw result unchanged so a
// future portal-side schema change doesn't silently start dropping data.

const SEARCH_TABLE_COLUMNS = ['title', 'slug', 'type', 'score', 'chunk_text'];
const TIMELINE_COLUMNS = ['date', 'source', 'summary', 'detail'];
const JOBS_STATUS_COLUMNS = ['id', 'name', 'queue', 'status', 'created_at', 'started_at', 'finished_at', 'error_text'];

function pickFields<T extends Record<string, unknown>>(row: T, cols: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = row[c] ?? null;
  return out;
}

/**
 * Parse a markdown table out of arbitrary text. Returns null if no parseable
 * pipe-style table is found.
 *
 * Recognizes:
 *   | A | B |
 *   | --- | --- |   (or :--- / ---: alignment markers)
 *   | x | y |
 *
 * Handles a leading `# Heading` or `## Heading` immediately above the table
 * by returning it as `title`. Coerces numeric-looking cells (with currency
 * symbols stripped) to numbers when at least 2 cells in a column parse — the
 * Layer-2 view-picker uses that to decide line vs. bar charts.
 */
export function parseMarkdownTable(text: string): { title?: string; columns: string[]; rows: Record<string, unknown>[] } | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split(/\r?\n/);
  // Find the first 3-row run of pipe-led lines (header / sep / data).
  for (let i = 0; i < lines.length - 2; i++) {
    const header = lines[i].trim();
    const sep = lines[i + 1].trim();
    if (!header.startsWith('|') || !sep.startsWith('|')) continue;
    if (!/^\|[\s:|-]+\|$/.test(sep)) continue;
    const headerCells = splitMdRow(header);
    const sepCells = splitMdRow(sep);
    if (headerCells.length < 2 || sepCells.length !== headerCells.length) continue;
    if (!sepCells.every(c => /^:?-{3,}:?$/.test(c.replace(/\s/g, '')))) continue;

    const columns = headerCells;
    const rows: Record<string, unknown>[] = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith('|')) {
      const dataCells = splitMdRow(lines[j].trim());
      if (dataCells.length === columns.length) {
        const row: Record<string, unknown> = {};
        for (let c = 0; c < columns.length; c++) {
          row[columns[c]] = coerceCell(dataCells[c]);
        }
        rows.push(row);
      }
      j++;
    }
    if (rows.length === 0) continue;

    // Look back up to 3 lines for a heading.
    let title: string | undefined;
    for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
      const m = /^\s*#{1,6}\s+(.+?)\s*$/.exec(lines[k]);
      if (m) { title = m[1]; break; }
      if (lines[k].trim() !== '') break;
    }

    return { title, columns, rows };
  }
  return null;
}

function splitMdRow(line: string): string[] {
  // Strip leading + trailing pipe, then split by unescaped |.
  const trimmed = line.replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(s => s.trim());
}

function coerceCell(raw: string): unknown {
  if (raw === '') return null;
  // Strip $ and , and whitespace, try as number.
  const numeric = raw.replace(/[\s$,]/g, '');
  if (/^-?\d+(\.\d+)?%?$/.test(numeric)) {
    const stripped = numeric.replace(/%$/, '');
    const n = Number(stripped);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

function shapeSearchTable(params: Record<string, unknown>, result: unknown): Record<string, unknown> {
  const query = (typeof params.query === 'string' ? params.query : '') ||
                (typeof params.q === 'string' ? params.q : '');
  const arr = Array.isArray(result) ? result : [];

  // Layer 1: when there's exactly one strong result and its chunk_text contains
  // a parseable markdown table, serve THAT table as the artifact body. The MCP
  // result is unchanged; only the portal payload is reshaped, so the agent
  // still sees the raw search row but the operator sees a clean table.
  if (arr.length === 1 && isPlainObject(arr[0])) {
    const top = arr[0] as Record<string, unknown>;
    const chunkText = typeof top.chunk_text === 'string' ? top.chunk_text : '';
    const md = parseMarkdownTable(chunkText);
    if (md && md.rows.length > 0) {
      return {
        query,
        // Title falls back to the page's frontmatter title so the artifact
        // header is meaningful even when the markdown didn't carry one.
        title: md.title || (typeof top.title === 'string' ? top.title : ''),
        columns: md.columns,
        rows: md.rows,
        source_slug: typeof top.slug === 'string' ? top.slug : null,
        source_kind: 'markdown_table',
      };
    }
  }

  const rows = arr
    .filter(r => isPlainObject(r))
    .map(r => pickFields(r as Record<string, unknown>, SEARCH_TABLE_COLUMNS));
  return { query, columns: SEARCH_TABLE_COLUMNS, rows };
}

function shapeTimelineView(params: Record<string, unknown>, result: unknown): Record<string, unknown> {
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const entries = Array.isArray(result)
    ? (result as Record<string, unknown>[])
        .filter(r => isPlainObject(r))
        .map(r => pickFields(r, TIMELINE_COLUMNS))
    : [];
  return { slug, columns: TIMELINE_COLUMNS, entries };
}

function shapeJobsStatus(_params: Record<string, unknown>, result: unknown): Record<string, unknown> {
  const list = Array.isArray(result) ? result : (isPlainObject(result) ? [result] : []);
  const rows = (list as Record<string, unknown>[])
    .filter(r => isPlainObject(r))
    .map(r => pickFields(r, JOBS_STATUS_COLUMNS));
  return { columns: JOBS_STATUS_COLUMNS, rows };
}

function shapeStatsDashboard(_params: Record<string, unknown>, result: unknown): Record<string, unknown> {
  if (!isPlainObject(result)) return { metrics: {} };
  // Coerce flat numeric fields into a metrics dict the dashboard can render.
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(result)) if (typeof v === 'number') metrics[k] = v;
  return { metrics, raw: result };
}

function shapeGenericCards(_params: Record<string, unknown>, result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) {
    const cards = (result as unknown[])
      .filter(r => isPlainObject(r))
      .map(r => r as Record<string, unknown>);
    return { cards };
  }
  if (isPlainObject(result)) return { cards: [result] };
  return { cards: [] };
}

/**
 * Build a `line_chart` payload from any of three input shapes:
 *   1. The `render_chart` op handler return (already chart-shaped, marked
 *      with `_genui_template: "line_chart"`).
 *   2. A markdown 2-column numeric table (e.g. extracted from a search hit
 *      where col1 is a year and col2 is a price).
 *   3. An array of `{x, y}` point objects.
 * Returns null if none of those shapes match — caller decides what to do
 * with that, which today means fall back to whatever else fits.
 */
export function shapeLineChart(
  params: Record<string, unknown>,
  result: unknown,
): Record<string, unknown> | null {
  // Case 1: handler already produced a chart payload.
  if (isPlainObject(result) && result._genui_template === 'line_chart') {
    const { _genui_template: _t, ...rest } = result as Record<string, unknown>;
    return rest;
  }

  // Case 2: caller passed raw {title, x_label, y_label, series}.
  if (isPlainObject(result) && Array.isArray((result as Record<string, unknown>).series)) {
    return result as Record<string, unknown>;
  }

  // Case 3: top-of-search-results with a markdown table in chunk_text.
  if (Array.isArray(result) && result.length === 1 && isPlainObject(result[0])) {
    const top = result[0] as Record<string, unknown>;
    const text = typeof top.chunk_text === 'string' ? top.chunk_text : '';
    const md = parseMarkdownTable(text);
    if (md && md.columns.length === 2 && md.rows.length >= 2) {
      const xKey = md.columns[0];
      const yKey = md.columns[1];
      // Y must be numeric in every row; otherwise this isn't a chartable series.
      const allNumericY = md.rows.every(r => typeof r[yKey] === 'number');
      if (allNumericY) {
        return {
          title: md.title || (typeof top.title === 'string' ? top.title : ''),
          x_axis: { label: xKey, field: 'x' },
          y_axis: { label: yKey, field: 'y', format: detectYFormat(text) },
          series: [{
            name: yKey,
            points: md.rows.map(r => ({ x: r[xKey], y: r[yKey] })),
          }],
          source_slug: typeof top.slug === 'string' ? top.slug : null,
        };
      }
    }
  }

  return null;
}

function detectYFormat(text: string): 'currency' | 'percent' | 'number' {
  // Quick heuristic — currency wins if $ shows up at all in the source markdown.
  if (/\$\d/.test(text)) return 'currency';
  if (/\d%(?!\d)/.test(text)) return 'percent';
  return 'number';
}

export function shapePortalPayload(template: string, params: Record<string, unknown>, result: unknown): unknown {
  switch (template) {
    case 'search_table':    return shapeSearchTable(params, result);
    case 'timeline_view':   return shapeTimelineView(params, result);
    case 'jobs_status':     return shapeJobsStatus(params, result);
    case 'stats_dashboard': return shapeStatsDashboard(params, result);
    case 'generic_cards':   return shapeGenericCards(params, result);
    case 'line_chart': {
      const shaped = shapeLineChart(params, result);
      // Fall back to raw result on shape miss so the portal sees what GBrain
      // sent and the response_body in the artifact_post log explains why.
      return shaped ?? result;
    }
    default:                return result;
  }
}

// --- Layer 2: LLM view-picker ---
//
// Opt-in. When `GENUI_VIEW_PICKER=true`, after the rule-based picker has
// chosen a template, ask a cheap LLM (gateway default chat model — typically
// Haiku 4.5 / Gemini Flash) to confirm or override the choice given a small
// sample of the actual data. Output is constrained to `TEMPLATE_CATALOG` so
// the picker can never produce a template the portal doesn't render.
//
// Failure modes (return null, falls back to rule-based pick):
//   - Gateway not configured / no API key (`isAvailable('chat')` false)
//   - LLM throws / times out
//   - Output is malformed JSON or names an unknown template

export interface TemplateCatalogEntry {
  template: string;
  category: string;
  view: string;
  description: string;
}

/**
 * Always-available templates the Hermes portal renders today. New templates
 * added to the portal go through `OPTIONAL_TEMPLATES` below + an env flag,
 * so adding a name here without the portal renderer doesn't immediately
 * break by routing artifacts through a template that 400s.
 */
export const TEMPLATE_CATALOG: TemplateCatalogEntry[] = [
  {
    template: 'search_table',
    category: 'search',
    view: 'table',
    description: 'Tabular result list with columns. Default for any list of objects.',
  },
  {
    template: 'stats_dashboard',
    category: 'stats',
    view: 'dashboard',
    description: 'Numeric metric grid. Use when result is an object with multiple numeric fields.',
  },
  {
    template: 'timeline_view',
    category: 'timeline',
    view: 'timeline',
    description: 'Chronological list. Use when items have a date field and a summary.',
  },
  {
    template: 'jobs_status',
    category: 'jobs',
    view: 'status',
    description: 'Job-board layout grouped by status. Use for items with id + status fields.',
  },
  {
    template: 'generic_cards',
    category: 'graph',
    view: 'cards',
    description: 'Card grid. Use for entity/page summaries with title + slug + description.',
  },
];

/**
 * Optional templates that ship behind a feature flag because their portal
 * renderer is added separately in the daniel-hermes repo. Until the flag is
 * flipped, neither the rule-based picker nor the LLM picker will route
 * artifacts to these templates — preventing the "we promoted but Hermes
 * doesn't render it yet → 400 cascade" failure mode.
 */
interface OptionalTemplate extends TemplateCatalogEntry {
  /** Returns true when the portal-side renderer is known to be live. */
  isEnabled: (cfg: GenuiConfig) => boolean;
}

const OPTIONAL_TEMPLATES: OptionalTemplate[] = [
  {
    template: 'line_chart',
    category: 'finance',
    view: 'chart',
    description: 'X/Y line chart for numeric time series. Use when data has a sequential x-axis (years/dates) and a numeric y-axis. Y values must be numbers; format hint via y_axis.format = "currency" | "percent" | "number".',
    isEnabled: (cfg) => cfg.lineChartEnabled,
  },
];

/**
 * Effective catalog the picker can choose from. Always includes the base
 * 5 templates; additionally includes any optional templates whose flag is
 * on. Read at call time so a Railway env flip takes effect without rebuild.
 */
export function getTemplateCatalog(cfg?: GenuiConfig): TemplateCatalogEntry[] {
  const c = cfg ?? loadGenuiConfig();
  const out: TemplateCatalogEntry[] = [...TEMPLATE_CATALOG];
  for (const opt of OPTIONAL_TEMPLATES) {
    if (opt.isEnabled(c)) {
      const { isEnabled: _ie, ...entry } = opt;
      out.push(entry);
    }
  }
  return out;
}

/** Truncate the result to a small JSON sample fit for an LLM prompt. */
function sampleResultForPrompt(result: unknown, maxBytes = 2000): unknown {
  let serialized = '';
  try { serialized = JSON.stringify(result); } catch { return null; }
  if (serialized.length <= maxBytes) return result;
  // For arrays, keep first few entries. For objects, keep all keys but
  // truncate string values.
  if (Array.isArray(result)) {
    const sample = result.slice(0, 5).map(item => truncateValues(item, 400));
    return sample;
  }
  if (isPlainObject(result)) return truncateValues(result, 400);
  return String(serialized).slice(0, maxBytes);
}

function truncateValues(v: unknown, max: number): unknown {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…[truncated]' : v;
  if (Array.isArray(v)) return v.slice(0, 5).map(x => truncateValues(x, max));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = truncateValues(val, max);
    return out;
  }
  return v;
}

/** Best-effort JSON parser; tolerates code-fenced output. */
function parseLooseJson(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  let body = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  // Find first { ... last }.
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) body = body.slice(first, last + 1);
  try {
    const parsed = JSON.parse(body);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const VIEW_PICKER_SYSTEM = `You pick the best UI template for displaying a JSON result to a human operator.

You must respond with strict JSON of the shape:
{"template": "<one of the candidate template names>", "reason": "<one short sentence>"}

Choose the template that best matches the data. Prefer specialized templates (timeline_view for date-ordered events, jobs_status for jobs, stats_dashboard for numeric metrics) over the generic search_table when the data fits them. If nothing fits well, fall back to the candidate marked as the current pick. Never invent a template name not in the candidates.`;

interface PickedView {
  template: string;
  category: string;
  view: string;
  reason?: string;
}

async function pickViewWithLlm(opts: {
  operation: string;
  params: Record<string, unknown>;
  result: unknown;
  initialTemplate: string;
  cfg: GenuiConfig;
}): Promise<PickedView | null> {
  try {
    const gateway = await import('../core/ai/gateway.ts');
    if (!gateway.isAvailable('chat')) {
      recordDebug('view_picker', { skipped: true, reason: 'chat_not_available' });
      return null;
    }
    const catalog = getTemplateCatalog(opts.cfg);
    const byName = new Map(catalog.map(t => [t.template, t]));
    const sample = sampleResultForPrompt(opts.result);
    const prompt = JSON.stringify({
      operation: opts.operation,
      params: redactParamsSummary(opts.operation, opts.params),
      result_sample: sample,
      candidate_templates: catalog.map(t => ({
        template: t.template,
        description: t.description,
      })),
      current_pick: opts.initialTemplate,
    });

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error('view_picker_timeout')), opts.cfg.viewPickerTimeoutMs);
    (t as { unref?: () => void } | undefined)?.unref?.();
    const startedAt = Date.now();
    let result: { text?: string };
    try {
      result = await gateway.chat({
        ...(opts.cfg.viewPickerModel ? { model: opts.cfg.viewPickerModel } : {}),
        system: VIEW_PICKER_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
        abortSignal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    const text = result.text ?? '';
    const parsed = parseLooseJson(text);
    if (!parsed) {
      recordDebug('view_picker', { skipped: true, reason: 'parse_failed', latency_ms: Date.now() - startedAt });
      return null;
    }
    const tpl = typeof parsed.template === 'string' ? parsed.template : '';
    const meta = byName.get(tpl);
    if (!meta) {
      recordDebug('view_picker', { skipped: true, reason: 'unknown_template', got: tpl, latency_ms: Date.now() - startedAt });
      return null;
    }
    const picked: PickedView = {
      template: meta.template,
      category: meta.category,
      view: meta.view,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : undefined,
    };
    recordDebug('view_picker', {
      from: opts.initialTemplate,
      to: picked.template,
      changed: picked.template !== opts.initialTemplate,
      reason: picked.reason,
      latency_ms: Date.now() - startedAt,
    });
    return picked;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    recordDebug('view_picker', { skipped: true, reason: 'exception', message: msg });
    return null;
  }
}

// --- Public entry point ---

export async function maybeRenderUi(input: MaybeRenderUiInput): Promise<UiArtifactSummary | null> {
  const startedAt = Date.now();
  const cfg = loadGenuiConfig();
  // Defensive normalization — bare op names are what the MCP wire-protocol
  // sends, but client-side display rewriters (`mcp_<server>_<tool>`) showing
  // up here would silently miss UI_RULES.
  const operation = normalizeOperationName(input.operation);
  const decision = decideRender(cfg, operation, input.params, input.result);
  const log = (decisionStatus: 'rendered' | 'skipped' | 'failed', extra: Record<string, unknown> = {}) => {
    const entry: Record<string, unknown> = {
      operation,
      decision: decisionStatus,
      category: decision.category,
      view: decision.view,
      reasons: decision.reasons,
      score: decision.score,
      latency_ms: Date.now() - startedAt,
      ...extra,
    };
    if (operation !== input.operation) entry.raw_operation = input.operation;
    recordDebug('decision', entry);
  };

  if (!decision.shouldRender) {
    log('skipped');
    return null;
  }
  if (!cfg.baseUrl) {
    decision.reasons.push('no_base_url');
    log('skipped');
    return null;
  }

  // Layer 2: optionally let an LLM upgrade the template choice from the
  // catalog. Pure additive — failure → keep the rule-based pick.
  if (cfg.viewPickerEnabled && decision.template) {
    const picked = await pickViewWithLlm({
      operation,
      params: input.params,
      result: input.result,
      initialTemplate: decision.template,
      cfg,
    });
    if (picked) {
      decision.template = picked.template;
      decision.category = picked.category;
      decision.view = picked.view;
    }
  }

  const title = deriveTitle(operation, input.params, decision.override);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + cfg.ttlHours * 3600 * 1000);
  // Shape the payload to match what the portal template expects. The MCP
  // response (`result`) is unchanged — only the artifact's `payload` field
  // is normalized so the portal can render directly without each template
  // re-deriving columns/rows from a heterogeneous shape.
  const portalPayload = shapePortalPayload(decision.template!, input.params, input.result);
  const body = {
    title,
    category: decision.category!,
    viewType: decision.view!,
    status: 'temporary' as const,
    source: {
      operation,
      paramsSummary: redactParamsSummary(operation, input.params),
      transport: 'unknown',
      trigger: 'chat',
    },
    payload: portalPayload,
    renderSpec: {
      kind: 'template' as const,
      template: decision.template!,
      props: {},
    },
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  try {
    const resp = await _artifactClient({
      baseUrl: cfg.baseUrl,
      apiToken: cfg.apiToken,
      body,
      timeoutMs: cfg.timeoutMs,
    });
    const url = resp.url || `${cfg.baseUrl}/ui/latest/${resp.id}`;
    const status: 'temporary' | 'saved' = resp.status === 'saved' ? 'saved' : 'temporary';
    const summary: UiArtifactSummary = {
      id: resp.id,
      type: decision.template!,
      category: decision.category!,
      title,
      url,
      status,
    };
    log('rendered', { artifact_id: resp.id });
    return summary;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log('failed', { error: msg });
    return null;
  }
}

// --- Test introspection (kept tiny on purpose) ---

export const _internal = {
  isMutating,
  shapeMatches,
  approxResultBytes,
};
