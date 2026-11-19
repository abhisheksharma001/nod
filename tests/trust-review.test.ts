import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustReview, ClearedMessageReviewError } from '../src/server/trust-review.ts';
import type { ModelReview } from '../src/ports/decisions.ts';
import { createDecisionModel } from '../src/providers/decisions.ts';

const input = {
  userMessages: [
    {
      at: '2026-11-01T09:00:00Z',
      text: 'Draft this. Show it before sending.',
      canAuthorize: false,
    },
    { at: '2026-11-03T09:00:00Z', text: 'Change the ending, then send it.', canAuthorize: true },
  ],
  action: { name: 'GMAIL_SEND_EMAIL', arguments: { body: 'Synthetic edited message.' } },
};

test('a review restriction can block a grant but cannot grant an action', async (t) => {
  for (const restriction of [
    undefined,
    null,
    {},
    { review: 'required' },
    { review: 'uncertain' },
    { review: 'clear ' },
  ])
    for (const because of ['read', input.userMessages[1].text])
      await t.test(
        `${JSON.stringify(restriction)} with ${because === 'read' ? 'read' : 'owner words'}`,
        async () => {
          const seen: unknown[] = [];
          let selections = 0;
          const selected: ModelReview = async (_instructions, value) => {
            seen.push(value);
            return Object(value).purpose === 'review_requirement'
              ? restriction
              : { run: true, because };
          };
          const review: ModelReview = async () => assert.fail('Use the selected review model.');
          review.select = async () => {
            selections++;
            return selected;
          };
          assert.deepEqual(await createTrustReview({ review })('Synthetic policy.', input), {
            run: false,
            reviewRequired: true,
            ...(Object(restriction).review === 'required' ? {} : { reviewUnavailable: true }),
          });
          assert.equal(selections, 1);
          assert.equal(seen.length, 2);
          assert.deepEqual(Object(seen[1]).userMessages, input.userMessages);
          assert.deepEqual(Object(seen[1]).action, input.action);
        },
      );
  const denied = { run: false, rule: true };
  assert.deepEqual(
    await createTrustReview({
      review: async (_instructions, value) =>
        Object(value).purpose === 'review_requirement' ? { review: 'clear', run: true } : denied,
    })('', input),
    denied,
  );
});

test('a clear review result preserves ordinary send permission and private preparation', async () => {
  for (const primary of [
    { run: true, because: input.userMessages[1].text },
    { run: true, because: 'read' },
  ]) {
    const review = createTrustReview({
      review: async (_instructions, value) =>
        Object(value).purpose === 'review_requirement' ? { review: 'clear' } : primary,
    });
    assert.deepEqual(await review('', input), primary);
  }
});

test('an unavailable draft can be cleared for related work that does not share it', async (t) => {
  for (const mode of ['llm', 'decision'] as const)
    await t.test(mode, async () => {
      let words = 'Delete the synthetic draft now.';
      let clear = true;
      let clearance: unknown = [0];
      let certainty = 1;
      let primary = true;
      const checked = {
        userMessages: [{ at: '2026-11-03T09:00:00Z', text: words, canAuthorize: true }],
        messageDrafts: [
          {
            draftId: 'synthetic-draft',
            connectionId: 'synthetic-account',
            target: {},
            messages: [],
            unavailable: true,
          },
        ],
        action: {
          name: 'GMAIL_DELETE_DRAFT',
          arguments: { draft_id: 'synthetic-draft', connectionId: 'synthetic-account' },
        },
      };
      const review = createTrustReview({
        review: async (_instructions, value) => {
          assert.equal(mode, 'llm');
          return Object(value).purpose === 'review_requirement'
            ? { review: 'clear', clearedDrafts: clear ? clearance : [] }
            : { run: primary, because: words };
        },
        ...(mode === 'decision'
          ? {
              decisions: {
                async check() {
                  return {
                    trust: primary ? 'message:0' : 'ask',
                    probability: 1,
                    additional: {
                      ...Object.fromEntries(
                        [
                          'scope',
                          'constraints',
                          'time',
                          'numbers',
                          'conditions',
                          'targets',
                          'bans',
                          'costs',
                        ].map((name) => [name, { choice: name === 'scope', probability: 1 }]),
                      ),
                      preparation: { preparation: false, choice: false, probability: 1 },
                      permission: { permission: primary, choice: primary, probability: 1 },
                      messageReview: { choice: false, probability: 1 },
                      draftReviewClear_0: { choice: clear, probability: certainty },
                    },
                  };
                },
              },
            }
          : {}),
      });
      assert.equal(Object(await review('', checked)).run, true);
      clear = false;
      assert.equal(Object(await review('', checked)).reviewRequired, true);
      clear = true;
      if (mode === 'llm') {
        for (clearance of [undefined, [0, 'other'], [0, -1], [0, 10]])
          assert.equal(Object(await review('', checked)).reviewRequired, true);
        clearance = [0];
      } else {
        certainty = 0.98;
        assert.equal(Object(await review('', checked)).reviewRequired, true);
        certainty = 1;
      }
      primary = false;
      assert.notEqual(Object(await review('', checked)).run, true);
      primary = true;
      checked.action.name = 'GMAIL_SEND_DRAFT';
      assert.equal(Object(await review('', checked)).reviewRequired, true);
      words = 'Send the separate synthetic draft from my other account.';
      checked.userMessages[0].text = words;
      checked.action.arguments.connectionId = 'synthetic-other-account';
      assert.equal(Object(await review('', checked)).run, true);
      clear = false;
      assert.equal(Object(await review('', checked)).reviewRequired, true);
      clear = true;
      checked.action.arguments.connectionId = 'synthetic-account';
      assert.equal(Object(await review('', checked)).reviewRequired, true);
    });
});

