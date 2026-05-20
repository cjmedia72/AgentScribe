// Tests for Wave 3 correlation-engine extensions.
// Run: node --test tests/wave3/correlation-engine.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  correlate,
  correlateWsFrames,
  inferPagination,
  tagMutation
} from '../../correlation-engine.js';

// ---------------------------------------------------------------------------
// Sanity: existing export still works
// ---------------------------------------------------------------------------

test('correlate() existing signature still functions', () => {
  const dom = [{ id: 'd1', timestamp: 1000 }];
  const net = [{ requestId: 'r1', url: 'https://example.com/api', method: 'GET', timestamp: 1500, resourceType: 'Fetch' }];
  const out = correlate(dom, net);
  assert.equal(out.networkEvents.length, 1);
  assert.equal(out.networkEvents[0].correlatedToDomEventId, 'd1');
});

// ---------------------------------------------------------------------------
// correlateWsFrames
// ---------------------------------------------------------------------------

test('WS: groups outbound + inbound replies inside window', () => {
  const frames = [
    { connection_id: 'c1', direction: 'outbound', timestamp: 1000, payload: 'hello' },
    { connection_id: 'c1', direction: 'inbound',  timestamp: 1100, payload: 'ack' },
    { connection_id: 'c1', direction: 'inbound',  timestamp: 1200, payload: 'data' }
  ];
  const ex = correlateWsFrames(frames);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].connection_id, 'c1');
  assert.equal(ex[0].request_frame.payload, 'hello');
  assert.equal(ex[0].response_frames.length, 2);
  assert.equal(ex[0].timing_ms, 200);
});

test('WS: server-initiated exchange (inbound -> outbound replies)', () => {
  const frames = [
    { connection_id: 'c2', direction: 'inbound',  timestamp: 5000, payload: 'push' },
    { connection_id: 'c2', direction: 'outbound', timestamp: 5050, payload: 'ack' }
  ];
  const ex = correlateWsFrames(frames);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].request_frame.direction, 'inbound');
  assert.equal(ex[0].response_frames.length, 1);
  assert.equal(ex[0].timing_ms, 50);
});

test('WS: frame outside window does not get grouped', () => {
  const frames = [
    { connection_id: 'c3', direction: 'outbound', timestamp: 0, payload: 'q1' },
    { connection_id: 'c3', direction: 'inbound',  timestamp: 5000, payload: 'r1' } // 5s > default 2s window
  ];
  const ex = correlateWsFrames(frames);
  assert.equal(ex.length, 2);
  assert.equal(ex[0].response_frames.length, 0);
  assert.equal(ex[0].timing_ms, null);
});

test('WS: separates exchanges across connection_ids', () => {
  const frames = [
    { connection_id: 'cA', direction: 'outbound', timestamp: 100, payload: 'a' },
    { connection_id: 'cB', direction: 'outbound', timestamp: 110, payload: 'b' },
    { connection_id: 'cA', direction: 'inbound',  timestamp: 150, payload: 'a-ack' },
    { connection_id: 'cB', direction: 'inbound',  timestamp: 160, payload: 'b-ack' }
  ];
  const ex = correlateWsFrames(frames);
  assert.equal(ex.length, 2);
  const a = ex.find(e => e.connection_id === 'cA');
  const b = ex.find(e => e.connection_id === 'cB');
  assert.equal(a.response_frames[0].payload, 'a-ack');
  assert.equal(b.response_frames[0].payload, 'b-ack');
});

test('WS: empty input returns []', () => {
  assert.deepEqual(correlateWsFrames([]), []);
  assert.deepEqual(correlateWsFrames(null), []);
  assert.deepEqual(correlateWsFrames(undefined), []);
});

// ---------------------------------------------------------------------------
// inferPagination
// ---------------------------------------------------------------------------

test('pagination: detects nextPageToken cursor', () => {
  const ev = { responseBodyParsed: { items: [1, 2, 3], nextPageToken: 'abc123' } };
  const out = inferPagination(ev);
  assert.equal(out.has_pagination, true);
  assert.equal(out.scheme, 'cursor');
  assert.equal(out.cursor_field, 'nextPageToken');
  assert.equal(out.cursor_value_example, 'abc123');
});

