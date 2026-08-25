#!/usr/bin/env node
/**
 * Repository state, derived on demand.
 *
 *   node tools/state.mjs           human-readable report
 *   node tools/state.mjs --json    machine-readable
 *
 * Documentation must not hard-code HEAD, branches, dirty files or worktrees --
 * that prose goes stale within a day. Run this instead. It is the first thing a
 * new agent should run in this repository.
 *
 * Read-only by construction: it never checks out, prunes, resets or deletes.
 */
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const git = (...args) => {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return '';
  }
};
const lines = (s) => (s ? s.split('\n').filter(Boolean) : []);

// ---------------------------------------------------------------- gather ----
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const head = git('rev-parse', 'HEAD');
const headShort = git('rev-parse', '--short', 'HEAD');
const dirty = lines(git('status', '--porcelain'));
const recent = lines(git('log', '--oneline', '-12'));
const remotes = lines(git('remote', '-v'));

// A partially completed repository operation must be finished or aborted before
// anyone starts new work on top of it.
const inProgress = [];
for (const [file, label] of [
  ['MERGE_HEAD', 'merge'], ['REBASE_HEAD', 'rebase'], ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase/am'], ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect'],
]) {
  if (git('rev-parse', '--git-path', file) && existsInGitDir(file)) inProgress.push(label);
}
function existsInGitDir(name) {
  const p = git('rev-parse', '--git-path', name);
  if (!p) return false;
  try { execFileSync('test', ['-e', resolve(ROOT, p)], { cwd: ROOT }); return true; }
  catch { return false; }
}

const mainRef = git('rev-parse', '--verify', 'main') ? 'main' : branch;

const branches = lines(git('for-each-ref', '--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(contents:subject)', 'refs/heads'))
  .map((l) => {
    const [name, sha, when, subject] = l.split('|');
    const ahead = name === mainRef ? '0' : (git('rev-list', '--count', `${mainRef}..${name}`) || '?');
    const behind = name === mainRef ? '0' : (git('rev-list', '--count', `${name}..${mainRef}`) || '?');
    return { name, sha, when, subject, ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
  });

// `git worktree list --porcelain` is the only reliable enumeration. Worktrees
// created by agents that no longer exist still contain real work.
const worktrees = [];
{
  let cur = null;
  for (const l of lines(git('worktree', 'list', '--porcelain'))) {
    if (l.startsWith('worktree ')) { cur = { path: l.slice(9) }; worktrees.push(cur); }
    else if (l.startsWith('HEAD ')) cur.head = l.slice(5, 12);
    else if (l.startsWith('branch ')) cur.branch = l.slice(7).replace('refs/heads/', '');
    else if (l === 'detached') cur.branch = '(detached)';
    else if (l === 'bare') cur.bare = true;
  }
  for (const w of worktrees) {
    if (w.path === ROOT) { w.isPrimary = true; continue; }
    // Ask the worktree about itself; a stale registration reports nothing.
    try {
      w.dirty = lines(execFileSync('git', ['--no-optional-locks', '-C', w.path, 'status', '--porcelain'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()).length;
    } catch { w.missing = true; }
    w.unmerged = Number(git('rev-list', '--count', `${mainRef}..${w.branch || w.head}`) || 0);
  }
}

const report = {
  root: ROOT, branch, head, headShort,
  operationInProgress: inProgress,
  dirtyCount: dirty.length, dirty,
  recent, branches, worktrees,
  remotes: remotes.length ? remotes : ['(none - this repository is local only)'],
};

// ---------------------------------------------------------------- output ----
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const H = (s) => `\n\x1b[1m${s}\x1b[0m`;
console.log(H('HEAD'));
console.log(`  ${branch} @ ${headShort}`);
if (inProgress.length) {
  console.log(`\n  !! A ${inProgress.join(' + ')} is IN PROGRESS.`);
  console.log('     Finish or abort it before starting new work.');
}

console.log(H(`Uncommitted changes (${dirty.length})`));
if (!dirty.length) console.log('  clean');
else {
  for (const d of dirty) console.log(`  ${d}`);
  console.log('\n  Agents may own some of these files and still be editing them.');
  console.log('  The ownership table is in AGENTS.md ("Architecture and file');
  console.log('  ownership"); AI_HANDOFF.md section 9 explains how to tell live');
  console.log('  work from abandoned work.');
}

console.log(H('Recent commits'));
for (const c of recent) console.log(`  ${c}`);

console.log(H('Branches'));
for (const b of branches) {
  const rel = b.name === mainRef ? '' : `  (+${b.ahead}/-${b.behind} vs ${mainRef})`;
  console.log(`  ${b.name.padEnd(34)} ${b.sha}  ${b.when}${rel}`);
  console.log(`  ${''.padEnd(34)} ${b.subject}`);
}

console.log(H('Worktrees'));
for (const w of worktrees) {
  const tag = w.isPrimary ? '[primary]' : w.missing ? '[PATH MISSING]' : `[dirty ${w.dirty}]`;
  console.log(`  ${tag} ${w.path}`);
  console.log(`      branch ${w.branch || '(detached)'} @ ${w.head}` +
    (w.isPrimary ? '' : `, ${w.unmerged} commit(s) not on ${mainRef}`));
}
if (worktrees.length > 1) {
  console.log(`
  Some of these were created by autonomous agents that no longer exist.
  NEVER delete, prune or reset an unfamiliar worktree just because nobody owns
  it -- it may hold the only copy of real work. Inspect it first:

    git -C <path> status
    git -C <path> log --oneline ${mainRef}..HEAD
    git -C <path> diff ${mainRef}...HEAD --stat
    git -C <path> stash list

  If it has unmerged commits worth keeping, cherry-pick or merge them. Only
  after you have confirmed there is nothing to salvage:
    git worktree remove <path>        # refuses if dirty; use --force knowingly
    git worktree prune                # only clears already-deleted paths`);
}

console.log(H('Remotes'));
for (const r of report.remotes) console.log(`  ${r}`);

// THE SHIPPED PAYLOAD, MEASURED. The README used to carry this as a number and
// it went stale by 78% -- it claimed 443KB/139KB while the game had grown to
// 769KB/258KB. There is no build step, so the payload is simply every module
// under src/ plus index.html, and measuring it is three lines. Anything that can
// be derived should be derived; prose about repository state is prose that lies.
console.log(H('Payload'));
{
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html|css)$/.test(e.name)) files.push(p);
    }
  };
  try { walk(join(ROOT, 'src')); } catch { /* no src */ }
  try { files.push(join(ROOT, 'index.html')); } catch { /* none */ }
  let raw = 0;
  const bufs = [];
  for (const f of files) { try { const b = readFileSync(f); raw += b.length; bufs.push(b); } catch { /* skip */ } }
  const gz = gzipSync(Buffer.concat(bufs), { level: 9 }).length;
  const kb = (n) => (n / 1024).toFixed(0) + 'KB';
  console.log(`  ${files.length} files   ${kb(raw)} raw   ${kb(gz)} gzipped   (no build step: this IS the payload)`);
}

console.log(H('Next'));
console.log('  Read README.md, then AI_HANDOFF.md, then AGENTS.md.');
console.log('  Authoritative check:  node tools/check.mjs --seeds 7,3');
console.log('');