test('a failed review keeps its service reason and a stopped review cannot return a grant', async () => {
  const failure = Object.assign(new Error('Synthetic review rate limit.'), { status: 429 });
  const failing = createTrustReview({
    review: async (_instructions, value) => {
      if (Object(value).purpose === 'review_requirement') throw failure;
      return { run: true, because: 'read' };
    },
  });
  await assert.rejects(
    failing('', input),
    (error) =>
      error === failure && Object(error).status === 429 && Object(error).reviewRequired === true,
  );
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const stopped = createTrustReview({
    review: async (_instructions, value) => {
      entered();
      await held;
      return Object(value).purpose === 'review_requirement'
        ? { review: 'clear' }
        : { run: true, because: 'read' };
    },
  });
  const pending = stopped('', input, controller.signal);
  await started;
  controller.abort();
  release();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('typed decision checks require a clear message review result without an LLM fallback', async () => {
  const additional = Object.fromEntries(
    ['scope', 'constraints', 'time', 'numbers', 'conditions', 'targets', 'bans', 'costs'].map(
      (name) => [name, { choice: name === 'scope', probability: 1 }],
    ),
  );
  let restriction: unknown;
  const review = createTrustReview({
    review: async () => assert.fail('A typed decision cannot switch to an LLM.'),
    decisions: {
      async check(request) {
        assert.ok(
          request.additionalQuestions?.some((question) => question.name === 'messageReview'),
        );
        return {
          trust: 'message:1',
          choice: 'message:1',
          probability: 1,
          additional: {
            ...additional,
            preparation: { preparation: false, choice: false, probability: 1 },
            permission: { permission: true, choice: true, probability: 1 },
            messageReview: restriction,
          },
        };
      },
    },
  });
  for (restriction of [
    undefined,
    {},
    { choice: true, probability: 1 },
    { choice: false, probability: 0.98 },
  ])
    assert.equal(Object(await review('', input)).reviewRequired, true);
  restriction = { choice: false, probability: 1 };
  const allowed = Object(await review('', input));
  assert.equal(allowed.run, true);
  assert.equal(allowed.because, input.userMessages[1].text);
});

test('selection failures preserve the cause and cannot lose the complete review requirement', async () => {
  for (const mode of ['llm', 'decision']) {
    const failure = Object.assign(new Error('Synthetic selected model is unavailable.'), {
      status: 503,
    });
    const review: ModelReview = async () =>
      assert.fail('An unavailable selection cannot start a request.');
    review.select = async () => {
      throw failure;
    };
    const checked = createTrustReview({
      review,
      ...(mode === 'decision'
        ? {
            decisions: {
              select: async () => {
                throw failure;
              },
              check: async () => assert.fail('The selected decision is unavailable.'),
            },
          }
        : {}),
    });
    await assert.rejects(
      checked('', input),
      (error) =>
        error === failure &&
        Object(error).status === 503 &&
        Object(error).reviewRequired === true &&
        Object(error).reviewUnavailable === true,
    );
  }
  const classifiedFailure = new Error('Synthetic reply classification is unavailable.');
  const classified: ModelReview = async () => {
    throw classifiedFailure;
  };
  const question = {
    name: 'answer',
    uncertainValue: 'other',
    choices: [
      { value: 'yes', description: 'The owner approves.' },
      { value: 'other', description: 'No approval.' },
    ],
  };
  await assert.rejects(
    createTrustReview({ review: classified })('', { reply: 'Yes' }, undefined, question),
    (error) => error === classifiedFailure && !('reviewRequired' in classifiedFailure),
  );
});

test('only a complete clear result can keep ordinary confirmation after a permission failure', async () => {
  const failure = Object.assign(new Error('Synthetic permission service failed.'), { status: 502 });
  let restriction: unknown = { review: 'clear' };
  const review = createTrustReview({
    review: async (_instructions, value) => {
      if (Object(value).purpose === 'review_requirement') return restriction;
      throw failure;
    },
  });
  await assert.rejects(
    review('', input),
    (error) =>
      error instanceof ClearedMessageReviewError &&
      error.failure === failure &&
      Object(error).status === 502,
  );
  const unknown = {
    ...input,
    messageDrafts: [
      {
        draftId: 'synthetic-draft',
        connectionId: 'synthetic-connection',
        target: { recipient_email: 'other@example.test' },
        messages: [],
        unavailable: true,
      },
    ],
  };
  await assert.rejects(
    review('', unknown),
    (error) =>
      error === failure &&
      Object(error).reviewRequired === true &&
      Object(error).reviewUnavailable === true,
  );
  restriction = { review: 'clear', clearedDrafts: [0] };
  await assert.rejects(
    review('', unknown),
    (error) => error instanceof ClearedMessageReviewError && error.failure === failure,
  );
  const exact = {
    ...unknown,
    action: { name: 'GMAIL_SEND_DRAFT', arguments: { draft_id: 'synthetic-draft' } },
  };
  await assert.rejects(
    review('', exact),
    (error) => error === failure && Object(error).reviewRequired === true,
  );
});

test('a complete typed review clearance keeps ordinary approval for missing permission data', async () => {
  const checked = {
    userMessages: [
      { at: '2026-11-19T09:00:00Z', text: 'Set the synthetic monthly limit to 100 dollars.' },
    ],
    action: { name: 'NOD_limits_update', arguments: { monthlyUsd: 100 } },
    messageDrafts: [
      {
        draftId: null,
        connectionId: 'synthetic-connection',
        target: {},
        messages: [],
        unavailable: true,
      },
    ],
  };
  for (const missing of ['permission', 'preparation', 'constraints', 'time', 'costs']) {
    const additional: Record<string, unknown> = {
      ...Object.fromEntries(
        ['scope', 'constraints', 'time', 'numbers', 'conditions', 'targets', 'bans', 'costs'].map(
          (name) => [name, { choice: name === 'scope', probability: 1 }],
        ),
      ),
      preparation: { preparation: false, choice: false, probability: 1 },
      permission: { permission: true, choice: true, probability: 1 },
      messageReview: { choice: false, probability: 1 },
      draftReviewClear_0: { choice: true, probability: 1 },
    };
    delete additional[missing];
    const review = createTrustReview({
      review: async () => assert.fail('The decision check cannot switch to an LLM.'),
      decisions: {
        check: async () => ({
          trust: 'message:0',
          choice: 'message:0',
          probability: 1,
          additional,
        }),
      },
    });
    assert.equal(await review('', checked), undefined, missing);
    additional.messageReview = { choice: false, probability: 0.98 };
    assert.equal(Object(await review('', checked)).reviewRequired, true);
    additional.messageReview = { choice: false, probability: 1 };
    additional.draftReviewClear_0 = { choice: false, probability: 1 };
    assert.equal(Object(await review('', checked)).reviewRequired, true);
  }
});

test('Perplexity review clearance requires its fixed served model before every return path', async (t) => {
  const expected = 'perplexity/pplx-decider-v1.2-20261016';
  for (const path of ['grant', 'scope', 'rule'])
    for (const served of [expected, 'perplexity/pplx-decider-v1.3', undefined])
      await t.test(`${path}: ${served ?? 'missing served model'}`, async () => {
        let calls = 0;
        const decisions = createDecisionModel({
          resolve: async () => ({
            provider: 'openrouter',
            key: 'synthetic-decision-key',
            model: 'perplexity/pplx-decider-v1.2',
          }),
          fetch: async (_url, init) => {
            calls++;
            const request = JSON.parse(String(init?.body));
            assert.equal(request.provider.allow_fallbacks, false);
            return Response.json({
              model: served,
              answers: Object.fromEntries(
                Object.entries(request.questions).map(([name, value]) => {
                  const question = value as { criteria: Record<string, string> };
                  const choice =
                    name === 'trust'
                      ? path === 'rule'
                        ? 'rule'
                        : 'message:1'
                      : String(
                          name === 'permission' ||
                            (name === 'scope' && path !== 'scope') ||
                            name === 'draftReviewClear_0',
                        );
                  return [
                    name,
                    {
                      type: 'choice',
                      choice,
                      probabilities: Object.fromEntries(
                        Object.keys(question.criteria).map((key) => [key, Number(key === choice)]),
                      ),
                    },
                  ];
                }),
              ),
              usage: { input_tokens: 100 },
            });
          },
        });
        const review = createTrustReview({
          decisions,
          review: async () => assert.fail('The decision check cannot switch to an LLM.'),
        });
        const checked = {
          ...input,
          action: {
            name: 'NOD_browser',
            arguments: { page: 'https://mail.example.test/compose', control: { name: 'Send' } },
          },
          ...(path === 'rule' ? { userRules: 'Ask before sending a synthetic message.' } : {}),
          messageDrafts: [
            {
              draftId: null,
              connectionId: 'synthetic-connection',
              target: {},
              messages: [],
              unavailable: true,
            },
          ],
        };
        if (served === expected)
          assert.equal(Object(await review('', checked)).run, path === 'grant');
        else
          await assert.rejects(
            review('', checked),
            (error) =>
              Object(error).code === 'decision_model_mismatch' &&
              Object(error).reviewRequired === true &&
              Object(error).reviewUnavailable === true &&
              String(error).includes(expected),
          );
        assert.equal(calls, 1);
      });
});

test('a selected Perplexity action check cannot lose its response binding', async () => {
  const requested = 'perplexity/pplx-decider-v1.2';
  const served = 'perplexity/pplx-decider-v1.2-20261016';
  for (const model of [
    undefined,
    { provider: 'openai', requested, served },
    { provider: 'openrouter', requested: 'synthetic-other-model', served },
    { requested, served },
  ]) {
    const review = createTrustReview({
      review: async () => assert.fail('The decision check cannot switch to an LLM.'),
      decisions: {
        check: async (request) => {
          request.forModel?.({ provider: 'openrouter', model: requested });
          return {
            choice: 'message:1',
            probability: 1,
            additional: { messageReview: { choice: false, probability: 1 } },
            model,
          };
        },
      },
    });
    await assert.rejects(
      review('', input),
      (error) =>
        Object(error).code === 'decision_model_mismatch' &&
        Object(error).reviewRequired === true &&
        Object(error).reviewUnavailable === true,
    );
  }
});

test('Perplexity read and reply classifications require the fixed served model', async () => {
  const expected = 'perplexity/pplx-decider-v1.2-20261016';
  for (const name of ['readOnly', 'answer'])
    for (const served of [expected, 'perplexity/pplx-decider-v1.3', undefined]) {
      const choices =
        name === 'readOnly'
          ? [
              { value: true, description: 'This action only reads.' },
              { value: false, description: 'This action changes data.' },
            ]
          : [
              { value: 'yes', description: 'The owner approves.' },
              { value: 'no', description: 'The owner refuses.' },
            ];
      const review = createTrustReview({
        review: async () => assert.fail('The decision check cannot switch to an LLM.'),
        decisions: createDecisionModel({
          resolve: async () => ({
            provider: 'openrouter',
            key: 'synthetic-decision-key',
            model: 'perplexity/pplx-decider-v1.2',
          }),
          fetch: async () =>
            Response.json({
              model: served,
              answers: {
                [name]: {
                  type: 'choice',
                  choice: String(choices[0].value),
                  probabilities: Object.fromEntries(
                    choices.map(({ value }, index) => [String(value), Number(index === 0)]),
                  ),
                },
              },
              usage: { input_tokens: 100 },
            }),
        }),
      });
      if (served === expected) {
        const result = Object(
          await review('', input, undefined, { name, choices, minProbability: 0.99 }),
        );
        assert.equal(result[name], choices[0].value);
        assert.equal(result.choice, choices[0].value);
      } else
        await assert.rejects(
          review('', input, undefined, { name, choices, minProbability: 0.99 }),
          (error) => Object(error).code === 'decision_model_mismatch',
        );
    }
});
