import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const USER_CONFIG_DIR = path.join(os.homedir(), '.pty-remote');
const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, 'cli.conf');
const TEMPLATE_PATH = path.join(ROOT_DIR, 'cli.conf');
function ensureCliConfigFile(): string {
  try {
    if (!existsSync(USER_CONFIG_PATH)) {
      if (existsSync(TEMPLATE_PATH)) {
        mkdirSync(USER_CONFIG_DIR, { recursive: true });
        copyFileSync(TEMPLATE_PATH, USER_CONFIG_PATH);
      }
    }
  } catch {
    // Fall back to environment defaults if we cannot create/read the config file.
  }
  return USER_CONFIG_PATH;
}

function parseConfig(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const [key, ...rest] = trimmed.split('=');
    if (!key) {
      continue;
    }
    const value = rest.join('=').trim();
    if (!value) {
      continue;
    }
    entries[key.trim()] = value;
  }
  return entries;
}

export function loadCliConfig(): Record<string, string> {
  const configPath = ensureCliConfigFile();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, 'utf8');
    return parseConfig(raw);
  } catch {
    return {};
  }
}
