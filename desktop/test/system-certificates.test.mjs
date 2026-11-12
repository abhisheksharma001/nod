import assert from 'node:assert/strict';
import test from 'node:test';
import { trustSystemCertificates } from '../main/system-certificates.mjs';

function fakeTLS(stores) {
  const set = [];
  return {
    set,
    getCACertificates: (type) => stores[type],
    setDefaultCACertificates: (certificates) => set.push(certificates),
  };
}

test('operating system certificates are added to the bundled and extra ones once', () => {
  const tls = fakeTLS({
    default: ['bundled', 'extra', 'shared'],
    system: ['private CA', 'shared'],
  });
  trustSystemCertificates(tls);
  assert.deepEqual(tls.set, [['bundled', 'extra', 'shared', 'private CA']]);
});

test('the default certificates stay untouched when the operating system adds none', () => {
  const tls = fakeTLS({ default: ['bundled'], system: [] });
  trustSystemCertificates(tls);
  assert.deepEqual(tls.set, []);
});
