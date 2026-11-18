import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpenApiContract, withoutTextStreamSchemas } from './openapi.ts';

// A small OpenAPI 3.1 contract in the shapes generators emit: $ref'd schemas, a 3.1 type array for a nullable
// property, an envelope-style error description that names codes, a 204 without content, a 2XX range and default.
const spec = {
  openapi: '3.1.0',
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
          },
          '404': {
            description: 'Item not found (APP0404)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
      delete: { responses: { '204': { description: 'Deleted' } } },
    },
    '/items': {
      post: {
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemCreate' } } } },
        responses: {
          '2XX': { description: 'Created', content: { '*/*': { schema: { $ref: '#/components/schemas/Item' } } } },
          default: {
            description: 'Rejected (APP0400, APP0409)',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Item: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          note: { type: 'string' },
          owner: { type: ['string', 'null'] },
          tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
        },
      },
      Tag: { type: 'object', properties: { label: { type: 'string' } } },
      ItemCreate: { type: 'object', properties: { name: { type: 'string' } } },
      Error: { type: 'object', properties: { code: { type: 'string' } } },
    },
  },
};

const contract = (options: ConstructorParameters<typeof OpenApiContract>[1] = {}) =>
  new OpenApiContract(structuredClone(spec), options);

describe('OpenApiContract.validateResponse', () => {
  it('accepts a response exactly as documented', () => {
    assert.deepEqual(contract().validateResponse('GET', '/items/{id}', 200, { id: '1', name: 'a', owner: null }), []);
  });

  it('names an undocumented status and the documented ones', () => {
    const [violation] = contract().validateResponse('GET', '/items/{id}', 500, {});
    assert.match(violation, /status 500 is not documented for GET \/items\/\{id\} \(documented: 200, 404\)/);
  });

  it('reports an operation the contract does not have', () => {
    assert.deepEqual(contract().validateResponse('PUT', '/items/{id}', 200, {}), [
      'PUT /items/{id} is not in the contract',
    ]);
  });

  it('reports a schema violation with its location', () => {
    const violations = contract().validateResponse('GET', '/items/{id}', 200, { id: 1, name: 'a' });
    assert.deepEqual(violations, ['/id must be string']);
  });

  it('accepts null only where the 3.1 type lists "null"', () => {
    const c = contract();
    assert.deepEqual(c.validateResponse('GET', '/items/{id}', 200, { id: '1', name: 'a', owner: null }), []);
    assert.deepEqual(c.validateResponse('GET', '/items/{id}', 200, { id: '1', name: 'a', note: null }), [
      '/note must be string',
    ]);
  });

  it('optionalPropertiesNullable accepts null on optional properties, never on required ones', () => {
    const c = contract({ optionalPropertiesNullable: true });
    assert.deepEqual(c.validateResponse('GET', '/items/{id}', 200, { id: '1', name: 'a', note: null }), []);
    assert.deepEqual(c.validateResponse('GET', '/items/{id}', 200, { id: '1', name: null }), ['/name must be string']);
  });

  it('strictResponseProperties rejects undeclared properties, also inside $ref and arrays', () => {
    const c = contract({ strictResponseProperties: true });
    assert.deepEqual(c.validateResponse('GET', '/items/{id}', 200, { id: '1', name: 'a', extra: 1 }), [
      '/ must NOT have unevaluated properties "extra"',
    ]);
    assert.deepEqual(
      c.validateResponse('GET', '/items/{id}', 200, { id: '1', name: 'a', tags: [{ label: 'x', y: 1 }] }),
      ['/tags/0 must NOT have unevaluated properties "y"'],
    );
    assert.deepEqual(contract().validateResponse('GET', '/items/{id}', 200, { id: '1', name: 'a', extra: 1 }), []);
  });

  it('falls back to a status range, then to default', () => {
    const c = contract();
    assert.deepEqual(c.validateResponse('POST', '/items', 201, { id: '1', name: 'a' }), []);
    assert.deepEqual(c.validateResponse('POST', '/items', 409, { code: 'APP0409' }), []);
  });

  it('accepts any body for a response documented without content', () => {
    assert.deepEqual(contract().validateResponse('DELETE', '/items/{id}', 204, undefined), []);
  });

  it('is case-insensitive on the method', () => {
    assert.ok(contract().operation('get', '/items/{id}'));
  });
});

