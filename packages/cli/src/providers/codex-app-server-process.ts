import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

import { createCodexShellExecConfig } from './codex-shell.ts';

export interface CodexAppServerProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  explicitPort?: number | null;
  readyTimeoutMs: number;
  onLog?: (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void;
}

export interface CodexAppServerEndpoint {
  port: number;
  readyUrl: string;
  wsUrl: string;
}

function logMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve a free local port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function normalizeStdoutLine(chunk: string): string[] {
  return chunk
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export class CodexAppServerProcess {
  private readonly options: CodexAppServerProcessOptions;

  private child: ChildProcess | null = null;

  private endpoint: CodexAppServerEndpoint | null = null;

  private startupPromise: Promise<CodexAppServerEndpoint> | null = null;

  constructor(options: CodexAppServerProcessOptions) {
    this.options = options;
  }

  async ensureStarted(): Promise<CodexAppServerEndpoint> {
    if (this.child && this.endpoint) {
      return this.endpoint;
    }

    if (this.startupPromise) {
      return this.startupPromise;
    }

    this.startupPromise = this.start();
    try {
      return await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.endpoint = null;

    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 1_500);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  private async start(): Promise<CodexAppServerEndpoint> {
    const port = this.options.explicitPort && this.options.explicitPort > 0 ? this.options.explicitPort : await findAvailablePort();
    const endpoint: CodexAppServerEndpoint = {
      port,
      readyUrl: `http://127.0.0.1:${port}/readyz`,
      wsUrl: `ws://127.0.0.1:${port}`
    };
    const launch = createCodexShellExecConfig(['app-server', '--listen', endpoint.wsUrl], this.options.env);
    const child = spawn(launch.command, launch.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const earlyExitPromise = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => {
        this.child = null;
        this.endpoint = null;
        reject(new Error(`Codex app-server exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      });
      child.once('error', (error) => {
        this.child = null;
        this.endpoint = null;
        reject(error);
      });
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of normalizeStdoutLine(chunk)) {
        this.options.onLog?.('info', 'codex app-server stdout', { line });
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of normalizeStdoutLine(chunk)) {
        this.options.onLog?.('warn', 'codex app-server stderr', { line });
      }
    });

    this.child = child;
    this.endpoint = endpoint;

    try {
      await Promise.race([this.waitForReady(endpoint), earlyExitPromise]);
      this.options.onLog?.('info', 'codex app-server ready', {
        port: endpoint.port,
        readyUrl: endpoint.readyUrl,
        wsUrl: endpoint.wsUrl
      });
      return endpoint;
    } catch (error) {
      this.options.onLog?.('error', 'failed to start codex app-server', {
        error: logMessage(error, 'Failed to start Codex app-server'),
        wsUrl: endpoint.wsUrl
      });
      await this.stop();
      throw error;
    }
  }

  private async waitForReady(endpoint: CodexAppServerEndpoint): Promise<void> {
    const deadline = Date.now() + Math.max(1_000, this.options.readyTimeoutMs);

    while (Date.now() < deadline) {
      try {
        const response = await fetch(endpoint.readyUrl);
        if (response.ok) {
          return;
        }
      } catch {
        // server still starting
      }

      await sleep(150);
    }

    throw new Error(`Codex app-server did not become ready within ${this.options.readyTimeoutMs}ms`);
  }
}
