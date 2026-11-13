import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { TSApiError } from '../middleware/error-handler.js';
import { config } from '../config.js';

export class WebQueryClient {
  private http!: AxiosInstance;
  private agent!: http.Agent | https.Agent;
  private lastTransportReset = 0;
  // Circuit breaker: when the server is flood-protecting us, every reset
  // opens yet another query connection and feeds the flood counter. One
  // reset attempt per window, then fail fast.
  private static readonly RESET_COOLDOWN_MS = 5000;

  // TeamSpeak 6 bans a query client that sends more than
  // serverinstance_serverquery_flood_commands (default 10) commands within
  // flood_time (default 3 s) for ban_time (default 600 s), and a request with a
  // virtual server id ("/{sid}/{command}") counts as two commands (use + the
  // command). A page that loads several lists at once easily crosses that, and
  // the ban then outlasts a restart of this app. So requests are paced to stay
  // below the default limit, and when the server still answers "flooding" no
  // further request is sent for a while (backoff) instead of feeding the ban.
  private static readonly FLOOD_WINDOW_MS = 3000;
  private static readonly FLOOD_BUDGET = 8;
  private static readonly FLOOD_BACKOFF_START_MS = 30_000;
  private static readonly FLOOD_BACKOFF_MAX_MS = 300_000;
  private sentCommands: { at: number; weight: number }[] = [];
  private floodUntil = 0;
  private floodBackoffMs = 0;

  // A page often asks for the same list several times in a row (several
  // components, quick reloads). Identical read-only requests that are already
  // running share one answer, and the answer is reused for a second.
  private static readonly READ_ONLY = /^(?:[a-z]+(?:list|info|find)|version|whoami|logview)$/;
  private static readonly READ_CACHE_MS = 1000;
  private inflight = new Map<string, Promise<any>>();
  private readCache = new Map<string, { at: number; value: any }>();

  constructor(
    private host: string,
    private port: number,
    private apiKey: string,
    private useHttps: boolean = false,
  ) {
    this.createTransport();
  }

