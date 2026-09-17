import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { RingServer } from './RingServer.js';

const token = 'test-token-for-doorbell-32-characters-minimum';
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test('HTTP ring: authentication, routing, failures, cooldown and shutdown', async () => {
  const port = await freePort();
  const calls: string[] = [];
  const server = new RingServer({ port, token }, async id => {
    calls.push(id);
    if (id === 'offline') return 'unavailable';
    if (id === 'error') throw new Error('sensitive internal detail');
    return id === 'front door' ? 'ok' : 'not-found';
  });
  await server.start();
  const request = (id = 'front%20door', method = 'POST', auth = token) => fetch(`http://127.0.0.1:${port}/api/cameras/${id}/ring`, {
    method, headers: { Authorization: `Bearer ${auth}` },
  });
  try {
    assert.equal((await request(undefined, undefined, 'bad')).status, 401);
    assert.equal((await request(undefined, 'GET')).status, 405);
    assert.equal(calls.length, 0);
    assert.equal((await request('%invalid')).status, 400);
    assert.equal((await request('unknown')).status, 404);
    assert.equal((await request('offline')).status, 503);
    const failure = await request('error');
    assert.equal(failure.status, 503);
    assert(! (await failure.text()).includes('sensitive'));
    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 429);
    assert.equal(calls.filter(id => id === 'front door').length, 1);
  } finally { await server.stop(); }
  await assert.rejects(request());
});

test('concurrent rings do not overlap; distinct cameras remain independent', async () => {
  const port = await freePort();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const server = new RingServer({ port, token, cooldownMs: 0 }, async id => {
    if (id === 'one') { entered(); await blocked; }
    return 'ok';
  });
  await server.start();
  const request = (id: string) => fetch(`http://127.0.0.1:${port}/api/cameras/${id}/ring`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  try {
    const first = request('one');
    await started;
    assert.equal((await request('one')).status, 429);
    assert.equal((await request('two')).status, 200);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await request('one')).status, 200);
  } finally { release(); await server.stop(); }
});

test('invalid configuration fails before listening', () => {
  const ring = async () => 'ok' as const;
  assert.throws(() => new RingServer({}, ring), /token/);
  assert.throws(() => new RingServer({ token, port: 0 }, ring), /port/);
  assert.throws(() => new RingServer({ token, cooldownMs: -1 }, ring), /cooldown/);
});
