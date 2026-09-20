import 'dotenv/config';
import { server } from './server.js';

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 8088;
    await server.listen({ port, host: '0.0.0.0' });
    server.log.info(`Secure Proxy Gateway running on port ${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();