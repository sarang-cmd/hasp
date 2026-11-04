import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppearance } from '../app/appearance.mjs';

test('defaults to Foundry light and Nightshift dark', () => {
  assert.deepEqual(normalizeAppearance(null), { design: 'foundry', modes: { foundry: 'light', nightshift: 'dark' } });
});
test('keeps independent modes for each design', () => {
  assert.deepEqual(normalizeAppearance({ design: 'nightshift', modes: { foundry: 'dark', nightshift: 'light' } }), { design: 'nightshift', modes: { foundry: 'dark', nightshift: 'light' } });
});
test('invalid saved values fall back safely', () => {
  assert.deepEqual(normalizeAppearance({ design: 'other', modes: { foundry: 'unknown', nightshift: null } }), { design: 'foundry', modes: { foundry: 'light', nightshift: 'dark' } });
});