describe('OpenApiContract.documentedPairs', () => {
  it('without an envelope, one pair per documented status with no code', () => {
    const pairs = contract().documentedPairs();
    assert.deepEqual(
      pairs.filter((p) => p.operation === 'GET /items/{id}'),
      [
        { operation: 'GET /items/{id}', status: '200', code: null },
        { operation: 'GET /items/{id}', status: '404', code: null },
      ],
    );
  });

  it('with an envelope, one pair per code named in the description, the success code for 2xx', () => {
    const pairs = contract({ codePattern: 'APP\\d{4}', successCode: 'APP0000' }).documentedPairs();
    assert.deepEqual(
      pairs.filter((p) => p.operation === 'POST /items'),
      [
        { operation: 'POST /items', status: '2XX', code: 'APP0000' },
        { operation: 'POST /items', status: 'default', code: 'APP0400' },
        { operation: 'POST /items', status: 'default', code: 'APP0409' },
      ],
    );
  });

  it('records the request schema name of each operation', () => {
    assert.equal(contract().operation('POST', '/items')?.requestSchema, 'ItemCreate');
  });
});

describe('OpenApiContract with reusable components', () => {
  const withRefs = {
    openapi: '3.1.0',
    paths: {
      '/things': {
        post: {
          requestBody: { $ref: '#/components/requestBodies/ThingIn' },
          responses: { '400': { $ref: '#/components/responses/BadRequest' } },
        },
      },
    },
    components: {
      requestBodies: {
        ThingIn: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ThingIn' } } } },
      },
      responses: {
        BadRequest: {
          description: 'Rejected (APP0400)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
      schemas: {
        ThingIn: { type: 'object' },
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      },
    },
  };

  it('validates a response given as $ref to components/responses, with its description and codes', () => {
    const c = new OpenApiContract(structuredClone(withRefs), { codePattern: 'APP\\d{4}' });
    assert.deepEqual(c.validateResponse('POST', '/things', 400, { error: 'x' }), []);
    assert.deepEqual(c.validateResponse('POST', '/things', 400, {}), ["/ must have required property 'error'"]);
    assert.deepEqual(c.documentedPairs(), [{ operation: 'POST /things', status: '400', code: 'APP0400' }]);
  });

  it('follows a request body given as $ref to components/requestBodies', () => {
    const c = new OpenApiContract(structuredClone(withRefs));
    assert.equal(c.operation('POST', '/things')?.requestSchema, 'ThingIn');
  });
});

describe('withoutTextStreamSchemas', () => {
  type Media = Record<string, Record<string, unknown>>;
  const stream = (media: Media) => ({ responses: { '200': { description: 'x', content: media } } });
  const content = (spec: unknown, path: string, method: string): Media =>
    (spec as { paths: Record<string, Record<string, ReturnType<typeof stream>>> }).paths[path][method].responses['200']
      .content;

  it('drops a string schema from streams without itemSchema, keeps everything else', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/text': {
          post: stream({
            'application/json': { schema: { type: 'object' } },
            'text/event-stream': { schema: { type: 'string' } },
          }),
        },
        '/items': {
          get: stream({ 'text/event-stream': { itemSchema: { type: 'object' }, schema: { type: 'string' } } }),
        },
        '/events': { get: stream({ 'text/event-stream': { schema: { type: 'object' } } }) },
      },
      components: {
        responses: { Stream: { description: 'y', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
      },
    };
    const { spec: out, removed } = withoutTextStreamSchemas(structuredClone(spec));
    assert.deepEqual(removed, ['/text post responses 200', 'components responses Stream']);
    assert.deepEqual(content(out, '/text', 'post')['text/event-stream'], {});
    assert.deepEqual(content(out, '/text', 'post')['application/json'], { schema: { type: 'object' } });
    assert.deepEqual(content(out, '/items', 'get'), content(spec, '/items', 'get'));
    assert.deepEqual(content(out, '/events', 'get'), content(spec, '/events', 'get'));
    // The caller's contract is untouched.
    assert.deepEqual(content(spec, '/text', 'post')['text/event-stream'], { schema: { type: 'string' } });
  });
});
