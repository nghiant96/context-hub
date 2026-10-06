import { execFileSync } from "node:child_process";
import { foldVietnamese, redact } from "../text.ts";
import { inTransaction, type Db } from "../db.ts";

export interface GitFileChange {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommit {
  sha: string;
  author: string;
  date: string;
  parents: string[];
  subject: string;
  body: string;
  files: GitFileChange[];
}

const RECORD = "\x1e";
const FIELD = "\x1f";

/**
 * Read every commit reachable from any ref, with per-file line counts, in
 * topological order: a commit always comes before its parents.
 */
export function readGitLog(repoPath: string): GitCommit[] {
  const output = execFileSync(
    "git",
    ["-C", repoPath, "log", "--all", "--topo-order", "--no-renames", "--numstat", `--format=${RECORD}%H${FIELD}%an${FIELD}%aI${FIELD}%P${FIELD}%s${FIELD}%b${FIELD}`],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
  );
  return output.split(RECORD).filter((record) => record.trim()).map(parseRecord);
}

function parseRecord(record: string): GitCommit {
  const [sha = "", author = "", date = "", parents = "", subject = "", body = "", numstat = ""] = record.split(FIELD);
  const files: GitFileChange[] = [];
  for (const line of numstat.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    files.push({
      path: match[3]!,
      additions: match[1] === "-" ? null : Number(match[1]),
      deletions: match[2] === "-" ? null : Number(match[2])
    });
  }
  return { sha: sha.trim(), author, date, parents: parents.split(" ").filter(Boolean), subject, body, files };
}

/**
 * Ticket keys mentioned in a commit message or branch name. QC branches bundle
 * several tickets as `qc/HOS-1310-1456-1471-1313`, so trailing number groups
 * (three digits or more, to skip things like "-2") count as further keys.
 */
export function extractIssueKeys(text: string, projectKeys: string[]): string[] {
  if (projectKeys.length === 0) return [];
  const pattern = new RegExp(`\\b(${projectKeys.join("|")})-(\\d+(?:-\\d{3,})*)`, "g");
  const keys = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    for (const number of match[2]!.split("-")) {
      keys.add(`${match[1]}-${Number(number)}`);
    }
  }
  return [...keys];
}

/**
 * The branch a merge brought in, from the subjects git, GitLab, GitHub and
 * Bitbucket write. Free-form merge messages give null: they may name only the
 * target ("HOS-910 merge(develop): …"), not what was merged.
 */
export function mergedBranch(subject: string): string | null {
  const match = /^Merge (?:remote-tracking )?branch '([^']+)'|^Merge pull request #\d+ from (\S+)|^Merged in (\S+)/.exec(subject);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

/**
 * Ticket keys for every commit. A commit's own message decides; one that names
 * no ticket takes the keys of the branch that brought it in, from the nearest
 * merge. Own keys always win: a QC branch bundling four tickets would
 * otherwise attach all four to every commit on it.
 */
export function issueKeysByCommit(commits: GitCommit[], projectKeys: string[]): Map<string, string[]> {
  const keysByCommit = new Map(commits.map((commit) => [commit.sha, extractIssueKeys(`${commit.subject}\n${commit.body}`, projectKeys)]));
  const unlinked = new Set(commits.filter((commit) => commit.parents.length < 2 && keysByCommit.get(commit.sha)!.length === 0).map((commit) => commit.sha));
  if (unlinked.size === 0) return keysByCommit;

  // Walking topological order backwards visits parents before children, so
  // generations are known when needed and merges come oldest first: the
  // nearest merge claims a commit before any later merge that also holds it.
  const parentsOf = new Map<string, string[]>();
  const generation = new Map<string, number>();
  for (const commit of commits.toReversed()) {
    parentsOf.set(commit.sha, commit.parents);
    generation.set(commit.sha, 1 + Math.max(0, ...commit.parents.map((parent) => generation.get(parent) ?? 0)));
    const branch = commit.parents.length > 1 ? mergedBranch(commit.subject) : null;
    const keys = branch ? extractIssueKeys(branch, projectKeys) : [];
    if (keys.length === 0) continue;
    for (const sha of broughtIn(commit.parents, parentsOf, generation)) {
      if (unlinked.delete(sha)) keysByCommit.set(sha, keys);
    }
    if (unlinked.size === 0) break;
  }
  return keysByCommit;
}

/**
 * What a merge brought in: commits reachable from its other parents but not
 * from the first. Like git's merge-base, it walks the highest generation first
 * and stops once every open path is known to lead into the first parent.
 */
