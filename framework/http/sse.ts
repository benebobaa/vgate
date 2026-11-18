/**
 * Server-Sent Events, parsed the way a browser's EventSource does (WHATWG HTML, "event stream interpretation"), so a
 * stream the framework accepts is one a real client can read.
 */
import type { StreamTerminal } from '../config.ts';

export interface SseEvent {
  /** The `event:` field; `message` when the event names none. */
  event: string;
  /** The `data:` lines joined with `\n`. */
  data: string;
  /** The data parsed as JSON; undefined when it is not JSON (e.g. `[DONE]`). */
  json?: unknown;
  id?: string;
  retry?: number;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Incremental parser: feed it chunks as they arrive, it returns the events each chunk completed. */
export class SseParser {
  private buffer = '';
  private started = false;
  private event?: string;
  private data: string[] = [];
  private id?: string;
  private retry?: number;
  /** Fields were read since the last dispatch: the stream ended inside an event. */
  private open = false;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    if (!this.started && this.buffer.length > 0) {
      this.started = true;
      if (this.buffer.startsWith('﻿')) this.buffer = this.buffer.slice(1);
    }
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone `\r` at the end may be the first half of `\r\n`: wait for the next chunk.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** The stream closed. `partial` is true when it closed inside an event (no blank line after its fields). */
  end(): { events: SseEvent[]; partial: boolean } {
    const events: SseEvent[] = [];
    let rest = this.buffer;
    this.buffer = '';
    // A `\r` held back as a possible half of `\r\n` was a line ending after all.
    if (rest.endsWith('\r')) {
      const event = this.line(rest.slice(0, -1));
      if (event) events.push(event);
      rest = '';
    }
    // Per the standard an unterminated last event is dropped; the caller learns it through `partial`.
    if (rest.length > 0) this.line(rest);
    return { events, partial: this.open };
  }

  private line(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.open = true;
    if (name === 'event') this.event = value;
    else if (name === 'data') this.data.push(value);
    else if (name === 'id' && !value.includes('\0')) this.id = value;
    else if (name === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    const { event, data, id, retry } = this;
    // `id` is the event's own field here, not the browser's persisting lastEventId: the contract describes events.
    this.event = undefined;
    this.data = [];
    this.id = undefined;
    this.retry = undefined;
    this.open = false;
    // An event without data is not dispatched (the standard); `id` persists as the last event id.
    if (data.length === 0) return undefined;
    const text = data.join('\n');
    const json = parseJson(text);
    return {
      event: event || 'message',
      data: text,
      ...(json === undefined ? {} : { json }),
      ...(id === undefined ? {} : { id }),
      ...(retry === undefined ? {} : { retry }),
    };
  }
}

/** Every event of a complete body. */
export function parseSse(text: string): { events: SseEvent[]; partial: boolean } {
  const parser = new SseParser();
  const events = parser.push(text);
  const end = parser.end();
  return { events: [...events, ...end.events], partial: end.partial };
}

export function isEventStream(contentType: string | undefined): boolean {
  return /^text\/event-stream\s*(;|$)/i.test(contentType ?? '');
}

/** The terminal marker an event is, if any. */
export function terminalOf(event: SseEvent, terminals: StreamTerminal[] | undefined): StreamTerminal | undefined {
  return (terminals ?? []).find(
    (t) => (t.data === undefined || t.data === event.data) && (t.event === undefined || t.event === event.event),
  );
}

/** A terminal that is only a marker (`data: [DONE]`), not a documented event the contract describes. */
export function isMarkerOnly(terminal: StreamTerminal | undefined): boolean {
  return terminal?.data !== undefined && terminal.event === undefined;
}
