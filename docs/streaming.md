# Streaming responses (Server-Sent Events)

A `text/event-stream` response is parsed the way a browser's `EventSource` parses it, and every event is held to the
contract. Two ways to call:

```ts
// Read as it arrives: per-event timing, a bounded wait for each event, cut-offs seen as such.
const res = await api.as('ci').stream('post', '/v1/chat/completions', { body: { model, stream: true, messages } });
res.complete; // true: it ended with its terminal marker
res.ending; // 'terminal' | 'closed' | 'cut-off' | 'stalled'
res.events; // [{ event, data, json, id, retry }]
res.eventData; // the JSON data of every event, markers such as [DONE] left out
res.eventAt[0]; // ms from the request to the first event (time to first token)

// Read whole (any call whose answer is a stream): the same checks, no timing.
const whole = await api.as('ci').post('/v1/chat/completions', { body });
whole.events;
```

An answer that is not a stream (a 400 as JSON) is checked like any other call; `events` is then empty.

## What fails a call

- An event whose data breaks the event schema the contract declares, or an event name the contract does not name.
- A datetime without the configured offset inside an event's data (`rules.datetimeOffset`).
- A stream that ends before its terminal marker: the server closed it (`closed`), the connection broke (`cut-off`),
  or no event arrived within the event timeout (`stalled`). The message says which, after how many events, and
  whether it ended inside an event.
- The header rules (`rules.headers`) apply to the stream's headers: a `withBody` `Content-Type` rule must allow
  `text/event-stream`.

A test that asserts an incomplete stream on purpose (the server ends a stream at its absolute timeout, a provider
dropped mid-stream) passes `allowIncomplete: true` and checks `ending` itself. The events that arrived are still
validated.

## service.yaml

```yaml
rules:
  streaming:
    terminal: # any of these ends a stream; empty: a stream ends when the server closes it
      - data: '[DONE]' # OpenAI style: a marker, not validated as an event
      - event: message_stop # Anthropic style: a real event, validated like the others
    eventTimeoutMs: 30000 # the longest wait for the next (and the first) event; per call: { eventTimeoutMs }
    operations: # what differs per operation
      'GET /api/v1/feed': { terminal: [] }
```

## How the contract describes the events

| Contract                                             | What is validated                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `itemSchema` (OpenAPI 3.2), in a 3.1 or 3.2 document | Each event as the object `{ event, data, id?, retry? }`. A `data` property with `contentMediaType: application/json` and a `contentSchema` is validated as the parsed JSON against that `contentSchema` |
| `x-vgate-events: { <event name>: <schema of data> }` | Each event's parsed data against the schema of its name (`message` for events without `event:`); an unnamed event is a violation                                                                        |
| only `schema: { type: string }`                      | The framing only: events parse, the stream ends with its terminal marker. Data is not checked                                                                                                           |

`itemSchema` is the standard and the recommended form; Schemathesis reads it too (its check ST108 validates each
event against it).

**Schemathesis and `schema: { type: string }`.** Before OpenAPI 3.2, Schemathesis reads a stream's `schema` as the
schema of each event, so a stream documented as `schema: { type: string }` (it means "the body is text") would fail
ST108 on every event and turn the gate red for a correct service. `task contract` therefore hands Schemathesis a copy
of the contract without those string schemas, on streams that have no `itemSchema`, and prints which ones
(`reports/schemathesis/contract.json`). Schemathesis still tests those operations (status codes, JSON answers, auth);
only its event check skips them. The API tests still check the stream's framing and terminal marker. Nothing checks
the events' data until the contract describes it, so a 3.1 contract should describe streams with `itemSchema`:

```yaml
text/event-stream:
  itemSchema:
    oneOf:
      - type: object
        required: [data]
        properties:
          event: { const: message }
          data:
            type: string
            contentMediaType: application/json
            contentSchema: { $ref: '#/components/schemas/ChatCompletionChunk' }
      - type: object
        required: [data]
        properties:
          data: { const: '[DONE]' }
```

`$ref`s to the item schema and to its `oneOf`/`anyOf`/`allOf` variants are followed a few levels deep to find the
`contentSchema`s. `strictResponseProperties` and `optionalPropertiesNullable` apply to event schemas as to responses.

## Limits

- Event `id` is the event's own `id:` field, not the browser's persisting "last event id".
- `stream()` reads with `fetch`, not Playwright's request context: the call is in `http-calls.json` and the observed
  coverage, but not in the Playwright trace.
- Only Server-Sent Events. Newline-delimited JSON (`application/x-ndjson`, `application/jsonl`) and WebSockets are
  not supported yet.
