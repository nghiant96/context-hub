import fs from "node:fs";
import path from "node:path";

export interface RepoConfig {
  /** Short name shown in results, e.g. "healthos". */
  name: string;
  /** Local clone; relative paths resolve against the config file. */
  path: string;
}

export interface HubConfig {
  dbPath: string;
  jira: {
    baseUrl: string;
    projects: string[];
    email?: string;
    apiToken?: string;
  };
  /** Same Atlassian site and credentials as Jira; Confluence is served under /wiki. */
  confluence: {
    /** Space keys, as in /wiki/spaces/<KEY>/… */
    spaces: string[];
  };
  repos: RepoConfig[];
  /** Path patterns left out of rankings: lockfiles, generated and binary files. */
  ignorePaths: RegExp[];
}

const DEFAULT_IGNORES = [
  "(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Podfile\\.lock|Gemfile\\.lock)$",
  "\\.pbxproj$",
  "\\.snap$",
  "\\.(png|jpe?g|gif|webp|svg|ttf|otf|mp3|mp4|lottie)$",
  "(^|/)(Pods|build|dist|node_modules)/"
];

export interface RawConfig {
  dbPath?: string;
  jira?: { baseUrl?: string; projects?: string[] };
  confluence?: { spaces?: string[] };
  repos?: RepoConfig[];
  ignorePaths?: string[];
}

/**
 * Load `context-hub.config.json` (or CTX_CONFIG) plus secrets from `.env`.
 * The config file holds no secrets and is committed; Jira credentials only
 * ever come from the environment.
 */
export function loadConfig(configPath = process.env.CTX_CONFIG ?? "context-hub.config.json"): HubConfig {
  const absoluteConfig = path.resolve(configPath);
  const baseDir = path.dirname(absoluteConfig);
  const envPath = path.join(baseDir, ".env");
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }

  const raw: RawConfig = fs.existsSync(absoluteConfig) ? JSON.parse(fs.readFileSync(absoluteConfig, "utf8")) : {};
  return buildConfig(raw, baseDir);
}

/**
 * Settings plus credentials from `env`. Relative paths resolve against
 * `baseDir`. The CLI reads them from a config file; the Claude Desktop
 * extension from what the user typed when installing it.
 */
export function buildConfig(raw: RawConfig, baseDir: string, env: NodeJS.ProcessEnv = process.env): HubConfig {
  const projects = raw.jira?.projects?.length ? raw.jira.projects : ["HOS"];
  return {
    dbPath: path.resolve(baseDir, raw.dbPath ?? "data/context.db"),
    jira: {
      baseUrl: normalizeJiraBaseUrl(env.JIRA_BASE_URL || raw.jira?.baseUrl || ""),
      projects,
      email: env.JIRA_EMAIL || undefined,
      apiToken: env.JIRA_API_TOKEN || undefined
    },
    confluence: { spaces: raw.confluence?.spaces ?? [] },
    repos: (raw.repos ?? []).map((repo) => ({ name: repo.name, path: path.resolve(baseDir, repo.path) })),
    ignorePaths: [...DEFAULT_IGNORES, ...(raw.ignorePaths ?? [])].map((pattern) => new RegExp(pattern))
  };
}

/**
 * People paste the address they see in the browser, e.g.
 * `https://onemount.atlassian.net/jira` or a `/browse/HOS-1` link. Jira Cloud
 * serves its REST API at the site root, so any path on an atlassian.net URL is
 * dropped. Other hosts keep their path, which a self-hosted Jira may need.
 */
export function normalizeJiraBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.hostname.endsWith(".atlassian.net") ? url.origin : trimmed;
  } catch {
    return trimmed;
  }
}

export function isIgnoredPath(config: Pick<HubConfig, "ignorePaths">, filePath: string): boolean {
  return config.ignorePaths.some((pattern) => pattern.test(filePath));
}
