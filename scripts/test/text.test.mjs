import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanTitle,
  contentKey,
  findCurseForgeUrl,
  isBotAuthor,
  isMergeMessage,
  parseJsonArray,
  prettyName,
  readmeExcerpt,
  splitMessage,
  truncate,
} from '../lib/text.mjs';

test('cleanTitle removes prefixes, CI markers and request numbers', () => {
  assert.equal(cleanTitle('feat(ui): add dark mode (#12)'), 'Add dark mode');
  assert.equal(cleanTitle('Pin the CurseForge upload action to a commit [skip ci]'), 'Pin the CurseForge upload action to a commit');
  assert.equal(cleanTitle('fix: typo in tooltip.'), 'Typo in tooltip');
});

test('merge messages are recognised', () => {
  assert.equal(isMergeMessage('Merge pull request #5 from Gasteren/gasteren-fix'), true);
  assert.equal(isMergeMessage("Merge branch 'main' into feature"), true);
  assert.equal(isMergeMessage('Merged the docs'), false);
});

test('splitMessage drops trailers', () => {
  assert.deepEqual(splitMessage('Title line\n\nBody text\n\nCo-authored-by: Copilot <copilot@example.com>'), {
    title: 'Title line',
    body: 'Body text',
  });
});

test('CurseForge links must match the project name', () => {
  const jetpacks =
    'This addon is a plugin for [HandyNotes](https://www.curseforge.com/wow/addons/handynotes).\n' +
    '- Please [open an issue](https://legacy.curseforge.com/wow/addons/handynotes_jetpacks/issues/create)';
  assert.equal(findCurseForgeUrl({ name: 'HandyNotes_Jetpacks', homepage: '' }, jetpacks), 'https://www.curseforge.com/wow/addons/handynotes-jetpacks');

  const adibags =
    '[Betterbags Fishing Link](https://www.curseforge.com/wow/addons/betterbags-fishing)\n' +
    '- Please create an [Issue](https://legacy.curseforge.com/wow/addons/adibags_fishing/issues)';
  assert.equal(findCurseForgeUrl({ name: 'Adibags_Fishing', homepage: '' }, adibags), 'https://www.curseforge.com/wow/addons/adibags-fishing');

  const lozn = 'Please create an [Issue](https://www.curseforge.com/wow/addons/lozn64-levelup/issues) on CurseForge.';
  assert.equal(findCurseForgeUrl({ name: 'LoZN64', homepage: '' }, lozn), 'https://www.curseforge.com/wow/addons/lozn64-levelup');

  assert.equal(
    findCurseForgeUrl({ name: 'Anything', homepage: 'https://www.curseforge.com/wow/addons/some-addon' }, ''),
    'https://www.curseforge.com/wow/addons/some-addon',
  );
  assert.equal(findCurseForgeUrl({ name: 'KH-Hotfix', homepage: '' }, 'see https://www.curseforge.com/wow/addons/tomtom'), null);
});

test('identical changes share a content key', () => {
  const file = {
    filename: '.github/workflows/release.yml',
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: '@@ -10,7 +10,7 @@\n-      uses: BigWigsMods/packager@v2\n+      uses: BigWigsMods/packager@abc123 # v2',
  };
  const message = 'Pin the CurseForge upload action to a commit [skip ci]';
  const a = contentKey([message], [file]);
  const b = contentKey([message], [
    { ...file, patch: '@@ -12,7 +12,7 @@\n-        uses: BigWigsMods/packager@v2\n+        uses: BigWigsMods/packager@abc123 # v2' },
  ]);
  const c = contentKey([message], [{ ...file, patch: '-uses: x@v1\n+uses: x@v2' }]);
  assert.equal(a, b);
  assert.notEqual(a, c);

  const k1 = contentKey(['Merge pull request #3 from Gasteren/x', 'Add zone (#3)'], [file]);
  const k2 = contentKey(['Merge pull request #9 from Gasteren/y', 'Add zone (#9)'], [file]);
  assert.equal(k1, k2);
});

test('JSON arrays are read from model replies', () => {
  assert.deepEqual(parseJsonArray('```json\n[{"id":"u1"}]\n```'), [{ id: 'u1' }]);
  assert.deepEqual(parseJsonArray('Here you go: [{"id":"u2","headline":"A [test]"}] done'), [{ id: 'u2', headline: 'A [test]' }]);
  assert.equal(parseJsonArray('no json here'), null);
  assert.equal(parseJsonArray('{"id":1}'), null);
});

test('README excerpts skip badges, images and markup', () => {
  const markdown =
    '# My Addon\n\n[![Build](https://img.shields.io/badge.svg)](https://example.com)\n\n![shot](a.png)\n\n' +
    'Shows **jetpack** locations on your map.\n\n<p align="center">Hi</p>';
  const excerpt = readmeExcerpt(markdown, 200);
  assert.ok(excerpt.includes('Shows jetpack locations on your map.'));
  assert.ok(!excerpt.includes('shields'));
  assert.ok(!excerpt.includes('png'));
});

test('small text helpers', () => {
  assert.equal(prettyName('HandyNotes_Jetpacks'), 'HandyNotes Jetpacks');
  assert.equal(prettyName('KH-Hotfix'), 'KH Hotfix');
  assert.equal(prettyName('gasteren.github.io'), 'gasteren.github.io');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});

test('bot accounts are recognised', () => {
  assert.equal(isBotAuthor({ login: 'github-actions[bot]' }), true);
  assert.equal(isBotAuthor({ type: 'Bot' }), true);
  assert.equal(isBotAuthor({ name: 'dependabot[bot]' }), true);
  assert.equal(isBotAuthor({ email: '41898282+github-actions[bot]@users.noreply.github.com' }), true);
  assert.equal(isBotAuthor({ login: 'Gasteren', type: 'User', name: 'Gasteren', email: 'someone@example.com' }), false);
  assert.equal(isBotAuthor(), false);
});
