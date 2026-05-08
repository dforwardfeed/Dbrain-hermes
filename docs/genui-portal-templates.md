# GenUI portal template contract

The Hermes / Railway GenUI portal renders artifacts that GBrain POSTs to
`POST /api/ui/artifacts`. GBrain decides which template to use and reshapes
the artifact payload to match what the template expects. The portal owns
the actual rendering; GBrain owns picking + payload shaping.

This document is the source-of-truth contract between the two repos. When
you add a new template to the portal, add an entry here AND in
`src/mcp/ui-middleware.ts:TEMPLATE_CATALOG` so the LLM view-picker
(`GENUI_VIEW_PICKER=true`) can route data into it.

## Current templates (already shipping)

### `search_table`

Tabular results with a column header row. GBrain emits this for `search`,
`query`, `list_pages`, etc. The shaper has a Layer-1 special case: when
the search returns exactly one result and the top result's `chunk_text`
contains a parseable markdown table, the shaper swaps to the parsed
table — same template, but `source_kind: "markdown_table"` is set on the
payload so the renderer can show a different header.

```json
{
  "title": "Search: MongoDB",
  "category": "search",
  "viewType": "table",
  "renderSpec": { "kind": "template", "template": "search_table", "props": {} },
  "payload": {
    "query": "MongoDB",
    "columns": ["title", "slug", "type", "score", "chunk_text"],
    "rows": [
      { "title": "...", "slug": "...", "type": "note", "score": 0.30, "chunk_text": "..." }
    ],

    // Markdown-table-swap variant (single-result only):
    "source_kind": "markdown_table",
    "source_slug": "mongodb_data",
    "title": "MongoDB Stock Price Evolution",
    "columns": ["Year", "Closing Price"],
    "rows": [
      { "Year": 2018, "Closing Price": 83.74 },
      { "Year": 2019, "Closing Price": 131.61 }
    ]
  }
}
```

### `timeline_view`

Chronological list. GBrain emits this for `get_timeline`.

```json
{
  "payload": {
    "slug": "people/example",
    "columns": ["date", "source", "summary", "detail"],
    "entries": [
      { "date": "2026-04-01", "source": "meeting", "summary": "Kickoff", "detail": "" }
    ]
  }
}
```

### `jobs_status`

Job-board layout grouped by status. GBrain emits for `list_jobs` / `get_job`.

```json
{
  "payload": {
    "columns": ["id", "name", "queue", "status", "created_at", "started_at", "finished_at", "error_text"],
    "rows": [{ "id": 1, "name": "sync", "status": "completed" }]
  }
}
```

### `stats_dashboard`

Numeric metric grid. GBrain emits for `get_stats`, `get_health`. Numeric
fields are extracted from the result; the original object is kept under
`raw` for the portal to display ancillary fields.

```json
{
  "payload": {
    "metrics": { "pages": 1234, "chunks": 5678 },
    "raw": { "pages": 1234, "chunks": 5678, "engine": "pglite" }
  }
}
```

### `generic_cards`

Card grid. GBrain emits for `traverse_graph`, `find_orphans`, etc.

```json
{
  "payload": {
    "cards": [{ "slug": "...", "title": "...", "summary": "..." }]
  }
}
```

## Templates to add (Hermes-side TODO)

These names are reserved in the GenUI roadmap. Once Hermes implements
any of them, add an entry to `TEMPLATE_CATALOG` in
`src/mcp/ui-middleware.ts` and the LLM view-picker will start emitting
them automatically when the data shape fits.

### `line_chart` (GBrain side ready — pending Hermes renderer)

GBrain ships the line_chart pipeline behind `GENUI_LINE_CHART=true`
(default off). When the flag is on AND the Hermes portal can render
`line_chart`, three paths produce chart artifacts:

1. **Explicit:** the agent calls the new `render_chart` MCP op with
   `{title, x_label, y_label, series, y_format?, source_url?}`. Use
   this when the agent has data from web search (Tavily/Exa) or any
   non-brain source.
2. **Auto from search:** when `mcp_gbrain_search` returns a single hit
   whose `chunk_text` contains a 2-column numeric markdown table (every
   row in col 2 is numeric), `shapeLineChart` builds the chart payload
   from that table. The LLM view-picker (when on) routes such results
   to `line_chart` automatically.
3. **Auto from explicit chart payload:** any handler that returns
   `{_genui_template: "line_chart", title, x_axis, y_axis, series}` is
   recognized as already chart-shaped; the marker is stripped on the way
   to the portal.

Until `GENUI_LINE_CHART=true` is set, the catalog gate in
`decideRender` skips line_chart artifacts cleanly with reason
`template_not_in_catalog` — no failed POSTs.

The portal-side renderer must accept this payload shape:

```json
{
  "renderSpec": { "kind": "template", "template": "line_chart", "props": {} },
  "payload": {
    "title": "AAPL closing price, last 12 months",
    "x_axis": { "label": "Date", "field": "x" },
    "y_axis": { "label": "Closing price", "field": "y", "format": "currency" },
    "series": [
      {
        "name": "AAPL",
        "points": [
          { "x": "2025-01", "y": 200.12 },
          { "x": "2025-02", "y": 215.40 }
        ]
      }
    ],
    "source_url": "https://example.com/article",
    "source_slug": "wiki/people/example"
  }
}
```

