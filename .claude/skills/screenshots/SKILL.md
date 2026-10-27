---
name: screenshots
description: Take screenshots of Ryadom screens (web, PWA, admin panel, landing site) on a running environment — only the needed screens and widths, with a layout glitch check, a before/after comparison, and attachments to an issue or PR. Use when asked to "show screenshots", "make a report with screenshots", "how does this look on a phone", "compare before and after", and before reporting a UI change.
---

# Screenshots

Screenshots are taken not by hand in a browser but by `app/e2e/scripts/ui-shots.mjs`: for each screen and width it opens
a clean context, brings the screen up, waits, checks the layout for glitches (page wider than the window, truncated
text, overlaps, empty screen) and only then takes the shot. Screens are described in `app/e2e/scripts/shots/<app>.mjs`
(`web`, `mobile`, `admin`, `landing`): a new screen is added there, next to similar ones.

## How many to take

- **A change made during a task** — only the screens it changes, at two widths: 390 (phone) and 1280 (desktop). That
  takes minutes, not half an hour.
- **Final report** (the user asks "is it done?", the PR goes to merge) — the affected screens at all four widths
  (390, 820, 1280, 1920) or the full set (below).
- **New visual feature** — the user scenario step by step, as in the spec: initial state, action, result, plus the
  empty state and the error if they are in the spec. One shot per step, 390 and 1280, named
  `NN-<step>.png` (for example `01-diary-empty.png`), with a caption for each — what the user sees. Steps that cannot
  be reached through `ui-shots.mjs` are shot by the feature's Playwright test (`page.screenshot` after the step's
  `expect`). Android — only if the task changes the native part (widget, notifications, plugins). Synthetic data only.
- **Video** — only if asked for.

## Environment and sign-in

A running dev environment is needed: `pnpm dev` (skill `local-dev`) or your own environment on other ports. Addresses
are passed with flags: `--base` (the app), `--agent` (the agent mock), `--mail` (Mailpit). From the `app/` directory:

```bash
# once per environment: demo account «Женя» with a conversation journal; the session is saved to .playwright-mcp/web-state.json
node e2e/scripts/demo-account.mjs --base http://localhost:3003 --mail http://localhost:8026 --agent http://127.0.0.1:8080
node e2e/scripts/ui-shots.mjs --app mobile --login --base http://localhost:5174       # logs in with the same demo account
node e2e/scripts/ui-shots.mjs --app admin --login --base http://localhost:3001 --mail http://localhost:8026
```

(The ports in the examples are the dev environment from `local-dev`: landing 3000, admin 3001, web 3003, PWA 5174,
Mailpit 8026, mock 8080. Your own environment has its own addresses.)

## Taking a shot

```bash
node e2e/scripts/ui-shots.mjs --app web --base http://localhost:3003 --agent http://127.0.0.1:8080 \
  --screens home,profile --widths 390,1280 --out ../screenshots/after
node e2e/scripts/ui-shots.mjs --app mobile --base http://localhost:5174 --agent http://127.0.0.1:8080 --screens home,dialog
```

Files are named `<app>-<screen>-<width>.png` and go by default into `screenshots/` in the repository root (it never
ends up in git). Under each shot's name the script prints the glitches it found; `--strict` does not save a shot with a
glitch, exit code 1 — there were glitches or a screen did not open. A glitch is a reason to fix the layout before the
report, not a caption under the screenshot.

Screens: web — `home`, `dialog`, `dialog-voice`, `dialog-summary`, `journal`, `journal-entry`, `profile`, `people`,
`sos`, `menu`, `login`, `register`, and others; mobile — `welcome`, `home`, `dialog`, `dialog-end`, `journal`,
`profile`, `people`, `sos`, and others; admin — `login`, `users`, `user-card`, `audit`; landing — `home`, `privacy`,
`terms`, `download`, `delete-account`. The full list is the `screens` keys in `shots/<app>.mjs`.

## Before and after

```bash
node e2e/scripts/ui-shots.mjs --app web … --screens home --out /tmp/shots-before   # before the change
node e2e/scripts/ui-shots.mjs --app web … --screens home --out /tmp/shots-after    # after
node e2e/scripts/ui-diff.mjs --a /tmp/shots-before --b /tmp/shots-after --out /tmp/shots-diff
```

`ui-diff.mjs` prints by what percentage each image changed and writes `<name>-diff.png` with the changed pixels. A
refactoring that must not change the look — about 0 %; anything a person will notice — a few percent.

## Full set

For a final review of the whole interface — `node e2e/scripts/review-shots.mjs` (PWA and landing site) and
`node e2e/scripts/review-web-shots.mjs` (web) into `review/`. They need the e2e environment
(`node e2e/scripts/stack.mjs`, skill `e2e`); they shoot everything and take a long time — not for every change.

## In the report

- Multica issue: `multica issue comment add <ID> --content-file report.md --attachment shot1.png --attachment shot2.png`
  (files outside the current directory — with `--allow-external-file`).
- PR: post the images as a comment with `gh pr comment --body-file`; keep the files in a separate orphan branch
  `assets/pr-<N>-screenshots`, not in the PR branch.
- Show only the screens that changed and caption what is on each one and at what width. Before sending, look at the
  shots yourself: a Next dev server overlay or a screen that has not finished loading is not an "after" screenshot.

Related: [[e2e]] — the e2e environment and the full run; [[local-dev]] — the dev environment and sign-in.