  // Use a single persistent TCP connection (keep-alive) to the TS WebQuery API.
  // Without this, each concurrent request opens a new TCP connection, and the
  // TS server registers each one as a separate "serveradmin" query client
  // (serveradmin, serveradmin1, serveradmin2, ...).
  private createTransport(): void {
    const protocol = this.useHttps ? 'https' : 'http';

    this.agent = this.useHttps
      ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: !config.tsAllowSelfSigned })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });

    this.http = axios.create({
      baseURL: `${protocol}://${this.host}:${this.port}`,
      headers: { 'x-api-key': this.apiKey },
      timeout: 15000,
      httpAgent: this.useHttps ? undefined : this.agent,
      httpsAgent: this.useHttps ? this.agent : undefined,
    });
  }

  // A long-lived agent can rot irrecoverably: its single keep-alive socket
  // may die silently (NAT/conntrack expiry, server-side close without RST)
  // while Node still considers it established, and with maxSockets: 1 every
  // request then funnels through the corpse. Rebuild agent + axios so the
  // retry behaves exactly like a freshly created client.
  private resetTransport(): void {
    try { this.agent.destroy(); } catch { }
    this.createTransport();
    console.warn(`[WebQuery] Transport reset for ${this.host}:${this.port} after a stale-socket error`);
  }

  // The single keep-alive socket can be closed server-side while idle; the
  // next request then fails instantly with ECONNRESET/"socket hang up". The
  // errored socket is discarded from the pool, so one retry on a fresh
  // connection is safe — but only for errors where no response was received.
  private isStaleSocketError(error: any): boolean {
    if (error.response) return false;
    const code = error.code || '';
    const msg = error.message || '';
    return code === 'ECONNRESET' || code === 'EPIPE' || msg.includes('socket hang up');
  }

  private async withStaleSocketRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      if (!this.isStaleSocketError(error)) throw error;
      const now = Date.now();
      if (now - this.lastTransportReset < WebQueryClient.RESET_COOLDOWN_MS) {
        throw error;
      }
      this.lastTransportReset = now;
      this.resetTransport();
      return await fn();
    }
  }

  private toApiError(error: any): TSApiError {
    let apiError: TSApiError;
    if (error instanceof TSApiError) apiError = error;
    else if (error.response?.data?.status) {
      apiError = new TSApiError(error.response.data.status.code, error.response.data.status.message);
    } else apiError = new TSApiError(-1, error.message || 'Connection failed');
    if (this.isFloodError(apiError)) this.noteFlood();
    return apiError;
  }

  private isFloodError(error: any): boolean {
    return error instanceof TSApiError && !(error as any).floodBlocked && /flood/i.test(error.message);
  }

  private assertNotFloodBlocked(): void {
    const left = this.floodUntil - Date.now();
    if (left > 0) {
      const blocked = new TSApiError(
        -1,
        `TeamSpeak flood protection is active for this client; waiting ${Math.ceil(left / 1000)} s before asking again. ` +
          'Add the Supervisor network to query_ip_allowlist in the TeamSpeak 6 app.',
      );
      (blocked as any).floodBlocked = true; // our own message, not a new report from the server
      throw blocked;
    }
  }

  private noteFlood(): void {
    this.floodBackoffMs = Math.min(
      this.floodBackoffMs ? this.floodBackoffMs * 2 : WebQueryClient.FLOOD_BACKOFF_START_MS,
      WebQueryClient.FLOOD_BACKOFF_MAX_MS,
    );
    this.floodUntil = Date.now() + this.floodBackoffMs;
    console.warn(`[WebQuery] TeamSpeak reports flooding for ${this.host}:${this.port}; pausing requests for ${Math.round(this.floodBackoffMs / 1000)} s`);
  }

  // Wait until sending one more request keeps the commands in the last
  // FLOOD_WINDOW_MS below FLOOD_BUDGET.
  private async pace(sid: number): Promise<void> {
    const weight = sid > 0 ? 2 : 1;
    for (;;) {
      const now = Date.now();
      this.sentCommands = this.sentCommands.filter((c) => now - c.at < WebQueryClient.FLOOD_WINDOW_MS);
      const used = this.sentCommands.reduce((sum, c) => sum + c.weight, 0);
      if (used + weight <= WebQueryClient.FLOOD_BUDGET) {
        this.sentCommands.push({ at: now, weight });
        return;
      }
      const wait = this.sentCommands[0].at + WebQueryClient.FLOOD_WINDOW_MS - now;
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 20)));
    }
  }

  private async send<T>(sid: number, fn: () => Promise<T>): Promise<T> {
    this.assertNotFloodBlocked();
    await this.pace(sid);
    this.assertNotFloodBlocked();
    const result = await fn();
    this.floodBackoffMs = 0;
    return result;
  }

  async execute(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    if (!WebQueryClient.READ_ONLY.test(command)) {
      this.readCache.clear();
      return this.executeNow(sid, command, params);
    }
    const key = `${sid}:${command}:${JSON.stringify(this.cleanParams(params) ?? {})}`;
    const cached = this.readCache.get(key);
    if (cached && Date.now() - cached.at < WebQueryClient.READ_CACHE_MS) return structuredClone(cached.value);
    let running = this.inflight.get(key);
    if (!running) {
      running = this.executeNow(sid, command, params)
        .then((value) => {
          this.readCache.set(key, { at: Date.now(), value });
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, running);
    }
    return structuredClone(await running);
  }

  private async executeNow(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    try {
      // WebQuery URL pattern: /{sid}/{command}
      // For instance-level commands (sid=0): /{command}
      const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;

      const response = await this.send(sid, () =>
        this.withStaleSocketRetry(() => this.http.get(path, { params: this.cleanParams(params) })),
      );

      const data = response.data;

      if (data.status && data.status.code !== 0) {
        throw new TSApiError(data.status.code, data.status.message);
      }

      return data.body || data;
    } catch (error: any) {
      throw this.toApiError(error);
    }
  }

  async executePost(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    this.readCache.clear();
    try {
      const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;
      const response = await this.send(sid, () =>
        this.withStaleSocketRetry(() => this.http.post(path, null, { params: this.cleanParams(params) })),
      );

      const data = response.data;
      if (data.status && data.status.code !== 0) {
        throw new TSApiError(data.status.code, data.status.message);
      }

      return data.body || data;
    } catch (error: any) {
      throw this.toApiError(error);
    }
  }

  // Remove undefined/null values from params
  private cleanParams(params?: Record<string, any>): Record<string, any> | undefined {
    if (!params) return undefined;
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        cleaned[key] = value;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  // Test connection
  async testConnection(): Promise<boolean> {
    try {
      await this.execute(0, 'version');
      return true;
    } catch {
      return false;
    }
  }

  // Destroy the HTTP agent, closing all keep-alive sockets.
  // Call this for temporary clients (e.g. test connection) to avoid lingering query logins.
  destroy(): void {
    this.agent.destroy();
  }
}
