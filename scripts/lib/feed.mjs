import { cleanTitle, isBotAuthor, languageColor, truncate } from './text.mjs';
import { DAY_MS, toTime } from './util.mjs';

const WEEK_MS = 7 * DAY_MS;

export function fallbackHeadline(update) {
  if (update.pr?.title) {
    const title = cleanTitle(update.pr.title);
    if (title) return truncate(title, 90);
  }
  const commits = (update.commits || []).filter((commit) => !commit.merge);
  for (let index = commits.length - 1; index >= 0; index--) {
    const title = cleanTitle(commits[index].title);
    if (title) return truncate(title, 90);
  }
  return update.newProject ? 'A new project was started' : 'Project updated';
}

export function fallbackSummary(update) {
  const headline = fallbackHeadline(update);
  const others = (update.commits || [])
    .filter((commit) => !commit.merge)
    .map((commit) => cleanTitle(commit.title))
    .filter((title) => title && title !== headline);
  const unique = [...new Set(others)].reverse();
  if (!unique.length) return '';
  const shown = unique.slice(0, 3).join('; ');
  const more = unique.length > 3 ? `, and ${unique.length - 3} more` : '';
  return truncate(`Also in this update: ${shown}${more}.`, 400);
}

function weekStart(time) {
  const date = new Date(toTime(time));
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay());
}

// Groups identical changes (same content key) that landed in several projects close together into one card,
// and folds pushes made entirely by bot accounts into one card per project per week.
export function groupIntoCards(updates, windowHours) {
  const windowMs = windowHours * 60 * 60 * 1000;
  const sorted = [...updates].sort((a, b) => toTime(b.time) - toTime(a.time));
  const cards = [];
  const open = new Map();
  const automatic = new Map();
  for (const update of sorted) {
    if (update.bot) {
      const week = weekStart(update.time);
      const id = `${update.repo}|${week}`;
      const existing = automatic.get(id);
      if (existing) {
        existing.members.push(update);
        continue;
      }
      const card = { key: `automatic-${id}`, week, time: update.time, members: [update], repos: new Set([update.repo]), automated: true };
      automatic.set(id, card);
      cards.push(card);
      continue;
    }
    const card = open.get(update.key);
    const fits = card && toTime(card.time) - toTime(update.time) <= windowMs && !card.repos.has(update.repo);
    if (fits) {
      card.members.push(update);
      card.repos.add(update.repo);
      continue;
    }
    const fresh = { key: update.key, time: update.time, members: [update], repos: new Set([update.repo]) };
    open.set(update.key, fresh);
    cards.push(fresh);
  }
  return cards;
}

function automaticOutput(card) {
  const lead = card.members[0];
  const count = card.members.length;
  const titles = new Map();
  for (const member of card.members) {
    for (const commit of member.commits || []) {
      const title = cleanTitle(commit.title);
      if (title) titles.set(title, (titles.get(title) || 0) + 1);
    }
  }
  const common = [...titles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    id: `${lead.repo}-automatic-${new Date(card.week).toISOString().slice(0, 10)}`,
    time: lead.time,
    projects: [lead.repo],
    headline: count === 1 ? 'Automatic update' : `${count} automatic updates`,
    summary: truncate(
      `Saved by an automated tool rather than by hand, for example to refresh data${common ? ` ("${common}")` : ''}. Shown as one entry per week to keep this feed readable.`,
      400,
    ),
    impact: null,
    ai: false,
    automated: true,
    newProject: false,
    details: {
      type: 'automated',
      pr: null,
      commits: card.members
        .flatMap((member) => [...(member.commits || [])].reverse())
        .slice(0, 8)
        .map((commit) => ({ sha: String(commit.sha || '').slice(0, 7), title: commit.title, url: commit.url })),
      totalCommits: card.members.reduce((sum, member) => sum + (member.totalCommits || 0), 0),
      files: 0,
      additions: 0,
      deletions: 0,
      links: lead.compareUrl ? [{ project: lead.repo, url: lead.compareUrl }] : [],
    },
  };
}

