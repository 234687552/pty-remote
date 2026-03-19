import { chmodSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.exit(0);
}

const helperCandidates = [
  path.join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
  path.join(process.cwd(), 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper')
];

for (const helperPath of helperCandidates) {
  if (!existsSync(helperPath)) {
    continue;
  }

  const mode = statSync(helperPath).mode & 0o111;
  if (mode === 0o111) {
    continue;
  }

  chmodSync(helperPath, 0o755);
}
