#!/usr/bin/env node
// Builds site/data/dashboard.json from public GitHub data and adds plain-English summaries written by Copilot CLI.
// Usage: node scripts/build.mjs [--state state] [--out site/data] [--config dashboard.config.json] [--no-ai]
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './lib/copilot.mjs';
import { activitySeries, cardOutput, countSince, groupIntoCards, languageMix, summarizeContributors } from './lib/feed.mjs';
import { GitHubClient, linkTarget, RateLimitError } from './lib/github.mjs';
import { assertPublicOnly, compactRepo, httpUrl, isPublicRepo, selectRepos } from './lib/repos.mjs';
import {
  cleanPrBody,
  contentKey,
  findCurseForgeUrl,
  isBotAuthor,
  isMergeMessage,
  languageColor,
  prettyName,
  projectKind,
  readmeExcerpt,
  splitMessage,
  truncate,
} from './lib/text.mjs';
import { DAY_MS, endGroup, group, hash, info, mapPool, readJson, toTime, warn, writeJson } from './lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DETAILS_VERSION = 2;
const STATS_VERSION = 1;
const WEEKS_VERSION = 2;
const STATE_FILES = ['cache.json', 'updates.json', 'summaries.json', 'ai-usage.json'];

const DEFAULTS = {
  owner: '',
  title: '',
  tagline: '',
  exclude: [],
  includeForks: false,
  includeArchived: true,
  curseforgeLinks: {},
  feed: {
    days: 180,
    maxCards: 200,
    groupWindowHours: 12,
    activityTypes: ['push', 'pr_merge', 'merge_queue_merge', 'force_push', 'branch_creation'],
  },
  ai: {
    enabled: true,
    models: ['gpt-6-luna', 'gpt-5.6-luna'],
    reasoningEffort: 'low',
    maxAiCreditsPerCall: 30,
    maxAiCreditsPerRun: 20,
    maxAiCreditsPerDay: 100,
    maxCallsPerRun: 4,
    maxUpdatesPerCall: 15,
    maxPromptChars: 60000,
    maxAttemptsPerUpdate: 3,
    timeoutSeconds: 300,
    prices: { 'gpt-6-luna': [0.1, 0.5], 'gpt-5.6-luna': [0.2, 1.2] },
  },
  github: {
    concurrency: 4,
    maxActivityPages: 3,
    maxDetailFetchesPerRun: 120,
    minRateLimitRemaining: 150,
  },
};

