import { config } from './config';
import { makeLogger } from './core/logger';
import { Supervisor } from './fleet/supervisor';
import { createControlServer } from './control/server';

const log = makeLogger('daemon');

async function main(): Promise<void> {
  const sup = new Supervisor();
  await sup.init();
  const server = createControlServer(sup);
  server.listen(config.control.port, config.control.host, () =>
    log.ok(`agentd on http://${config.control.host}:${config.control.port} — connect the MCP/CLI`),
  );

  let down = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (down) return;
    down = true;
    log.info(`${sig} — shutting down…`);
    server.close();
    await sup.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
