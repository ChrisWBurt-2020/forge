import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { unwrapEnvelope } from '../src/hooks/envelope.js';
import { type Operation, Transport } from '../src/transport.js';

describe('unwrapEnvelope', () => {
  test('returns the body as it is', () => {
    const body = { success: true, errors: [], messages: [], result: { id: 'a' } };
    assert.equal(unwrapEnvelope(new Response(), body), body);
  });

  test("leaves the clients' bodies as they are", async () => {
    const body = { success: true, errors: [], messages: [], result: { id: 'a' } };
    const transport = new Transport({
      token: 'secret',
      baseUrl: 'https://api.test',
      fetch: (async () => new Response(JSON.stringify(body))) as typeof fetch,
    });
    const get: Operation = { method: 'GET', route: '/a', response: null };
    assert.deepEqual(await transport.send(get, undefined, undefined), body);
  });
});
