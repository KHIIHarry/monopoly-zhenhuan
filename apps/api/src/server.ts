import { buildApiApp } from './app.js';

const app = await buildApiApp({ startRoomTrashCleaner: true });
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
