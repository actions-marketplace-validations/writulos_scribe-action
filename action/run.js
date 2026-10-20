'use strict';
const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');

// Composite actions do NOT auto-populate INPUT_* for `run:` steps — action.yml
// forwards its inputs as WRITULOS_*-prefixed env vars, which are the primary
// names here. INPUT_* stays honored for anyone invoking run.js directly with
// that convention. (Reading only INPUT_* was why every action run exited 1
// with "writulos_api_key is not set".)
const API_URL     = process.env.INPUT_API_URL              || process.env.WRITULOS_API_URL         || 'https://scribe.writulos.com/api/action-generate';
const OUTPUT_DIR  = process.env.INPUT_OUTPUT_DIR           || process.env.WRITULOS_OUTPUT_DIR      || 'docs';
const API_KEY     = process.env.INPUT_WRITULOS_API_KEY     || process.env.WRITULOS_API_KEY         || '';
const GH_TOKEN    = process.env.INPUT_GITHUB_TOKEN         || process.env.GITHUB_TOKEN             || '';
const FILE_EXTS   = (process.env.INPUT_FILE_EXTENSIONS     || process.env.WRITULOS_FILE_EXTENSIONS || 'js,ts,jsx,tsx,py,java,kt,scala,go,rb')
                      .split(',').map(e => e.trim().replace(/^\./, ''));
const MODE        = (process.env.INPUT_MODE                || process.env.WRITULOS_MODE            || 'commit').toLowerCase();
// What the workflow ASKS for. What it GETS is decided by the server — see
// `mayFailOnDrift` below. Three values:
//   'org'   (default) follow the account's own setting — the team's switch on
//                     a team, the Drift page toggle on a solo plan.
//   'true'            fail this repo's build on stale docs. Honoured on Pro and
//                     Business; warns and stays advisory on Free.
//   'false'           never fail this repo's build, whatever the plan allows
const FAIL_ON_DRIFT_INPUT = (process.env.INPUT_FAIL_ON_DRIFT || process.env.WRITULOS_FAIL_ON_DRIFT || 'org').toLowerCase();
// Ceiling on how many files one run may document. Deliberately tri-state:
//   unset / ''  -> not configured; a large full-repo scan is refused up front
//   '0'         -> explicitly uncapped ("document everything, I mean it")
//   'N' (N > 0) -> document at most N files in this run
// Telling "left at the default" apart from "deliberately set to 0" is what
// lets the full-scan guard in main() fail loudly and for free, instead of
// silently spending a whole monthly quota and then dying on a 429.
const RAW_MAX_FILES = (process.env.INPUT_MAX_FILES || process.env.WRITULOS_MAX_FILES || '').trim();
const MAX_FILES_SET = RAW_MAX_FILES !== '';
const MAX_FILES     = MAX_FILES_SET ? Number.parseInt(RAW_MAX_FILES, 10) : 0;

// One file documented = one generation = one unit of the caller's monthly
// quota — and on a team, of the whole org's shared pool. A workflow_dispatch
// run documents EVERY
// matching file in the repo, so past this many files we make the caller name
// a number rather than discover the cost after it has been spent.
const FULL_SCAN_CONFIRM_THRESHOLD = 25;

