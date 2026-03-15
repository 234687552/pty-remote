import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface RelayConfig {
  replayBufferSize: number;
  snapshotCacheMax: number;
  snapshotMaxBytes: number;
}

const DEFAULTS: RelayConfig = {
  replayBufferSize: 200,
  snapshotCacheMax: 50,
  snapshotMaxBytes: 200_000
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadRelayConfig(rootDir: string): RelayConfig {
  const configPath = path.join(rootDir, 'relay.conf');
  if (!existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  const raw = readFileSync(configPath, 'utf8');
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
    entries[key.trim()] = rest.join('=').trim();
  }

  return {
    replayBufferSize: parseNumber(entries.RELAY_REPLAY_BUFFER_SIZE, DEFAULTS.replayBufferSize),
    snapshotCacheMax: parseNumber(entries.RELAY_SNAPSHOT_CACHE_MAX, DEFAULTS.snapshotCacheMax),
    snapshotMaxBytes: parseNumber(entries.RELAY_SNAPSHOT_MAX_BYTES, DEFAULTS.snapshotMaxBytes)
  };
}
