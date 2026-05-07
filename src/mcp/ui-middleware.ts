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

import type { OperationContext, Operation } from '../core/operations.ts';
import { operations } from '../core/operations.ts';

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
  return { enabled, mode, baseUrl, apiToken: apiToken || null, ttlHours, renderFor, maxPayloadBytes, timeoutMs };
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

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(input.body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`GenUI portal responded ${res.status}`);
  }
  const json = await res.json() as Record<string, unknown>;
  // Support both shapes: { id, url, status } and { artifact: { id, url, status } }.
  const inner = isPlainObject(json.artifact) ? json.artifact : json;
  const id = typeof inner.id === 'string' ? inner.id : undefined;
  if (!id) throw new Error('GenUI portal response missing id');
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

// --- Public entry point ---

export async function maybeRenderUi(input: MaybeRenderUiInput): Promise<UiArtifactSummary | null> {
  const startedAt = Date.now();
  const cfg = loadGenuiConfig();
  const decision = decideRender(cfg, input.operation, input.params, input.result);
  const log = (decisionStatus: 'rendered' | 'skipped' | 'failed', extra: Record<string, unknown> = {}) => {
    const entry = {
      operation: input.operation,
      decision: decisionStatus,
      category: decision.category,
      view: decision.view,
      reason: decision.reasons,
      latency_ms: Date.now() - startedAt,
      ...extra,
    };
    try { input.ctx.logger?.info?.(`[genui] ${JSON.stringify(entry)}`); } catch { /* never throw from logger */ }
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

  const title = deriveTitle(input.operation, input.params, decision.override);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + cfg.ttlHours * 3600 * 1000);
  const body = {
    title,
    category: decision.category!,
    viewType: decision.view!,
    status: 'temporary' as const,
    source: {
      operation: input.operation,
      paramsSummary: redactParamsSummary(input.operation, input.params),
      transport: 'unknown',
      trigger: 'chat',
    },
    payload: input.result,
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
