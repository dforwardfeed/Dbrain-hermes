# ARCHITECTURE — Dbrain-hermes (GBrain fork) + Daniel-Hermes (Railway wrapper)

> **Read this BEFORE making changes that touch deploy, MCP wiring, or the
> GenUI flow.** Future Claude Code sessions: this file plus `CLAUDE.md`
> are your map.

## 1. Overview

Two separate GitHub repos cooperate at runtime to deliver a personal AI
agent (Dbrain Hermes) reachable from Telegram / WhatsApp / Slack:

- **`dforwardfeed/Dbrain-hermes`** (this repo) — fork of Garry Tan's GBrain.
  Owns the GBrain source, MCP operations, dispatch path, and the GenUI
  middleware that decides when a tool result deserves a UI artifact.
  Not deployed directly anywhere.
- **`dforwardfeed/daniel-hermes`** — the Hermes Railway wrapper. Owns the
  Dockerfile, startup scripts, FastAPI server, GenUI portal routes, admin
  dashboard, persistent volume layout, and the public Railway URL.
  Railway deploys this repo and only this repo.

At Railway boot, the Hermes wrapper clones `Dbrain-hermes` into
`/data/gbrain` and runs `bun link` so the `gbrain` CLI is available at
`/data/.bun/bin/gbrain`. Hermes then registers `gbrain serve` as an MCP
server. Tool calls from the agent cross the stdio MCP boundary into the
gbrain subprocess.

## 2. Repositories

### `dforwardfeed/daniel-hermes` — Railway-deployed wrapper

| Aspect             | Value |
|---                 |--- |
| Local path         | `C:\coding-projects\daniel-hermes` |
| Branch             | `main` |
| Deploy target      | Railway (auto-deploys on push) |
| Public URL         | <https://hermes-agent-production-861b.up.railway.app> |
| Persistent volume  | `/data` (Railway-managed) |

Owns:

- `Dockerfile` (Python 3.12 + Node 22 + Bun + tini)
- `start.sh`, `install_gbrain.sh` (clones Dbrain-hermes into `/data/gbrain`)
- `server.py` — FastAPI app (HTTP + WebSocket + admin dashboard)
- `genui.py` — GenUI portal: artifact storage, view routes, auth
- `templates/` — Jinja or React templates rendered by `genui.py`
- `railway.toml`, `requirements.txt`
- All GenUI portal HTTP routes:
  - `POST /api/ui/artifacts` — artifact creation (the endpoint GBrain
    middleware POSTs to)
  - `GET /api/ui/artifacts/list` — list saved/temporary artifacts
  - `GET /ui/latest/{id}` — render a single artifact
  - `GET /ui/saved`, `/ui/daily` — operator views
- `/data/genui/` storage layout (artifacts + retention)
- All `GENUI_*` env-var consumers on the Hermes side (token verification,
  storage path resolution, retention cleanup)

### `dforwardfeed/Dbrain-hermes` — GBrain fork (this repo)

| Aspect             | Value |
|---                 |--- |
| Local path         | `C:\coding-projects\Dbrain-hermes` |
| Branch             | `master` |
| Deploy target      | none directly — installed by Hermes at runtime |
| Upstream           | `garrytan/gbrain` |
| Compiled binary    | `/data/.bun/bin/gbrain` (in container) |

Owns:

- All GBrain source code (forked from upstream)
- MCP transport layer:
  - `src/mcp/server.ts` — stdio MCP server entry
  - `src/mcp/dispatch.ts` — single dispatch path consumed by stdio + HTTP
  - `src/mcp/tool-defs.ts` — schema for tool registration
  - `src/mcp/ui-middleware.ts` — **GenUI decision engine + artifact POST**
- All MCP operations: `src/core/operations.ts`
- Type definitions: `src/core/types.ts`
- Skills: `skills/`
- Build / packaging that produces the gbrain CLI binary

## 3. Runtime architecture

