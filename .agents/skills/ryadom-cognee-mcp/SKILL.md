---
name: ryadom-cognee-mcp
description: "Connecting to the Ryadom team's Cognee MCP (twc-sber500) — shared team memory. The connection uses the env variables COGNEE_MCP_USER/COGNEE_MCP_PASS, with no secrets in configs. Rules: write project facts to the dataset ryadom, recall before starting work, never index secrets. Use when you need to connect the MCP, save or find team knowledge, or diagnose the connection."
whenToUse: When connecting Cognee MCP in this repo, setting up mcp.json for a new team member, saving or searching team knowledge (remember/recall), or when recall/remember do not work
---

# Ryadom team memory — Cognee MCP

Cognee is the shared memory of the **Ryadom** project (cluster `twc-sber500`, see the `deploy` skill). The team works
in **one context**: a shared Cognee MCP server and a shared dataset `ryadom`. Local docker and Cognee Cloud are not
used.

All MCP clients use one service account, so the data of all team members lands in the same datasets — that is the
shared context.

## Connection (developer onboarding)

Principle: **configs hold only variable names, credentials live in the developer's environment.**

1. Get basic-auth credentials from whoever deployed the MCP (the password has the format `XXXX-XXXX-XXXX`).
2. Export them in `~/.zshrc` (or `.env` + direnv):
   ```bash
   export COGNEE_MCP_USER="mcp"
   export COGNEE_MCP_PASS="XXXX-XXXX-XXXX"   # ask the team
   ```
3. The server is already declared in the repository's root `.mcp.json` (name `cognee`) — it is picked up
   automatically. The stdio entry runs `npx mcp-remote` at session start: node/npx is required, the shell substitutes
   the credentials from env.
4. Restart the client session (`/new` or a restart) — the MCP loads only at start.
5. Check: call `get_client_info_json` — it should return the agent dataset. A quick check without an IDE:
   ```bash
   curl -N -u "$COGNEE_MCP_USER:$COGNEE_MCP_PASS" https://mcp.fantomas404.ru/sse
   # expected: event: endpoint / data: /messages/?session_id=...
   # 401 = wrong or missing COGNEE_MCP_USER/COGNEE_MCP_PASS
   ```

Contents of `.mcp.json` (the source of truth is the file in the repo root):

```json
{
  "mcpServers": {
    "cognee": {
      "command": "bash",
      "args": ["-c", "BASIC=$(printf '%s' \"$COGNEE_MCP_USER:$COGNEE_MCP_PASS\" | base64); exec npx -y mcp-remote \"https://mcp.fantomas404.ru/sse\" --header \"Authorization: Basic $BASIC\""],
      "startupTimeoutMs": 180000,
      "toolTimeoutMs": 300000
    }
  }
}
```

Why not credentials in the URL (`https://user:pass@host/sse`): mcp-remote (Node fetch/undici) rejects such URLs —
`TypeError: Request cannot be constructed from a URL that includes credentials`.

Other clients:
- **Claude Code** — the same root `.mcp.json`; it supports `${VAR}` and native SSE without mcp-remote:
  `"url": "https://${COGNEE_MCP_USER}:${COGNEE_MCP_PASS}@mcp.fantomas404.ru/sse"`.
- **Cursor** — the GUI does not inherit the shell env; credentials only in the user-level `~/.cursor/mcp.json`
  (outside the repo).

## Tools (prefix `mcp__cognee__*`)

Deployed with `COGNEE_MCP_TOOL_MODE=all` — 10 tools:

- `remember(data, dataset_name?, session_id?)` — save. Without `session_id` — the full add + cognify pipeline
  (knowledge graph, slow). With `session_id` — a fast per-session cache, without entity extraction.
- `recall(query, datasets?, search_type?, top_k?)` — memory search, the strategy is routed automatically.
  `search_type`: `GRAPH_COMPLETION`, `RAG_COMPLETION`, `CHUNKS`, `SUMMARIES`, `TEMPORAL`, etc.
- `forget(dataset?, everything?)` — destructive, confirm with the user.
- Datasets: `list_datasets_json`, `list_dataset_data_json`, `create_dataset_json`,
  `get_client_info_json` (client + default dataset — a liveness check).
- Workspace UI: `open_cognee_workspace`, `upload_file_ui`, `visualize_graph_ui`.

## Rules for working in the shared context

- **The project dataset is `ryadom`.** Write all facts, decisions and findings about the Ryadom project with
  `dataset_name="ryadom"` (it is created on the fly). Personal drafts go to the default agent dataset or with
  `session_id` (session cache).
- **Recall before work:** for questions like "how is it built / what did we decide / where does it live" first run
  `recall(query=..., datasets="ryadom")` — cheaper than walking the codebase. But recall returns a synthesis, not exact
  code: always read the real files before editing.
- **Remember after work:** non-trivial decisions, pitfalls, agreements — `remember(data=..., dataset_name="ryadom")`.
  Write facts, with links to files/pods/dates.
- The current set of datasets — only via `list_datasets_json`, not from notes.
- Do not touch other datasets (not `ryadom`) without a request — other projects may live on the server too.

## Known traps

- MCP `remember` may time out on the client (-32001), but the server still PROCESSES the request. Check the dataset
  before retrying, otherwise you get duplicates.
- `HTTP 404: Could not find session` — the mcp-remote SSE session went stale (pod/ingress restart). Fix: restart the
  client session.
- MCP recall forcibly routes to completion strategies, ignoring `search_type=CHUNKS`; for raw chunks use REST
  `POST /api/v1/search`.
- Dedup by content hash: re-uploading an unchanged file is skipped.
- Code indexing: `.py` → CODE route (fast, but weak semantic search); a `.txt` suffix in the filename → TEXT route
  (chunks + embeddings, slow, good quality).

## Security rules

- Never index `.env`, secrets, kubeconfigs or keys: the kubeconfig and registry keys the administrator keeps locally
  are off limits for remember/add.
- MCP credentials only through the env `COGNEE_MCP_USER`/`COGNEE_MCP_PASS`: do not hardcode, commit or index them.

## Diagnostics

- 401 on SSE — the env credentials are missing or wrong in the environment the client is launched from.
- 502/503 — the pod is warming up (3–4 min) or crashed; logs are checked by whoever administers the deployment.
- The MCP responds but the tools fail with 401 — the MCP→API service token expired; escalate to the deployment admin.
