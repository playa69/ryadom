---
name: openspec
description: The one skill for OpenSpec in the Ryadom repo — decide whether a change is needed, explore an idea, propose a change (proposal, delta specs, design, tasks), implement its tasks, revise it, validate and archive it; repo conventions (code in main is the source of truth for now, one issue = one change, the surfaces line, tasks.md with acceptance lines and a verification section with step screenshots) and the CLI. Use when a task adds or changes behavior a person sees or a client ↔ API ↔ agent contract, names an OpenSpec change or a path under openspec/, asks what the spec says, or asks to propose, apply, update or archive a change.
---

# OpenSpec

`openspec/` describes what the product does: behavior a person sees and the contracts between clients, the API and
the agent. How the code is built goes to `design.md` and `tasks.md`, not to specs.

## Layout

- `openspec/specs/<capability>/spec.md` — how the product works now, one folder per capability. Only archiving a
  change writes here; never edit by hand.
- `openspec/changes/<change>/` — a change in progress: `proposal.md` (why and what changes), `design.md` (decisions
  and open questions; small changes can skip it), `specs/<capability>/spec.md` (the delta), `tasks.md` (steps),
  `mockups/` (UI, before code).
- `openspec/changes/archive/<YYYY-MM-DD>-<change>/` — rolled-out changes: the history of why things are the way they
  are.
- `openspec/config.yaml` — project context and per-artifact rules; the CLI hands them to any agent.

## Code in main is the source of truth for now

No change has been archived yet, there is no `openspec/specs/`, and the old changes have drifted from the code. Until
the baseline is captured from code and archived:

- Trust the code in `main`. Where a spec contradicts the code, the code wins; name the mismatch in the report and PR.
- Do not trust `- [x]` in `tasks.md`: check that the code is in `main`.
- Do not use `add-agent-service` and `add-app-client-specs` as requirements (outdated, the baseline will replace
  them), nor anything about the removed `backend/`.
- In a new change write ADDED requirements for the behavior it introduces or changes, in a capability named after the
  product domain. Do not write MODIFIED or REMOVED against requirements that live in another change's folder.
- Once the baseline exists, open changes are rebased: an ADDED requirement whose name is already in `openspec/specs`
  becomes MODIFIED.

## When a change is needed

- A change is needed when behavior a person or a client sees changes: a new feature, changed or removed behavior, a
  changed client ↔ API ↔ agent contract. A bug fix that restores described behavior, refactoring and config cleanup
  go without one.
- One issue — one change — one branch. Name: a verb phrase in kebab-case (`add-mood-diary`, `restrict-memory-health`).
- The first line of `proposal.md` is `Задача: PROTEUS-NNN` when there is an issue; the issue links to the change
  folder.
- New feature or changed behavior: proposal, delta, tasks and, for UI, mockups first; show them to the user and wait
  for an explicit "yes", then code in the same branch.

Update the current change or start a new one:

- Same goal, the execution got clearer (scope narrowed, the design did not work, the owner corrected it), and the
  change is not archived yet — edit the current change.
- A new goal, or the current change is already rolled out and archived — a new change.
- Never edit an archived change or `openspec/specs` by hand.

## CLI

The CLI is not in the repo dependencies yet: run the version these files were made with, from the repo root.

```bash
npx -y @fission-ai/openspec@1.9.0 <command>
```

| Command | What it does |
|---|---|
| `list`, `list --specs` | changes in progress, capabilities |
| `show <name> --json --no-interactive` | one change or spec |
| `new change <name>` | change skeleton with `.openspec.yaml` |
| `status --change <name>` | which artifacts are done |
| `instructions <artifact> --change <name>` | template, schema guidance, project context and our rules for `proposal`, `specs`, `design` or `tasks` |
| `instructions apply --change <name>` | files to read and task progress for implementation |
| `validate <name> --strict`, `validate --all --strict` | format check |
| `archive <name> --yes` | merge the deltas into `openspec/specs` and move the change to `archive/` |

Agents do not answer CLI prompts: always pass names explicitly, plus `--yes` or `--no-interactive`. Do not run
`openspec init` or `openspec update`: they generate a separate skill per operation into `.agents/skills/`, and this
repo keeps this one skill instead.

## Explore

Thinking before a proposal: read the code in `main`, open changes (`list`, `show`) and `docs/spec.md`, ask questions,
compare options. Write no files and no code. When the idea settles, suggest proposing a change.

## Propose

1. Clarify what should change. Ask when the answer affects scope, visible behavior, compatibility or acceptance;
   record minor assumptions in the proposal.
2. Check for overlap: `list` and `git grep -n "Requirement: <name>" openspec/`. A change with that name already
   exists — ask whether to continue it.
3. `new change <name>`.
4. For `proposal`, `specs`, `design`, `tasks` in this order: run `instructions <artifact> --change <name>` and write
   the file it names by its template and rules. The `<project_context>` and `<rules>` blocks are constraints for you;
   do not copy them into the file. Re-read the artifacts already written from disk before the next one.
