#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function runNode(entry, args) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code) => {
    process.exit(typeof code === 'number' ? code : 0);
  });
}

function printHelp() {
  const text = `pty-remote

Usage:
  pty-remote server        Start socket server (serves Web UI)
  pty-remote cli [args]     Start CLI client (pass-through args)
  pty-remote threads [args] List threads via CLI
  pty-remote --version      Show version
`;
  process.stdout.write(text);
}

function printVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    process.stdout.write(`${pkg.version || '0.0.0'}\n`);
  } catch {
    process.stdout.write('0.0.0\n');
  }
}

const [command, ...restArgs] = process.argv.slice(2);

if (!command || command === '-h' || command === '--help' || command === 'help') {
  printHelp();
  process.exit(0);
}

if (command === '--version' || command === '-v' || command === 'version') {
  printVersion();
  process.exit(0);
}

if (command === 'server' || command === 'socket') {
  runNode(path.join(ROOT_DIR, 'src/socket-main.ts'), restArgs);
  process.exit(0);
}

if (command === 'cli') {
  runNode(path.join(ROOT_DIR, 'src/cli-main.ts'), restArgs);
  process.exit(0);
}

if (command === 'threads') {
  runNode(path.join(ROOT_DIR, 'src/cli-main.ts'), ['threads', ...restArgs]);
  process.exit(0);
}

printHelp();
process.exit(1);
