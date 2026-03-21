import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { BUILTIN_SLASH_COMMANDS, type ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, Array<{
    installPath: string;
    lastUpdated: string;
  }>>;
}

function getClaudeCommandsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude');
  return path.join(configDir, 'commands');
}

function getCodexPromptsDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
  return path.join(codexHome, 'prompts');
}

async function scanCommandNames(dir: string, segments: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const discovered: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name.includes(':')) {
        continue;
      }
      discovered.push(...(await scanCommandNames(path.join(dir, entry.name), [...segments, entry.name])));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const baseName = entry.name.slice(0, -3);
    if (!baseName || baseName.includes(':')) {
      continue;
    }

    discovered.push([...segments, baseName].join(':'));
  }

  return discovered;
}

async function scanClaudePluginCommandNames(): Promise<string[]> {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude');
  const installedPluginsPath = path.join(configDir, 'plugins', 'installed_plugins.json');

  try {
    const content = await fs.readFile(installedPluginsPath, 'utf8');
    const installedPlugins = JSON.parse(content) as InstalledPluginsFile;
    const discovered: string[] = [];

    for (const [pluginKey, installations] of Object.entries(installedPlugins.plugins ?? {})) {
      if (installations.length === 0) {
        continue;
      }

      const latestInstallation = [...installations].sort((left, right) => {
        return new Date(right.lastUpdated).getTime() - new Date(left.lastUpdated).getTime();
      })[0];
      if (!latestInstallation?.installPath) {
        continue;
      }

      const lastAtIndex = pluginKey.lastIndexOf('@');
      const pluginName = lastAtIndex > 0 ? pluginKey.slice(0, lastAtIndex) : pluginKey;
      const names = await scanCommandNames(path.join(latestInstallation.installPath, 'commands'));
      for (const name of names) {
        discovered.push(`${pluginName}:${name}`);
      }
    }

    return discovered;
  } catch {
    return [];
  }
}

function dedupeCommands(commandGroups: string[][]): string[] {
  return [...new Set(commandGroups.flat().map((command) => command.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

export async function listProviderSlashCommands(providerId: ProviderId): Promise<string[]> {
  const builtin = BUILTIN_SLASH_COMMANDS[providerId] ?? [];

  if (providerId === 'claude') {
    const [userCommands, pluginCommands] = await Promise.all([
      scanCommandNames(getClaudeCommandsDir()),
      scanClaudePluginCommandNames()
    ]);
    return dedupeCommands([builtin, pluginCommands, userCommands]);
  }

  if (providerId === 'codex') {
    const userCommands = await scanCommandNames(getCodexPromptsDir());
    return dedupeCommands([builtin, userCommands]);
  }

  return dedupeCommands([builtin]);
}