function parseArgs(argv) {
  const options = { ai: true, state: 'state', out: 'site/data', config: 'dashboard.config.json' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--no-ai') options.ai = false;
    else if (arg === '--state') options.state = argv[++index];
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--config') options.config = argv[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function loadConfig(file) {
  const user = await readJson(file, null);
  if (!user) throw new Error(`Missing config file: ${file}`);
  const config = {
    ...DEFAULTS,
    ...user,
    feed: { ...DEFAULTS.feed, ...user.feed },
    ai: { ...DEFAULTS.ai, ...user.ai, prices: { ...DEFAULTS.ai.prices, ...user.ai?.prices } },
    github: { ...DEFAULTS.github, ...user.github },
  };
  if (!config.owner) throw new Error('Set "owner" in dashboard.config.json.');
  if (!Array.isArray(config.ai.models) || !config.ai.models.length) config.ai.models = DEFAULTS.ai.models;
  if (!(config.ai.maxAiCreditsPerCall >= 30)) {
    warn('ai.maxAiCreditsPerCall must be at least 30 (the Copilot CLI minimum); using 30.');
    config.ai.maxAiCreditsPerCall = 30;
  }
  const links = {};
  for (const [name, url] of Object.entries(config.curseforgeLinks || {})) links[name.toLowerCase()] = url;
  config.curseforgeLinks = links;
  return config;
}

async function fetchProfile(gh, owner, cache) {
  const fallback = { login: owner, name: owner, avatarUrl: `https://github.com/${owner}.png`, url: `https://github.com/${owner}`, bio: '' };
  try {
    const response = await gh.request(`/users/${owner}`, { etag: cache.profile?.etag });
    if (response.status === 304 && cache.profile?.data) return cache.profile.data;
    const profile = response.data;
    const data = { login: profile.login, name: profile.name || profile.login, avatarUrl: profile.avatar_url, url: profile.html_url, bio: profile.bio || '' };
    cache.profile = { etag: response.etag || null, data };
    return data;
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    warn(`Could not load the profile: ${error.message}`);
    return cache.profile?.data || fallback;
  }
}

async function fetchRepoList(gh, owner) {
  let url = `/users/${owner}/repos?type=owner&sort=pushed&per_page=100`;
  const repos = [];
  for (let page = 0; url && page < 10; page++) {
    const response = await gh.request(url);
    repos.push(...(Array.isArray(response.data) ? response.data : []).map(compactRepo));
    url = linkTarget(response.headers.get('link'), 'next');
  }
  return repos;
}

async function refreshActivity(gh, base, repo, entry, since, config) {
  if (entry.branch !== repo.defaultBranch) {
    entry.branch = repo.defaultBranch;
    entry.activity = [];
    entry.activityEtag = null;
  }
  const known = new Set((entry.activity || []).map((event) => event.id));
  const fresh = [];
  let newEtag = entry.activityEtag || null;
  let url = `${base}/activity?ref=${encodeURIComponent(repo.defaultBranch)}&per_page=100`;
  for (let page = 1; url && page <= config.github.maxActivityPages; page++) {
    const response = await gh.request(url, { etag: page === 1 ? entry.activityEtag : undefined, allowStatuses: [404, 409, 422] });
    if (response.status !== 200) break;
    if (page === 1) newEtag = response.etag || null;
    const list = Array.isArray(response.data) ? response.data : [];
    let stop = list.length === 0;
    for (const event of list) {
      if (known.has(event.id) || toTime(event.timestamp) < since) {
        stop = true;
        continue;
      }
      if (!config.feed.activityTypes.includes(event.activity_type)) continue;
      fresh.push({
        id: event.id,
        type: event.activity_type,
        before: event.before,
        after: event.after,
        time: event.timestamp,
        actor: event.actor?.login ?? null,
      });
    }
    if (stop) break;
    url = linkTarget(response.headers.get('link'), 'next');
  }
  const merged = new Map();
  for (const event of [...fresh, ...(entry.activity || [])]) {
    if (toTime(event.time) >= since && !merged.has(event.id)) merged.set(event.id, event);
  }
  entry.activity = [...merged.values()].sort((a, b) => toTime(b.time) - toTime(a.time));
  entry.activityEtag = newEtag;
}

async function refreshStats(gh, base, repo, entry, week) {
  const languages = await gh.request(`${base}/languages`, { allowStatuses: [404] });
  entry.languages = languages.status === 200 && languages.data ? languages.data : {};

  const commits = await gh.count(`${base}/commits?sha=${encodeURIComponent(repo.defaultBranch)}`, { allowStatuses: [404, 409] });
  entry.commits = commits.count;
  entry.lastCommitAt = commits.first?.commit?.committer?.date ?? commits.first?.commit?.author?.date ?? null;

  const releases = await gh.count(`${base}/releases`, { allowStatuses: [404] });
  entry.releases = releases.count;
  const latest = releases.first;
  entry.latestRelease = latest
    ? { name: truncate(latest.name || latest.tag_name, 80), tag: latest.tag_name, url: latest.html_url, date: latest.published_at || latest.created_at }
    : null;

  const readme = await gh.request(`${base}/readme`, { raw: true, allowStatuses: [404] });
  const text = readme.status === 200 ? String(readme.data || '') : '';
  entry.readme = readmeExcerpt(text, 600);
  entry.curseforge = findCurseForgeUrl(repo, text);
  entry.kind = projectKind(repo, text, Boolean(entry.curseforge));

  entry.pushedAt = repo.pushedAt;
  entry.week = week;
  entry.statsVersion = STATS_VERSION;
}

async function refreshRepo(gh, config, repo, cache, { since, week }) {
  const entry = cache.repos[repo.name] || {};
  cache.repos[repo.name] = entry;
  if (!repo.defaultBranch) return;
  const base = `/repos/${config.owner}/${repo.name}`;

  await refreshActivity(gh, base, repo, entry, since, config);
  if (gh.lowOnBudget) return;

  if (entry.statsVersion !== STATS_VERSION || entry.pushedAt !== repo.pushedAt || entry.week !== week) {
    await refreshStats(gh, base, repo, entry, week);
  }
  // Weekly commits by people; commits from bot accounts (such as scheduled data refreshes) are left out.
  if (!entry.weeks || entry.weeksPushedAt !== repo.pushedAt || entry.weeksWeek !== week || entry.weeksVersion !== WEEKS_VERSION) {
    const contributors = await gh.stats(`${base}/stats/contributors`);
    if (contributors) {
      const summary = summarizeContributors(contributors);
      entry.weeks = summary.weeks;
      entry.humanCommits = summary.humanCommits;
      entry.botCommits = summary.botCommits;
      entry.weeksPushedAt = repo.pushedAt;
      entry.weeksWeek = week;
      entry.weeksVersion = WEEKS_VERSION;
    }
  }
  if (!repo.openIssues) {
    entry.openPrs = 0;
    entry.openPrsFor = 0;
  } else if (entry.openPrsFor !== repo.openIssues) {
    const pulls = await gh.count(`${base}/pulls?state=open`, { allowStatuses: [404] });
    entry.openPrs = pulls.count;
    entry.openPrsFor = repo.openIssues;
  }
}

async function fetchUpdate(gh, owner, repo, event, contexts) {
  const base = `/repos/${owner}/${repo.name}`;
  const zeroBefore = !event.before || /^0+$/.test(event.before);
  const newProject = zeroBefore && Math.abs(toTime(event.time) - toTime(repo.createdAt)) < 3 * DAY_MS;
  let commits = [];
  let files = [];
  let totalCommits = 0;
  let compareUrl = null;

  if (!zeroBefore) {
    const compare = await gh.request(`${base}/compare/${event.before}...${event.after}`, { allowStatuses: [404, 422] });
    if (compare.status === 200 && compare.data) {
      commits = compare.data.commits || [];
      files = compare.data.files || [];
      totalCommits = compare.data.total_commits ?? commits.length;
      compareUrl = compare.data.html_url || null;
    }
  }
  if (!commits.length && event.after) {
    const head = await gh.request(`${base}/commits/${event.after}`, { allowStatuses: [404, 422] });
    if (head.status === 200 && head.data) {
      commits = [head.data];
      files = head.data.files || [];
      totalCommits = 1;
      compareUrl = head.data.html_url || null;
    }
  }

  const messages = commits.map((commit) => commit.commit?.message || '');
  let pr = null;
  const wantsPr = ['pr_merge', 'merge_queue_merge'].includes(event.type) || messages.some((message) => /#\d+/.test(message));
  if (wantsPr && event.after) {
    const pulls = await gh.request(`${base}/commits/${event.after}/pulls`, { allowStatuses: [404, 422] });
    const list = Array.isArray(pulls.data) ? pulls.data : [];
    const chosen = list.find((item) => item.merge_commit_sha === event.after) || list.find((item) => item.merged_at) || null;
    if (chosen) pr = { number: chosen.number, title: chosen.title || '', body: cleanPrBody(chosen.body || '', 1500), url: chosen.html_url };
  }

  const compactCommits = commits.map((commit) => {
    const { title, body } = splitMessage(commit.commit?.message);
    return {
      sha: commit.sha,
      title: truncate(title, 200),
      body: truncate(body, 400),
      url: commit.html_url,
      author: commit.author?.login || null,
      merge: isMergeMessage(commit.commit?.message),
      bot: isBotAuthor({
        login: commit.author?.login,
        type: commit.author?.type,
        name: commit.commit?.author?.name,
        email: commit.commit?.author?.email,
      }),
    };
  });
  const uid = `${repo.name}#${event.id}`;
  contexts.set(uid, {
    commits: compactCommits,
    files: files.slice(0, 80).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions || 0,
      deletions: file.deletions || 0,
      patch: file.patch || '',
    })),
  });

  return {
    v: DETAILS_VERSION,
    repo: repo.name,
    id: event.id,
    type: event.type,
    time: event.time,
    before: event.before,
    after: event.after,
    actor: event.actor,
    newProject,
    // Direct pushes where every commit came from a bot account; merged pull requests never count as automatic.
    bot: ['push', 'force_push'].includes(event.type) && compactCommits.length > 0 && compactCommits.every((commit) => commit.bot),
    key: commits.length ? contentKey(messages, files) : `solo-${hash(uid)}`,
    pr,
    commits: compactCommits.slice(-30),
    totalCommits,
    files: {
      count: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions || 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
      names: files.slice(0, 30).map((file) => file.filename),
    },
    compareUrl,
  };
}