`x` is a string (date label) or number (year/index). `y` is always a
finite number. `y_axis.format` is one of `number` | `currency` | `percent`.
Multiple series are allowed for overlay charts. `source_url` and
`source_slug` are optional citation hints — render as a small caption
below the chart if the renderer supports it.

To enable end-to-end:
1. `daniel-hermes`: implement the `line_chart` renderer + register the
   template in the portal validator.
2. Railway: set `GENUI_LINE_CHART=true` on the Hermes service env.
3. Redeploy. `[genui-boot] line_chart_enabled=true` confirms.

### `bar_chart`

Same shape as `line_chart` but rendered as bars. Use when the x axis is
categorical (countries, products, segments) rather than continuous.

```json
{
  "payload": {
    "title": "Pages by source",
    "x_axis": { "label": "Source", "field": "source" },
    "y_axis": { "label": "Pages", "field": "count" },
    "series": [
      {
        "name": "Pages",
        "points": [
          { "source": "wiki", "count": 1234 },
          { "source": "media", "count": 567 }
        ]
      }
    ]
  }
}
```

### `markdown_view`

Rendered markdown body. Use when the result is essentially a single
document and the operator just wants to read it (long page content, an
agent-authored summary). Today this is force-fit into `search_table`
which displays the markdown as flat text in a column.

```json
{
  "payload": {
    "title": "Brain Page: people/example",
    "markdown": "# Heading\n\nFull markdown body...",
    "source_slug": "people/example"
  }
}
```

### `metric_card`

Single big-number callout. Use for stats with exactly one headline metric
(`get_stats` returning just `page_count`, autopilot cycle returning a
duration, etc.).

```json
{
  "payload": {
    "label": "Total pages",
    "value": 1234,
    "unit": "pages",
    "delta": { "value": 42, "direction": "up", "since": "yesterday" }
  }
}
```

## Wire protocol

Every artifact body (regardless of template) ships with these top-level
fields. The portal validates against these:

| Field        | Type           | Notes |
|---           |---             |--- |
| `title`      | string         | Header for the artifact card |
| `category`   | string         | `search`, `graph`, `timeline`, `jobs`, `stats`, `briefing`, `finance` |
| `viewType`   | string         | `table`, `cards`, `dashboard`, `timeline`, `status`, `chart`, `line_chart`, `bar_chart`, `pie_chart`, `area_chart`, `scatter_chart`, `document`, `markdown`, `custom` — semantic/navigation tag, NOT the renderer (renderer is `renderSpec.template`). Hermes portal validator at `daniel-hermes/genui.py:VALID_VIEW_TYPES` is the authoritative enum; keep both repos in sync when adding values. |
| `status`     | `"temporary"` \| `"saved"` | Default `"temporary"`; portal manages TTL |
| `source`     | object         | `{ operation, paramsSummary, transport, trigger }` — see below |
| `payload`    | object         | Template-specific. See sections above. |
| `renderSpec` | object         | `{ kind: "template", template: "<name>", props: {} }` |
| `createdAt`  | ISO timestamp  | |
| `expiresAt`  | ISO timestamp  | createdAt + `GENUI_TEMPORARY_TTL_HOURS` |

`source` is privacy-safe: `paramsSummary` only contains keys declared by
the operation; unknown/attacker-supplied keys are counted but never
named, and values are never echoed.

```json
{
  "source": {
    "operation": "search",
    "paramsSummary": {
      "operation": "search",
      "declared_keys": ["query"],
      "unknown_key_count": 0
    },
    "transport": "unknown",
    "trigger": "chat"
  }
}
```

## Auth

When `GENUI_API_TOKEN` is set on the GBrain side, every POST to
`/api/ui/artifacts` carries it twice for portal compatibility:

```
Authorization: Bearer <token>
X-GenUI-Token: <token>
```

Portal should accept either header.

## Error reporting

On non-2xx, GBrain logs the response body (truncated to 1000 chars) under
`event=artifact_post` in `/data/genui/gbrain-mcp-genui.log`. Always
return a JSON validation message in the body when rejecting — that's the
operator's only signal for what went wrong.

```json
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "validation_failed",
  "field": "payload.rows",
  "message": "expected array of objects, got string"
}
```

## LLM view-picker

When `GENUI_VIEW_PICKER=true` is set, GBrain calls the AI gateway after
the rule-based picker has chosen a template. The LLM is given:

- The operation name + redacted params summary
- A truncated sample of the result (≤ 2KB)
- The full `TEMPLATE_CATALOG` (this list)
- The current rule-based pick

Output is constrained to a template name from the catalog. Failure
(timeout, malformed JSON, unknown template) → fall back to the rule-based
pick. So adding a new template to the portal + the `TEMPLATE_CATALOG`
constant is sufficient to make the picker start emitting it; no
prompt-engineering needed per template.
