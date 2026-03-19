import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RelayConfig {
  host: string;
  port: number;
  replayBufferSize: number;
  snapshotCacheMax: number;
  snapshotMaxBytes: number;
  socketMaxHttpBufferSize: number;
  cliCommandTimeoutMs: number;
}

const USER_CONFIG_DIR = path.join(os.homedir(), '.pty-remote');
const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, 'relay.conf');
const MIN_SOCKET_MAX_HTTP_BUFFER_SIZE = 1024 * 1024;
const DEFAULTS: RelayConfig = {
  host: '127.0.0.1',
  port: 3001,
  replayBufferSize: 200,
  snapshotCacheMax: 50,
  snapshotMaxBytes: 200_000,
  socketMaxHttpBufferSize: 8 * 1024 * 1024,
  cliCommandTimeoutMs: 30_000
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseString(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function ensureRelayConfigFile(rootDir: string): string {
  try {
    if (!existsSync(USER_CONFIG_PATH)) {
      const templatePath = path.join(rootDir, 'relay.conf');
      if (existsSync(templatePath)) {
        mkdirSync(USER_CONFIG_DIR, { recursive: true });
        copyFileSync(templatePath, USER_CONFIG_PATH);
      }
    }
  } catch {
    // Fall back to defaults if we cannot create/read the config file.
  }
  return USER_CONFIG_PATH;
}

export function loadRelayConfig(rootDir: string): RelayConfig {
  const configPath = ensureRelayConfigFile(rootDir);
  if (!existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  let raw = '';
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return { ...DEFAULTS };
  }
  const lines = raw.split(/\r?\n/);
  const entries: Record<string, string> = {};

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

  return {
    host: parseString(entries.HOST, DEFAULTS.host),
    port: parseNumber(entries.PORT, DEFAULTS.port),
    replayBufferSize: parseNumber(entries.RELAY_REPLAY_BUFFER_SIZE, DEFAULTS.replayBufferSize),
    snapshotCacheMax: parseNumber(entries.RELAY_SNAPSHOT_CACHE_MAX, DEFAULTS.snapshotCacheMax),
    snapshotMaxBytes: parseNumber(entries.RELAY_SNAPSHOT_MAX_BYTES, DEFAULTS.snapshotMaxBytes),
    socketMaxHttpBufferSize: Math.max(
      MIN_SOCKET_MAX_HTTP_BUFFER_SIZE,
      parseNumber(entries.RELAY_SOCKET_MAX_HTTP_BUFFER_SIZE, DEFAULTS.socketMaxHttpBufferSize)
    ),
    cliCommandTimeoutMs: parseNumber(entries.RELAY_CLI_COMMAND_TIMEOUT_MS, DEFAULTS.cliCommandTimeoutMs)
  };
}
