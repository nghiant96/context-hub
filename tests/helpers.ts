import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HubConfig } from "../src/config.ts";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** Run git; dates are pinned only when given, so a cherry-pick keeps its original author date. */
export function git(repo: string, args: string[], date?: string): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Tester", "-c", "user.email=tester@example.invalid", ...args], {
    encoding: "utf8",
    env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env
  });
}

export function commit(repo: string, files: Record<string, string>, message: string, date: string): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  git(repo, ["add", "-A"], date);
  git(repo, ["commit", "-q", "-m", message], date);
}

/**
 * A small repository with a known story:
 *  - HOS-10 built OTP login (otp.ts, login.ts), later tested; its first commit
 *    is also cherry-picked to a release branch, so it exists twice.
 *  - HOS-11 built the profile screen, unrelated to auth.
 *  - HOS-12 fixed OTP expiry in otp.ts.
 *  - A ticketless chore touched the README.
 *  - Branch `feature` (HOS-20) changes otp.ts and adds pin.ts.
 *  - Branch `feat/HOS-30-khoa-pin` holds one commit with no key; it is
 *    merged into main, so the commit belongs to HOS-30 by its branch name.
 *  - Branch `feat/HOS-31` (src/authentication/) merges main back in,
 *    bringing a second ticketless chore that must not become HOS-31's.
 */
export function buildFixtureRepo(): string {
  const repo = tempDir("ctx-repo");
  git(repo, ["init", "-q", "-b", "main"]);
  commit(repo, { "src/auth/otp.ts": "otp v1\n", "src/auth/login.ts": "login v1\n" }, "HOS-10 feat: đăng nhập bằng OTP", "2026-01-02T09:00:00+07:00");
  commit(repo, { "src/profile/profile.ts": "profile v1\n" }, "HOS-11 feat: màn hồ sơ người dùng", "2026-01-03T09:00:00+07:00");
  commit(repo, { "src/auth/otp.ts": "otp v2\n" }, "HOS-12 fix: OTP hết hạn vẫn cho nhập", "2026-01-04T09:00:00+07:00");
  commit(repo, { "src/auth/otp.test.ts": "test\n", "package-lock.json": "{}\n" }, "HOS-10 test: thêm test OTP", "2026-01-05T09:00:00+07:00");
  commit(repo, { "README.md": "readme\n" }, "chore: cập nhật README", "2026-01-06T09:00:00+07:00");

  // A second copy of HOS-10's first commit on an unrelated branch: new sha,
  // same author date and subject.
  const firstSha = git(repo, ["rev-list", "--max-parents=0", "HEAD"]).trim();
  git(repo, ["switch", "-q", "--orphan", "copy"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "start copy"], "2026-01-08T09:00:00+07:00");
  git(repo, ["cherry-pick", firstSha]);
  git(repo, ["switch", "-q", "main"]);

  git(repo, ["switch", "-q", "-c", "feature"]);
  commit(repo, { "src/auth/otp.ts": "otp v3\n", "src/auth/pin.ts": "pin\n" }, "HOS-20 feat: khoá PIN sau 5 lần sai", "2026-01-07T09:00:00+07:00");
  git(repo, ["switch", "-q", "main"]);

  git(repo, ["switch", "-q", "-c", "feat/HOS-30-khoa-pin"]);
  commit(repo, { "src/security/pin-lock.ts": "lock\n" }, "wip: màn khoá PIN", "2026-01-09T09:00:00+07:00");
  git(repo, ["switch", "-q", "main"]);
  git(repo, ["merge", "-q", "--no-ff", "--no-edit", "feat/HOS-30-khoa-pin"], "2026-01-10T09:00:00+07:00");

  git(repo, ["switch", "-q", "-c", "feat/HOS-31"]);
  commit(repo, { "src/authentication/sso.ts": "sso\n" }, "HOS-31 feat: đăng nhập SSO", "2026-01-11T09:00:00+07:00");
  git(repo, ["switch", "-q", "main"]);
  commit(repo, { "README.md": "readme v2\n" }, "chore: tăng phiên bản", "2026-01-12T09:00:00+07:00");
  git(repo, ["switch", "-q", "feat/HOS-31"]);
  git(repo, ["merge", "-q", "--no-ff", "--no-edit", "main"], "2026-01-13T09:00:00+07:00");
  git(repo, ["switch", "-q", "main"]);
  return repo;
}

export function fixtureConfig(repo: string, dbPath: string): HubConfig {
  const dir = tempDir("ctx-config");
  const configPath = path.join(dir, "context-hub.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ dbPath, jira: { baseUrl: "https://example.atlassian.net", projects: ["HOS"] }, repos: [{ name: "app", path: repo }] })
  );
  return loadConfig(configPath);
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** An Atlassian site double: canned responses in order, every request recorded. */
export function fakeAtlassian(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: next.headers });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
