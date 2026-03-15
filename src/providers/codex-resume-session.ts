import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveCodexHistoryPaths, type CodexHistoryOptions } from './codex-history.ts';

const execFileAsync = promisify(execFile);
const TEMPLATE_FILE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../codex_template.jsonl');
const PLACEHOLDER_PATTERN = /^\{\{([a-z0-9_.]+)\}\}$/i;

interface CodexResumeSessionOptions extends CodexHistoryOptions {
  codexBin?: string;
}

interface SessionMetaTemplateRecord {
  timestamp?: string;
  type: 'session_meta';
  payload: Record<string, unknown>;
}

interface GitMetadataPayload {
  commit_hash?: string;
  branch?: string;
  repository_url?: string;
}

export interface PreparedCodexResumeSession {
  filePath: string;
  sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatRolloutFileTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function createRolloutDirectory(rootPath: string, date: Date): string {
  return path.join(
    rootPath,
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  );
}

async function readTemplateRecord(): Promise<SessionMetaTemplateRecord> {
  const raw = await fs.readFile(TEMPLATE_FILE_PATH, 'utf8');
  const firstLine = raw.split('\n', 1)[0]?.trim();
  if (!firstLine) {
    throw new Error(`Codex template file is empty: ${TEMPLATE_FILE_PATH}`);
  }

  const parsed = JSON.parse(firstLine) as unknown;
  if (!isRecord(parsed) || parsed.type !== 'session_meta' || !isRecord(parsed.payload)) {
    throw new Error(`Codex template file must start with session_meta: ${TEMPLATE_FILE_PATH}`);
  }

  return {
    ...parsed,
    type: 'session_meta',
    payload: parsed.payload
  } as SessionMetaTemplateRecord;
}

function replaceTemplatePlaceholders(value: unknown, variables: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceTemplatePlaceholders(item, variables));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, replaceTemplatePlaceholders(entryValue, variables)])
    );
  }

  if (typeof value !== 'string') {
    return value;
  }

  const match = value.match(PLACEHOLDER_PATTERN);
  if (!match) {
    return value;
  }

  const variableName = match[1];
  if (!(variableName in variables)) {
    throw new Error(`Unknown Codex template placeholder: ${variableName}`);
  }

  return variables[variableName];
}

function findUnresolvedPlaceholder(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const unresolved = findUnresolvedPlaceholder(item);
      if (unresolved) {
        return unresolved;
      }
    }
    return null;
  }

  if (isRecord(value)) {
    for (const entryValue of Object.values(value)) {
      const unresolved = findUnresolvedPlaceholder(entryValue);
      if (unresolved) {
        return unresolved;
      }
    }
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(PLACEHOLDER_PATTERN);
  return match ? match[0] : null;
}

async function readGitMetadata(cwd: string): Promise<GitMetadataPayload | null> {
  try {
    const insideWorkTree = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8'
    });
    if (insideWorkTree.stdout.trim() !== 'true') {
      return null;
    }
  } catch {
    return null;
  }

  const metadata: GitMetadataPayload = {};

  try {
    const result = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const commitHash = result.stdout.trim();
    if (commitHash) {
      metadata.commit_hash = commitHash;
    }
  } catch {
    // ignore
  }

  try {
    const result = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
    const branch = result.stdout.trim();
    if (branch) {
      metadata.branch = branch;
    }
  } catch {
    // ignore
  }

  try {
    const result = await execFileAsync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
    const repositoryUrl = result.stdout.trim();
    if (repositoryUrl) {
      metadata.repository_url = repositoryUrl;
    }
  } catch {
    // ignore
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

async function readCodexCliVersion(codexBin = 'codex'): Promise<string | null> {
  try {
    const result = await execFileAsync(codexBin, ['--version'], { encoding: 'utf8' });
    const version = result.stdout.trim();
    return version || null;
  } catch {
    return null;
  }
}

function buildSessionMetaRecord(
  template: SessionMetaTemplateRecord,
  templateVariables: Readonly<Record<string, string>>,
  gitMetadata: GitMetadataPayload | null
): SessionMetaTemplateRecord {
  const rendered = replaceTemplatePlaceholders(template, templateVariables) as SessionMetaTemplateRecord;
  const unresolved = findUnresolvedPlaceholder(rendered);
  if (unresolved) {
    throw new Error(`Unresolved Codex template placeholder: ${unresolved}`);
  }

  const payload = structuredClone(rendered.payload);
  payload.source ??= 'cli';
  payload.originator ??= 'codex_cli_rs';

  if (gitMetadata) {
    payload.git = gitMetadata;
  } else {
    delete payload.git;
  }

  return {
    ...rendered,
    type: 'session_meta',
    payload
  };
}

export async function prepareCodexResumeSession(
  cwd: string,
  options: CodexResumeSessionOptions = {}
): Promise<PreparedCodexResumeSession> {
  const resolvedCwd = path.resolve(cwd);
  const { sessionsRootPath } = resolveCodexHistoryPaths(options);
  const template = await readTemplateRecord();
  const sessionId = randomUUID();
  const now = new Date();
  const timestamp = now.toISOString();
  const cliVersion = (await readCodexCliVersion(options.codexBin)) ?? 'unknown';
  const gitMetadata = await readGitMetadata(resolvedCwd);
  const nextRecord = buildSessionMetaRecord(
    template,
    {
      cli_version: cliVersion,
      cwd: resolvedCwd,
      session_id: sessionId,
      timestamp
    },
    gitMetadata
  );
  const rolloutDir = createRolloutDirectory(sessionsRootPath, now);
  const filePath = path.join(rolloutDir, `rollout-${formatRolloutFileTimestamp(now)}-${sessionId}.jsonl`);

  await fs.mkdir(rolloutDir, { recursive: true });
  await fs.copyFile(TEMPLATE_FILE_PATH, filePath);
  await fs.writeFile(filePath, `${JSON.stringify(nextRecord)}\n`, 'utf8');
  return {
    filePath,
    sessionId
  };
}
