---
name: commit
description: Commit and open a pull request in the Ryadom repository — a branch in your own worktree, checks, what must not end up in the index, a diff check before pushing to the public repository, a message in the accepted style, a PR to main via gh. Use when asked to "commit", "push", "open a PR", "prepare the changes", and before any push.
---

# Commits and pull requests

The repository `playa69/ryadom` is **public**: everything that lands in commits and PRs is visible to everyone. Changes
go into `main` only through a PR; the user merges and rolls out.

## Branch

- Your own branch from a fresh `origin/main` in **your own worktree**:
  `git worktree add -b <branch> ../ryadom-<topic> origin/main`. Other agents work in the shared directory: do not
  switch branches there and do not commit anything there.
- Names: `app/…`, `agent/…`, `deploy/…`, `fix/…`, `docs/…`; for a Multica issue, include its number
  (`agent/PROTEUS-138-robovoice`).
- Never push to `main`, never force-push, and never rewrite history (including your own commits that are already
  pushed).

## Before committing

1. **Specification.** If behavior changes — an OpenSpec change (skill `openspec`); in tests and the PR — the OpenSpec
   requirement and `REQ-…`, if there is one. While `openspec/specs/` does not exist, the source of truth is the code in
   `main`: report a mismatch between the spec and the code in the PR, do not silently fix either one.
2. **Checks** — skill `local-dev` (typecheck and tests of app, pytest of the agent, prettier on changed files).
   If you changed `.agents/skills/` — run `node scripts/sync-agent-skills.mjs` and include the copies in
   `.claude/skills/` in the same commit.
3. **What goes into the commit** — read `git status` and `git diff --staged` in full. Never:
   - `.playwright-mcp/`, `screenshots/` in the root, `.turbo/`, `app/e2e/report`, `test-results`, dumps of logs and
     databases;
   - files with secrets and keys (`.env*` except `.env.example`, kubeconfig, registry and cloud keys) — even if git
     does not ignore them;
   - `docs/private/`;
   - contents of people's conversations from production (work, places, close people, verbatim phrases): in tests and
     examples use synthetic data.
   Do not touch what someone else has in the index (another session): commit only your own paths,
   `git commit -F <file> -- <paths>`.
4. **Public diff.** Before `git push` and `gh pr create`:

   ```bash
   git diff origin/main...HEAD | grep -nE '^\+.*(192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+|@gmail\.|@yandex\.|phx_|sk-lf-|pk-lf-|PRIVATE KEY|password=)'
   ```

   Remove what is found: internal node addresses, people's email addresses, keys, names of payment accounts. Do not
   describe how secrets are stored in the repository: "kept locally by the administrator"; names of Secrets and their
   keys are allowed.

## Message

`<type>(<scope>): <what was done>` — type `feat`, `fix`, `refactor`, `docs`, `deploy`, `chore`; scope `agent`, `app`,
`api`, `web`, `ui`, `k8s`; write the description in Russian, one logical change per commit, in the body — why and how
it was verified. Examples from history (in Russian): `feat(agent): зацепка в каждом ответе и длина по содержанию`,
`deploy(agent): образ 0.7.0 — без шаблонов, переспрос модели, новый промпт (#45, #47); ранбук`.

**No tool attribution lines**: no `Co-Authored-By: Claude …` and no "Generated with …" in commits and PRs.

## Pull request

```bash
git push -u origin <branch>
gh pr create --repo playa69/ryadom --base main --head <branch> --title "<same as the commit>" --body-file <file>
```

Pass the text as a file (Cyrillic in arguments breaks). In the description: what and why, `REQ-…`, how it was verified
(commands and result), risks, database migrations, new environment variables (names only), whether changes in `k8s/`
are needed, a link to the issue. Answer review comments in the same branch and the same PR. Screenshots — skill
`screenshots`.

Related: [[local-dev]] — checks; [[deploy]] — `deploy/*` branches and rollout.