5. `status --change <name>` shows every artifact done; `validate <name> --strict` passes.
6. Stop. Show the artifacts to the user and wait for an explicit "yes" before any code: a request to propose is not
   a request to implement.

## Apply

1. `instructions apply --change <name>`; read the proposal, design, delta specs and tasks it lists.
2. Task by task: code and tests, then `- [ ]` → `- [x]` in the same commit as the task's code. A commit or PR with
   only the spec ticks nothing.
3. Tick only fully implemented behavior. Stop and ask when a task is unclear, the design does not work (update the
   change first), the work grows beyond the spec, or you are tempted to narrow or defer specified behavior.

## Update a change

- Edit planning artifacts only, never code. After the requested edit, check every other artifact against it in any
  direction (a tasks edit can require a proposal edit) and fix contradictions, gaps and duplicates.
- A revision that changes behavior or scope needs the user's "yes", like a new proposal.
- The change is already implemented — after the revision, carry the difference into code (Apply).
- The goal itself changed — start a new change instead.

## Delta

Write the text in Russian with English keywords (SHALL, MUST, WHEN, THEN), as in the existing changes:

```markdown
## ADDED Requirements

### Requirement: Запоминание по просьбе
Агент SHALL сохранять заметку, только когда человек попросил запомнить.
Поверхности: agent · api · web · pwa

#### Scenario: Человек попросил запомнить
- **WHEN** человек говорит «запомни, что у меня кот Барсик»
- **THEN** на экране «Память» появляется заметка «Живёт с котом Барсиком»

#### Scenario: (PWA) Заметка видна без перезагрузки
- **WHEN** …
- **THEN** …
```

- **ADDED** — a new requirement.
- **MODIFIED** — copy the requirement from `openspec/specs` whole and edit it: the text and every scenario that stays.
  Whatever you leave out is lost on archive. If `validate` rejects a MODIFIED without one of the scenarios — REMOVED
  plus ADDED under a new name.
- **REMOVED** — the requirement name plus `**Reason**:` and `**Migration**:` lines.
- **RENAMED** — `FROM:` and `TO:` lines.
- **Name** — the `### Requirement:` name is the key for MODIFIED, REMOVED and RENAMED: do not change it without need.
- **Form** — one sentence with SHALL or MUST and at least one `#### Scenario:` (four `#`) with **WHEN** and **THEN**.
- **Surfaces** — every requirement has a `Поверхности:` line listing only what it touches: agent, api, web, pwa,
  android, ios, tg, admin, landing. A scenario for one surface starts with it in brackets: `(PWA)`, `(Android)`.
- **Capability** — named after the product domain (`memory-notes`, `dialog`, `account-deletion`), not a service.
  Check `openspec/specs` and open changes before adding a new one.
- **Before MODIFIED** — `git grep -n "Requirement: <name>" openspec/`. If another open change modifies the same
  requirement, say so in both issues; whoever archives second moves their block onto the updated spec.
- **Weight** — as light as possible while still verifiable. No file paths, class or library names in requirements.
- **docs/spec.md** holds product requirements (`REQ-…`): cite their numbers in the proposal, do not copy scenarios
  there.

## tasks.md

- Sections in this order, skip the ones not needed: 0 Решения (questions for the owner) → 1 Данные и контракты →
  2 Агент → 3 Шлюз API → 4 Клиенты по поверхностям → 5 Проверка → 6 Выкат → 7 Архив.
- Every task has real paths and a `Приёмка:` (acceptance) line.
- The «Проверка» (verification) section covers every scenario: unit or integration test file; e2e file and project
  (desktop, mobile); screenshots; manual checks (Android, iOS, Telegram); post-rollout checks (`k8s/postdeploy`).
- A test carries a comment with the change and the requirement: `` `openspec/changes/<change>`, «<requirement>» ``.
- Screenshots of a visual feature — skill `screenshots`: one shot per scenario step, widths 390 and 1280, no video,
  synthetic data only.

## Archive

Only when the code is in `main` and rolled out; if the feature sits behind a flag, the requirement says so.

1. Every task is `[x]` or marked `→ <other change>` or `снято` (dropped) with a reason.
2. Open questions in `design.md` are closed.
3. `validate <change> --strict` passes.
4. `archive <change> --yes` merges the deltas into `openspec/specs` and moves the folder to `archive/`. Check
   `git diff openspec/specs`: MODIFIED replaces whole requirements, nothing you meant to keep should disappear. Then
   `validate --specs --strict`.
5. Commit in the rollout PR or right after the rollout. The issue closes after that.

Deltas reach `openspec/specs` only through archive: do not merge them into specs by hand before. An abandoned change is
deleted, not archived: archive means "rolled out".

Related skills: `screenshots` (step shots), `e2e` (tests in the verification section), `commit` (ticks and PR).
