#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const requireFromBin = createRequire(import.meta.url);
const TSX_IMPORT_PATH = requireFromBin.resolve('tsx', { paths: [ROOT_DIR] });

const child = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', '--import', TSX_IMPORT_PATH, path.join(ROOT_DIR, 'src/cli-main.ts'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env
  }
);

child.on('exit', (code) => {
  process.exit(typeof code === 'number' ? code : 0);
});
