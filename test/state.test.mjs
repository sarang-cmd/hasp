import test from 'node:test';
import assert from 'node:assert/strict';
import { filterItems, sampleItems } from '../app/state.mjs';

test('all sample records appear by default', () => assert.equal(filterItems(sampleItems).length, 8));
test('search ignores surrounding spaces and case', () => assert.deepEqual(filterItems(sampleItems, { query: ' STRIPE ' }).map(item => item.service), ['Stripe']));
test('filters compose', () => assert.deepEqual(filterItems(sampleItems, { query: 'groq', type: 'API key', environment: 'staging' }).map(item => item.name), ['Groq staging']));
test('no matches produce an empty list', () => assert.equal(filterItems(sampleItems, { query: 'no such item' }).length, 0));
test('sample records contain no secret values', () => assert.ok(sampleItems.every(item => !('secret' in item) && !('value' in item))));
