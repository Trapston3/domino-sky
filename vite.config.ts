import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function vercelDevApiPlugin(): Plugin {
  return {
    name: 'domino-sky-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const urlPath = (req.url || '').split('?')[0];
        if (urlPath !== '/api/ping' && urlPath !== '/api/dispatch') {
          next();
          return;
        }

        try {
          const modulePath = urlPath === '/api/ping' ? '/api/ping.ts' : '/api/dispatch.ts';
          const mod = await server.ssrLoadModule(modulePath);
          const handler = mod.default as (vReq: unknown, vRes: unknown) => Promise<void> | void;

          let parsedBody: unknown = undefined;
          if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            try {
              parsedBody = await readJsonBody(req);
            } catch {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: 'Malformed JSON body' }));
              return;
            }
          }

          const urlObj = new URL(req.url || '/', 'http://localhost');
          const query: Record<string, string | string[]> = {};
          urlObj.searchParams.forEach((value, key) => {
            const existing = query[key];
            if (existing === undefined) {
              query[key] = value;
            } else if (Array.isArray(existing)) {
              existing.push(value);
            } else {
              query[key] = [existing, value];
            }
          });

          const vercelReq = Object.assign(req, {
            body: parsedBody,
            query,
            cookies: {},
          });

          const vercelRes: {
            statusCode: number;
            setHeader: (name: string, value: string | string[]) => typeof vercelRes;
            status: (code: number) => typeof vercelRes;
            json: (data: unknown) => void;
            send: (data: unknown) => void;
            end: (data?: unknown) => void;
          } = {
            statusCode: 200,
            setHeader(name: string, value: string | string[]) {
              (res as ServerResponse).setHeader(name, value);
              return vercelRes;
            },
            status(code: number) {
              res.statusCode = code;
              vercelRes.statusCode = code;
              return vercelRes;
            },
            json(data: unknown) {
              if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
              }
              res.end(JSON.stringify(data));
            },
            send(data: unknown) {
              if (typeof data === 'object' && data !== null && !Buffer.isBuffer(data)) {
                vercelRes.json(data);
                return;
              }
              res.end(data as string | Buffer);
            },
            end(data?: unknown) {
              res.end(data as string | Buffer | undefined);
            },
          };

          await handler(vercelReq, vercelRes);
        } catch (err) {
          console.error('[dev-api] error:', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'Internal server error',
              }),
            );
          }
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), vercelDevApiPlugin()],
  build: {
    outDir: 'dist',
  },
});
