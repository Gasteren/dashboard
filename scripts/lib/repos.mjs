// Only public repositories owned by the configured account may ever reach the published site or the data branch.
export function isPublicRepo(repo, owner) {
  return (
    repo.private === false &&
    repo.visibility === 'public' &&
    String(repo.owner || '').toLowerCase() === String(owner || '').toLowerCase()
  );
}

export function compactRepo(repo) {
  return {
    name: repo.name,
    owner: repo.owner?.login ?? '',
    private: repo.private,
    visibility: repo.visibility,
    fork: Boolean(repo.fork),
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    description: repo.description || '',
    homepage: repo.homepage || '',
    language: repo.language || null,
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    openIssues: repo.open_issues_count || 0,
    defaultBranch: repo.default_branch || null,
    createdAt: repo.created_at,
    pushedAt: repo.pushed_at,
    url: repo.html_url,
  };
}

export function selectRepos(repos, config) {
  const excluded = new Set((config.exclude || []).map((name) => String(name).toLowerCase()));
  return repos.filter(
    (repo) =>
      isPublicRepo(repo, config.owner) &&
      !repo.disabled &&
      (config.includeForks || !repo.fork) &&
      (config.includeArchived || !repo.archived) &&
      !excluded.has(repo.name.toLowerCase()),
  );
}

export function httpUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// Throws (without printing names) if anything outside the selected public projects is about to be published.
export function assertPublicOnly({ output, allowed, cache, updates }) {
  let problems = 0;
  for (const project of output.projects) if (!allowed.has(project.name)) problems++;
  for (const card of output.feed) {
    for (const name of card.projects) if (!allowed.has(name)) problems++;
    for (const link of card.details.links) if (!allowed.has(link.project)) problems++;
  }
  for (const name of Object.keys(cache.repos || {})) if (!allowed.has(name)) problems++;
  for (const update of Object.values(updates)) if (!allowed.has(update.repo)) problems++;
  if (problems) {
    throw new Error(`Refusing to publish: ${problems} item(s) refer to repositories that are not selected public projects.`);
  }
}
