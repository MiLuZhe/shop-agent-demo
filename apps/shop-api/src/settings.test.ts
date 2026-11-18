import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverSettings } from './settings.ts';
import { databasePoolMax } from '@shop/database';

test('deployment settings preserve loopback defaults and accept bounded container settings', () => {
  assert.deepEqual(serverSettings({}), { host: '127.0.0.1', port: 3000, mode: 'disabled', concurrency: 2, copilotConcurrency: 2, queueLimit: 20 });
  assert.deepEqual(serverSettings({ API_HOST: '0.0.0.0', API_PORT: '3000', AGENT_MODE: 'deepseek', AGENT_CONCURRENCY: '1', COPILOT_CONCURRENCY: '1', AGENT_QUEUE_LIMIT: '4' }),
    { host: '0.0.0.0', port: 3000, mode: 'deepseek', concurrency: 1, copilotConcurrency: 1, queueLimit: 4 });
  assert.equal(databasePoolMax(), 10); assert.equal(databasePoolMax('5'), 5); assert.equal(databasePoolMax('20'), 20);
});

test('invalid bind, pool and admission settings fail without echoing values', () => {
  for (const [name, values] of Object.entries({ API_HOST: ['public.example', ''], API_PORT: ['0', '65536', '3000suffix'], AGENT_MODE: ['other'], AGENT_CONCURRENCY: ['0', '3', 'NaN'], COPILOT_CONCURRENCY: ['0', '3'], AGENT_QUEUE_LIMIT: ['0', '21'] })) {
    for (const value of values) assert.throws(() => serverSettings({ [name]: value }), new RegExp(`Invalid ${name}`));
  }
  for (const value of ['', '0', '21', '5suffix', 'Infinity']) assert.throws(() => databasePoolMax(value), /Invalid DATABASE_POOL_MAX/);
});
