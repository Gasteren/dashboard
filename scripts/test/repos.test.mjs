import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPublicOnly, compactRepo, httpUrl, selectRepos } from '../lib/repos.mjs';

const raw = (name, extra = {}) => ({
  name,
  owner: { login: 'Gasteren' },
  private: false,
  visibility: 'public',
  fork: false,
  archived: false,
  default_branch: 'main',
  stargazers_count: 1,
  forks_count: 0,
  open_issues_count: 0,
  html_url: `https://github.com/Gasteren/${name}`,
  ...extra,
});

test('only public repositories owned by the account are selected', () => {
  const repos = [
    raw('Public'),
    raw('Secret', { private: true, visibility: 'private' }),
    raw('Internal', { visibility: 'internal' }),
    raw('Sneaky', { private: false, visibility: 'private' }),
    raw('Unknown', { private: undefined, visibility: undefined }),
    raw('Fork', { fork: true }),
    raw('Old', { archived: true }),
    raw('Hidden'),
    raw('Other', { owner: { login: 'someone-else' } }),
  ].map(compactRepo);
  const selected = selectRepos(repos, { owner: 'gasteren', exclude: ['hidden'], includeForks: false, includeArchived: true });
  assert.deepEqual(selected.map((repo) => repo.name), ['Public', 'Old']);
});

test('publishing refuses anything outside the selected projects', () => {
  const allowed = new Set(['Public']);
  const ok = { projects: [{ name: 'Public' }], feed: [{ projects: ['Public'], details: { links: [{ project: 'Public' }] } }] };
  assert.doesNotThrow(() =>
    assertPublicOnly({ output: ok, allowed, cache: { repos: { Public: {} } }, updates: { 'Public#1': { repo: 'Public' } } }),
  );
  const bad = { projects: [{ name: 'Public' }], feed: [{ projects: ['Secret'], details: { links: [] } }] };
  assert.throws(() => assertPublicOnly({ output: bad, allowed, cache: { repos: {} }, updates: {} }), /Refusing to publish/);
  assert.throws(() => assertPublicOnly({ output: ok, allowed, cache: { repos: { Secret: {} } }, updates: {} }), /Refusing to publish/);
});

test('homepage links are normalised', () => {
  assert.equal(httpUrl('gasteren.github.io'), 'https://gasteren.github.io/');
  assert.equal(httpUrl('https://example.com/page'), 'https://example.com/page');
  assert.equal(httpUrl(''), null);
});
