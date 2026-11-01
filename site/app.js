(() => {
  'use strict';

  const PAGE_SIZE = 15;
  const STALE_HOURS = 3;
  const state = { data: null, filter: '', shown: PAGE_SIZE, sort: 'updated', projects: new Map() };

  const numberFormat = new Intl.NumberFormat('en');
  const percentFormat = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });
  const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const dateTimeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
  const dayFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const monthFormat = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' });
  const external = { target: '_blank', rel: 'noopener noreferrer' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    append(node, children);
    return node;
  }

  function svg(tag, attributes, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
    append(node, children);
    return node;
  }

  function append(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function link(url, text, props) {
    const href = safeUrl(url);
    return href ? el('a', { href, ...external, ...props }, text) : el('span', props, text);
  }

  function safeColor(value) {
    return /^#[0-9a-f]{3,8}$/i.test(String(value)) ? value : '#8b949e';
  }

  function relativeTime(iso) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return 'unknown';
    const seconds = (time - Date.now()) / 1000;
    if (Math.abs(seconds) < 60) return 'just now';
    const units = [
      ['year', 31536000],
      ['month', 2592000],
      ['week', 604800],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
    ];
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
    }
    return 'just now';
  }

  function timeElement(iso) {
    const time = Date.parse(iso);
    return el('time', { datetime: iso, title: Number.isFinite(time) ? dateTimeFormat.format(new Date(time)) : null }, relativeTime(iso));
  }

  function projectTitle(name) {
    return state.projects.get(name)?.title || String(name).replace(/[_-]+/g, ' ');
  }

  function plural(count, word, pluralWord) {
    return `${numberFormat.format(count)} ${count === 1 ? word : pluralWord || `${word}s`}`;
  }

  function tag(text, kind) {
    return el('span', { class: `tag tag-${kind}` }, text);
  }

  function showNotice(message) {
    const notice = $('notice');
    notice.textContent = message;
    notice.hidden = false;
  }

  // Theme

  function currentTheme() {
    const chosen = document.documentElement.dataset.theme;
    if (chosen === 'light' || chosen === 'dark') return chosen;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function syncThemeButton() {
    const button = $('theme-toggle');
    const dark = currentTheme() === 'dark';
    button.classList.toggle('is-dark', dark);
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function setupTheme() {
    $('theme-toggle').addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('theme', next);
      } catch {
        // Private browsing can block storage; the choice then lasts for this visit only.
      }
      syncThemeButton();
    });
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButton);
    }
    syncThemeButton();
  }

  // Header, overview and footer

  function renderHeader(data) {
    const owner = data.owner || {};
    const title = data.title || 'Projects dashboard';
    document.title = title;
    $('brand-name').textContent = title;
    $('hero-title').textContent = title;
    if (data.tagline) $('hero-text').textContent = data.tagline;
    const avatar = safeUrl(owner.avatarUrl);
    if (avatar) {
      $('avatar').src = avatar;
      $('avatar').hidden = false;
    }
  }

  function renderTiles(totals) {
    const tiles = [
      [totals.projects, 'Projects', 'public projects on GitHub'],
      [totals.updatesWeek, 'Updates this week', 'in the last 7 days'],
      [totals.updatesMonth, 'Updates this month', 'in the last 30 days'],
      [totals.stars, 'Stars', 'times people bookmarked a project'],
      [totals.forks, 'Forks', 'copies others made to build on'],
      [totals.openIssues, 'Open issues', 'reported problems and ideas'],
      [totals.releases, 'Releases', 'published versions'],
    ];
    $('tiles').replaceChildren(
      ...tiles.map(([value, label, hint]) =>
        el(
          'li',
          { class: 'tile' },
          el('span', { class: 'tile-value' }, numberFormat.format(value || 0)),
          el('span', { class: 'tile-label' }, label),
          el('span', { class: 'tile-hint' }, hint),
        ),
      ),
    );
  }

  function renderFooter(data) {
    const footer = $('footer-text');
    const source = data.meta?.repository ? safeUrl(`https://github.com/${data.meta.repository}`) : null;
    footer.replaceChildren(
      'Refreshed automatically every hour from public GitHub data (last refresh ',
      timeElement(data.generatedAt),
      '). Plain-English summaries are written by GitHub Copilot and can occasionally be imperfect; open "Technical details" under an update to see exactly what changed.',
      source ? [' ', link(source, 'How this page works')] : null,
    );
    const age = Date.now() - Date.parse(data.generatedAt);
    if (Number.isFinite(age) && age > STALE_HOURS * 3600 * 1000) {
      showNotice(`Heads up: this page was last refreshed ${relativeTime(data.generatedAt)}. It normally refreshes every hour, so some recent updates may be missing.`);
    }
  }

  // Feed

  function cardMatches(card) {
    return !state.filter || card.projects.includes(state.filter);
  }

  function setFilter(name, { scroll = false, updateUrl = true } = {}) {
    state.filter = state.projects.has(name) ? name : '';
    state.shown = PAGE_SIZE;
    $('project-filter').value = state.filter;
    renderFeed();
    if (updateUrl) {
      const url = new URL(window.location.href);
      if (state.filter) url.searchParams.set('project', state.filter);
      else url.searchParams.delete('project');
      window.history.replaceState(null, '', url);
    }
    if (scroll) $('updates').scrollIntoView();
  }

  function renderFilterOptions(data) {
    const counts = new Map();
    for (const card of data.feed) for (const name of card.projects) counts.set(name, (counts.get(name) || 0) + 1);
    const names = [...counts.keys()].sort((a, b) => projectTitle(a).localeCompare(projectTitle(b)));
    $('project-filter').replaceChildren(
      el('option', { value: '' }, 'All projects'),
      ...names.map((name) => el('option', { value: name }, `${projectTitle(name)} (${counts.get(name)})`)),
    );
  }

  function projectNames(names) {
    const shown = names.slice(0, 3);
    const parts = [];
    shown.forEach((name, index) => {
      if (index) parts.push(', ');
      parts.push(
        el(
          'button',
          { type: 'button', class: 'link-button', title: `Show only updates for ${projectTitle(name)}`, onclick: () => setFilter(name, { scroll: true }) },
          projectTitle(name),
        ),
      );
    });
    if (names.length > shown.length) parts.push(` and ${names.length - shown.length} more`);
    return el('span', { class: 'card-projects' }, parts);
  }

  const TYPE_LABELS = {
    push: 'Pushed directly to the main branch',
    pr_merge: 'Merged pull request',
    merge_queue_merge: 'Merged through the merge queue',
    force_push: 'Force-pushed (history was rewritten)',
    branch_creation: 'Main branch created',
    automated: 'Pushed to the main branch by a bot account',
  };

  function renderDetails(card) {
    const details = card.details || {};
    const body = el('div', { class: 'tech-body' });
    const pr = details.pr;
    body.append(
      el(
        'p',
        null,
        TYPE_LABELS[details.type] || details.type || 'Update',
        pr ? [': ', link(pr.url, `#${pr.number} ${pr.title}`)] : null,
      ),
    );
    const commits = details.commits || [];
    if (commits.length) {
      const label = details.totalCommits > commits.length
        ? `Commits (latest ${commits.length} of ${numberFormat.format(details.totalCommits)})`
        : `Commits (${commits.length})`;
      body.append(
        el('p', { class: 'tech-label' }, label),
        el('ul', { class: 'commits' }, commits.map((commit) => el('li', null, link(commit.url, commit.sha, { class: 'sha' }), ' ', commit.title))),
      );
    }
    if (details.files) {
      body.append(
        el('p', null, `${plural(details.files, 'file')} changed: ${plural(details.additions || 0, 'line')} added and ${numberFormat.format(details.deletions || 0)} removed.`),
      );
    }
    const links = details.links || [];
    if (links.length) {
      body.append(
        el(
          'p',
          null,
          links.length === 1 ? 'See the full change on GitHub: ' : 'See the full changes on GitHub: ',
          links.map((item, index) => [index ? ', ' : '', link(item.url, projectTitle(item.project))]),
        ),
      );
    }
    return el('details', { class: 'tech' }, el('summary', null, 'Technical details'), body);
  }

  function renderCard(card) {
    const tags = [];
    if (card.newProject) tags.push(tag('New project', 'new'));
    if (card.impact === 'visible') tags.push(tag('Noticeable change', 'visible'));
    if (card.impact === 'behind-the-scenes') tags.push(tag('Behind the scenes', 'quiet'));
    if (card.projects.length > 1) tags.push(tag(`Same change in ${card.projects.length} projects`, 'bulk'));
    if (card.automated) tags.push(tag('Automatic', 'quiet'));
    else if (!card.ai) tags.push(tag("Developer's note, plain-English summary coming soon", 'pending'));
    return el(
      'li',
      { class: 'card' },
      el('div', { class: 'card-meta' }, projectNames(card.projects), timeElement(card.time)),
      el('h3', { class: 'card-title' }, card.headline),
      card.summary ? el('p', { class: 'card-text' }, card.summary) : null,
      tags.length ? el('div', { class: 'tags' }, tags) : null,
      renderDetails(card),
    );
  }

  function renderFeed() {
    const data = state.data;
    const cards = data.feed.filter(cardMatches);
    const list = $('feed');
    if (!cards.length) {
      const days = data.meta?.feedDays || 180;
      list.replaceChildren(el('li', { class: 'empty' }, state.filter ? `No updates for ${projectTitle(state.filter)} in the last ${days} days.` : `No updates in the last ${days} days.`));
    } else {
      list.replaceChildren(...cards.slice(0, state.shown).map(renderCard));
    }
    const more = $('feed-more');
    more.hidden = cards.length <= state.shown;
    more.textContent = `Show more updates (${numberFormat.format(cards.length - Math.min(cards.length, state.shown))} left)`;
    $('updates-intro').textContent = state.filter
      ? `Updates to ${projectTitle(state.filter)}, newest first.`
      : 'What changed recently, newest first.';
  }

  // Stats

  function renderActivity(weeks) {
    const container = $('activity-chart');
    if (!weeks || !weeks.length) {
      container.replaceChildren(el('p', { class: 'empty' }, 'No activity data yet.'));
      return;
    }
    const total = weeks.reduce((sum, week) => sum + week.commits, 0);
    const busiest = weeks.reduce((best, week) => (week.commits > best.commits ? week : best), weeks[0]);
    const max = Math.max(1, busiest.commits);
    const width = 420;
    const height = 180;
    const pad = { top: 10, right: 4, bottom: 24, left: 34 };
    const innerWidth = width - pad.left - pad.right;
    const innerHeight = height - pad.top - pad.bottom;
    const step = innerWidth / weeks.length;
    const barWidth = Math.max(2, step - 2);
    const yOf = (value) => pad.top + innerHeight - (value / max) * innerHeight;

    const chart = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': `Bar chart of changes saved per week over the past year. ${numberFormat.format(total)} in total; the busiest week had ${numberFormat.format(busiest.commits)}.`,
    });
    for (const value of [...new Set([0, Math.round(max / 2), max])]) {
      const y = yOf(value);
      chart.append(
        svg('line', { class: 'grid', x1: pad.left, x2: width - pad.right, y1: y, y2: y }),
        svg('text', { x: pad.left - 6, y: y + 4, 'text-anchor': 'end' }, numberFormat.format(value)),
      );
    }
    let lastMonth = null;
    weeks.forEach((week, index) => {
      const x = pad.left + index * step + (step - barWidth) / 2;
      const date = new Date(`${week.week}T00:00:00Z`);
      const label = `Week of ${dayFormat.format(date)}: ${plural(week.commits, 'change')} saved`;
      if (week.commits > 0) {
        const y = yOf(week.commits);
        chart.append(svg('rect', { class: 'bar', x, y, width: barWidth, height: Math.max(1, pad.top + innerHeight - y), rx: 1.5 }, svg('title', null, label)));
      } else {
        chart.append(svg('rect', { class: 'bar-empty', x, y: pad.top + innerHeight - 1, width: barWidth, height: 1 }, svg('title', null, label)));
      }
      const month = date.getUTCMonth();
      if (lastMonth !== null && month !== lastMonth && index < weeks.length - 1) {
        chart.append(svg('text', { x: x + barWidth / 2, y: height - 6, 'text-anchor': 'middle' }, monthFormat.format(date)));
      }
      lastMonth = month;
    });
    container.replaceChildren(chart);
    $('activity-intro').textContent = `${plural(total, 'change')} saved by hand across all projects in the past 12 months (automatic updates not counted). Busiest week: ${dayFormat.format(new Date(`${busiest.week}T00:00:00Z`))}.`;
  }

  function renderLanguages(languages) {
    const container = $('languages');
    if (!languages || !languages.length) {
      container.replaceChildren(el('p', { class: 'empty' }, 'No language data yet.'));
      return;
    }
    const bar = el('div', {
      class: 'lang-bar',
      role: 'img',
      'aria-label': languages.map((language) => `${language.name} ${percentFormat.format(language.share)}`).join(', '),
    });
    for (const language of languages) {
      const part = el('span', { title: `${language.name}: ${percentFormat.format(language.share)}` });
      part.style.width = `${(language.share * 100).toFixed(2)}%`;
      part.style.background = safeColor(language.color);
      bar.append(part);
    }
    const list = el(
      'ul',
      { class: 'lang-list' },
      languages.map((language) => {
        const dot = el('span', { class: 'dot', 'aria-hidden': 'true' });
        dot.style.background = safeColor(language.color);
        return el('li', null, dot, el('span', null, language.name), el('span', { class: 'lang-share' }, percentFormat.format(language.share)));
      }),
    );
    container.replaceChildren(bar, list);
  }

  // Projects

  function fact(label, value) {
    return el('div', null, el('dt', null, label), el('dd', null, value));
  }

  function sortProjects(projects) {
    const sorted = [...projects];
    if (state.sort === 'stars') sorted.sort((a, b) => b.stars - a.stars || a.title.localeCompare(b.title));
    else if (state.sort === 'name') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else sorted.sort((a, b) => (Date.parse(b.lastUpdate) || 0) - (Date.parse(a.lastUpdate) || 0));
    return sorted;
  }

  function renderProject(project, updateCounts) {
    const release = project.latestRelease;
    const facts = [
      fact('Last update', project.lastUpdate ? timeElement(project.lastUpdate) : 'Unknown'),
      fact('Latest release', release ? [link(release.url, release.name || release.tag), release.date ? [' (', relativeTime(release.date), ')'] : null] : 'None yet'),
      fact(
        'Saved changes',
        project.commits === null || project.commits === undefined
          ? 'Unknown'
          : [numberFormat.format(project.commits), project.automaticCommits ? ` (+${numberFormat.format(project.automaticCommits)} automatic)` : null],
      ),
      fact('Stars', numberFormat.format(project.stars || 0)),
    ];
    if (project.openIssues) facts.push(fact('Open issues', numberFormat.format(project.openIssues)));
    if (project.forks) facts.push(fact('Forks', numberFormat.format(project.forks)));

    const language = project.language
      ? (() => {
          const dot = el('span', { class: 'dot', 'aria-hidden': 'true' });
          dot.style.background = safeColor(project.languageColor);
          return el('span', { class: 'lang' }, dot, project.language);
        })()
      : el('span', { class: 'lang' });

    const updates = updateCounts.get(project.name) || 0;
    const links = el(
      'div',
      { class: 'project-links' },
      link(project.url, 'GitHub'),
      project.curseforge ? link(project.curseforge, 'CurseForge') : null,
      project.homepage ? link(project.homepage, 'Website') : null,
      updates
        ? el('button', { type: 'button', class: 'link-button', onclick: () => setFilter(project.name, { scroll: true }) }, `Updates (${updates})`)
        : null,
    );

    return el(
      'li',
      { class: 'project' },
      el('div', { class: 'project-head' }, el('h3', null, link(project.url, project.title)), project.archived ? tag('Archived', 'quiet') : null),
      project.kind ? el('p', { class: 'project-kind' }, project.kind) : null,
      el('p', { class: 'project-desc' }, project.description || 'No description yet.'),
      el('dl', { class: 'facts' }, facts),
      el('div', { class: 'project-foot' }, language, links),
    );
  }

  function renderProjects() {
    const counts = new Map();
    for (const card of state.data.feed) for (const name of card.projects) counts.set(name, (counts.get(name) || 0) + 1);
    $('project-list').replaceChildren(...sortProjects(state.data.projects).map((project) => renderProject(project, counts)));
  }

  // Start

  function render(data) {
    state.data = data;
    state.projects = new Map(data.projects.map((project) => [project.name, project]));
    renderHeader(data);
    renderTiles(data.totals);
    renderFilterOptions(data);
    renderActivity(data.activity);
    renderLanguages(data.languages);
    renderProjects();
    renderFooter(data);
    const wanted = new URL(window.location.href).searchParams.get('project');
    if (wanted && state.projects.has(wanted)) setFilter(wanted, { updateUrl: false });
    else renderFeed();
  }

  async function start() {
    setupTheme();
    $('project-filter').addEventListener('change', (event) => setFilter(event.target.value));
    $('project-sort').addEventListener('change', (event) => {
      state.sort = event.target.value;
      renderProjects();
    });
    $('feed-more').addEventListener('click', () => {
      state.shown += PAGE_SIZE;
      renderFeed();
    });
    try {
      const response = await fetch('data/dashboard.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json());
    } catch (error) {
      console.error(error);
      showNotice("Sorry, the dashboard data couldn't be loaded right now. Please try again in a few minutes.");
      $('feed').replaceChildren(el('li', { class: 'empty' }, 'No data available.'));
      $('tiles').replaceChildren();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
