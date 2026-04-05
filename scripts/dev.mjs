#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const FORCE_KILL_TIMEOUT_MS = 1500;

const COMMANDS = [
  {
    label: 'relay:server',
    args: ['run', 'dev:server', '--workspace', '@lzdi/pty-remote-relay']
  },
  {
    label: 'relay:web',
    args: ['run', 'dev:web', '--workspace', '@lzdi/pty-remote-relay']
  },
  {
    label: 'cli',
    args: ['run', 'dev', '--workspace', '@lzdi/pty-remote-cli']
  }
];

const children = new Map();
let shuttingDown = false;
let forceKillTimer = null;
let firstExit = null;

function writePrefixed(stream, label, chunk) {
  const text = chunk.toString('utf8');
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index === lines.length - 1 && line.length === 0) {
      continue;
    }
    stream.write(`[${label}] ${line}\n`);
  }
}

function terminateChild(child, signal) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      return;
    }
    throw error;
  }
}

function armForceKillTimer() {
  if (forceKillTimer) {
    return;
  }
  forceKillTimer = setTimeout(() => {
    for (const child of children.values()) {
      terminateChild(child, 'SIGKILL');
    }
  }, FORCE_KILL_TIMEOUT_MS);
  forceKillTimer.unref();
}

function clearForceKillTimer() {
  if (!forceKillTimer) {
    return;
  }
  clearTimeout(forceKillTimer);
  forceKillTimer = null;
}

function maybeExit() {
  if (children.size > 0) {
    return;
  }
  clearForceKillTimer();
  if (!firstExit) {
    process.exit(0);
  }
  if (firstExit.signal) {
    process.exit(128 + (osConstants.signals[firstExit.signal] ?? 0));
  }
  process.exit(firstExit.code ?? 0);
}

function shutdownAll(signal, source = 'signal') {
  if (shuttingDown) {
    for (const child of children.values()) {
      terminateChild(child, 'SIGKILL');
    }
    return;
  }

  shuttingDown = true;
  if (!firstExit) {
    firstExit = { code: 0, signal, source };
  }
  for (const child of children.values()) {
    terminateChild(child, signal);
  }
  armForceKillTimer();
  maybeExit();
}

function spawnCommand({ label, args }) {
  const child = spawn(NPM_CMD, args, {
    cwd: ROOT_DIR,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe']
  });

  children.set(label, child);

  child.stdout?.on('data', (chunk) => {
    writePrefixed(process.stdout, label, chunk);
  });

  child.stderr?.on('data', (chunk) => {
    writePrefixed(process.stderr, label, chunk);
  });

  child.on('error', (error) => {
    writePrefixed(process.stderr, label, `spawn error: ${error instanceof Error ? error.message : String(error)}`);
  });

  child.on('exit', (code, signal) => {
    children.delete(label);
    if (!shuttingDown) {
      firstExit = { code: typeof code === 'number' ? code : 1, signal: signal ?? null, source: label };
      shutdownAll('SIGTERM', label);
      return;
    }
    maybeExit();
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shutdownAll(signal, 'parent');
  });
}

for (const command of COMMANDS) {
  spawnCommand(command);
}
