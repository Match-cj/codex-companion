import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function sessionAppendStartOffset(');
const end = source.indexOf('function sessionKindFromMeta(');
const context = {};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)};this.sessionAppendStartOffset=sessionAppendStartOffset;`, context);

test('session monitor quarantines multi-callback rewrites', () => {
  assert.match(source, /codexSessionRewrites\.set\(file/);
  assert.match(source, /historical[\r\n]+\s*\/\/ bytes as fresh conversation events/);
});

test('opening an old project after monitoring starts does not replay its history', () => {
  assert.equal(context.sessionAppendStartOffset(5000, { size: 1200, birthtimeMs: 1 }, Date.now()), 1200);
  assert.equal(context.sessionAppendStartOffset(5000, { size: 5000, birthtimeMs: 1 }, Date.now()), 5000);
});

test('a newly created session file is read from the beginning once', () => {
  const now = Date.now();
  assert.equal(context.sessionAppendStartOffset(null, { size: 1200, birthtimeMs: now - 1000 }, now), 0);
  assert.equal(context.sessionAppendStartOffset(null, { size: 1200, birthtimeMs: now - 10 * 60 * 1000 }, now), 1200);
});

test('historical JSONL events are rejected by their event timestamp', () => {
  assert.match(source, /function isFreshCodexSessionEvent\(/);
  const helperStart = source.indexOf('function isFreshCodexSessionEvent(');
  const helperEnd = source.indexOf('function observeSessionPrompt(', helperStart);
  const helperContext = {};
  vm.createContext(helperContext);
  vm.runInContext(`${source.slice(helperStart, helperEnd)};this.isFreshCodexSessionEvent=isFreshCodexSessionEvent;`, helperContext);
  const cutoff = Date.parse('2026-10-19T10:00:00.000Z');
  assert.equal(helperContext.isFreshCodexSessionEvent({ timestamp: '2026-10-19T09:59:00.000Z' }, cutoff), false);
  assert.equal(helperContext.isFreshCodexSessionEvent({ timestamp: '2026-10-19T10:00:01.000Z' }, cutoff), true);
});
