# Writulos Auto-Docs — GitHub Action

Automatically generate **markdown documentation** for every changed code file in your repository, powered by [Writulos Scribe](https://scribe.writulos.com).

- **On push to main/master** → docs are committed directly to your `docs/` folder
- **On pull requests** → docs for the changed files are committed to the PR branch, and any file whose existing docs are behind the code gets an inline drift warning
- **PR review mode** → opens a pull request with docs so your team can review before merging

---

## Quick start

Add this workflow file to your repository at `.github/workflows/writulos-docs.yml`:

```yaml
name: Writulos Auto-Docs

on:
  # Optional "Run workflow" button that documents the whole repo in one go.
  # It costs one generation per file — see "The full-repo scan" below.
  workflow_dispatch:
  push:
    branches: [main, master]
    paths: ['**.js', '**.ts', '**.tsx', '**.jsx', '**.py', '**.java', '**.kt', '**.scala', '**.go', '**.rb']
  pull_request:
    paths: ['**.js', '**.ts', '**.tsx', '**.jsx', '**.py', '**.java', '**.kt', '**.scala', '**.go', '**.rb']

jobs:
  docs:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          # Full history, so doc-drift can count commits since each doc.
          fetch-depth: 0
      - uses: writulos/scribe-action@v1
        with:
          writulos_api_key: ${{ secrets.WRITULOS_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Ceiling on how many files one run may document, at one generation
          # each. Mostly a guard on the manual full-repo scan above.
          max_files: '25'
```

Get your API key from [scribe.writulos.com/dashboard/api-keys](https://scribe.writulos.com/dashboard/api-keys).

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `writulos_api_key` | ✅ | — | Your Writulos API key. Authenticates every doc generation request. |
| `github_token` | ✅ | — | Pass `secrets.GITHUB_TOKEN`. Used to commit docs and post PR comments. |
| `mode` | ❌ | `commit` | `commit` — push docs to branch. `pr` — open a PR for review. `comment` — post a PR comment only. |
| `file_extensions` | ❌ | `js,ts,jsx,tsx,py,java,kt,scala,go,rb` | Comma-separated extensions to document (no dots). |
| `output_dir` | ❌ | `docs` | Directory to write generated `.md` files into. |
| `max_files` | ❌ | _unset_ | Most files one run may document, at one generation each. Unset leaves push and PR runs uncapped and [refuses a full-repo scan](#the-full-repo-scan-and-what-it-costs) of more than 25 files. `0` lifts the cap entirely. |
| `fail_on_drift` | ❌ | `org` | What a stale doc does to the job. `org` follows your account's setting: the team's switch on a team, the toggle on your Drift page on a solo plan (off until you turn it on, except Business, where it starts on). `true` fails this repo's job on stale docs, on Pro and Business; on Free it warns and stays advisory. `false` never fails this repo's job. Accurate detection needs `actions/checkout` with `fetch-depth: 0`. |
| `api_url` | ❌ | `https://scribe.writulos.com/api/action-generate` | Override only if self-hosting. |

---

## The full-repo scan, and what it costs

Adding `workflow_dispatch:` to your workflow gives you a **Run workflow** button
that documents *every* matching file in the repo. It is worth running once, when
you first install the action and want your existing code covered.

**Every file costs one generation from your monthly quota** — 20 on the free
plan, 200 per developer on Pro and 500 on Business, pooled across a team. On a
200-file repo, an uncapped scan spends a full Pro month for one developer in a
single click.

So the action refuses to start an uncapped scan of more than **25 files**. It
stops before sending anything, spends nothing, and tells you what the run would
have cost:

```
Writulos: refusing to run. This full-repo scan would document 159 files -- one
generation each -- and `max_files` is not set.
```

Name a number and the scan runs:

```yaml
- uses: writulos/scribe-action@v1
  with:
    writulos_api_key: ${{ secrets.WRITULOS_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    max_files: '25'   # document 25 files this run, then stop
```

Re-run to take the next batch, or set `max_files: '0'` to lift the cap once you
know the bill. Files are capped in directory order, and a capped run says which
ones it skipped.

Two things the guard deliberately leaves alone:

- **Push and pull-request runs.** They only ever document the files that
  actually changed, so they are never refused — though `max_files` still caps
  them if you set it.
- **`mode: comment`.** It generates nothing and costs nothing, so it is never
  refused. It is the cheapest way to see exactly which files a scan would cover.

If a run does exhaust your quota partway through, every doc generated before
that point is still committed. You never pay for generations you don't receive.

---

## Doc drift

Every doc this action writes is stamped with the commit it was generated from
(an HTML comment at the top of the file, invisible in rendered markdown). On
each run the action counts how many commits have touched the source file since
that point, and reports it two ways:

- **On pull requests**, a changed file whose docs are behind gets an inline
  `::warning::` annotation naming the file and the number of commits. On Pro
  and Business, `fail_on_drift: true` (or the gate switch in your dashboard,
  which the default `fail_on_drift: org` follows) turns that into a failing
  check. Free stays advisory.
- **In your dashboard**, each documented file shows "Up to date",
  "N commits ago", or "Unknown".

Counting commits needs the repository's history, so check out with
`fetch-depth: 0`. Without it the action cannot measure drift and reports
"Unknown" — it will never quietly claim a stale doc is up to date.

Whether a run may fail is decided by your plan on our servers, not by the
workflow file, so editing the YAML cannot switch the gate on. The check can stop
a merge; it cannot stop a push, because an Action only runs after the push has
landed.

---

## Modes

### `mode: commit` (default)
Docs are committed directly to the current branch under `docs/`. Best for solo projects or when you trust automated commits.

### `mode: pr`
Docs are committed to a new `writulos/docs-*` branch and a pull request is opened for review. Best for teams that want to approve docs before merging.

### `mode: comment`
No files are written. A PR comment is posted listing what would be documented. Useful for a dry run.

---

## How it works

1. On every push or PR, the action runs `git diff` to find changed source files.
2. Each changed file is sent to the Writulos API (`/api/action-generate`) authenticated with your API key.
3. Writulos Scribe writes structured markdown documentation for it.
4. Docs are delivered based on the configured `mode`.

Doc paths mirror your source tree:
```
src/utils/auth.ts   →   docs/src/utils/auth.md
api/generate.js     →   docs/api/generate.md
```

---

## Supported file types

`.js` `.ts` `.jsx` `.tsx` `.py` `.java` `.kt` `.scala` `.go` `.rb`

Add more by passing `file_extensions: 'js,ts,py,rs,cpp'` to the action.

---

## Local testing

`run.js` reads GitHub's own environment variables, so set those to simulate a
run:

```bash
cd action
npm install
CHANGED_FILES="src/utils/auth.ts,api/generate.js" \
WRITULOS_API_KEY="your-api-key" \
GITHUB_TOKEN="your-github-token" \
GITHUB_EVENT_NAME="push" \
GITHUB_REPOSITORY="your-org/your-repo" \
GITHUB_REF="refs/heads/main" \
GITHUB_WORKSPACE="$(pwd)/.." \
node run.js
```

To exercise the full-repo scan without spending any quota, set
`GITHUB_EVENT_NAME="workflow_dispatch"` and `WRITULOS_MODE="comment"` — it lists
the files it would document and generates nothing. Add `WRITULOS_MAX_FILES` to
try the cap.

---