```
                           ┌──────────────────────────┐
                           │   Railway (us-east4)     │
                           │                          │
  Telegram / WhatsApp /    │  ┌────────────────────┐  │
  Slack / web              │  │   Hermes process   │  │
        │                  │  │  (server.py +      │  │
        │  HTTPS           │  │   genui.py)        │  │
        ▼                  │  │                    │  │
  ┌──────────────┐         │  │  ┌──────────────┐  │  │
  │ Hermes agent │─────────┼─►│  │ MCP client   │  │  │
  └──────────────┘         │  │  └──────┬───────┘  │  │
                           │  │         │ stdio    │  │
                           │  │         ▼          │  │
                           │  │  ┌──────────────┐  │  │
                           │  │  │ gbrain serve │  │  │  ◄── /data/.bun/bin/gbrain
                           │  │  │ (subprocess) │  │  │
                           │  │  └──────┬───────┘  │  │
                           │  │         │          │  │
                           │  │         │ tool call│  │
                           │  │         ▼          │  │
                           │  │  ┌──────────────┐  │  │
                           │  │  │ dispatch.ts  │  │  │
                           │  │  │  → handler   │  │  │
                           │  │  │  → maybeRenderUi
                           │  │  └──────┬───────┘  │  │
                           │  │         │          │  │
                           │  │         │ POST     │  │
                           │  │         │          │  │
                           │  │  ┌──────▼──────┐   │  │
                           │  │  │ /api/ui/    │   │  │
                           │  │  │ artifacts   │   │  │
                           │  │  │ (genui.py)  │   │  │
                           │  │  └──────┬──────┘   │  │
                           │  │         │          │  │
                           │  │         ▼          │  │
                           │  │  ┌──────────────┐  │  │
                           │  │  │ /data/genui/ │  │  │  ◄── persistent volume
                           │  │  │ artifact     │  │  │
                           │  │  │ storage      │  │  │
                           │  │  └──────────────┘  │  │
                           │  └────────────────────┘  │
                           └──────────────────────────┘
```

### Persistent volume layout (`/data`)

```
/data/
├── .bun/bin/gbrain                       ← compiled CLI (from this repo)
├── gbrain/                               ← git checkout of Dbrain-hermes
│   ├── src/, skills/, ...                ← source code
│   └── (linked into the gbrain CLI)
├── .gbrain/                              ← gbrain runtime data (PGLite, config)
└── genui/
    ├── gbrain-mcp-genui.log              ← durable middleware debug log
    └── artifacts/                        ← portal-stored artifacts
```

`GBRAIN_HOME=/data/.gbrain` and `GENUI_STORAGE=/data/genui` keep both repos
out of `$HOME` so a Railway instance restart doesn't lose state.

## 4. GenUI flow

A single end-to-end pass for a Telegram message that triggers a tool call:

1. User: "Search the brain for MongoDB"
2. Telegram → Hermes → agent prompt → tool decision: `mcp_gbrain_search`.
3. Hermes MCP client sends `{ name: "search", arguments: { query: "MongoDB" }}`
   over stdio to the `gbrain serve` subprocess.
4. `src/mcp/dispatch.ts:dispatchToolCall` resolves the operation, builds the
   `OperationContext` (`remote: true`), invokes `op.handler(ctx, params)`.
5. Handler returns the raw structured result (e.g. `SearchResult[]`).
6. Dispatch calls `logGenuiDispatchEntry(...)` then `maybeRenderUi(...)`
   (in `src/mcp/ui-middleware.ts`).
7. Middleware:
   - Loads config from env (`GENUI_ENABLED`, `GENUI_BASE_URL`, etc.) at call
     time so Railway env updates take effect without rebuilding.
   - Runs the deterministic decision engine (`decideRender`).
   - **Layer 1 (default on):** if `shapeSearchTable` sees a single search hit
     whose `chunk_text` contains a parseable markdown table, the artifact
     payload becomes `{title, columns, rows}` from that parsed table.
   - **Layer 2 (opt-in via `GENUI_VIEW_PICKER=true`):** ask the AI gateway's
     default chat model to confirm or override the rule-based template
     pick. Output constrained to `TEMPLATE_CATALOG`.
   - POSTs the artifact body to `${GENUI_BASE_URL}/api/ui/artifacts` with
     `Authorization: Bearer ${GENUI_API_TOKEN}` and `X-GenUI-Token: ...`.
   - On non-2xx: logs the response body (truncated to 1KB), returns null.
     The MCP response still ships the bare result.
8. Hermes portal (in `daniel-hermes`) receives, validates, persists under
   `/data/genui/artifacts/`, returns `{id, url}`.
9. Middleware folds the artifact summary into the MCP payload:
   ```json
   {
     "result": [/* original */],
     "ui": { "id": "ui_...", "url": "https://...", "type": "...", "category": "...", "title": "...", "status": "temporary" }
   }
   ```
