import { startSocketServer, stopSocketServer } from './socket/server.ts';

let shuttingDown = false;

async function shutdownRelay(reason: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  try {
    await stopSocketServer(reason);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    void shutdownRelay(signal);
  });
}

void startSocketServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
