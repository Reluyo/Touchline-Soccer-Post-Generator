import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, translateCandidates, rankStories, writeSlide } from './claude.js';

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

  await t.test('removes a stray "=" leaked between a colon and its value', () => {
    // Regression test for a real, shipped bug from a live run: the model
    // wrote "key":=true instead of "key":true, as if a JS/TS assignment
    // briefly leaked into JSON syntax.
    assert.deepEqual(parseJson('{"text":"Rodri","key":=true}'), { text: 'Rodri', key: true });
  });

  await t.test('removes a trailing TypeScript type assertion Claude sometimes appends', () => {
    // Regression test for a real, shipped bug from the same live run:
    // the model wrote {...} as any] instead of {...}] -- a TypeScript
    // type assertion leaking onto the end of a JSON value.
    assert.deepEqual(
      parseJson('{"headline_parts":[{"text":"Rodri","key":true} as any]}'),
      { headline_parts: [{ text: 'Rodri', key: true }] }
    );
  });

  await t.test('combines the "=" and "as any" quirks exactly as seen in production', () => {
    const text = '{"headline_parts":[{"text":"Rodri","key":=true} as any]}';
    assert.deepEqual(parseJson(text), { headline_parts: [{ text: 'Rodri', key: true }] });
  });

  await t.test('does not touch the word "as" appearing naturally inside real text', () => {
    assert.deepEqual(
      parseJson('{"body":"Seen as a coup, viewed as decisive"}'),
      { body: 'Seen as a coup, viewed as decisive' }
    );
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

test('rankStories', async (t) => {
  function fakeClaudeTextResponse(payload) {
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    };
  }

  function stories(n) {
    return Array.from({ length: n }, (_, i) => ({ title: `Story ${i}`, sourceName: 'Test', publishedAt: null }));
  }

  await t.test('drops a repeated index, keeping the first (best-ranked) occurrence', async (t) => {
    // Regression test for a real, shipped bug: Claude repeating an index
    // in its {"ranked":[...]} response (plausible on a long, few-hundred-
    // story list) put the same story object into the returned array
    // twice. Downstream, the picker keys candidates by fingerprint, so
    // the duplicate showed up as two cards that select together and
    // build into duplicate slides.
    t.mock.method(global, 'fetch', async () => fakeClaudeTextResponse({ ranked: [2, 0, 2, 1] }));

    const result = await rankStories({ stories: stories(3) });
    assert.deepEqual(result.map((s) => s.title), ['Story 2', 'Story 0', 'Story 1']);
  });

  await t.test('still returns every story exactly once when the model drops some indices', async (t) => {
    t.mock.method(global, 'fetch', async () => fakeClaudeTextResponse({ ranked: [1] }));

    const result = await rankStories({ stories: stories(3) });
    assert.equal(result.length, 3);
    assert.deepEqual(new Set(result.map((s) => s.title)), new Set(['Story 0', 'Story 1', 'Story 2']));
    assert.equal(result[0].title, 'Story 1'); // the one index the model did return stays first
  });

  await t.test('falls back to input order (deduped) if ranked is missing entirely', async (t) => {
    t.mock.method(global, 'fetch', async () => fakeClaudeTextResponse({}));

    const result = await rankStories({ stories: stories(2) });
    assert.deepEqual(result.map((s) => s.title), ['Story 0', 'Story 1']);
  });
});

test('writeSlide', async (t) => {
  function fakeClaudeTextResponse(payload) {
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    };
  }

  function story(overrides = {}) {
    return {
      sourceName: 'Test Source',
      title: 'Test headline',
      summary: 'First sentence of the summary. Second sentence here.',
      ...overrides,
    };
  }

  await t.test('retries once when the first response has no body, and returns the retry', async (t) => {
    let calls = 0;
    t.mock.method(global, 'fetch', async () => {
      calls += 1;
      const payload = calls === 1
        ? { headline_parts: [{ text: 'Leao', key: true }], body: null }
        : { headline_parts: [{ text: 'Leao', key: true }], body: 'Milan and Roma are discussing a deal.' };
      return fakeClaudeTextResponse(payload);
    });

    const result = await writeSlide({ story: story() });
    assert.equal(calls, 2);
    assert.equal(result.body, 'Milan and Roma are discussing a deal.');
  });

  await t.test('falls back to the source summary when both attempts return no body', async (t) => {
    // Regression test for a real, shipped bug: Claude returned valid,
    // cleanly-parsed JSON with a real headline and body: null -- no
    // error anywhere in the pipeline to catch, just a slide with no
    // text on it in production.
    t.mock.method(global, 'fetch', async () => fakeClaudeTextResponse({
      headline_parts: [{ text: 'Leao', key: true }],
      body: null,
    }));

    const result = await writeSlide({ story: story({ summary: 'Leao is offered to Roma. Milan want 50m.' }) });
    assert.equal(result.body, 'Leao is offered to Roma. Milan want 50m.');
  });

  await t.test('falls back to a generic line when there is no summary to fall back on either', async (t) => {
    t.mock.method(global, 'fetch', async () => fakeClaudeTextResponse({
      headline_parts: [{ text: 'Leao', key: true }],
      body: '',
    }));

    const result = await writeSlide({ story: story({ summary: '', sourceName: 'BBC Sport' }) });
    assert.equal(result.body, 'More from BBC Sport.');
  });

  await t.test('throws a clear error when headline_parts is still unusable after a retry', async (t) => {
    t.mock.method(global, 'fetch', async () => fakeClaudeTextResponse({
      headline_parts: [],
      body: 'Some body text here.',
    }));

    await assert.rejects(() => writeSlide({ story: story() }), /no usable headline/);
  });

  await t.test('a normal, complete response is returned as-is with no retry', async (t) => {
    let calls = 0;
    t.mock.method(global, 'fetch', async () => {
      calls += 1;
      return fakeClaudeTextResponse({
        headline_parts: [{ text: 'Leao', key: true }, { text: 'to Roma', key: false }],
        body: 'A straightforward, complete body.',
      });
    });

    const result = await writeSlide({ story: story() });
    assert.equal(calls, 1);
    assert.equal(result.body, 'A straightforward, complete body.');
  });
});
