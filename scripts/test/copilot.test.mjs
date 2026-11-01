import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packBatches, parseUsage, updateText } from '../lib/copilot.mjs';

test('usage is read from the OpenTelemetry export', () => {
  const agent = {
    name: 'invoke_agent',
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '12000' } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: 800 } },
      { key: 'github.copilot.nano_aiu', value: { intValue: '1500000000' } },
      { key: 'server.address', value: { stringValue: 'api.githubcopilot.com' } },
    ],
  };
  const chat = {
    name: 'chat gpt-6-luna',
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 12000, 'github.copilot.nano_aiu': 1500000000 },
  };
  const text = [JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [agent, chat] }] }] }), 'not json', ''].join('\n');
  assert.deepEqual(parseUsage(text), { inputTokens: 12000, outputTokens: 800, aiUnits: 1.5 });
  assert.equal(parseUsage(''), null);
});

test('updates are packed into few, small prompts', () => {
  const projects = new Map([['A', { name: 'A', kind: 'World of Warcraft add-on', description: 'Shows things.', readme: 'About A.' }]]);
  const item = (n) => ({
    key: `k${n}`,
    projects: ['A'],
    date: '2026-10-27',
    newProject: false,
    prTitle: '',
    prBody: '',
    commits: [{ title: `Change ${n}`, body: '' }],
    files: [{ filename: 'A.lua', status: 'modified', additions: 1, deletions: 0, patch: '+print("hi")' }],
    filesTotal: 1,
    diffChars: 2500,
  });
  const items = Array.from({ length: 7 }, (_, index) => item(index + 1));
  const batches = packBatches('Gasteren', items, projects, { maxItems: 3, maxChars: 60000 });
  assert.deepEqual(batches.map((batch) => batch.items.length), [3, 3, 1]);
  assert.deepEqual(batches[0].items.map((entry) => entry.id), ['u1', 'u2', 'u3']);
  assert.ok(batches[0].prompt.includes('[u1] Project: A'));
  assert.ok(batches[0].prompt.includes('Reply with ONLY a JSON array'));
  assert.equal(packBatches('Gasteren', items.slice(0, 2), projects, { maxItems: 10, maxChars: 100 }).length, 2);
});

test('bulk updates are described once and merge notes are left out', () => {
  const text = updateText({
    id: 'u1',
    projects: ['A', 'B'],
    date: '2026-10-27',
    newProject: false,
    prTitle: '',
    prBody: '',
    commits: [
      { title: 'Merge pull request #1 from x/y', body: '' },
      { title: 'Pin action', body: '' },
    ],
    files: [],
    filesTotal: 0,
    diffChars: 100,
  });
  assert.ok(text.includes('Same change applied to 2 projects: A, B'));
  assert.ok(text.includes('- Pin action'));
  assert.ok(!text.includes('Merge pull request'));
});
