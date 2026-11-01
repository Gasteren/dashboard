import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activitySeries,
  cardOutput,
  countSince,
  fallbackHeadline,
  fallbackSummary,
  groupIntoCards,
  languageMix,
  summarizeContributors,
  weekAxis,
} from '../lib/feed.mjs';

const update = (repo, id, time, key, extra = {}) => ({
  repo,
  id,
  time,
  key,
  type: 'push',
  commits: [{ sha: 'a'.repeat(40), title: 'Pin the CurseForge upload action to a commit [skip ci]', url: 'https://github.com/x', merge: false }],
  files: { count: 1, additions: 1, deletions: 1 },
  compareUrl: `https://github.com/Gasteren/${repo}/compare/a...b`,
  ...extra,
});

test('identical changes in several projects become one card', () => {
  const cards = groupIntoCards(
    [
      update('A', 1, '2026-10-27T15:19:10Z', 'k1'),
      update('B', 2, '2026-10-27T15:19:40Z', 'k1'),
      update('C', 3, '2026-10-27T15:20:05Z', 'k1'),
      update('A', 4, '2026-10-20T10:00:00Z', 'k2'),
    ],
    12,
  );
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0].members.map((member) => member.repo), ['C', 'B', 'A']);
  const output = cardOutput(cards[0], {});
  assert.deepEqual(output.projects, ['C', 'B', 'A']);
  assert.equal(output.ai, false);
  assert.equal(output.headline, 'Pin the CurseForge upload action to a commit');
  assert.equal(output.details.links.length, 3);
});

test('the same change far apart in time gets separate cards', () => {
  const cards = groupIntoCards([update('A', 1, '2026-10-01T00:00:00Z', 'k'), update('B', 2, '2026-10-03T00:00:00Z', 'k')], 12);
  assert.equal(cards.length, 2);
});

test('stored summaries replace the fallback text', () => {
  const cards = groupIntoCards([update('A', 1, '2026-10-01T00:00:00Z', 'k')], 12);
  const output = cardOutput(cards[0], { k: { headline: 'Safer automatic uploads', summary: 'Behind-the-scenes upkeep.', impact: 'behind-the-scenes' } });
  assert.equal(output.ai, true);
  assert.equal(output.headline, 'Safer automatic uploads');
  assert.equal(output.impact, 'behind-the-scenes');
  assert.equal(cardOutput(cards[0], { k: { failures: 2 } }).ai, false);
});

test('fallback text comes from the change request or the notes', () => {
  assert.equal(fallbackHeadline({ pr: { title: 'feat: Add trainer toggles (#7)' }, commits: [] }), 'Add trainer toggles');
  assert.equal(fallbackHeadline({ commits: [], newProject: true }), 'A new project was started');
  const notes = {
    commits: [
      { title: 'Add zone A', merge: false },
      { title: 'Merge pull request #2 from x/y', merge: true },
      { title: 'Fix tooltip', merge: false },
    ],
  };
  assert.equal(fallbackHeadline(notes), 'Fix tooltip');
  assert.equal(fallbackSummary(notes), 'Also in this update: Add zone A.');
});

test('weekly activity is summed on a 52-week axis', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const axis = weekAxis(now);
  assert.equal(axis.length, 52);
  assert.equal(new Date(axis[51]).toISOString(), '2026-11-01T00:00:00.000Z');
  const lastWeek = axis[51] / 1000;
  const series = activitySeries([[[lastWeek, 3]], [[lastWeek, 2], [axis[50] / 1000, 1]]], now);
  assert.equal(series.length, 52);
  assert.equal(series[51].commits, 5);
  assert.equal(series[50].commits, 1);
  assert.equal(series[51].week, '2026-11-01');
});

test('language mix adds up and groups small languages', () => {
  const mix = languageMix([{ Lua: 800, Shell: 50 }, { 'C#': 100, Lua: 50 }], 2);
  assert.deepEqual(mix.map((entry) => entry.name), ['Lua', 'C#', 'Other']);
  assert.equal(mix[0].share, 0.85);
  const total = mix.reduce((sum, entry) => sum + entry.share, 0);
  assert.ok(Math.abs(total - 1) < 0.001);
});

test('updates are counted over rolling windows', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(countSince([{ time: '2026-10-31T00:00:00Z' }, { time: '2026-09-01T00:00:00Z' }], 7, now), 1);
});

test('bot pushes fold into one automatic card per project per week', () => {
  const bot = (repo, id, time) =>
    update(repo, id, time, `key-${id}`, {
      bot: true,
      commits: [{ sha: 'b'.repeat(40), title: 'Update addon stats', url: 'https://github.com/y', merge: false, bot: true }],
    });
  const cards = groupIntoCards(
    [
      bot('Site', 1, '2026-10-20T10:00:00Z'),
      bot('Site', 2, '2026-10-20T10:10:00Z'),
      bot('Site', 3, '2026-10-21T09:00:00Z'),
      bot('Site', 4, '2026-10-26T09:00:00Z'),
      update('Site', 5, '2026-10-22T12:00:00Z', 'human'),
    ],
    12,
  );
  const outputs = cards.map((card) => cardOutput(card, {}));
  assert.deepEqual(
    outputs.map((output) => output.headline),
    ['Automatic update', 'Pin the CurseForge upload action to a commit', '3 automatic updates'],
  );
  assert.equal(outputs[2].automated, true);
  assert.equal(outputs[2].ai, false);
  assert.ok(outputs[2].summary.includes('"Update addon stats"'));
  assert.equal(outputs[2].id, 'Site-automatic-2026-10-18');
});

test('contributor stats leave out bot accounts', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const week = Date.parse('2026-10-25T00:00:00Z') / 1000;
  const old = Date.parse('2024-01-07T00:00:00Z') / 1000;
  const summary = summarizeContributors(
    [
      { author: { login: 'Gasteren', type: 'User' }, total: 40, weeks: [{ w: week, c: 3 }, { w: old, c: 5 }] },
      { author: { login: 'github-actions[bot]', type: 'Bot' }, total: 7000, weeks: [{ w: week, c: 900 }] },
      { author: null, total: 2, weeks: [{ w: week, c: 1 }] },
    ],
    now,
  );
  assert.equal(summary.humanCommits, 42);
  assert.equal(summary.botCommits, 7000);
  assert.deepEqual(summary.weeks, [[week, 4]]);
});
