/**
 * Dispatch-level integration tests for GenUI middleware.
 *
 * Asserts:
 *  1. With GENUI_ENABLED=false, dispatchToolCall returns the legacy result-only payload.
 *  2. With GENUI_ENABLED=true and a renderable op, the payload is { result, ui }.
 *  3. Artifact client failure NEVER fails dispatch — the normal MCP result still ships.
 *  4. params.ui.enabled=false suppresses UI even when GenUI is enabled.
 *
 * Tests use the in-memory PGLiteEngine and exercise the real `find_orphans` op
 * (zero-config, no API keys). The artifact client is mocked through
 * `setArtifactClient` so no network call is attempted.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { setArtifactClient } from '../src/mcp/ui-middleware.ts';

const PORTAL = 'https://hermes-agent-production-861b.up.railway.app';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Seed a minimal page so search has something to chew on, but find_orphans
  // also works on an empty brain (returns []).
  await engine.putPage('people/example-one', {
    type: 'person',
    title: 'Example One',
    compiled_truth: 'A test page about Example One.',
    frontmatter: {},
  });
  await engine.putPage('people/example-two', {
    type: 'person',
    title: 'Example Two',
    compiled_truth: 'Another test page about Example Two.',
    frontmatter: {},
  });
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => setArtifactClient(null));
afterEach(() => setArtifactClient(null));

function parseToolText(text: string): unknown {
  return JSON.parse(text);
}

describe('dispatch with GenUI middleware', () => {
  test('GENUI_ENABLED=false returns normal result only (no ui field)', async () => {
    await withEnv(
      { GENUI_ENABLED: 'false', GENUI_MODE: 'auto', GENUI_BASE_URL: PORTAL },
      async () => {
        const out = await dispatchToolCall(engine, 'find_orphans', {});
        expect(out.isError).toBeFalsy();
        const text = out.content[0].text;
        const parsed = parseToolText(text);
        // When UI is disabled, payload === result (no { result, ui } wrapping).
        expect(Array.isArray(parsed)).toBe(true);
      },
    );
  });

  test('GENUI enabled + renderable op returns { result, ui }', async () => {
    setArtifactClient(async () => ({
      id: 'art-find-orphans',
      url: `${PORTAL}/ui/latest/art-find-orphans`,
      status: 'temporary',
    }));
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_MODE: 'auto', GENUI_BASE_URL: PORTAL },
      async () => {
        const out = await dispatchToolCall(engine, 'find_orphans', {});
        expect(out.isError).toBeFalsy();
        const parsed = parseToolText(out.content[0].text) as Record<string, unknown>;
        expect(parsed).toHaveProperty('result');
        expect(parsed).toHaveProperty('ui');
        const ui = parsed.ui as Record<string, unknown>;
        expect(ui.id).toBe('art-find-orphans');
        expect(ui.url).toContain('/ui/latest/');
        expect(ui.category).toBe('graph');
      },
    );
  });

  test('artifact client failure does NOT fail dispatch — result still ships', async () => {
    setArtifactClient(async () => {
      throw new Error('simulated portal outage');
    });
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_MODE: 'auto', GENUI_BASE_URL: PORTAL },
      async () => {
        const out = await dispatchToolCall(engine, 'find_orphans', {});
        expect(out.isError).toBeFalsy();
        const parsed = parseToolText(out.content[0].text);
        // Failed UI render → payload === bare result, no ui field.
        expect(Array.isArray(parsed)).toBe(true);
      },
    );
  });

  test('params.ui.enabled=false suppresses UI even when GenUI enabled', async () => {
    let posted = false;
    setArtifactClient(async () => {
      posted = true;
      return { id: 'never' };
    });
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_MODE: 'auto', GENUI_BASE_URL: PORTAL },
      async () => {
        const out = await dispatchToolCall(engine, 'find_orphans', { ui: { enabled: false } });
        expect(out.isError).toBeFalsy();
        const parsed = parseToolText(out.content[0].text);
        expect(Array.isArray(parsed)).toBe(true);
        expect(posted).toBe(false);
      },
    );
  });

  test('render_chart op produces ui artifact when GENUI_LINE_CHART=true', async () => {
    let captured: Record<string, unknown> | null = null;
    setArtifactClient(async (input) => {
      captured = input.body as Record<string, unknown>;
      return { id: 'ui_chart_1', url: `${PORTAL}/ui/latest/ui_chart_1`, status: 'temporary' };
    });
    await withEnv(
      {
        GENUI_ENABLED: 'true',
        GENUI_MODE: 'auto',
        GENUI_BASE_URL: PORTAL,
        GENUI_LINE_CHART: 'true',
      },
      async () => {
        const out = await dispatchToolCall(engine, 'render_chart', {
          title: 'AAPL last year',
          x_label: 'Date',
          y_label: 'Closing price',
          y_format: 'currency',
          series: [
            {
              name: 'AAPL',
              points: [
                { x: '2025-01', y: 200 },
                { x: '2025-06', y: 215 },
                { x: '2025-12', y: 250 },
              ],
            },
          ],
        });
        expect(out.isError).toBeFalsy();
        const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>;
        expect(parsed).toHaveProperty('ui');
        const ui = parsed.ui as Record<string, unknown>;
        expect(ui.id).toBe('ui_chart_1');
        expect(ui.category).toBe('finance');
        expect(ui.type).toBe('line_chart');
        // The portal received a chart-shaped payload, not the marker.
        expect(captured).not.toBeNull();
        const payload = (captured as Record<string, unknown>).payload as Record<string, unknown>;
        expect(payload.title).toBe('AAPL last year');
        expect(payload._genui_template).toBeUndefined();
        expect((payload.y_axis as Record<string, unknown>).format).toBe('currency');
      },
    );
  });

  test('render_chart op skipped (no ui artifact) when GENUI_LINE_CHART=false', async () => {
    let posted = false;
    setArtifactClient(async () => {
      posted = true;
      return { id: 'never' };
    });
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_MODE: 'auto', GENUI_BASE_URL: PORTAL, GENUI_LINE_CHART: 'false' },
      async () => {
        const out = await dispatchToolCall(engine, 'render_chart', {
          title: 'x', x_label: 'a', y_label: 'b',
          series: [{ name: 's', points: [{ x: 1, y: 2 }] }],
        });
        expect(out.isError).toBeFalsy();
        // Result still ships (MCP behavior preserved); just no ui field.
        const parsed = JSON.parse(out.content[0].text);
        expect(parsed).toHaveProperty('_genui_template');
        expect(parsed.ui).toBeUndefined();
        expect(posted).toBe(false);
      },
    );
  });

  test('render_chart op rejects empty series with invalid_params', async () => {
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL, GENUI_LINE_CHART: 'true' },
      async () => {
        const out = await dispatchToolCall(engine, 'render_chart', {
          title: 'x', x_label: 'a', y_label: 'b', series: [],
        });
        expect(out.isError).toBe(true);
        const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>;
        expect(parsed.error).toBe('invalid_params');
      },
    );
  });

  test('render_chart op rejects non-numeric y values', async () => {
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_BASE_URL: PORTAL, GENUI_LINE_CHART: 'true' },
      async () => {
        const out = await dispatchToolCall(engine, 'render_chart', {
          title: 'x', x_label: 'a', y_label: 'b',
          series: [{ name: 's', points: [{ x: 1, y: 'NaN' }] }],
        });
        expect(out.isError).toBe(true);
      },
    );
  });

  test('write op (put_page, dry_run) does NOT auto-render even with GenUI enabled', async () => {
    let posted = false;
    setArtifactClient(async () => {
      posted = true;
      return { id: 'never' };
    });
    await withEnv(
      { GENUI_ENABLED: 'true', GENUI_MODE: 'auto', GENUI_BASE_URL: PORTAL },
      async () => {
        const out = await dispatchToolCall(engine, 'put_page', {
          slug: 'people/example-three',
          content: '# Example Three\n',
          dry_run: true,
        });
        expect(out.isError).toBeFalsy();
        expect(posted).toBe(false);
        // Result still ships — payload is the bare dry_run object, not wrapped.
        const parsed = JSON.parse(out.content[0].text);
        expect(parsed).toMatchObject({ dry_run: true, action: 'put_page' });
      },
    );
  });
});
