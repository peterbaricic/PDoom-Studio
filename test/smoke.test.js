import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';

test('bun:sqlite is available', () => {
  const db = new Database(':memory:');
  expect(db.query('select 1 as one').get()).toEqual({ one: 1 });
});
