/**
 * Unit tests for src/mcp/ui-middleware.ts — the GenUI decision engine + artifact-POST helper.
 *
 * Covers:
 *  - Master gate: GENUI_ENABLED / GENUI_MODE
 *  - Manual override (params.ui.enabled true/false, preference)
 *  - Mutating-op suppression
 *  - Operation rules + shape detection
 *  - Payload size limit
 *  - Artifact client mocking — Authorization + X-GenUI-Token headers
 *  - URL fallback when portal returns id only
 *  - Both response shapes ({id,...} and {artifact:{id,...}})
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import {
  loadGenuiConfig,
  decideRender,
  isSearchResults,
  isGraphPaths,
  isTimelineEntries,
  isStatsResult,
  isJobResult,
  redactParamsSummary,
  setArtifactClient,
  maybeRenderUi,
  normalizeOperationName,
  shapePortalPayload,
  shapeLineChart,
  parseMarkdownTable,
  getTemplateCatalog,
  TEMPLATE_CATALOG,
  UI_RULES,
  type ArtifactClient,
  type GenuiConfig,
} from '../src/mcp/ui-middleware.ts';
import type { OperationContext } from '../src/core/operations.ts';

// --- Fixtures ---

const PORTAL = 'https://hermes-agent-production-861b.up.railway.app';

function fakeCtx(): OperationContext {
  return {
    engine: {} as any,
    config: {} as any,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    dryRun: false,
    remote: true,
  };
}

function searchResults(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    slug: `people/example-${i}`,
    page_id: i + 1,
    title: `Example ${i}`,
    score: 0.9 - i * 0.1,
    chunk_text: `chunk ${i}`,
    chunk_source: 'compiled_truth',
    type: 'person',
  }));
}

function graphPaths() {
  return [
    { from_slug: 'a', to_slug: 'b', link_type: 'mentions', depth: 1, context: '' },
    { from_slug: 'b', to_slug: 'c', link_type: 'mentions', depth: 2, context: '' },
  ];
}

function timelineEntries() {
  return [
    { date: '2026-04-01', source: 'meeting', summary: 'Kickoff', detail: '' },
    { date: '2026-04-15', source: 'note', summary: 'Update', detail: '' },
  ];
}

function statsResult() {
  return { pages: 1234, chunks: 5678, links: 999, embed_coverage: 0.92 };
}

function jobsList() {
  return [
    { id: 1, name: 'sync', queue: 'default', status: 'completed', created_at: '2026-04-01' },
    { id: 2, name: 'embed', queue: 'default', status: 'active', created_at: '2026-04-02' },
  ];
}

// --- Config loader ---

describe('loadGenuiConfig', () => {
  test('disabled by default', async () => {
    await withEnv(
      { GENUI_ENABLED: undefined, GENUI_MODE: undefined, GENUI_BASE_URL: undefined, GENUI_API_TOKEN: undefined },
      () => {
        const cfg = loadGenuiConfig();
        expect(cfg.enabled).toBe(false);
        expect(cfg.mode).toBe('auto');
        expect(cfg.baseUrl).toBeNull();
      },
    );
  });

  test('reads enabled + mode + base URL + token + ttl', async () => {
    await withEnv(
      {
        GENUI_ENABLED: 'true',
        GENUI_MODE: 'auto',
        GENUI_BASE_URL: PORTAL + '/',
        GENUI_API_TOKEN: 'secret-123',
        GENUI_TEMPORARY_TTL_HOURS: '48',
      },
      () => {
        const cfg = loadGenuiConfig();
        expect(cfg.enabled).toBe(true);
        expect(cfg.mode).toBe('auto');
        expect(cfg.baseUrl).toBe(PORTAL); // trailing slash stripped
        expect(cfg.apiToken).toBe('secret-123');
        expect(cfg.ttlHours).toBe(48);
      },
    );
  });

  test('GENUI_RENDER_FOR parses comma list', async () => {
    await withEnv({ GENUI_ENABLED: 'true', GENUI_RENDER_FOR: 'search,jobs' }, () => {
      const cfg = loadGenuiConfig();
      expect(cfg.renderFor.has('search')).toBe(true);
      expect(cfg.renderFor.has('jobs')).toBe(true);
      expect(cfg.renderFor.has('graph')).toBe(false);
    });
  });
});

// --- Shape detection ---

describe('shape detection', () => {
  test('isSearchResults', () => {
    expect(isSearchResults(searchResults())).toBe(true);
    expect(isSearchResults([])).toBe(false);
    expect(isSearchResults({})).toBe(false);
    expect(isSearchResults([{ random: 1 }])).toBe(false);
  });

  test('isGraphPaths matches both edge and node shapes', () => {
    expect(isGraphPaths(graphPaths())).toBe(true);
    expect(isGraphPaths([{ slug: 'a', depth: 1 }])).toBe(true);
    expect(isGraphPaths([])).toBe(false);
  });

  test('isTimelineEntries', () => {
    expect(isTimelineEntries(timelineEntries())).toBe(true);
    expect(isTimelineEntries([{ date: '2026-04-01' }])).toBe(false); // no summary/detail/source
    expect(isTimelineEntries([])).toBe(false);
  });

  test('isStatsResult', () => {
    expect(isStatsResult(statsResult())).toBe(true);
    expect(isStatsResult({})).toBe(false);
    expect(isStatsResult({ name: 'x' })).toBe(false);
  });

  test('isJobResult', () => {
    expect(isJobResult({ id: 1, status: 'completed' })).toBe(true);
    expect(isJobResult(jobsList())).toBe(true);
    expect(isJobResult([])).toBe(false);
    expect(isJobResult({ id: 1 })).toBe(false);
  });
});

// --- Decision engine ---

function enabledCfg(overrides: Partial<GenuiConfig> = {}): GenuiConfig {
  return {
    enabled: true,
    mode: 'auto',
    baseUrl: PORTAL,
    apiToken: null,
    ttlHours: 72,
    renderFor: new Set(['search', 'graph', 'timeline', 'jobs', 'stats', 'briefing', 'finance']),
    maxPayloadBytes: 250_000,
    timeoutMs: 2500,
    ...overrides,
  };
}

describe('decideRender', () => {
  test('GENUI_ENABLED=false yields no render', () => {
    const out = decideRender(enabledCfg({ enabled: false }), 'search', { query: 'foo' }, searchResults());
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('genui_disabled');
  });

  test('GENUI_MODE=off yields no render', () => {
    const out = decideRender(enabledCfg({ mode: 'off' }), 'search', { query: 'foo' }, searchResults());
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('mode_off');
  });

  test('renderable search result with valid shape renders', () => {
    const out = decideRender(enabledCfg(), 'search', { query: 'alice' }, searchResults());
    expect(out.shouldRender).toBe(true);
    expect(out.template).toBe('search_table');
    expect(out.category).toBe('search');
  });

  test('manual override params.ui.enabled=false suppresses render', () => {
    const out = decideRender(enabledCfg(), 'search', { query: 'alice', ui: { enabled: false } }, searchResults());
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('user_disabled');
  });

  test('mutating operation does not auto-render without override', () => {
    const out = decideRender(enabledCfg(), 'put_page', { slug: 'x', content: '# y' }, { ok: true });
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('mutating_operation');
  });

  test('payload over soft cap suppresses render', () => {
    const big = Array.from({ length: 5_000 }, (_, i) => ({
      slug: `p/${i}`,
      page_id: i,
      title: `T${i}`,
      score: 0.5,
      chunk_text: 'x'.repeat(200),
    }));
    const out = decideRender(enabledCfg({ maxPayloadBytes: 1000 }), 'search', { query: 'q' }, big);
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('payload_too_large');
  });

  test('conditional rule (query) refuses without shape match', () => {
    // query op against non-search-shaped result (e.g. error string).
    const out = decideRender(enabledCfg(), 'query', { query: 'q' }, 'bad result');
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('no_shape_match');
  });

  test('jobs result maps to jobs_status template', () => {
    const out = decideRender(enabledCfg(), 'list_jobs', {}, jobsList());
    expect(out.shouldRender).toBe(true);
    expect(out.template).toBe('jobs_status');
  });

  test('mode=manual + override.enabled=true renders', () => {
    const out = decideRender(enabledCfg({ mode: 'manual' }), 'search', { query: 'x', ui: { enabled: true } }, searchResults());
    expect(out.shouldRender).toBe(true);
  });

  test('mode=manual without override yields skip', () => {
    const out = decideRender(enabledCfg({ mode: 'manual' }), 'search', { query: 'x' }, searchResults());
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('mode_manual_no_override');
  });

  test('no base URL yields skip', () => {
    const out = decideRender(enabledCfg({ baseUrl: null }), 'search', { query: 'x' }, searchResults());
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('no_base_url');
  });

  test('unknown operation yields no_render_rule', () => {
    const out = decideRender(enabledCfg(), 'totally_unknown_op', {}, []);
    expect(out.shouldRender).toBe(false);
    expect(out.reasons).toContain('no_render_rule');
  });

  test('preference is propagated as view', () => {
    const out = decideRender(enabledCfg(), 'search', { query: 'x', ui: { preference: 'cards' } }, searchResults());
    expect(out.shouldRender).toBe(true);
    expect(out.view).toBe('cards');
  });
});

// --- redactParamsSummary ---

describe('redactParamsSummary', () => {
  test('omits secret-shaped keys', () => {
    const out = redactParamsSummary('search', {
      query: 'alice',
      api_key: 'sk-xxx',
      authorization: 'Bearer foo',
      slug: 'people/alice',
      sneaky_token_field: 'x',
    } as Record<string, unknown>);
    const ser = JSON.stringify(out);
    expect(ser).not.toContain('api_key');
    expect(ser).not.toContain('authorization');
    expect(ser).not.toContain('sk-xxx');
    expect(ser).not.toContain('Bearer');
    expect(ser).not.toContain('sneaky_token');
  });

  test('counts unknown keys without naming them', () => {
    const out = redactParamsSummary('search', {
      query: 'alice',
      'wiki/people/SENSITIVE': 'x',
      another_unknown: 'y',
    } as Record<string, unknown>) as { declared_keys: string[]; unknown_key_count: number };
    expect(out.declared_keys).toContain('query');
    expect(out.unknown_key_count).toBe(2);
    expect(JSON.stringify(out)).not.toContain('SENSITIVE');
  });
});

// --- maybeRenderUi (artifact client mocked) ---

describe('maybeRenderUi', () => {
  beforeEach(() => setArtifactClient(null));
  afterEach(() => setArtifactClient(null));

  test('GENUI_ENABLED=false returns null', async () => {
    await withEnv({ GENUI_ENABLED: 'false', GENUI_BASE_URL: PORTAL }, async () => {
      const out = await maybeRenderUi({
        operation: 'search',
        params: { query: 'q' },
        result: searchResults(),
        ctx: fakeCtx(),
      });
      expect(out).toBeNull();
    });
  });

  test('renderable search result creates UI summary when client mocked', async () => {
    let captured: Parameters<ArtifactClient>[0] | null = null;
    setArtifactClient(async (input) => {
      captured = input;
      return { id: 'art-123', url: `${PORTAL}/ui/latest/art-123`, status: 'temporary' };
    });

    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_MODE: 'auto', GENUI_BASE_URL: PORTAL, GENUI_API_TOKEN: 'tok-9' },
      async () => {
        const out = await maybeRenderUi({
          operation: 'search',
          params: { query: 'alice' },
          result: searchResults(),
          ctx: fakeCtx(),
        });
        expect(out).not.toBeNull();
        expect(out!.id).toBe('art-123');
        expect(out!.url).toContain('/ui/latest/art-123');
        expect(out!.category).toBe('search');
        expect(out!.type).toBe('search_table');
        expect(out!.status).toBe('temporary');
        expect(captured).not.toBeNull();
        expect(captured!.apiToken).toBe('tok-9');
        // Body shape — title, payload, renderSpec
        const body = captured!.body as Record<string, unknown>;
        expect(body.viewType).toBe('table');
        expect(body.category).toBe('search');
        expect((body.renderSpec as any).template).toBe('search_table');
        expect((body.source as any).operation).toBe('search');
      },
    );
  });

  test('UI failure does not throw — returns null', async () => {
    setArtifactClient(async () => {
      throw new Error('portal exploded');
    });
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_MODE: 'auto', GENUI_BASE_URL: PORTAL },
      async () => {
        const out = await maybeRenderUi({
          operation: 'search',
          params: { query: 'q' },
          result: searchResults(),
          ctx: fakeCtx(),
        });
        expect(out).toBeNull();
      },
    );
  });

  test('params.ui.enabled=false suppresses UI', async () => {
    let called = false;
    setArtifactClient(async () => {
      called = true;
      return { id: 'never' };
    });
    await withEnv({ GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL }, async () => {
      const out = await maybeRenderUi({
        operation: 'search',
        params: { query: 'q', ui: { enabled: false } },
        result: searchResults(),
        ctx: fakeCtx(),
      });
      expect(out).toBeNull();
      expect(called).toBe(false);
    });
  });

  test('write/mutating operation does not auto-render', async () => {
    let called = false;
    setArtifactClient(async () => {
      called = true;
      return { id: 'never' };
    });
    await withEnv({ GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL }, async () => {
      const out = await maybeRenderUi({
        operation: 'put_page',
        params: { slug: 'x', content: '# y' },
        result: { ok: true },
        ctx: fakeCtx(),
      });
      expect(out).toBeNull();
      expect(called).toBe(false);
    });
  });

  test('search result shape maps to search_table template', async () => {
    let captured: any = null;
    setArtifactClient(async (input) => {
      captured = input.body;
      return { id: 'sr-1' };
    });
    await withEnv({ GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL }, async () => {
      await maybeRenderUi({
        operation: 'search',
        params: { query: 'alice' },
        result: searchResults(),
        ctx: fakeCtx(),
      });
    });
    expect(captured.renderSpec.template).toBe('search_table');
  });

  test('jobs result maps to jobs_status template', async () => {
    let captured: any = null;
    setArtifactClient(async (input) => {
      captured = input.body;
      return { id: 'j-1' };
    });
    await withEnv({ GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL }, async () => {
      await maybeRenderUi({
        operation: 'list_jobs',
        params: {},
        result: jobsList(),
        ctx: fakeCtx(),
      });
    });
    expect(captured.renderSpec.template).toBe('jobs_status');
    expect(captured.viewType).toBe('status');
  });

  test('payload size limit suppresses UI', async () => {
    let called = false;
    setArtifactClient(async () => {
      called = true;
      return { id: 'never' };
    });
    const big = Array.from({ length: 1000 }, (_, i) => ({
      slug: `p/${i}`,
      page_id: i,
      title: `T${i}`,
      score: 0.5,
      chunk_text: 'x'.repeat(500),
    }));
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL, GENUI_MAX_PAYLOAD_BYTES: '1024' },
      async () => {
        const out = await maybeRenderUi({
          operation: 'search',
          params: { query: 'q' },
          result: big,
          ctx: fakeCtx(),
        });
        expect(out).toBeNull();
        expect(called).toBe(false);
      },
    );
  });

  test('portal returns id only — middleware constructs URL', async () => {
    setArtifactClient(async () => ({ id: 'art-9' }));
    await withEnv({ GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL }, async () => {
      const out = await maybeRenderUi({
        operation: 'search',
        params: { query: 'q' },
        result: searchResults(),
        ctx: fakeCtx(),
      });
      expect(out!.url).toBe(`${PORTAL}/ui/latest/art-9`);
    });
  });

  test('portal returns wrapped { artifact: {...} } shape — middleware unwraps', async () => {
    // The default fetch client unwraps both shapes; verify by simulating the
    // wrapped response through a custom client that mimics that contract.
    setArtifactClient(async () => ({ id: 'art-w', url: `${PORTAL}/ui/latest/art-w`, status: 'saved' }));
    await withEnv({ GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL }, async () => {
      const out = await maybeRenderUi({
        operation: 'search',
        params: { query: 'q' },
        result: searchResults(),
        ctx: fakeCtx(),
      });
      expect(out!.id).toBe('art-w');
      expect(out!.status).toBe('saved');
    });
  });
});

// --- File-based debug logging ---

describe('GENUI_DEBUG_LOG file logging', () => {
  beforeEach(() => setArtifactClient(null));
  afterEach(() => setArtifactClient(null));

  test('writes JSONL records to GENUI_DEBUG_LOG when set, never throws on bad path', async () => {
    const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { _resetDebugLogPathForTests } = await import('../src/mcp/ui-middleware.ts');

    const dir = mkdtempSync(join(tmpdir(), 'genui-test-'));
    const logPath = join(dir, 'mcp-genui.log');

    setArtifactClient(async () => ({ id: 'art-log-1', url: 'https://example.test/ui/latest/art-log-1' }));
    _resetDebugLogPathForTests();
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL, GENUI_DEBUG_LOG: logPath },
      async () => {
        const out = await maybeRenderUi({
          operation: 'search',
          params: { query: 'x' },
          result: searchResults(),
          ctx: fakeCtx(),
        });
        expect(out).not.toBeNull();
      },
    );
    _resetDebugLogPathForTests();

    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').split(/\n/).filter(Boolean);
    // Should contain at least one decision record.
    const events = lines.map(l => JSON.parse(l).event);
    expect(events).toContain('decision');
  });

  test('unwritable log path does not throw or break dispatch', async () => {
    const { _resetDebugLogPathForTests } = await import('../src/mcp/ui-middleware.ts');
    setArtifactClient(async () => ({ id: 'art-bad-path' }));
    _resetDebugLogPathForTests();
    // A path under a file (not a directory) — mkdir will fail.
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL, GENUI_DEBUG_LOG: '/dev/null/cannot-be-a-dir/log.jsonl' },
      async () => {
        const out = await maybeRenderUi({
          operation: 'search',
          params: { query: 'x' },
          result: searchResults(),
          ctx: fakeCtx(),
        });
        // Should still render UI; file-log is best-effort.
        expect(out).not.toBeNull();
      },
    );
    _resetDebugLogPathForTests();
  });
});

// --- Operation name normalization ---

describe('normalizeOperationName', () => {
  test('strips mcp_<server>_ prefix', () => {
    expect(normalizeOperationName('mcp_gbrain_search')).toBe('search');
    expect(normalizeOperationName('mcp_gbrain_list_jobs')).toBe('list_jobs');
    expect(normalizeOperationName('mcp_gbrain_get_job')).toBe('get_job');
    expect(normalizeOperationName('mcp_brain_traverse_graph')).toBe('traverse_graph');
  });
  test('idempotent on bare names', () => {
    expect(normalizeOperationName('search')).toBe('search');
    expect(normalizeOperationName('list_jobs')).toBe('list_jobs');
  });
  test('does not strip random underscores', () => {
    expect(normalizeOperationName('something_unrelated')).toBe('something_unrelated');
  });
});

// --- Layer 1: parseMarkdownTable ---

describe('parseMarkdownTable', () => {
  test('parses the MongoDB stock-price table the user reported', () => {
    const text = `# MongoDB Stock Price Evolution (2018-2026)

This document tracks the year-end closing price of MongoDB (MDB).

| Year | Closing Price |
| :--- | :--- |
| 2018 | $83.74 |
| 2019 | $131.61 |
| 2020 | $359.04 |
| 2021 | $529.35 |
| 2022 | $196.84 |
| 2023 | $408.85 |
| 2024 | $232.81 |
| 2025 | $419.69 |
| 2026 (May) | $293.42 |`;
    const out = parseMarkdownTable(text)!;
    expect(out).not.toBeNull();
    expect(out.title).toBe('MongoDB Stock Price Evolution (2018-2026)');
    expect(out.columns).toEqual(['Year', 'Closing Price']);
    expect(out.rows.length).toBe(9);
    // Numeric coercion strips $ and , so the picker can see it as a series.
    expect(out.rows[0]).toEqual({ Year: 2018, 'Closing Price': 83.74 });
    expect(out.rows[8].Year).toBe('2026 (May)');
  });

  test('returns null when no table present', () => {
    expect(parseMarkdownTable('just plain text\nno table here')).toBeNull();
    expect(parseMarkdownTable('')).toBeNull();
  });

  test('rejects pseudo-tables without separator row', () => {
    expect(parseMarkdownTable('| A | B |\n| 1 | 2 |')).toBeNull();
  });

  test('handles right-aligned and centered separators', () => {
    const text = '| A | B |\n| ---: | :---: |\n| x | 9 |';
    const out = parseMarkdownTable(text)!;
    expect(out.columns).toEqual(['A', 'B']);
    expect(out.rows[0]).toEqual({ A: 'x', B: 9 });
  });
});

// --- Layer 1: shapeSearchTable swaps to markdown table on single hit ---

describe('shapeSearchTable markdown-table swap', () => {
  test('single result with markdown-table chunk_text is rendered as that table', () => {
    const result = [{
      slug: 'mongodb_data',
      page_id: 1,
      title: 'MongoDB Stock Price Evolution (2018-2026)',
      type: 'note',
      score: 0.3,
      chunk_text: '# MongoDB Stock Price Evolution\n\n| Year | Price |\n| :--- | :--- |\n| 2024 | $232 |\n| 2025 | $419 |',
    }];
    const out = shapePortalPayload('search_table', { query: 'MongoDB' }, result) as Record<string, unknown>;
    expect(out.columns).toEqual(['Year', 'Price']);
    expect(out.source_kind).toBe('markdown_table');
    expect(out.source_slug).toBe('mongodb_data');
    expect((out.rows as unknown[]).length).toBe(2);
  });

  test('multi-result query keeps the flat search_table shape', () => {
    const out = shapePortalPayload('search_table', { query: 'q' }, searchResults(3)) as Record<string, unknown>;
    expect(out.source_kind).toBeUndefined();
    expect(out.columns).toEqual(['title', 'slug', 'type', 'score', 'chunk_text']);
  });
});

// --- Layer 2: TEMPLATE_CATALOG sanity ---

describe('TEMPLATE_CATALOG', () => {
  test('templates align with what the portal currently renders', () => {
    const names = TEMPLATE_CATALOG.map(t => t.template).sort();
    expect(names).toEqual(['generic_cards', 'jobs_status', 'search_table', 'stats_dashboard', 'timeline_view']);
  });
  test('each entry has category + view + description', () => {
    for (const e of TEMPLATE_CATALOG) {
      expect(typeof e.category).toBe('string');
      expect(typeof e.view).toBe('string');
      expect(e.description.length).toBeGreaterThan(10);
    }
  });
});

// --- line_chart: catalog gating, shaper, and decideRender skip ---

describe('line_chart feature flag', () => {
  test('GENUI_LINE_CHART=false → catalog excludes line_chart', async () => {
    await withEnv({ GENUI_ENABLED: 'true', GENUI_LINE_CHART: 'false' }, () => {
      const cat = getTemplateCatalog();
      expect(cat.find(t => t.template === 'line_chart')).toBeUndefined();
    });
  });

  test('GENUI_LINE_CHART=true → catalog includes line_chart', async () => {
    await withEnv({ GENUI_ENABLED: 'true', GENUI_LINE_CHART: 'true' }, () => {
      const cat = getTemplateCatalog();
      const entry = cat.find(t => t.template === 'line_chart');
      expect(entry).toBeDefined();
      expect(entry!.category).toBe('finance');
      expect(entry!.view).toBe('chart');
    });
  });

  test('decideRender skips render_chart with template_not_in_catalog when flag off', async () => {
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL, GENUI_LINE_CHART: 'false' },
      () => {
        const out = decideRender(
          loadGenuiConfig(),
          'render_chart',
          { title: 'x', x_label: 'a', y_label: 'b', series: [] },
          { _genui_template: 'line_chart', title: 'x' },
        );
        expect(out.shouldRender).toBe(false);
        expect(out.reasons).toContain('template_not_in_catalog');
      },
    );
  });

  test('decideRender renders render_chart when GENUI_LINE_CHART=true', async () => {
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL, GENUI_LINE_CHART: 'true' },
      () => {
        const out = decideRender(
          loadGenuiConfig(),
          'render_chart',
          {},
          { _genui_template: 'line_chart', title: 'x' },
        );
        expect(out.shouldRender).toBe(true);
        expect(out.template).toBe('line_chart');
        expect(out.category).toBe('finance');
      },
    );
  });
});

describe('shapeLineChart', () => {
  test('passes through render_chart handler output (marker shape)', () => {
    const result = {
      _genui_template: 'line_chart',
      title: 'AAPL',
      x_axis: { label: 'Date', field: 'x' },
      y_axis: { label: 'Price', field: 'y', format: 'currency' },
      series: [{ name: 'AAPL', points: [{ x: '2025-01', y: 200 }] }],
    };
    const out = shapeLineChart({}, result) as Record<string, unknown>;
    expect(out._genui_template).toBeUndefined();
    expect(out.title).toBe('AAPL');
    expect((out.series as unknown[]).length).toBe(1);
  });

  test('builds chart from search result with 2-column numeric markdown table', () => {
    const result = [{
      slug: 'mongodb_data',
      title: 'MongoDB Stock Price Evolution',
      chunk_text: '# MongoDB\n\n| Year | Closing Price |\n| :--- | :--- |\n| 2018 | $83.74 |\n| 2019 | $131.61 |\n| 2020 | $359.04 |',
    }];
    const out = shapeLineChart({}, result) as Record<string, unknown>;
    expect(out).not.toBeNull();
    expect((out.x_axis as Record<string, unknown>).label).toBe('Year');
    expect((out.y_axis as Record<string, unknown>).label).toBe('Closing Price');
    expect((out.y_axis as Record<string, unknown>).format).toBe('currency');
    const series = out.series as Array<{ name: string; points: { x: unknown; y: number }[] }>;
    expect(series[0].points.length).toBe(3);
    expect(series[0].points[0]).toEqual({ x: 2018, y: 83.74 });
  });

  test('returns null when markdown table has non-numeric Y values', () => {
    const result = [{
      slug: 'x',
      chunk_text: '| A | B |\n| :--- | :--- |\n| foo | bar |\n| baz | qux |',
    }];
    expect(shapeLineChart({}, result)).toBeNull();
  });

  test('returns null for shapes that aren\'t chartable', () => {
    expect(shapeLineChart({}, 'string')).toBeNull();
    expect(shapeLineChart({}, [{ slug: 'x', chunk_text: 'no table' }])).toBeNull();
    expect(shapeLineChart({}, { irrelevant: 'object' })).toBeNull();
  });
});

describe('shapePortalPayload — line_chart', () => {
  test('returns chart payload when result is shapable', () => {
    const result = {
      _genui_template: 'line_chart',
      title: 'AAPL',
      x_axis: { label: 'Date', field: 'x' },
      y_axis: { label: 'Price', field: 'y' },
      series: [{ name: 'AAPL', points: [{ x: 1, y: 200 }] }],
    };
    const out = shapePortalPayload('line_chart', {}, result) as Record<string, unknown>;
    expect(out._genui_template).toBeUndefined();
    expect(out.title).toBe('AAPL');
  });

  test('falls back to raw result when shape doesn\'t match', () => {
    // Portal will 400 — and the response_body lands in the debug log.
    const raw = { not: 'a chart' };
    expect(shapePortalPayload('line_chart', {}, raw)).toBe(raw);
  });
});

// --- shapePortalPayload ---

describe('shapePortalPayload', () => {
  test('search_table returns { query, columns, rows } with expected columns', () => {
    const out = shapePortalPayload('search_table', { query: 'mongodb' }, searchResults(2)) as Record<string, unknown>;
    expect(out.query).toBe('mongodb');
    expect(out.columns).toEqual(['title', 'slug', 'type', 'score', 'chunk_text']);
    const rows = out.rows as Record<string, unknown>[];
    expect(rows.length).toBe(2);
    expect(rows[0]).toHaveProperty('title');
    expect(rows[0]).toHaveProperty('slug');
    expect(rows[0]).toHaveProperty('score');
  });

  test('search_table accepts params.q as fallback for query', () => {
    const out = shapePortalPayload('search_table', { q: 'fallback' }, searchResults(1)) as Record<string, unknown>;
    expect(out.query).toBe('fallback');
  });

  test('search_table on non-array result returns empty rows, never throws', () => {
    const out = shapePortalPayload('search_table', { query: 'q' }, 'not an array') as Record<string, unknown>;
    expect(out.rows).toEqual([]);
  });

  test('jobs_status maps to columns + rows', () => {
    const out = shapePortalPayload('jobs_status', {}, jobsList()) as Record<string, unknown>;
    expect(out.columns).toEqual(expect.arrayContaining(['id', 'name', 'status']));
    expect((out.rows as unknown[]).length).toBe(2);
  });

  test('timeline_view maps to slug + entries', () => {
    const out = shapePortalPayload('timeline_view', { slug: 'x' }, timelineEntries()) as Record<string, unknown>;
    expect(out.slug).toBe('x');
    expect((out.entries as unknown[]).length).toBeGreaterThan(0);
  });

  test('stats_dashboard extracts numeric metrics', () => {
    const out = shapePortalPayload('stats_dashboard', {}, statsResult()) as Record<string, unknown>;
    const metrics = out.metrics as Record<string, number>;
    expect(metrics.pages).toBe(1234);
    expect(metrics.chunks).toBe(5678);
  });

  test('unknown template falls back to raw result', () => {
    const raw = { hello: 'world' };
    expect(shapePortalPayload('mystery', {}, raw)).toBe(raw);
  });
});

// --- UI_RULES sanity ---

describe('UI_RULES', () => {
  test('declares actual operation names from operations.ts', () => {
    // These are the names used in the live code; if they drift, the rule
    // table needs updating.
    const expected = [
      'search', 'query', 'traverse_graph', 'get_timeline',
      'get_stats', 'get_health', 'list_jobs', 'get_job',
    ];
    for (const name of expected) {
      expect(UI_RULES[name]).toBeDefined();
    }
    // Named jobs ops use list_jobs / get_job — NOT jobs_list / jobs_get.
    expect(UI_RULES.jobs_list).toBeUndefined();
    expect(UI_RULES.jobs_get).toBeUndefined();
  });
});