10. Hermes agent sees both, replies to user with the answer + the artifact
    URL.

### Debug-log records (`/data/genui/gbrain-mcp-genui.log`)

JSONL, one line per event. Always-on, no env flag needed. Events:

| `event`         | When |
|---              |--- |
| `boot`          | `gbrain serve` startup — config snapshot |
| `dispatch`      | Per-call entry, before `maybeRenderUi` |
| `decision`      | Render / skip / fail with reasons + score |
| `view_picker`   | Layer-2 LLM call result (only when enabled) |
| `artifact_post` | HTTP status from portal; on 4xx includes `response_body` |
| `error`         | Non-fatal middleware error, with `stage` |

## 5. What belongs in each repo

The dividing line: **does the change touch HTTP routes, the public URL,
container build, or how artifacts are stored and rendered?** If yes →
`daniel-hermes`. If no, and it's about MCP / dispatch / decision / payload
shape → `Dbrain-hermes`.

### `daniel-hermes` (Railway wrapper)

- Anything in `Dockerfile`, `start.sh`, `install_gbrain.sh`, `railway.toml`
- FastAPI routes in `server.py`
- All GenUI portal routes (`/api/ui/artifacts*`, `/ui/*`)
- Artifact storage layout, TTL/cleanup logic
- Admin dashboard
- Token verification at the portal level
- Render templates (the actual HTML/React/Jinja that renders an artifact)
- Auth flow against the public URL

### `Dbrain-hermes` (this repo)

- MCP operations (`src/core/operations.ts`)
- Dispatch path, scope enforcement, trust boundaries (`src/mcp/dispatch.ts`)
- GenUI decision engine + artifact POST client (`src/mcp/ui-middleware.ts`)
- Shape detection, payload shaping per template
- Operation metadata (mutating? scope? localOnly?)
- Skills
- Anything that runs inside the gbrain subprocess

### When a feature crosses the boundary (e.g. new visual template)

Both repos move together:

1. **`daniel-hermes`** adds the renderer (`templates/<template>.html` or
   React component, registered in `genui.py`).
2. **`Dbrain-hermes`** adds an entry to `TEMPLATE_CATALOG` in
   `src/mcp/ui-middleware.ts` and (optionally) a payload shaper that
   produces the shape the renderer expects.

The contract between them is documented in `docs/genui-portal-templates.md`
in this repo.

#### Concrete example: adding `line_chart`

**Daniel-hermes side:**

- Implement a renderer that consumes:
  ```json
  {
    "title": "...",
    "x_axis": { "label": "Year", "field": "Year" },
    "y_axis": { "label": "Closing Price", "field": "Closing Price", "format": "currency" },
    "series": [{ "name": "...", "points": [{ "Year": 2018, "Closing Price": 83.74 }] }]
  }
  ```
- Whitelist the template name `line_chart` in the artifact validator.

**Dbrain-hermes side:**

- Add to `TEMPLATE_CATALOG`:
  ```ts
  { template: 'line_chart', category: 'finance', view: 'chart',
    description: 'X/Y line chart for numeric time series.' }
  ```
- Optionally add a shaper that detects markdown 2-column numeric tables
  produced by `parseMarkdownTable` and emits the line-chart payload shape.
- The opt-in LLM view-picker (`GENUI_VIEW_PICKER=true`) will start emitting
  `line_chart` automatically when the data fits — no prompt-engineering
  required per template.

## 6. Deployment workflow

### Change in `daniel-hermes`

```powershell
cd C:\coding-projects\daniel-hermes
git add .
git commit -m "<message>"
git push origin main
# Railway auto-deploys on push.
```

### Change in `Dbrain-hermes` (this repo)

```powershell
cd C:\coding-projects\Dbrain-hermes
git add .
git commit -m "<message>"
git push origin master
```

GBrain is NOT redeployed automatically — it's pulled fresh by Hermes
on container boot. To force Hermes to pick up the new GBrain commit,
trigger a Hermes redeploy:

```powershell
# Either click Redeploy in Railway UI, or:
cd C:\coding-projects\daniel-hermes
git commit --allow-empty -m "Redeploy to pull latest Dbrain-hermes"
git push origin main
```

### Verifying the right Dbrain-hermes commit is live

After redeploy, check from a Telegram shell tool:

