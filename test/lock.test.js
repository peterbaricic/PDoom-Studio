// test/lock.test.js
import { test, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock } from '../studio/lock.js';

const dbPath = () => join(mkdtempSync(join(tmpdir(), 'lock-')), 'studio.db');

test('acquire writes a lock file and release removes it', () => {
  const db = dbPath();
  const release = acquireLock(db, 4321);
  expect(JSON.parse(readFileSync(`${db}.lock`, 'utf8'))).toEqual({ pid: process.pid, port: 4321 });
  release();
  expect(existsSync(`${db}.lock`)).toBe(false);
});

test('a second acquire with a live pid throws', () => {
  const db = dbPath();
  acquireLock(db, 4321);
  expect(() => acquireLock(db, 4322)).toThrow(`another studio is already running on this database (pid ${process.pid}, http://localhost:4321/)`);
});

test('a stale lock (a dead pid) is taken over', async () => {
  const db = dbPath();
  const p = Bun.spawn(['true']);
  await p.exited;
  writeFileSync(`${db}.lock`, JSON.stringify({ pid: p.pid, port: 4321 }));
  const release = acquireLock(db, 4322);
  expect(JSON.parse(readFileSync(`${db}.lock`, 'utf8'))).toEqual({ pid: process.pid, port: 4322 });
  release();
  expect(existsSync(`${db}.lock`)).toBe(false);
});

test('release does not delete a lock now held by another pid', () => {
  const db = dbPath();
  const release = acquireLock(db, 4321);
  writeFileSync(`${db}.lock`, JSON.stringify({ pid: process.pid + 1, port: 9999 }));
  release();
  expect(existsSync(`${db}.lock`)).toBe(true);
});

test('an empty or corrupt lock file is stale', () => {
  for (const content of ['', '{"pid":', 'null', '{"port":1}']) {
    const db = dbPath();
    writeFileSync(`${db}.lock`, content);
    const release = acquireLock(db, 4323);
    expect(JSON.parse(readFileSync(`${db}.lock`, 'utf8'))).toEqual({ pid: process.pid, port: 4323 });
    release();
  }
});
