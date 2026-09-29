import { createServer, Server as HTTPServer } from 'http';
import app from './app';
import seedSuperAdmin from './app/DB';
import config from './config';
import { customConsole } from './app/utils/customConsole';
import { cleanupExpiredSessions } from './app/utils/sessionTtl';
import { initMaintenanceCache } from './app/modules/Maintenance/maintenance.service';

const port = config.port || 5000;

async function main() {
  await initMaintenanceCache();
  const server: HTTPServer = createServer(app).listen(port, () => {
    customConsole(port, config.project_name || 'Server');
    seedSuperAdmin();
    cleanupExpiredSessions();
  });

  const exitHandler = () => {
    if (server) {
      server.close(() => {
        console.info('Server closed!');
      });
    }
    process.exit(1);
  };

  process.on('uncaughtException', error => {
    console.log(error);
    exitHandler();
  });

  process.on('unhandledRejection', error => {
    console.log(error);
    exitHandler();
  });
}

main();
