import { createBot } from './bot.ts';
import http from 'http';
import { parse } from 'url';
import { once } from 'events';

const bots = new Map<string, Awaited<ReturnType<typeof createBot>>>();

await Promise.all([
  createBot('auth', '🤖 בוט 1').then(bot => bots.set('bot1', bot)),
  createBot('auth2', '🤖 בוט 2').then(bot => bots.set('bot2', bot))
]);

const server = http.createServer(async (req, res) => {
  const url = parse(req.url!, true);

  if (req.method === 'POST' && url.pathname === '/send') {
    const body = await once(req, 'data');
    const data = JSON.parse(body.toString());

    const bot = bots.get(data.bot);
    if (!bot) {
      res.statusCode = 404;
      res.end('Bot not found');
      return;
    }

    try {
      await bot.sendText(data.jid, data.text);
      res.end('OK');
    } catch (err: any) {
      res.statusCode = 500;
      res.end(err.message);
    }
  } else {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(3000, () => {
  console.log('🌐 HTTP API on http://localhost:3000');
});
