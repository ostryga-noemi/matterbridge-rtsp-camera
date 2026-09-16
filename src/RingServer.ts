import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface RingServerConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
  cooldownMs?: number;
}
export type RingResult = 'ok' | 'not-found' | 'unavailable';

/** Opt-in local webhook. A successful response means Matter accepted the event,
 * not that a controller or television displayed a notification. */
export class RingServer {
  private readonly server: Server;
  private readonly token: Buffer;
  private readonly host: string;
  private readonly port: number;
  private readonly cooldown: number;
  private readonly lastRing = new Map<string, number>();
  private readonly busy = new Set<string>();
  private stopping = false;

  constructor(config: RingServerConfig, private readonly ring: (id: string) => Promise<RingResult>) {
    if (!config.token || config.token.length < 32 || /\s/.test(config.token)) {
      throw new Error('ringServer.token must contain at least 32 characters without whitespace');
    }
    this.token = Buffer.from(`Bearer ${config.token}`);
    this.host = config.host ?? '127.0.0.1';
    this.port = config.port ?? 8787;
    this.cooldown = config.cooldownMs ?? 1000;
    if (!this.host.trim()) throw new Error('ringServer.host cannot be empty');
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('Invalid ringServer.port');
    if (!Number.isInteger(this.cooldown) || this.cooldown < 0 || this.cooldown > 60000) throw new Error('Invalid ringServer.cooldownMs');
    this.server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
      void this.handle(req, res).catch(() => this.reply(res, 503, 'unavailable'));
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.keepAliveTimeout = 1000;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve());
      this.server.closeIdleConnections();
    });
  }

  private reply(res: ServerResponse, status: number, result: string): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(JSON.stringify({ result }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume();
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== this.token.length || !timingSafeEqual(supplied, this.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return this.reply(res, 401, 'unauthorized');
    }
    if (this.stopping) return this.reply(res, 503, 'unavailable');
    const match = /^\/api\/cameras\/([^/?]+)\/ring$/.exec(req.url ?? '');
    if (!match) return this.reply(res, 404, 'not-found');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return this.reply(res, 405, 'method-not-allowed');
    }
    let id: string;
    try { id = decodeURIComponent(match[1]!); }
    catch { return this.reply(res, 400, 'invalid-camera-id'); }
    if (this.busy.has(id) || Date.now() - (this.lastRing.get(id) ?? 0) < this.cooldown) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(this.cooldown / 1000))));
      return this.reply(res, 429, 'rate-limited');
    }
    this.busy.add(id);
    try {
      const result = await this.ring(id);
      if (result === 'ok') this.lastRing.set(id, Date.now());
      this.reply(res, result === 'ok' ? 200 : result === 'not-found' ? 404 : 503, result);
    } finally {
      this.busy.delete(id);
    }
  }
}