function collectEvents(repos, cache, types, since) {
  const events = [];
  for (const repo of repos) {
    for (const event of cache.repos[repo.name]?.activity || []) {
      if (!types.includes(event.type) || toTime(event.time) < since) continue;
      events.push({ ...event, repo: repo.name, uid: `${repo.name}#${event.id}` });
    }
  }
  return events.sort((a, b) => toTime(b.time) - toTime(a.time));
}

async function runSummaries({ config, profile, repos, cache, events, updates, summaries, contexts, gh, budget }) {
  const groups = new Map();
  for (const event of events) {
    const update = updates[event.uid];
    if (!update || !update.commits?.length || update.bot) continue;
    const stored = summaries[update.key];
    if (stored?.headline || (stored?.failures || 0) >= config.ai.maxAttemptsPerUpdate) continue;
    if (!groups.has(update.key)) groups.set(update.key, []);
    groups.get(update.key).push(update);
  }
  if (!groups.size) {
    info('Every update already has a summary, so Copilot was not called.');
    return null;
  }
  const pending = [...groups.entries()].slice(0, config.ai.maxCallsPerRun * config.ai.maxUpdatesPerCall);
  info(`${groups.size} update(s) need a summary; sending up to ${pending.length} this run.`);

  // Updates found in an earlier run need their full change context fetched again.
  const repoByName = new Map(repos.map((repo) => [repo.name, repo]));
  for (const [, members] of pending) {
    const lead = members[0];
    const uid = `${lead.repo}#${lead.id}`;
    if (contexts.has(uid) || gh.lowOnBudget) continue;
    try {
      await fetchUpdate(gh, config.owner, repoByName.get(lead.repo), lead, contexts);
    } catch (error) {
      if (error instanceof RateLimitError) break;
      warn(`Could not reload details for ${uid}: ${error.message}`);
    }
  }

  const items = pending.map(([key, members]) => {
    const lead = members[0];
    const context = contexts.get(`${lead.repo}#${lead.id}`);
    const files = context?.files || (lead.files?.names || []).map((filename) => ({ filename, status: 'modified', additions: 0, deletions: 0, patch: '' }));
    return {
      key,
      projects: [...new Set(members.map((member) => member.repo))],
      date: String(lead.time).slice(0, 10),
      newProject: lead.newProject,
      prTitle: lead.pr?.title || '',
      prBody: lead.pr?.body || '',
      commits: (context?.commits || lead.commits).map((commit) => ({ title: commit.title, body: commit.body || '' })),
      files,
      filesTotal: lead.files?.count ?? files.length,
      diffChars: 2500,
    };
  });

  const projectsByName = new Map(
    repos.map((repo) => [
      repo.name,
      { name: repo.name, kind: cache.repos[repo.name]?.kind, description: repo.description, readme: cache.repos[repo.name]?.readme },
    ]),
  );
  const run = await summarize(profile.name || config.owner, items, projectsByName, config, budget);
  const at = new Date().toISOString();
  for (const [key, value] of run.results) summaries[key] = { ...value, at };
  for (const key of run.failedKeys) summaries[key] = { failures: (summaries[key]?.failures || 0) + 1, at };
  return { ...run, waiting: groups.size - run.results.size };
}