```bash
cd /data/gbrain && git log -1 --oneline
which gbrain
gbrain --version
```

The `git log` line should match the commit you just pushed. If it
doesn't, `install_gbrain.sh` either failed or skipped the pull — check
Railway logs for the `[install_gbrain]` block.

## 7. Debugging and verification

### Smoke-test MCP + GenUI end-to-end

From a Telegram chat with the Hermes agent:

> Use the `mcp_gbrain_search` tool to search for "MongoDB". Show me the
> raw MCP tool response including any top-level `ui` object.

Expected response:

```json
{
  "result": [/* search results */],
  "ui": {
    "id": "ui_...",
    "type": "search_table",
    "category": "search",
    "title": "Search: MongoDB",
    "url": "https://hermes-agent-production-861b.up.railway.app/ui/latest/ui_...",
    "status": "temporary"
  }
}
```

Open the URL in a browser to see the rendered artifact.

### Debug log tail

```
tail -n 120 /data/genui/gbrain-mcp-genui.log
```

The file is JSONL — each line is a `{ts, event, ...}` record without a
prefix. (Stderr lines have a human prefix `[genui-<event>]` for the
operator's eye, but the file is raw JSON for grep / jq friendliness.)

Filter to one event type:

```
grep '"event":"boot"' /data/genui/gbrain-mcp-genui.log | tail -1
grep '"event":"dispatch"' /data/genui/gbrain-mcp-genui.log | tail -10
grep '"event":"decision"' /data/genui/gbrain-mcp-genui.log | tail -20
grep '"event":"view_picker"' /data/genui/gbrain-mcp-genui.log | tail -10
grep '"event":"artifact_post"' /data/genui/gbrain-mcp-genui.log | tail -10
grep '"event":"error"' /data/genui/gbrain-mcp-genui.log | tail -20
```

Common misuse — `grep genui-boot` matches the **stderr** prefix only.
That works when stderr is captured by the Hermes process AND surfaced
to the agent shell, but the file uses the prefix-free JSONL form.
Always grep `'"event":"boot"'` against the log file.

### Hit the portal API directly (Windows PowerShell)

```powershell
$BASE = "https://hermes-agent-production-861b.up.railway.app"
$TOKEN = "<GENUI_API_TOKEN>"
curl.exe -sS "$BASE/api/ui/artifacts/list?limit=5" -H "Authorization: Bearer $TOKEN"
```

If the list returns artifacts but the agent never returns a `ui` field:
the GBrain side is producing artifacts and the Hermes wrapper is
unwrapping `{result, ui}` upstream — debug on the Hermes side.

### Triage matrix

| Symptom                                          | Likely cause | Where to fix |
|---                                               |--- |--- |
| `[genui-boot]` line missing entirely             | Stale gbrain binary; `install_gbrain.sh` didn't pull | daniel-hermes (force redeploy) |
| `[genui-boot] enabled=false`                     | `GENUI_ENABLED` not propagated to gbrain subprocess | daniel-hermes (env forwarding) |
| `[genui-boot] base_url_set=false`                | `GENUI_BASE_URL` not propagated | daniel-hermes |
| `[genui-decision] decision=skipped`              | Operation not whitelisted, mutating, or shape mismatch | Dbrain-hermes (`TEMPLATE_CATALOG` / `UI_RULES`) |
| `[genui-artifact] status=400 response_body=...`  | Portal validation rejected the payload | Use the `response_body` to decide which repo |
| `[genui-artifact] status=401`                    | Token mismatch | daniel-hermes (token config) |
| Decision rendered + 200 but no `ui` in response  | Hermes wrapper unwrapping `{result, ui}` | daniel-hermes |
| Visual is wrong/ugly but data is correct         | Renderer issue | daniel-hermes |
| Wrong template chosen for the data               | Decision engine | Dbrain-hermes (`UI_RULES` or LLM picker) |

## 8. Current known state (as of 2026-05-08)

- ✅ Railway deploys `daniel-hermes`.
- ✅ Hermes pulls and links `Dbrain-hermes` at startup; binary at
  `/data/.bun/bin/gbrain`.
- ✅ `mcp_gbrain_search` and other ops are reachable from the Hermes agent.
- ✅ GenUI middleware fires; durable log at `/data/genui/gbrain-mcp-genui.log`.
- ✅ Artifact POSTs succeed (HTTP 201). Verified with `ui_Lwj7Iyw3kux3MPlT`.
- ✅ The MCP response wraps `{result, ui}` with a working portal URL.
- ✅ Layer 1 markdown-table swap shipped (commit `106ceb0`): MongoDB-style
  search results render as a clean Year/Price table.
- ✅ Layer 2 LLM view-picker shipped, **off by default**. Enable with
  `GENUI_VIEW_PICKER=true` on the Hermes Railway env. (User reported
  enabling — verify via `[genui-boot] view_picker_enabled=true` in the
  log; a typo like `ture` silently parses as false.)
- ✅ `line_chart` GBrain-side support shipped behind `GENUI_LINE_CHART=true`
  feature flag (default off). Includes:
  - New `render_chart` MCP op for the agent to call after assembling
    x/y data from any source (Tavily / Exa / a finance MCP / etc.).
  - `shapeLineChart()` shaper that also detects 2-column-numeric
    markdown tables in search results so the LLM picker can route
    chartable data automatically.
  - Catalog-validation gate in `decideRender` that skips with
    `template_not_in_catalog` when the flag is off — keeps the system
    safe before Hermes ships the renderer.
- ⏳ **Hermes-side `line_chart` renderer required.** Until `daniel-hermes`
  ships the portal renderer AND the Railway env sets
  `GENUI_LINE_CHART=true`, the catalog gate keeps line_chart artifacts
  from being POSTed (artifact_post would otherwise 400).
- ⏳ `bar_chart` / `markdown_view` / `metric_card` still pending —
  documented in `docs/genui-portal-templates.md`.

## 9. Common mistakes to avoid

- **"Just pushing Dbrain-hermes auto-deploys."** It does not. Railway
  watches `daniel-hermes`. Pushing this repo updates GitHub but not the
  running container until Hermes reboots.
- **Adding portal renderer templates here.** This repo has no HTTP server,
  no Jinja templates, no React. Renderers live in `daniel-hermes`.
- **Adding new operations to `daniel-hermes`.** Operations are MCP-side;
  they live in `src/core/operations.ts` here.
- **Hardcoding `localhost:NNNN` in artifact POST URLs.** GBrain reads
  `GENUI_BASE_URL` at call time. The Railway env var sets the public URL.
- **Logging request bodies / tokens.** The middleware redacts unknown keys
  and never echoes values; new code must use `recordDebug(event, fields)`,
  not `console.log(JSON.stringify(payload))`.
- **Treating stderr as the durable log.** Stderr lines may be dropped if
  the parent (Hermes) doesn't forward them. `/data/genui/gbrain-mcp-genui.log`
  is the file of record.
- **Modifying the upstream gbrain CLAUDE.md to describe the fork.**
  Upstream-tracking annotations belong in CLAUDE.md (it's a fork), but
  fork-specific deployment details belong in this file (ARCHITECTURE.md).
  The CLAUDE.md fork-block points here to keep the divergence minimal.

## 10. Future improvements

- **Charts — `line_chart`:** GBrain side ready (`render_chart` op,
  shaper, catalog entry behind `GENUI_LINE_CHART=true`). Pending:
  Hermes portal renderer in `daniel-hermes`. Schema documented in
  `docs/genui-portal-templates.md`. Once shipped, set
  `GENUI_LINE_CHART=true` on Railway and any agent prompt like
  "search Apple's stock prices last year and chart them" can call
  `mcp_gbrain_render_chart` with the points it gathered from
  Tavily/Exa.
- **Charts — `bar_chart`:** same model as line_chart; would add a
  second optional template + a `render_bar_chart` op (or fold into
  `render_chart` with a `kind` param).
- **`markdown_view` template:** dedicated long-document render; today
  long markdown is force-fit into `search_table` and looks bad.
- **`metric_card`:** big-number callouts for `get_stats` / autopilot
  cycle outputs.
- **WebSocket push from portal back to Hermes** so a new artifact
  notifies the active Telegram chat instead of relying on the agent
  surfacing the URL itself.
- **json-render adoption:** if the Hermes portal switches to
  `@json-render/react`, the GBrain side could emit a json-render spec
  directly via `renderSpec.kind: "spec"` and let one renderer drive every
  template. This is a longer-term simplification of the
  `template + payload` contract.
- **Per-template payload validators in this repo:** Zod schemas matching
  each entry in `TEMPLATE_CATALOG` so a malformed payload fails locally
  before the portal 400s.