const REPO_NAME   = process.env.GITHUB_REPOSITORY         || '';
const EVENT_NAME  = process.env.GITHUB_EVENT_NAME         || '';
// On pull_request events GITHUB_REF is the synthetic "refs/pull/N/merge" and
// GITHUB_SHA is a throwaway merge commit that lives on no branch. Committing
// docs there fails (GitHub refuses the ref) and stamping docs with that sha
// leaves nothing a later drift lookup can find — so on PRs the real head
// branch (GITHUB_HEAD_REF) and head commit (PR_HEAD_SHA, forwarded by
// action.yml) take precedence.
const REPO_BRANCH = process.env.GITHUB_HEAD_REF
                      || (process.env.GITHUB_REF || '').replace(/^refs\/(heads|tags)\//, '')
                      || 'main';
const COMMIT_SHA  = process.env.PR_HEAD_SHA || process.env.GITHUB_SHA || '';
// On pull_request events, the base ref is the branch being merged into.
const PR_BASE_REF = process.env.GITHUB_BASE_REF          || '';
const PR_NUMBER   = process.env.PR_NUMBER
                      || (process.env.GITHUB_REF
                        ? (process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\//) || [])[1]
                        : null);
const WORKSPACE   = process.env.GITHUB_WORKSPACE          || process.cwd();

// Doc-drift snapshot endpoint is a route on the shared misc function.
const REPO_DOCS_URL = API_URL.replace(/\/action-generate\/?$/, '/misc?route=repo-docs');

// ─────────────────────────────────────────────────────────────────────────────
// What this key is allowed to do.
//
// FAILING A BUILD IS A SERVER DECISION. A workflow file is written by whoever
// can push to the repo, so a plan gate that lived in YAML would be a gate
// anyone could open by editing two words. The runner asks; the server answers;
// the answer is what is obeyed.
//
// The refusal is loud rather than silent. A team that expected red CI and got
// green would find out from a stale doc in production, which is exactly the
// failure this feature exists to prevent — so an unentitled `fail_on_drift:
// true` prints a warning naming the plan that grants it, every run.
// ─────────────────────────────────────────────────────────────────────────────
let ENTITLEMENTS = { plan: null, canFailOnDrift: false, failOnDrift: false, known: false };

/**
 * Ask the server what this key may do. Cheap: `probe=1` short-circuits before
 * any drift records are read.
 *
 * A failure here leaves `known: false`, and an unknown entitlement never fails
 * a build. Refusing to merge because our own API had a bad minute would be a
 * worse outage than a stale doc.
 */
async function loadEntitlements() {
  try {
    const res = await fetch(`${REPO_DOCS_URL}&probe=1`, { headers: { 'x-api-key': API_KEY } });
    if (!res.ok) {
      if (res.status === 402) {
        const body = await res.json().catch(() => ({}));
        console.log(`::warning::Writulos: ${body.error || 'this feature needs a paid plan.'}`);
      }
      return;
    }
    const data = await res.json();
    ENTITLEMENTS = {
      plan: data.plan ?? null,
      // Two different questions. `canFailOnDrift` answers `fail_on_drift:
      // true`; `failOnDrift` answers the default when the workflow said
      // nothing — which only a team, with its org-wide switch on, says yes to.
      canFailOnDrift: data.canFailOnDrift === true,
      failOnDrift: data.failOnDrift === true,
      known: true,
    };
  } catch (e) {
    console.log(`Writulos: could not read plan entitlements (${e.message}); drift will be advisory this run.`);
  }
}

/** May this run fail the build on stale docs? Workflow asks, plan decides. */
function mayFailOnDrift() {
  // An explicit no always wins. A repo that genuinely cannot be blocked needs
  // a way out that does not mean disabling the gate for a whole organisation.
  if (FAIL_ON_DRIFT_INPUT === 'false') return false;

  // An explicit yes, honoured if the plan allows it.
  if (FAIL_ON_DRIFT_INPUT === 'true') {
    if (ENTITLEMENTS.canFailOnDrift) return true;
    if (ENTITLEMENTS.known) {
      console.log(
        '::warning::Writulos: fail_on_drift is set, but failing a build on stale docs needs a Pro or Business plan. ' +
        'Drift is still measured and annotated on this plan. See https://scribe.writulos.com/pricing'
      );
    }
    return false;
  }

  // Default ('org'): follow the account's own switch. The server has already
  // applied each plan's default — on for Business, which is bought for the
  // gate; off for everyone else until they flip it — so the gate is never
  // switched on for someone who did not ask. That is the whole reason this is
  // not simply `canFailOnDrift`.
  return ENTITLEMENTS.failOnDrift === true;
}

const OUTPUT_DIR_ABS = path.resolve(WORKSPACE, OUTPUT_DIR);
const EXTS = new Set(FILE_EXTS);

// --- Doc-drift helpers (Phase 1A) ------------------------------------------

// Metadata is embedded as an HTML comment at the top of each doc so it does not
// affect rendered markdown, but can be parsed back to recover the commit a doc
// was generated at.
function buildDocMetaHeader(filePath, sha) {
  const meta = { filePath, generatedAtCommitSha: sha, generatedAt: new Date().toISOString() };
  return `<!-- writulos:meta ${JSON.stringify(meta)} -->\n\n`;
}

function parseDocMeta(content) {
  const m = content.match(/<!--\s*writulos:meta\s*(\{[\s\S]*?\})\s*-->/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// A commit as git prints it, the same check public/pre-push.sh applies to
// the same header field.
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

// Count commits that touched `filePath` in the range `<sinceSha>..<untilRef>`.
// Returns a non-negative integer, or null if git can't answer (shallow clone,
// unknown sha, etc.) so callers can degrade gracefully.
//
// The sha comes from a doc's writulos:meta header and the path from a file's
// name, both written by whoever's commit was merged, so git gets them as
// arguments and never through a shell. As one command string, either was
// enough to run a command on a runner holding the API key and a write token.
function gitDriftCount(sinceSha, untilRef, filePath) {
  if (typeof sinceSha !== 'string' || !COMMIT_SHA_RE.test(sinceSha)) return null;
  try {
    const out = execFileSync(
      'git', ['rev-list', '--count', `${sinceSha}..${untilRef}`, '--', String(filePath)],
      { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

if (!API_KEY) {
  console.error('Writulos: writulos_api_key is not set. Add WRITULOS_API_KEY as a GitHub secret.');
  process.exit(1);
}
if (!GH_TOKEN) {
  console.error('Writulos: github_token is not set.');
  process.exit(1);
}
if (MAX_FILES_SET && (!Number.isInteger(MAX_FILES) || MAX_FILES < 0)) {
  // Never coerce a typo to 0 — that would read as "uncapped, go ahead".
  console.error(`Writulos: max_files must be a whole number >= 0 (got "${RAW_MAX_FILES}").`);
  process.exit(1);
}

function getAllFiles(dir, root) {
  root = root || dir;
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== OUTPUT_DIR) {
        results = results.concat(getAllFiles(fullPath, root));
      }
    } else if (entry.isFile()) {
      // A link is neither: generateDoc refuses one, so a scan never counts it.
      const ext = entry.name.split('.').pop();
      if (ext && EXTS.has(ext)) results.push(path.relative(root, fullPath));
    }
  }
  return results;
}

const GH_HEADERS = {
  Authorization: `Bearer ${GH_TOKEN}`,
  'Content-Type': 'application/json',
  Accept: 'application/vnd.github+json',
  'User-Agent': 'writulos-action',
  'X-GitHub-Api-Version': '2022-11-28',
};

/**
 * Where a source file's doc goes: its path under OUTPUT_DIR, as .md. The path
 * is a file's name in the repository, so it decides where a token that can
 * write to the repository writes: null when it would leave OUTPUT_DIR, as a
 * `.` or `..` segment that a backslash in a name makes after path.join has
 * collapsed the literal ones.
 */
function docPathFor(filePath) {
  const docPath = path
    .join(OUTPUT_DIR, filePath.replace(/\.[^.]+$/, '.md'))
    .replace(/\\/g, '/');
  if (docPath.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  const base = path.posix.normalize(OUTPUT_DIR.replace(/\\/g, '/')).replace(/\/+$/, '');
  return base === '.' || docPath.startsWith(`${base}/`) ? docPath : null;
}

/**
 * A file the runner may read and upload: a regular file whose real path is
 * inside the checkout and outside .git. A name comes from the repository, and
 * a symlink, or a path through a linked directory, would upload whatever it
 * points at: another file on the runner, or the checkout's credentials.
 */
function isCheckoutFile(absPath) {
  try {
    if (!fs.lstatSync(absPath).isFile()) return false;
    const rel = path.relative(fs.realpathSync(WORKSPACE), fs.realpathSync(absPath));
    if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
    return rel.split(path.sep)[0] !== '.git';
  } catch {
    return false;
  }
}

async function commitFileToBranch(docPath, content, branch = REPO_BRANCH) {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  // One segment at a time: a name may hold `%2e%2e`, `#` or `?`, which the
  // URL parser fetch applies would read as `..`, a fragment or a query, and
  // send the write somewhere other than the doc's own path.
  const apiPath = `https://api.github.com/repos/${REPO_NAME}/contents/${docPath.split('/').map(encodeURIComponent).join('/')}`;

  let existingSha = null;
  const getRes = await fetch(`${apiPath}?${new URLSearchParams({ ref: branch })}`, { headers: GH_HEADERS });
  if (getRes.ok) {
    const existing = await getRes.json();
    existingSha = existing.sha || null;
  }

  const putRes = await fetch(apiPath, {
    method: 'PUT',
    headers: GH_HEADERS,
    body: JSON.stringify({
      message: `docs: auto-generate documentation for ${docPath} [writulos]`,
      content: encoded,
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
      committer: { name: 'Writulos Bot', email: 'action@writulos.com' },
    }),
  });

  if (!putRes.ok) {
    console.error(`  [commit error] ${docPath}: HTTP ${putRes.status} -- ${await putRes.text()}`);
    return false;
  }
  console.log(`  [committed] -> ${docPath} on ${branch}`);
  return true;
}

/** Create `branchName` at the current head of REPO_BRANCH (no-op if it exists). */
async function ensureBranch(branchName) {
  const refRes = await fetch(
    `https://api.github.com/repos/${REPO_NAME}/git/ref/heads/${encodeURIComponent(REPO_BRANCH)}`,
    { headers: GH_HEADERS }
  );
  if (!refRes.ok) {
    console.error(`  [branch error] could not resolve ${REPO_BRANCH}: HTTP ${refRes.status}`);
    return false;
  }
  const baseSha = (await refRes.json()).object?.sha;
  if (!baseSha) return false;

  const createRes = await fetch(`https://api.github.com/repos/${REPO_NAME}/git/refs`, {
    method: 'POST',
    headers: GH_HEADERS,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  if (createRes.ok || createRes.status === 422) return true; // 422 = already exists
  console.error(`  [branch error] ${branchName}: HTTP ${createRes.status} -- ${await createRes.text()}`);
  return false;
}

async function openPullRequest(branchName, docCount) {
  const res = await fetch(`https://api.github.com/repos/${REPO_NAME}/pulls`, {
    method: 'POST',
    headers: GH_HEADERS,
    body: JSON.stringify({
      title: `docs: auto-generated documentation [writulos]`,
      head: branchName,
      base: REPO_BRANCH,
      body: `Writulos generated documentation for ${docCount} file${docCount === 1 ? '' : 's'}. Review and merge to publish the docs into \`${OUTPUT_DIR}/\`.`,
    }),
  });
  if (res.ok) {
    const pr = await res.json();
    console.log(`Writulos: opened PR #${pr.number} -> ${pr.html_url}`);
    return true;
  }
  // 422 usually means a PR for this branch already exists — the push above
  // updated it, so that is still a success.
  if (res.status === 422) {
    console.log(`Writulos: PR for ${branchName} already exists; docs updated on that branch.`);
    return true;
  }
  console.error(`  [pr error] HTTP ${res.status} -- ${await res.text()}`);
  return false;
}

/** Post to the PR conversation when we have one, else as a commit comment. */
async function postComment(bodyText) {
  const url = PR_NUMBER
    ? `https://api.github.com/repos/${REPO_NAME}/issues/${PR_NUMBER}/comments`
    : `https://api.github.com/repos/${REPO_NAME}/commits/${COMMIT_SHA}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: GH_HEADERS,
    body: JSON.stringify({ body: bodyText }),
  });
  if (!res.ok) {
    console.error(`  [comment error] HTTP ${res.status} -- ${await res.text()}`);
    return false;
  }
  console.log('Writulos: comment posted.');
  return true;
}

async function generateDoc(filePath) {
  const absPath = path.resolve(WORKSPACE, filePath);
  if (fs.existsSync(absPath) && !isCheckoutFile(absPath)) {
    console.warn(`  [skip] ${filePath} is a link or leads outside the repository`);
    return null;
  }
  let code;
  try { code = fs.readFileSync(absPath, 'utf8'); }
  catch { console.warn(`  [skip] Could not read ${absPath}`); return null; }

  if (!code.trim())          { console.warn(`  [skip] ${filePath} is empty`);      return null; }
  if (code.length > 100_000) { console.warn(`  [skip] ${filePath} is over 100KB`); return null; }

  // Only what the backend actually reads. The repo-scoped GITHUB_TOKEN never
  // belongs in this payload — the API has no use for it.
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      code,
      filename: filePath,
      context: `File from GitHub repository: ${REPO_NAME}`,
    }),
  });

  if (response.status === 429) {
    const data = await response.json();
    return {
      limitReached: true,
      daysLeft:     data.daysLeft || 0,
      isPro:        data.isPro === true || data.showProBanner === false,
      filename:     filePath,
      message:      data.error || 'Monthly generation limit reached.',
    };
  }

  if (!response.ok) {
    console.error(`  [error] ${filePath}: HTTP ${response.status} -- ${await response.text()}`);
    return null;
  }

  const data = await response.json();
  return {
    documentation: data.documentation || null,
    usage:         data.usage         || null,
  };
}

/**
 * PR drift check (Phase 1A): for each changed source file that already has a
 * doc, warn (via GitHub workflow annotations) when the file has commits newer
 * than the commit its doc was generated at. Pure git — no AI, no generation.
 * Returns { stale, unknown }: files whose docs are behind, and files that
 * could not be checked at all (no git history in the checkout).
 */
function runPrDriftCheck(changedFiles) {
  const base = PR_BASE_REF ? `origin/${PR_BASE_REF}` : 'HEAD';
  let stale = 0;
  let unknown = 0;

  for (const filePath of changedFiles) {
    const docPath = docPathFor(filePath);
    if (!docPath) continue;               // a name that leaves OUTPUT_DIR has no doc
    const docAbs = path.resolve(WORKSPACE, docPath);

    let meta = null;
    try { meta = parseDocMeta(fs.readFileSync(docAbs, 'utf8')); }
    catch { continue; }                 // no existing doc → nothing to be stale
    if (!meta?.generatedAtCommitSha) continue;

    const drift = gitDriftCount(meta.generatedAtCommitSha, base, filePath);
    if (drift === null) {
      unknown += 1;
      console.log(`  [drift] ${filePath}: could not compute (shallow clone? run actions/checkout with fetch-depth: 0)`);
      continue;
    }
    if (drift > 0) {
      stale += 1;
      // GitHub renders ::warning file=...:: as an inline annotation on the PR.
      console.log(`::warning file=${filePath}::Docs for ${filePath} are ${drift} commit${drift === 1 ? '' : 's'} behind the code (last documented at ${meta.generatedAtCommitSha.slice(0, 7)}).`);
    }
  }

  // An unchecked file is not an up-to-date file. Say so in the run summary,
  // instead of the reassuring "all up to date" line the old code printed after
  // computing nothing.
  if (unknown > 0) {
    console.log(`::warning::Writulos could not check doc drift for ${unknown} file(s): the checkout has no git history. Use actions/checkout with fetch-depth: 0.`);
  }
  if (stale === 0 && unknown === 0) console.log('Writulos drift check: all changed files are documented up to date.');
  return { stale, unknown };
}

/**
 * After generation, snapshot drift for every doc in OUTPUT_DIR and push the
 * records to the backend so the dashboard can surface "N commits ago" badges.
 * Best-effort: never fails the run.
 */
async function reportDriftSnapshot() {
  let docFiles = [];
  try { docFiles = getAllMarkdownDocs(OUTPUT_DIR_ABS); }
  catch { return; }
  if (docFiles.length === 0) return;

  const head = COMMIT_SHA || 'HEAD';
  const records = [];
  let unknown = 0;
  for (const docAbs of docFiles) {
    let meta;
    try { meta = parseDocMeta(fs.readFileSync(docAbs, 'utf8')); }
    catch { continue; }
    if (!meta?.filePath || !meta?.generatedAtCommitSha) continue;

    const drift = gitDriftCount(meta.generatedAtCommitSha, head, meta.filePath);
    if (drift === null) unknown += 1;
    records.push({
      filePath: meta.filePath,
      docPath: path.relative(WORKSPACE, docAbs).replace(/\\/g, '/'),
      generatedAtCommitSha: meta.generatedAtCommitSha,
      generatedAt: meta.generatedAt || null,
      // null = "could not measure" (shallow clone). The backend and dashboard
      // show that as unknown; coercing it to 0 used to make every stale doc
      // read as "Up to date" the moment the checkout lacked history.
      driftCommits: drift,
      headSha: COMMIT_SHA || null,
    });
  }
  if (records.length === 0) return;
  if (unknown > 0) {
    console.log(`::warning::Writulos: drift is unknown for ${unknown} of ${records.length} doc(s) because the checkout has no git history. Use actions/checkout with fetch-depth: 0 so the dashboard can show how far each doc is behind.`);
  }

  try {
    const res = await fetch(REPO_DOCS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ repo: REPO_NAME, branch: REPO_BRANCH, records }),
    });
    if (res.ok) {
      console.log(`Writulos: drift snapshot updated for ${records.length} doc(s).`);
      // The freshest possible answer: a plan that changed mid-run is reflected
      // by the time the build decides whether to fail.
      const data = await res.json().catch(() => null);
      if (data?.entitlements) {
        ENTITLEMENTS = {
          plan: data.entitlements.plan ?? ENTITLEMENTS.plan,
          canFailOnDrift: data.entitlements.canFailOnDrift === true,
          failOnDrift: data.entitlements.failOnDrift === true,
          known: true,
        };
      }
    } else if (res.status === 402) {
      const body = await res.json().catch(() => ({}));
      console.log(`::warning::Writulos: ${body.error || 'doc-drift tracking needs a paid plan.'}`);
    } else {
      console.log(`Writulos: drift snapshot skipped (HTTP ${res.status}).`);
    }
  } catch (e) {
    console.log(`Writulos: drift snapshot skipped (${e.message}).`);
  }
}

// Collect all .md files under a directory (for the drift snapshot scan).
function getAllMarkdownDocs(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(getAllMarkdownDocs(fullPath));
    else if (entry.name.endsWith('.md')) results.push(fullPath);
  }
  return results;
}

async function main() {
  const isFullScan = EVENT_NAME === 'workflow_dispatch';
  let changedFiles = [];

  if (isFullScan) {
    console.log('Full-repo scan triggered via workflow_dispatch.');
    changedFiles = getAllFiles(WORKSPACE, WORKSPACE);
    console.log(`Found ${changedFiles.length} file(s) to document.`);
  } else {
    // Newline-separated (comma tolerated for older workflows) — commas are
    // legal inside filenames, newlines are not.
    changedFiles = (process.env.CHANGED_FILES || '').split(/[\n,]/).map(f => f.trim()).filter(Boolean);
  }

  if (changedFiles.length === 0) {
    console.log('Writulos: no supported files found. Skipping.');
    return;
  }

  // The full-repo scan is the one path where a single click can spend a whole
  // month of generations, so an uncapped one on a big repo has to be asked for
  // by name. `mode: comment` is exempt: it generates nothing and costs nothing,
  // which makes it the right way to size a scan before paying for it.
  if (isFullScan && MODE !== 'comment' && !MAX_FILES_SET
      && changedFiles.length > FULL_SCAN_CONFIRM_THRESHOLD) {
    console.error(
`Writulos: refusing to run. This full-repo scan would document ${changedFiles.length} files -- one
generation each -- and \`max_files\` is not set.

An uncapped scan of a repo this size can spend a whole month's generations in a
single run. Nothing was sent and no quota was used.

Decide what this run costs by setting \`max_files\`:

    - uses: writulos/scribe-action@v1
      with:
        writulos_api_key: \${{ secrets.WRITULOS_API_KEY }}
        github_token: \${{ secrets.GITHUB_TOKEN }}
        max_files: '${FULL_SCAN_CONFIRM_THRESHOLD}'   # document this many, then stop
        # max_files: '0'  # no cap -- documents all ${changedFiles.length} files

Push and pull_request runs are unaffected; they only ever document the files
that actually changed. To list what a scan would cover without spending
anything, set \`mode: comment\`.`
    );
    process.exit(1);
  }

  // Before anything decides whether it may fail a build.
  await loadEntitlements();
  if (ENTITLEMENTS.known && ENTITLEMENTS.plan) {
    console.log(
      `Writulos: ${ENTITLEMENTS.plan} plan, drift ${mayFailOnDrift() ? 'FAILS the build' : 'is reported as annotations'}.`,
    );
  }

  if (MAX_FILES > 0 && changedFiles.length > MAX_FILES) {
    const skipped = changedFiles.length - MAX_FILES;
    // ::warning:: so the skipped files show up in the run summary rather than
    // only in the log body, where a partial result reads as a complete one.
    console.log(`::warning::Writulos documented the first ${MAX_FILES} of ${changedFiles.length} file(s); ${skipped} skipped by max_files. Raise max_files to document more.`);
    changedFiles = changedFiles.slice(0, MAX_FILES);
  }

  if (isFullScan && MODE !== 'comment') {
    console.log(`Writulos: this run will use ${changedFiles.length} generation(s) from your monthly quota.`);
  }

  // PR drift check runs against the docs as they exist on the incoming branch,
  // before any regeneration below.
  let staleCount = 0;
  let unknownCount = 0;
  if (EVENT_NAME === 'pull_request') {
    console.log('\nWritulos: checking doc drift for changed files...');
    ({ stale: staleCount, unknown: unknownCount } = runPrDriftCheck(changedFiles));
  }

  // mode: comment — report what WOULD be documented; no generation, no writes,
  // no credits spent.
  if (MODE === 'comment') {
    const fileList = changedFiles.map((f) => `- \`${f}\``).join('\n');
    const staleNote = staleCount > 0
      ? `\n\n${staleCount} of these already have docs that are behind the code.`
      : '';
    const unknownNote = unknownCount > 0
      ? `\n\n${unknownCount} of these could not be checked for doc drift: the checkout has no git history (use \`actions/checkout\` with \`fetch-depth: 0\`).`
      : '';
    await postComment(
      `**Writulos** would document ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} on this ${PR_NUMBER ? 'pull request' : 'push'}:\n\n${fileList}${staleNote}${unknownNote}\n\nSwitch \`mode\` to \`commit\` or \`pr\` to generate them.`
    );
    if (mayFailOnDrift() && staleCount > 0) {
      console.error(`\nWritulos: ${staleCount} file(s) have stale docs, and this team fails builds on drift.`);
      process.exit(1);
    }
    return;
  }

  console.log(`Files to document: ${changedFiles.join(', ')}`);

  const generated = [];
  let limitReached = false, limitFilename = null, limitMessage = null;

  for (const filePath of changedFiles) {
    console.log(`\nProcessing: ${filePath}`);
    // Before generating, so a name that has nowhere to go spends nothing.
    const docPath = docPathFor(filePath);
    if (!docPath) {
      console.warn(`  [skip] ${filePath}: its doc would land outside ${OUTPUT_DIR}`);
      continue;
    }
    const result = await generateDoc(filePath);
    if (!result) continue;

    if (result.limitReached) {
      limitReached = true; limitFilename = result.filename;
      limitMessage = result.message;
      console.warn(`  [limit] Monthly generation limit reached.`);
      break;
    }

    // Print usage inline for visibility in Actions logs
    if (result.usage) {
      const u = result.usage;
      console.log(`  [usage] ${u.used}/${u.limit} used this month (${u.plan} plan) -- ${u.remaining} remaining`);
    }

    // Stamp the doc with the commit it was generated at, so drift can be
    // measured against the source file's later history (Phase 1A).
    const content = buildDocMetaHeader(filePath, COMMIT_SHA) + result.documentation;

    fs.mkdirSync(path.dirname(path.resolve(WORKSPACE, docPath)), { recursive: true });
    fs.writeFileSync(path.resolve(WORKSPACE, docPath), content, 'utf8');
    console.log(`Documented: ${filePath} -> ${docPath}`);
    generated.push({ docPath, filePath, content });
  }

  if (generated.length === 0) {
    console.log('\nWritulos: no docs generated.');
    // Still refresh the drift snapshot from existing docs and honor fail_on_drift.
    await reportDriftSnapshot();
    if (limitReached) {
      console.error(`\nFailed for ${limitFilename}. ${limitMessage}`);
      process.exit(1);
    }
    if (mayFailOnDrift() && staleCount > 0) {
      console.error(`\nWritulos: ${staleCount} file(s) have stale docs, and this team fails builds on drift.`);
      process.exit(1);
    }
    return;
  }

  // Deliver the docs per mode: straight onto the branch, or via a review PR.
  let targetBranch = REPO_BRANCH;
  if (MODE === 'pr') {
    targetBranch = `writulos/docs-${(COMMIT_SHA || String(Date.now())).slice(0, 7)}`;
    const branchOk = await ensureBranch(targetBranch);
    if (!branchOk) {
      console.error('Writulos: could not create the docs branch; falling back to direct commit.');
      targetBranch = REPO_BRANCH;
    }
  }

  const committed = [];
  for (const { docPath, content } of generated) {
    const ok = await commitFileToBranch(docPath, content, targetBranch);
    if (ok) committed.push(docPath);
  }

  if (MODE === 'pr' && targetBranch !== REPO_BRANCH && committed.length > 0) {
    await openPullRequest(targetBranch, committed.length);
  }

  console.log(`\nWritulos: done. Committed ${committed.length} doc(s) to ${targetBranch}.`);

  // Push the drift snapshot so the dashboard badges stay current.
  await reportDriftSnapshot();

  // Deliver first, then fail. Exiting the moment the quota ran out would throw
  // away every doc this run had already generated and paid for.
  if (limitReached) {
    console.error(`\nWritulos: stopped at ${limitFilename}. ${limitMessage}`);
    console.error(`The ${committed.length} doc(s) generated before the limit were committed, so that quota was not wasted.`);
    process.exit(1);
  }

  if (mayFailOnDrift() && staleCount > 0) {
    console.error(`\nWritulos: ${staleCount} file(s) have stale docs, and this team fails builds on drift.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Writulos action failed:', err.message);
  process.exit(1);
});
