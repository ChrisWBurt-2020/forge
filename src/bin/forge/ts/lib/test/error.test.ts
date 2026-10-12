import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ApiError, errorMessage } from '../src/error.js';

describe('ApiError', () => {
  test('holds the response and details', () => {
    const response = new Response('{}', { status: 422 });
    const cause = new Error('cause');
    const error = new ApiError('invalid', response, { field: 'a' }, { cause });
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, 'ApiError');
    assert.equal(error.message, 'invalid');
    assert.equal(error.status, 422);
    assert.equal(error.response, response);
    assert.deepEqual(error.details, { field: 'a' });
    assert.equal(error.cause, cause);
    assert.match(String(error.stack), /^ApiError: invalid/);
  });

  test('has no cause without options', () => {
    const error = new ApiError('x', new Response(null, { status: 500 }), '');
    assert.equal('cause' in error, false);
  });
});

describe('errorMessage', () => {
  test('reads the top-level message fields in order', () => {
    const body = { message: 'm', error: 'e', detail: 'd', title: 't' };
    assert.equal(errorMessage(body), 'm');
    assert.equal(errorMessage({ ...body, message: undefined }), 'e');
    assert.equal(errorMessage({ detail: 'd', title: 't' }), 'd');
    assert.equal(errorMessage({ title: 't' }), 't');
  });

  test('skips fields that are empty or not strings', () => {
    assert.equal(errorMessage({ message: '', error: 'e' }), 'e');
    assert.equal(errorMessage({ message: 1, detail: 'd' }), 'd');
    assert.equal(errorMessage({ message: ['m'], title: 't' }), 't');
  });

  test('reads a nested error object', () => {
    assert.equal(errorMessage({ error: { message: 'm', detail: 'd' } }), 'm');
    assert.equal(errorMessage({ error: { detail: 'd' } }), 'd');
    assert.equal(errorMessage({ error: { message: '' } }), undefined);
  });

  test('prefers top-level fields to the nested error', () => {
    assert.equal(errorMessage({ error: { message: 'n' }, title: 't' }), 't');
  });

  test('joins the messages of an errors array', () => {
    assert.equal(
      errorMessage({
        errors: [{ message: 'a' }, 'b', { code: 1 }, '', 2, null, { message: 'c' }],
      }),
      'a; b; c',
    );
    assert.equal(errorMessage({ errors: [] }), undefined);
    assert.equal(errorMessage({ errors: [{ code: 1 }] }), undefined);
    assert.equal(errorMessage({ errors: 'a' }), undefined);
  });

  test('prefers the nested error to the errors array', () => {
    assert.equal(errorMessage({ error: { message: 'n' }, errors: [{ message: 'a' }] }), 'n');
  });

  test('returns undefined for bodies with no message', () => {
    for (const body of [undefined, null, 'message', 42, [{ message: 'm' }], {}, { code: 1 }]) {
      assert.equal(errorMessage(body), undefined);
    }
  });
});
