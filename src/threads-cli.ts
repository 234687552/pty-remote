import path from 'node:path';

import type { ProjectSessionSummary } from '../shared/protocol.ts';
import { listProjectSessions } from './project-history.ts';

type ThreadsCommand = 'list' | 'ids';

interface ThreadsCliOptions {
  command: ThreadsCommand;
  cwd: string;
  json: boolean;
  limit: number;
}

function printUsage(): void {
  console.log(`Usage:
  node src/cli-main.ts threads [list|ids] [--cwd <path>] [--limit <n>] [--json]

Examples:
  node src/cli-main.ts threads
  node src/cli-main.ts threads list --limit 20
  node src/cli-main.ts threads ids --cwd .
  node src/cli-main.ts threads list --json`);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function printSessionTable(sessions: ProjectSessionSummary[]): void {
  const rows = sessions.map((session) => ({
    sessionId: session.sessionId,
    messages: String(session.messageCount),
    updatedAt: formatTimestamp(session.updatedAt),
    preview: truncate(session.preview, 96)
  }));

  const sessionIdWidth = Math.max('sessionId'.length, ...rows.map((row) => row.sessionId.length));
  const messagesWidth = Math.max('msgs'.length, ...rows.map((row) => row.messages.length));
  const updatedAtWidth = Math.max('updatedAt'.length, ...rows.map((row) => row.updatedAt.length));

  console.log(
    `${'sessionId'.padEnd(sessionIdWidth)}  ${'msgs'.padEnd(messagesWidth)}  ${'updatedAt'.padEnd(updatedAtWidth)}  preview`
  );
  console.log(
    `${'-'.repeat(sessionIdWidth)}  ${'-'.repeat(messagesWidth)}  ${'-'.repeat(updatedAtWidth)}  ${'-'.repeat(24)}`
  );

  for (const row of rows) {
    console.log(
      `${row.sessionId.padEnd(sessionIdWidth)}  ${row.messages.padEnd(messagesWidth)}  ${row.updatedAt.padEnd(updatedAtWidth)}  ${row.preview}`
    );
  }
}

function parseThreadsArgs(argv: string[]): ThreadsCliOptions | null {
  let command: ThreadsCommand = 'list';
  let cwd = process.cwd();
  let limit = 12;
  let json = false;

  const args = [...argv];
  if (args[0] === 'list' || args[0] === 'ids') {
    command = args.shift() as ThreadsCommand;
  }

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      return null;
    }

    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--cwd') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --cwd');
      }
      cwd = path.resolve(value);
      continue;
    }

    if (arg === '--limit') {
      const value = args.shift();
      const parsed = Number.parseInt(value ?? '', 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: ${value ?? '<empty>'}`);
      }
      limit = parsed;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    command,
    cwd,
    json,
    limit
  };
}

export async function runThreadsCli(argv: string[]): Promise<number> {
  const options = parseThreadsArgs(argv);
  if (!options) {
    return 0;
  }

  const sessions = await listProjectSessions(options.cwd, options.limit);

  if (options.command === 'ids') {
    const ids = sessions.map((session) => session.sessionId);
    if (options.json) {
      console.log(JSON.stringify(ids, null, 2));
      return 0;
    }

    for (const sessionId of ids) {
      console.log(sessionId);
    }
    return 0;
  }

  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return 0;
  }

  if (sessions.length === 0) {
    console.log(`No Claude sessions found for ${options.cwd}`);
    return 0;
  }

  printSessionTable(sessions);
  return 0;
}