function broughtIn(parents: string[], parentsOf: Map<string, string[]>, generation: Map<string, number>): string[] {
  const TARGET = 1; // reachable from the first parent: already on the branch merged into
  const SOURCE = 2;
  const flags = new Map<string, number>();
  const queue: string[] = []; // ascending generation, so pop() takes the newest
  const reach = (sha: string, flag: number) => {
    const before = flags.get(sha) ?? 0;
    flags.set(sha, before | flag);
    if (before !== 0) return;
    const rank = generation.get(sha) ?? 0;
    let index = queue.length;
    while (index > 0 && (generation.get(queue[index - 1]!) ?? 0) > rank) index -= 1;
    queue.splice(index, 0, sha);
  };
  parents.forEach((parent, index) => reach(parent, index === 0 ? TARGET : SOURCE));

  const result: string[] = [];
  while (queue.some((sha) => flags.get(sha) === SOURCE)) {
    const sha = queue.pop()!;
    const flag = flags.get(sha)!;
    if (flag === SOURCE) result.push(sha);
    for (const parent of parentsOf.get(sha) ?? []) reach(parent, flag);
  }
  return result;
}

const FIX_WORD = /^(?:fix(?:bug|es|ed)?|bug-?fix|hot-?fix|bugs?|sua)\b/;

/**
 * Whether a commit subject marks a bug fix. The change type is read where the
 * team writes it: "HOS-12 fix: …", "fix(auth): …", "HOS-1158 fixbug …",
 * "feat(HOS-982): fix bugs", "HOS-1474 sửa …". A change of another type that
 * merely mentions a fix ("refactor: … to fix double border", "test: fix flaky
 * tests") is not one, and neither is a "fixture".
 */
export function isFixSubject(subject: string): boolean {
  const rest = foldVietnamese(subject).replace(/^(?:\[?[a-z][a-z0-9]*-\d+(?:-\d+)*\]?[\s:,-]*)+/, "");
  const typed = /^(\w+)(?:\(([^)]*)\))?!?:\s*/.exec(rest);
  if (!typed) return FIX_WORD.test(rest);
  if (FIX_WORD.test(typed[1]!)) return true;
  // "feat(HOS-982): fix bugs": the scope is the ticket, so the description carries the kind of change.
  return /^[a-z][a-z0-9]*-\d+$/.test(typed[2] ?? "") && FIX_WORD.test(rest.slice(typed[0].length));
}

export interface GitSyncResult {
  repo: string;
  commits: number;
  linkedCommits: number;
  tickets: number;
}

/**
 * Index one repository's history. Re-running is cheap and idempotent: commits
 * are keyed by sha. Merge commits keep their ticket links (from the branch
 * name) but not files, which their parents already account for; a ticketless
 * commit they brought in carries the files instead (see issueKeysByCommit).
 */
export function syncGitRepo(db: Db, repoName: string, repoPath: string, projectKeys: string[]): GitSyncResult {
  const commits = readGitLog(repoPath);
  const keysByCommit = issueKeysByCommit(commits, projectKeys);
  const insertCommit = db.prepare("INSERT OR IGNORE INTO commits(repo, sha, author, date, subject, is_merge) VALUES (?, ?, ?, ?, ?, ?)");
  const insertIssue = db.prepare("INSERT OR IGNORE INTO commit_issues(repo, sha, issue_key) VALUES (?, ?, ?)");
  const insertFile = db.prepare("INSERT OR IGNORE INTO commit_files(repo, sha, path, additions, deletions) VALUES (?, ?, ?, ?, ?)");
  const deleteFts = db.prepare("DELETE FROM commits_fts WHERE repo = ? AND sha = ?");
  const insertFts = db.prepare("INSERT INTO commits_fts(repo, sha, subject) VALUES (?, ?, ?)");

  let linkedCommits = 0;
  const tickets = new Set<string>();
  inTransaction(db, () => {
    for (const commit of commits) {
      const isMerge = commit.parents.length > 1;
      const subject = redact(commit.subject);
      insertCommit.run(repoName, commit.sha, commit.author, commit.date, subject, isMerge ? 1 : 0);
      deleteFts.run(repoName, commit.sha);
      insertFts.run(repoName, commit.sha, foldVietnamese(subject));

      const keys = keysByCommit.get(commit.sha)!;
      if (keys.length > 0) linkedCommits += 1;
      for (const key of keys) {
        insertIssue.run(repoName, commit.sha, key);
        tickets.add(key);
      }
      if (!isMerge) {
        for (const file of commit.files) {
          insertFile.run(repoName, commit.sha, file.path, file.additions, file.deletions);
        }
      }
    }
  });
  return { repo: repoName, commits: commits.length, linkedCommits, tickets: tickets.size };
}

/** Files changed on `head` since it diverged from `base` (three-dot diff). */
export function changedFiles(repoPath: string, base: string, head: string): string[] {
  const output = execFileSync("git", ["-C", repoPath, "diff", "--name-only", "--no-renames", `${base}...${head}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Ticket keys named by commits on `head` that are not on `base`. */
export function ticketsInRange(repoPath: string, base: string, head: string, projectKeys: string[]): string[] {
  const output = execFileSync("git", ["-C", repoPath, "log", "--format=%s%n%b", `${base}..${head}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return extractIssueKeys(output, projectKeys);
}
