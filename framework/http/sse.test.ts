import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEventStream, isMarkerOnly, parseSse, SseParser, terminalOf } from './sse.ts';

describe('SseParser', () => {
  it('dispatches on a blank line, joins data lines, defaults the event name, parses JSON', () => {
    const { events, partial } = parseSse('data: {"a":1}\n\nevent: delta\ndata: one\ndata: two\nid: 7\nretry: 50\n\n');
    assert.equal(partial, false);
    assert.deepEqual(events, [
      { event: 'message', data: '{"a":1}', json: { a: 1 } },
      { event: 'delta', data: 'one\ntwo', id: '7', retry: 50 },
    ]);
  });

  it('reads CRLF and CR line endings, also when a CRLF is split across chunks', () => {
    const parser = new SseParser();
    const first = parser.push('data: a\r');
    const second = parser.push('\n\r\ndata: b\r\r');
    assert.deepEqual(first, []);
    // The last `\r` may still be half of a `\r\n`: `b` completes when the stream ends.
    assert.deepEqual(
      second.map((e) => e.data),
      ['a'],
    );
    assert.deepEqual(
      parser.end().events.map((e) => e.data),
      ['b'],
    );
  });

  it('ignores comments (keep-alives), strips one leading space and a BOM, skips events without data', () => {
    const { events } = parseSse('\uFEFF: ping\n\nevent: empty\n\ndata:  two spaces\n\ndata:x\n\n');
    assert.deepEqual(
      events.map((e) => [e.event, e.data]),
      [
        ['message', ' two spaces'],
        ['message', 'x'],
      ],
    );
  });

  it('reports a stream that ends inside an event, and drops that event as a browser does', () => {
    const { events, partial } = parseSse('data: complete\n\ndata: half');
    assert.deepEqual(
      events.map((e) => e.data),
      ['complete'],
    );
    assert.equal(partial, true);
    assert.equal(parseSse('data: complete\n\n').partial, false);
  });

  it('keeps non-JSON data as text only', () => {
    const [done] = parseSse('data: [DONE]\n\n').events;
    assert.equal(done.json, undefined);
    assert.equal(done.data, '[DONE]');
  });
});

describe('stream helpers', () => {
  it('recognises the media type with parameters', () => {
    assert.equal(isEventStream('text/event-stream; charset=utf-8'), true);
    assert.equal(isEventStream('application/json'), false);
    assert.equal(isEventStream(undefined), false);
  });

  it('matches terminal markers by data or by event name', () => {
    const terminals = [{ data: '[DONE]' }, { event: 'message_stop' }];
    assert.deepEqual(terminalOf({ event: 'message', data: '[DONE]' }, terminals), { data: '[DONE]' });
    assert.deepEqual(terminalOf({ event: 'message_stop', data: '{}' }, terminals), { event: 'message_stop' });
    assert.equal(terminalOf({ event: 'message', data: '{}' }, terminals), undefined);
    assert.equal(isMarkerOnly({ data: '[DONE]' }), true);
    assert.equal(isMarkerOnly({ event: 'message_stop' }), false);
  });
});
