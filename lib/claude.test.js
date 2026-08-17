import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, translateCandidates } from './claude.js';

test('parseJson', async (t) => {
  await t.test('parses plain valid JSON', () => {
    assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  });

  await t.test('strips markdown code fences', () => {
    assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  await t.test('removes a trailing comma before a closing bracket', () => {
    assert.deepEqual(parseJson('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] });
  });

  await t.test('quotes unquoted property names', () => {
    assert.deepEqual(parseJson('{a:1,b:2}'), { a: 1, b: 2 });
  });

  await t.test('inserts a missing comma between two adjacent string values', () => {
    assert.deepEqual(parseJson('{"a":"foo" "b":"bar"}'), { a: 'foo', b: 'bar' });
  });

  await t.test('converts Python-style True/False/None literals', () => {
    assert.deepEqual(parseJson('{"a": True, "b": False, "c": None}'), { a: true, b: false, c: null });
  });

  await t.test('inserts a dropped "key" property name before a bare boolean', () => {
    // Regression test for a real, shipped bug from a live run: the model
    // wrote {"text":"Leao",true} instead of {"text":"Leao","key":true} --
    // dropping the property name entirely rather than just its quotes or
    // the comma before it (the two other quirks already handled above).
    const text = '{"headline_parts":[{"text":"Leao",true},{"text":"offered",false},'
      + '{"text":"to",false},{"text":"Roma",true},{"text":"as",false},'
      + '{"text":"Milan",true},{"text":"pay",false},{"text":"€50m",true}]}';
    const result = parseJson(text);
    assert.deepEqual(result.headline_parts[0], { text: 'Leao', key: true });
    assert.deepEqual(result.headline_parts[1], { text: 'offered', key: false });
    assert.deepEqual(result.headline_parts[7], { text: '€50m', key: true });
  });

  await t.test('does not touch a legitimate array of booleans', () => {
    assert.deepEqual(parseJson('{"flags":[true,false,true]}'), { flags: [true, false, true] });
  });

  await t.test('strips a trailing method call Claude sometimes appends', () => {
    assert.deepEqual(parseJson('{"a":1}.map(x => x)'), { a: 1 });
  });

  await t.test('extracts the balanced JSON value out of surrounding prose', () => {
    assert.deepEqual(
      parseJson('Here is the JSON you asked for: {"a": 1} Hope that helps!'),
      { a: 1 }
    );
  });

  await t.test('extraction stops at the first balanced close, not the last bracket in the text', () => {
    // A greedy regex-based approach would grab everything up to the LAST
    // bracket in the string, swallowing the trailing aside below into the
    // "parsed" result. Balanced-substring extraction should stop correctly
    // at the first fully-closed value instead.
    const result = parseJson('[1,2,3] (see also [4,5] for related context)');
    assert.deepEqual(result, [1, 2, 3]);
  });

  await t.test('combines several quirks in one response, as a real model output might', () => {
    const text = '```json\n{a: True, b: "x" "y": [1,2,],}\n```';
    assert.deepEqual(parseJson(text), { a: true, b: 'x', y: [1, 2] });
  });

  await t.test('throws a clear, diagnostic error on genuinely unparseable input', () => {
    // Single-quoted strings are deliberately unhandled -- verify it fails
    // loudly with a useful message rather than silently returning garbage.
    assert.throws(() => parseJson("{'a': 1}"), /Could not parse JSON/);
  });

  await t.test('throws on input with no JSON at all', () => {
    assert.throws(() => parseJson('Sorry, I cannot help with that.'), /Could not parse JSON/);
  });
});

test('translateCandidates', async (t) => {
  function fakeClaudeTextResponse(payload) {
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    };
  }

  await t.test('applies a successful translation back to the correct original story', async (t) => {
    // Regression test for a real, shipped bug: the matching logic used to
    // key a translation back to its source story by checking whether the
    // TRANSLATED text equaled the ORIGINAL text, which is never true for a
    // real translation -- every non-English candidate silently stayed
    // untranslated while still paying for the wasted call. Claude's
    // response already carried the correct index for this; it just wasn't
    // being read.
    const items = [
      { title: 'Bayern verpflichtet neuen Stürmer', summary: 'Der FC Bayern...', lang: 'de' },
      { title: 'Dortmund gewinnt Pokal', summary: 'Borussia Dortmund gewinnt...', lang: 'de' },
    ];

    t.mock.method(global, 'fetch', async () => fakeClaudeTextResponse({
      translations: [
        { index: 0, title: 'Bayern sign new striker', summary: 'FC Bayern...' },
        { index: 1, title: 'Dortmund win the cup', summary: 'Borussia Dortmund win...' },
      ],
    }));

    const result = await translateCandidates(items);
    assert.equal(result[0].title, 'Bayern sign new striker');
    assert.equal(result[0].summary, 'FC Bayern...');
    assert.equal(result[1].title, 'Dortmund win the cup');
    assert.equal(result[1].summary, 'Borussia Dortmund win...');
  });

  await t.test('leaves English candidates untouched', async () => {
    const items = [{ title: 'Arsenal sign someone', summary: 'x', lang: 'en' }];
    const result = await translateCandidates(items);
    assert.equal(result[0].title, 'Arsenal sign someone');
  });

  await t.test('degrades a failed batch to untranslated instead of throwing', async (t) => {
    const items = [{ title: 'Bayern verpflichtet neuen Stürmer', summary: 'x', lang: 'de' }];

    t.mock.method(global, 'fetch', async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error',
    }));

    const result = await translateCandidates(items);
    assert.equal(result[0].title, 'Bayern verpflichtet neuen Stürmer');
  });
});
