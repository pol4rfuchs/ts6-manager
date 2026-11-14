import { describe, it, expect } from 'vitest';
import { FlowRunner } from './flow-runner.js';

type Call = { cmd: string; params: any };

function setup(whoami: { client_id: string; client_channel_id: string }) {
  const calls: Call[] = [];
  const client: any = {
    execute: async () => [whoami],
    executePost: async (_sid: number, cmd: string, params: any) => { calls.push({ cmd, params }); return []; },
  };
  const ctx: any = { sid: 1, eventData: {}, resolveTemplate: async (s: string) => s };
  const runner: any = new FlowRunner({} as any, {} as any, {} as any);
  return { calls, client, ctx, runner };
}

describe('action_message to a channel', () => {
  it('does not move the query client when it already is in the target channel (TS error 770)', async () => {
    const { calls, client, ctx, runner } = setup({ client_id: '7', client_channel_id: '1' });
    await runner.executeMessage({ targetMode: 2, target: '1', message: 'hi' }, ctx, client);
    expect(calls.map((c) => c.cmd)).toEqual(['sendtextmessage']);
    expect(calls[0].params).toMatchObject({ targetmode: 2, msg: 'hi' });
  });

  it('moves into the channel, sends and moves back when it is elsewhere', async () => {
    const { calls, client, ctx, runner } = setup({ client_id: '7', client_channel_id: '1' });
    await runner.executeMessage({ targetMode: 2, target: '5', message: 'hi' }, ctx, client);
    expect(calls.map((c) => c.cmd)).toEqual(['clientmove', 'sendtextmessage', 'clientmove']);
    expect(calls[0].params).toEqual({ clid: '7', cid: '5' });
    expect(calls[2].params).toEqual({ clid: '7', cid: '1' });
  });
});
