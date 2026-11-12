import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForEngineHealth } from '../main/engine-health.mjs';

const wait = (overrides) => {
  const lines = [];
  const result = waitForEngineHealth({
    request: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
    active: () => true,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    timeoutMs: 60,
    intervalMs: 5,
    ...overrides,
  });
  return { lines, result };
};

test('a health wait that times out logs how long it waited, that the engine ran, and the last failure', async () => {
  const { lines, result } = wait({});
  assert.equal(await result, false);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^Background service health check timed out after \d+\.\ds\. Engine process still running: yes\. Last health check: ECONNREFUSED\.$/,
  );
});

test('a health wait reports an HTTP status, a timeout or an unexpected body as the last failure', async () => {
  const responses = [
    [{ ok: false, status: 503 }, 'HTTP 503'],
    [{ ok: true, status: 200, json: async () => ({ ok: false }) }, 'unexpected response'],
    [null, 'TimeoutError'],
  ];
  for (const [response, expected] of responses) {
    const { lines, result } = wait({
      request: async () => {
        if (response) return response;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    assert.equal(await result, false);
    assert.match(lines[0], new RegExp(`Last health check: ${expected}\\.$`));
  }
});

test('a health wait notes when the engine process is gone and when no check ran', async () => {
  const { lines, result } = wait({ active: () => false, timeoutMs: 0 });
  assert.equal(await result, false);
  assert.match(lines[0], /Engine process still running: no\. Last health check: none\.$/);
});

test('a health wait that succeeds, is aborted or loses its engine writes nothing', async () => {
  const healthy = wait({ request: async () => ({ ok: true, json: async () => ({ ok: true }) }) });
  assert.equal(await healthy.result, true);
  assert.deepEqual(healthy.lines, []);

  const controller = new AbortController();
  controller.abort();
  const aborted = wait({ signal: controller.signal });
  assert.equal(await aborted.result, false);
  assert.deepEqual(aborted.lines, []);

  let running = true;
  const exited = wait({
    active: () => running,
    request: async () => {
      running = false;
      throw new Error('gone');
    },
    timeoutMs: 1000,
  });
  assert.equal(await exited.result, false);
  assert.deepEqual(exited.lines, []);
});