function buildOutput({ config, profile, repos, cache, events, updates, summaries, now }) {
  const live = events.map((event) => updates[event.uid]).filter(Boolean);
  const cards = groupIntoCards(live, config.feed.groupWindowHours);
  const handmade = cards.filter((card) => !card.automated);
  const feed = cards.slice(0, config.feed.maxCards).map((card) => cardOutput(card, summaries));
  const activity = activitySeries(repos.map((repo) => cache.repos[repo.name]?.weeks || []), now);
  const newestByHand = new Map();
  for (const update of live) if (!update.bot && !newestByHand.has(update.repo)) newestByHand.set(update.repo, update.time);

  const projects = repos
    .map((repo) => {
      const entry = cache.repos[repo.name] || {};
      const candidates = [entry.activity?.[0]?.time, entry.lastCommitAt].filter(Boolean);
      const lastUpdate = newestByHand.get(repo.name) || candidates.sort((a, b) => toTime(b) - toTime(a))[0] || repo.pushedAt;
      const counted = (entry.humanCommits || 0) + (entry.botCommits || 0);
      const key = repo.name.toLowerCase();
      const override = Object.prototype.hasOwnProperty.call(config.curseforgeLinks, key) ? config.curseforgeLinks[key] : undefined;
      const homepage = httpUrl(repo.homepage);
      const curseforge = override === undefined ? entry.curseforge || null : httpUrl(override);
      return {
        name: repo.name,
        title: prettyName(repo.name),
        description: repo.description,
        kind: entry.kind || (curseforge ? 'World of Warcraft add-on' : null),
        url: repo.url,
        homepage: homepage && !/curseforge\.com/i.test(homepage) ? homepage : null,
        curseforge,
        language: repo.language,
        languageColor: repo.language ? languageColor(repo.language) : null,
        stars: repo.stars,
        forks: repo.forks,
        openIssues: Math.max(0, repo.openIssues - (entry.openPrs || 0)),
        commits: counted > 0 ? entry.humanCommits : entry.commits ?? null,
        automaticCommits: counted > 0 ? entry.botCommits : 0,
        releases: entry.releases || 0,
        latestRelease: entry.latestRelease || null,
        lastUpdate,
        createdAt: repo.createdAt,
        archived: repo.archived,
        topics: repo.topics.slice(0, 8),
      };
    })
    .sort((a, b) => toTime(b.lastUpdate) - toTime(a.lastUpdate));

  const sum = (field) => projects.reduce((total, project) => total + (project[field] || 0), 0);
  const aiCards = feed.filter((card) => card.ai);
  const models = [...new Set(Object.values(summaries).map((entry) => entry.model).filter(Boolean))];
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    title: config.title || `${profile.name}'s projects`,
    tagline: config.tagline || '',
    owner: profile,
    totals: {
      projects: projects.length,
      updatesWeek: countSince(handmade, 7, now),
      updatesMonth: countSince(handmade, 30, now),
      stars: sum('stars'),
      forks: sum('forks'),
      openIssues: sum('openIssues'),
      releases: sum('releases'),
      commitsYear: activity.reduce((total, week) => total + week.commits, 0),
    },
    activity,
    languages: languageMix(repos.map((repo) => cache.repos[repo.name]?.languages || {})),
    projects,
    feed,
    meta: {
      feedDays: config.feed.days,
      aiSummaries: aiCards.length,
      aiModels: models,
      repository: process.env.GITHUB_REPOSITORY || null,
    },
  };
}

