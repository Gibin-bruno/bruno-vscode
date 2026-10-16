import { describe, it, expect } from 'vitest';
import { prepareBody } from './prepare-request';

describe('prepareBody parses a json body into a JSON object', () => {
  it('parses plain JSON into an object', () => {
    const data = prepareBody({ mode: 'json', json: '{"name": "bruno"}' }, {});
    expect(data).toEqual({ name: 'bruno' });
  });

  it('strips // and /* */ comments before parsing', () => {
    const json = `{
  // line comment
  "name": "bruno", /* inline block comment */
  "url": "https://example.com/path", // url with // inside a string
  "nested": {
    /* multi
       line */
    "enabled": true
  }
}`;
    const data = prepareBody({ mode: 'json', json }, {});
    expect(data).toEqual({
      name: 'bruno',
      url: 'https://example.com/path',
      nested: { enabled: true }
    });
  });

  it('falls back to the raw string when the body is not valid JSON', () => {
    const data = prepareBody({ mode: 'json', json: '{not json' }, {});
    expect(data).toBe('{not json');
  });
});
