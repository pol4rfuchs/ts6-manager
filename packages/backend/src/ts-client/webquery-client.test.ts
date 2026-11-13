import { describe, it, expect, vi } from 'vitest';
import { WebQueryClient } from './webquery-client.js';

function staleSocketError(message: string, code?: string) {
  const err: any = new Error(message);
  if (code) err.code = code;
  return err;
}

function okResponse(body: any = { ok: 1 }) {
  return { data: { status: { code: 0, message: 'ok' }, body } };
}

// Pin the mocked transport in place: resetTransport would otherwise replace
// this.http with a real axios instance mid-test.
function pinTransport(client: WebQueryClient, impl: any) {
  (client as any).http = impl;
  return vi.spyOn(client as any, 'resetTransport').mockImplementation(() => {});
}

describe('WebQueryClient stale keep-alive retry', () => {
  it('resets the transport and retries once when the socket was closed server-side', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn()
      .mockRejectedValueOnce(staleSocketError('socket hang up', 'ECONNRESET'))
      .mockResolvedValueOnce(okResponse());
    const reset = pinTransport(client, { get });

    const result = await client.execute(1, 'serverinfo');
    expect(result).toEqual({ ok: 1 });
    expect(get).toHaveBeenCalledTimes(2);
    // The corrupted agent must be rebuilt, not reused: a rotten transport
    // previously failed every request until the server entry was re-added
    expect(reset).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('does not retry more than once', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockRejectedValue(staleSocketError('socket hang up', 'ECONNRESET'));
    pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/socket hang up/);
    expect(get).toHaveBeenCalledTimes(2);
    client.destroy();
  });

  it('does not retry TS API errors (HTTP response received)', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockResolvedValue({ data: { status: { code: 1538, message: 'invalid parameter' } } });
    const reset = pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/invalid parameter/);
    expect(get).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    client.destroy();
  });

  it('does not retry non-socket network errors', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockRejectedValue(staleSocketError('timeout of 15000ms exceeded', 'ECONNABORTED'));
    const reset = pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/timeout/);
    expect(get).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    client.destroy();
  });

  it('retries POST requests the same way', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const post = vi.fn()
      .mockRejectedValueOnce(staleSocketError('read ECONNRESET', 'ECONNRESET'))
      .mockResolvedValueOnce(okResponse());
    const reset = pinTransport(client, { post });

    const result = await client.executePost(1, 'clientaddperm', { foo: 'bar' });
    expect(result).toEqual({ ok: 1 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('opens the circuit: no reset churn within the cooldown window', async () => {
    // When the TS server flood-protects us (error 524 / connection resets),
    // every reconnection feeds its flood counter — one reset per window max.
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockRejectedValue(staleSocketError('socket hang up', 'ECONNRESET'));
    const reset = pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(); // reset + retry
    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(); // fail fast, no churn
    expect(get).toHaveBeenCalledTimes(3);
    expect(reset).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('resetTransport really replaces the agent and axios instance', () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const agentBefore = (client as any).agent;
    const httpBefore = (client as any).http;

    (client as any).resetTransport();

    expect((client as any).agent).not.toBe(agentBefore);
    expect((client as any).http).not.toBe(httpBefore);
    client.destroy();
  });
});

describe('WebQueryClient flood protection', () => {
  it('shares one request between identical concurrent read-only calls and reuses the answer for a moment', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockResolvedValue(okResponse({ list: [1, 2] }));
    pinTransport(client, { get });

    const [a, b, c] = await Promise.all([
      client.execute(1, 'channellist'),
      client.execute(1, 'channellist'),
      client.execute(1, 'channellist'),
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ list: [1, 2] });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // a different command or different parameters is a different request
    await client.execute(1, 'clientlist');
    await client.execute(1, 'channellist', { x: 1 });
    expect(get).toHaveBeenCalledTimes(3);
    client.destroy();
  });

  it('does not cache commands that change something and drops the cache after them', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockResolvedValue(okResponse());
    pinTransport(client, { get });

    await client.execute(1, 'channellist');
    await client.execute(1, 'channelcreate', { channel_name: 'a' });
    await client.execute(1, 'channelcreate', { channel_name: 'a' });
    await client.execute(1, 'channellist');
    expect(get).toHaveBeenCalledTimes(4);
    client.destroy();
  });

  it('keeps the requests below the server flood limit', async () => {
    vi.useFakeTimers();
    try {
      const client = new WebQueryClient('10.0.0.1', 10080, 'key');
      const times: number[] = [];
      const get = vi.fn().mockImplementation(async () => { times.push(Date.now()); return okResponse(); });
      pinTransport(client, { get });

      // 10 different requests for a virtual server (2 commands each for the server)
      const all = Promise.all(Array.from({ length: 10 }, (_, i) => client.execute(1, 'channelinfo', { cid: i })));
      await vi.advanceTimersByTimeAsync(20_000);
      await all;
      expect(get).toHaveBeenCalledTimes(10);
      // never more than 8 commands (= 4 requests) within any 3 s window
      for (let i = 0; i < times.length; i++) {
        const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 3000).length;
        expect(inWindow * 2).toBeLessThanOrEqual(8);
      }
      client.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops sending after "client is flooding" and says what to do', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockResolvedValue({ data: { status: { code: 524, message: 'client is flooding' } } });
    pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/client is flooding/);
    // while the backoff lasts nothing is sent to the server
    for (let i = 0; i < 5; i++) {
      await expect(client.execute(1, 'clientlist')).rejects.toThrow(/query_ip_allowlist/);
    }
    expect(get).toHaveBeenCalledTimes(1);
    // our own notice must not extend the backoff
    const until = (client as any).floodUntil;
    await expect(client.execute(1, 'clientlist')).rejects.toThrow();
    expect((client as any).floodUntil).toBe(until);
    client.destroy();
  });

  it('asks again after the backoff and forgets it after a success', async () => {
    vi.useFakeTimers();
    try {
      const client = new WebQueryClient('10.0.0.1', 10080, 'key');
      const get = vi.fn()
        .mockResolvedValueOnce({ data: { status: { code: 524, message: 'client is flooding' } } })
        .mockResolvedValue(okResponse());
      pinTransport(client, { get });

      await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/flooding/);
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(client.execute(1, 'clientlist')).resolves.toEqual({ ok: 1 });
      expect((client as any).floodBackoffMs).toBe(0);
      client.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