async function readStateTexts(stateDir) {
  const texts = {};
  for (const file of STATE_FILES) {
    try {
      texts[file] = await readFile(path.join(stateDir, file), 'utf8');
    } catch {
      texts[file] = null;
    }
  }
  return texts;
}

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function writeStepSummary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function usageLines(aiRun, config) {
  if (!aiRun) return ['### Copilot usage', '', 'No AI calls this run (nothing new to summarize, or AI turned off).'];
  const usage = aiRun.usage;
  const lines = [
    '### Copilot usage',
    '',
    `Limits: ${config.ai.maxAiCreditsPerCall} AI credits per call (Copilot CLI \`--max-ai-credits\`), ${config.ai.maxAiCreditsPerRun} per run, ${config.ai.maxAiCreditsPerDay} per 24 hours, and at most ${config.ai.maxCallsPerRun} calls per run.`,
    '',
    '| # | Model | Updates | Input tokens | Output tokens | AI units | Est. AI credits | Exit |',
    '|---|---|---|---|---|---|---|---|',
  ];
  usage.details.forEach((call, index) => {
    lines.push(
      `| ${index + 1} | ${call.model} | ${call.updates} | ${call.inputTokens ?? '?'} | ${call.outputTokens ?? '?'} | ${call.aiUnits ?? '?'} | ${call.estimatedCredits ?? '?'} | ${call.exitCode} |`,
    );
  });
  lines.push(
    '',
    `Total: ${usage.calls} call(s), ${usage.inputTokens} input and ${usage.outputTokens} output tokens, ${usage.aiUnits.toFixed(4)} AI units reported, about ${usage.estimatedCredits.toFixed(4)} AI credits (≈ $${(usage.estimatedCredits / 100).toFixed(4)}) estimated from token prices.`,
    `Summaries written: ${aiRun.results.size}. Still waiting: ${aiRun.waiting}.`,
  );
  return lines;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(path.resolve(ROOT, options.config));
  const stateDir = path.resolve(ROOT, options.state);
  const outFile = path.resolve(ROOT, options.out, 'dashboard.json');
  const aiEnabled = options.ai && config.ai.enabled !== false && process.env.DASHBOARD_AI !== 'off';
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!token) warn('No GITHUB_TOKEN or GH_TOKEN is set; GitHub allows only 60 unauthenticated requests per hour.');

  const gh = new GitHubClient({ token, minRemaining: config.github.minRateLimitRemaining });
  const now = Date.now();
  const since = now - config.feed.days * DAY_MS;
  const week = Math.floor(now / (7 * DAY_MS));

  const before = await readStateTexts(stateDir);
  const cache = JSON.parse(before['cache.json'] || '{}');
  cache.repos ||= {};
  delete cache.list;
  const updates = JSON.parse(before['updates.json'] || '{}');
  const summaries = JSON.parse(before['summaries.json'] || '{}');
  const usageHistory = JSON.parse(before['ai-usage.json'] || '[]');

  group('Projects');
  const profile = await fetchProfile(gh, config.owner, cache);
  const listed = await fetchRepoList(gh, config.owner);
  const repos = selectRepos(listed, config);
  const allowed = new Set(repos.map((repo) => repo.name));
  for (const name of Object.keys(cache.repos)) if (!allowed.has(name)) delete cache.repos[name];
  info(`${repos.length} public project(s) selected (${listed.filter((repo) => isPublicRepo(repo, config.owner)).length} public, ${listed.length} listed).`);
  endGroup();

  group('Activity and stats');
  let rateLimited = false;
  await mapPool(repos, config.github.concurrency, async (repo) => {
    if (rateLimited) return;
    try {
      await refreshRepo(gh, config, repo, cache, { since, week });
    } catch (error) {
      if (error instanceof RateLimitError) rateLimited = true;
      warn(`${repo.name}: ${error.message}`);
    }
  });
  const events = collectEvents(repos, cache, config.feed.activityTypes, since);
  info(`${events.length} update(s) to default branches in the last ${config.feed.days} days.`);
  endGroup();

  group('Update details');
  const contexts = new Map();
  const repoByName = new Map(repos.map((repo) => [repo.name, repo]));
  const missing = events.filter((event) => updates[event.uid]?.v !== DETAILS_VERSION);
  const toFetch = missing.slice(0, config.github.maxDetailFetchesPerRun);
  let fetched = 0;
  await mapPool(toFetch, config.github.concurrency, async (event) => {
    if (rateLimited || gh.lowOnBudget) return;
    try {
      updates[event.uid] = await fetchUpdate(gh, config.owner, repoByName.get(event.repo), event, contexts);
      fetched++;
    } catch (error) {
      if (error instanceof RateLimitError) rateLimited = true;
      warn(`${event.uid}: ${error.message}`);
    }
  });
  const live = new Set(events.map((event) => event.uid));
  for (const uid of Object.keys(updates)) if (!live.has(uid)) delete updates[uid];
  info(`Fetched details for ${fetched} update(s); ${missing.length - fetched} still waiting for a later run.`);
  endGroup();

  group('Plain-English summaries');
  let aiRun = null;
  const spentToday = usageHistory
    .filter((entry) => toTime(entry.at) >= now - DAY_MS)
    .reduce(
      (total, entry) =>
        total + Math.max(entry.aiUnits || 0, entry.estimatedCredits || 0) + (entry.unknownUsageCalls || 0) * config.ai.maxAiCreditsPerCall,
      0,
    );
  const budget = Math.min(config.ai.maxAiCreditsPerRun, config.ai.maxAiCreditsPerDay - spentToday);
  if (!aiEnabled) info('AI summaries are turned off for this run.');
  else if (budget <= 0) info(`Skipping AI this run: about ${spentToday.toFixed(2)} AI credits were used in the last 24 hours (daily limit ${config.ai.maxAiCreditsPerDay}).`);
  else aiRun = await runSummaries({ config, profile, repos, cache, events, updates, summaries, contexts, gh, budget });
  const liveKeys = new Set(Object.values(updates).map((update) => update.key));
  for (const key of Object.keys(summaries)) if (!liveKeys.has(key)) delete summaries[key];
  if (aiRun && aiRun.usage.calls > 0) {
    const usage = aiRun.usage;
    usageHistory.push({
      at: new Date().toISOString(),
      calls: usage.calls,
      failedCalls: usage.failedCalls,
      summaries: aiRun.results.size,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      aiUnits: Number(usage.aiUnits.toFixed(4)),
      estimatedCredits: Number(usage.estimatedCredits.toFixed(4)),
      unknownUsageCalls: usage.unknownUsageCalls,
      models: usage.models,
    });
  }
  endGroup();

  const output = buildOutput({ config, profile, repos, cache, events, updates, summaries, now });
  assertPublicOnly({ output, allowed, cache, updates });
  await writeJson(outFile, output, { pretty: false });

  const after = {
    'cache.json': `${JSON.stringify(cache, null, 2)}\n`,
    'updates.json': `${JSON.stringify(updates, null, 2)}\n`,
    'summaries.json': `${JSON.stringify(summaries, null, 2)}\n`,
    'ai-usage.json': `${JSON.stringify(usageHistory.slice(-500), null, 2)}\n`,
  };
  // ETags alone don't justify a new snapshot of the data branch.
  const comparable = (file, text) =>
    file === 'cache.json' && text ? JSON.stringify(JSON.parse(text), (key, value) => (key === 'etag' || key === 'activityEtag' ? undefined : value)) : text;
  let changed = false;
  for (const file of STATE_FILES) {
    if (comparable(file, after[file]) !== comparable(file, before[file])) changed = true;
    await writeJson(path.join(stateDir, file), JSON.parse(after[file]));
  }
  await setOutput('state_changed', String(changed));

  const apiLine = `GitHub API: ${gh.requests} requests, ${gh.notModified} unchanged (free), ${gh.remaining ?? '?'} of ${gh.limit ?? '?'} left this hour.`;
  info(apiLine);
  info(`Feed: ${output.feed.length} card(s), ${output.meta.aiSummaries} with Copilot summaries. Saved data changed: ${changed}.`);
  await writeStepSummary([
    '## Dashboard build',
    '',
    `- Projects: ${output.totals.projects}`,
    `- Feed cards: ${output.feed.length} (${output.meta.aiSummaries} with Copilot summaries)`,
    `- ${apiLine}`,
    '',
    ...usageLines(aiRun, config),
  ]);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