export function cardOutput(card, summaries) {
  if (card.automated) return automaticOutput(card);
  const lead = card.members[0];
  const stored = summaries[card.key];
  const summary = stored?.headline ? stored : null;
  const files = lead.files || { count: 0, additions: 0, deletions: 0 };
  return {
    id: `${lead.repo}-${lead.id}`,
    time: lead.time,
    projects: card.members.map((member) => member.repo),
    headline: summary ? summary.headline : fallbackHeadline(lead),
    summary: summary ? summary.summary : fallbackSummary(lead),
    impact: summary ? summary.impact : null,
    ai: Boolean(summary),
    newProject: Boolean(lead.newProject),
    details: {
      type: lead.type,
      pr: card.members.length === 1 && lead.pr ? { number: lead.pr.number, title: lead.pr.title, url: lead.pr.url } : null,
      commits: (lead.commits || [])
        .filter((commit) => !commit.merge)
        .slice(-8)
        .reverse()
        .map((commit) => ({ sha: String(commit.sha || '').slice(0, 7), title: commit.title, url: commit.url })),
      totalCommits: lead.totalCommits || 0,
      files: files.count,
      additions: files.additions,
      deletions: files.deletions,
      links: card.members.map((member) => ({ project: member.repo, url: member.compareUrl })).filter((link) => link.url),
    },
  };
}

export function weekAxis(now = Date.now(), weeks = 52) {
  const date = new Date(now);
  const sunday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay());
  return Array.from({ length: weeks }, (_, index) => sunday - (weeks - 1 - index) * WEEK_MS);
}

// Sums GitHub's weekly commit counts ([unixSeconds, total] pairs) of all projects onto one shared axis.
export function activitySeries(weekLists, now = Date.now()) {
  const axis = weekAxis(now);
  const totals = new Array(axis.length).fill(0);
  for (const list of weekLists) {
    for (const [week, total] of list || []) {
      const index = Math.round((week * 1000 - axis[0]) / WEEK_MS);
      if (index >= 0 && index < axis.length) totals[index] += total;
    }
  }
  return axis.map((start, index) => ({ week: new Date(start).toISOString().slice(0, 10), commits: totals[index] }));
}

export function languageMix(languageMaps, top = 7) {
  const bytes = new Map();
  for (const map of languageMaps) {
    for (const [name, count] of Object.entries(map || {})) bytes.set(name, (bytes.get(name) || 0) + count);
  }
  const total = [...bytes.values()].reduce((sum, count) => sum + count, 0);
  if (!total) return [];
  const sorted = [...bytes.entries()].sort((a, b) => b[1] - a[1]);
  const mix = sorted.slice(0, top).map(([name, count]) => ({ name, share: count / total, color: languageColor(name) }));
  const rest = sorted.slice(top).reduce((sum, [, count]) => sum + count, 0);
  if (rest > 0) mix.push({ name: 'Other', share: rest / total, color: '#8b949e' });
  return mix.map((entry) => ({ ...entry, share: Math.round(entry.share * 10000) / 10000 }));
}

export function countSince(cards, days, now = Date.now()) {
  const since = now - days * DAY_MS;
  return cards.filter((card) => toTime(card.time) >= since).length;
}

// Sums weekly commits from /stats/contributors, leaving out bot accounts such as github-actions[bot].
export function summarizeContributors(contributors, now = Date.now(), keepWeeks = 60) {
  const since = (now - keepWeeks * WEEK_MS) / 1000;
  const weeks = new Map();
  let humanCommits = 0;
  let botCommits = 0;
  for (const contributor of contributors || []) {
    const author = contributor?.author || {};
    if (isBotAuthor({ login: author.login, type: author.type })) {
      botCommits += contributor.total || 0;
      continue;
    }
    humanCommits += contributor?.total || 0;
    for (const week of contributor?.weeks || []) {
      if (week.c > 0 && week.w >= since) weeks.set(week.w, (weeks.get(week.w) || 0) + week.c);
    }
  }
  return { weeks: [...weeks.entries()].sort((a, b) => a[0] - b[0]), humanCommits, botCommits };
}