test('pagination: detects snake_case next_page_token', () => {
  const ev = { responseBodyParsed: { results: [], next_page_token: 'xyz' } };
  const out = inferPagination(ev);
  assert.equal(out.has_pagination, true);
  assert.equal(out.cursor_field, 'next_page_token');
});

test('pagination: detects nested pagination.next', () => {
  const ev = { responseBodyParsed: { data: [], pagination: { next: '/api/x?page=2' } } };
  const out = inferPagination(ev);
  assert.equal(out.has_pagination, true);
  assert.equal(out.scheme, 'cursor');
  assert.equal(out.cursor_field, 'pagination.next');
  assert.equal(out.cursor_value_example, '/api/x?page=2');
});

test('pagination: detects page-number scheme', () => {
  const ev = { responseBodyParsed: { items: [], page: 3, total_pages: 10 } };
  const out = inferPagination(ev);
  assert.equal(out.has_pagination, true);
  assert.equal(out.scheme, 'page-number');
  assert.equal(out.cursor_field, 'page');
});

test('pagination: detects Link: rel="next" header', () => {
  const ev = {
    responseHeaders: [{ name: 'Link', value: '<https://api.example.com/x?page=2>; rel="next"' }],
    responseBodyParsed: { items: [] }
  };
  const out = inferPagination(ev);
  assert.equal(out.has_pagination, true);
  assert.equal(out.scheme, 'link-header');
  assert.equal(out.cursor_value_example, 'https://api.example.com/x?page=2');
});

test('pagination: no pagination markers returns false', () => {
  const ev = { responseBodyParsed: { user: { id: 42, name: 'cj' } } };
  const out = inferPagination(ev);
  assert.equal(out.has_pagination, false);
  assert.equal(out.scheme, null);
  assert.equal(out.cursor_field, null);
});

test('pagination: parses string responseBody as fallback', () => {
  const ev = { responseBody: '{"items":[1],"nextPageToken":"tok-7"}' };
  const out = inferPagination(ev);
  assert.equal(out.has_pagination, true);
  assert.equal(out.cursor_value_example, 'tok-7');
});

test('pagination: garbage body does not throw', () => {
  const ev = { responseBody: 'not json at all <html>' };
  const out = inferPagination(ev);
  assert.equal(out.has_pagination, false);
});

// ---------------------------------------------------------------------------
// tagMutation
// ---------------------------------------------------------------------------

test('mutation: GET is never a mutation', () => {
  assert.equal(tagMutation({ method: 'GET' }), false);
  assert.equal(tagMutation({ method: 'HEAD' }), false);
  assert.equal(tagMutation({ method: 'OPTIONS' }), false);
});

test('mutation: DELETE always mutates', () => {
  assert.equal(tagMutation({ method: 'DELETE' }), true);
});

test('mutation: POST that creates a resource -> true', () => {
  const ev = {
    method: 'POST',
    responseBodyParsed: { id: 99, status: 'created', created_at: '2026-05-20' }
  };
  assert.equal(tagMutation(ev), true);
});

test('mutation: POST that returns search results -> false', () => {
  const ev = {
    method: 'POST',
    responseBodyParsed: { results: [{ x: 1 }, { x: 2 }], totalHits: 2 }
  };
  assert.equal(tagMutation(ev), false);
});

test('mutation: POST that returns a top-level array -> false (list read)', () => {
  const ev = { method: 'POST', responseBodyParsed: [{ id: 1 }, { id: 2 }] };
  assert.equal(tagMutation(ev), false);
});

test('mutation: PUT with status field -> true', () => {
  const ev = { method: 'PUT', responseBodyParsed: { status: 'updated' } };
  assert.equal(tagMutation(ev), true);
});

test('mutation: PATCH with no response body -> true (default)', () => {
  assert.equal(tagMutation({ method: 'PATCH' }), true);
});

test('mutation: empty object after POST -> true (no-op create)', () => {
  assert.equal(tagMutation({ method: 'POST', responseBodyParsed: {} }), true);
});

test('mutation: handles malformed input gracefully', () => {
  assert.equal(tagMutation(null), false);
  assert.equal(tagMutation(undefined), false);
  assert.equal(tagMutation({}), false);
  assert.equal(tagMutation({ method: 'POST', responseBody: 'not json' }), true);
});
