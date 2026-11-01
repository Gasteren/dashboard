import { hash } from './util.mjs';

const CI_MARKERS = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|\*\*\*NO_CI\*\*\*/gi;
const TRAILERS = /^(?:co-authored-by|signed-off-by|reviewed-by|change-id|skip-checks):.*$/gim;
const MERGE_MESSAGE = /^Merge (?:pull request #\d+ from \S+|branch '[^']*'|remote-tracking branch '[^']*'|[0-9a-f]{7,40} into )/i;
const CONVENTIONAL_PREFIX = /^(?:feat|feature|fix|chore|docs|style|refactor|perf|test|tests|build|ci|revert|deps)(?:\([^)]*\))?!?:\s*/i;

export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function stripCiMarkers(text) {
  return String(text ?? '').replace(CI_MARKERS, '').replace(/[ \t]+$/gm, '').trim();
}

export function splitMessage(message) {
  const clean = stripCiMarkers(String(message ?? '').replace(/\r\n/g, '\n'));
  const [title = '', ...rest] = clean.split('\n');
  const body = rest.join('\n').replace(TRAILERS, '').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title.trim(), body };
}

export function isMergeMessage(message) {
  return MERGE_MESSAGE.test(String(message ?? '').trim());
}

// Bot accounts such as github-actions[bot]; scheduled data refreshes are often committed this way.
export function isBotAuthor({ login, type, name, email } = {}) {
  return (
    type === 'Bot' ||
    /\[bot\]$/i.test(String(login ?? '')) ||
    /\[bot\]$/i.test(String(name ?? '')) ||
    /\[bot\]@users\.noreply\.github\.com$/i.test(String(email ?? ''))
  );
}

export function cleanTitle(title) {
  let text = stripCiMarkers(String(title ?? '').split('\n')[0]);
  text = text.replace(CONVENTIONAL_PREFIX, '');
  text = text.replace(/\s*\((?:#\d+[,\s]*)+\)\s*$/, '');
  text = text.replace(/[\s.]+$/, '').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

export function prettyName(name) {
  return String(name ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function cleanMarkdown(markdown) {
  let text = String(markdown ?? '').replace(/\r\n/g, '\n');
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^\s*#{1,6}\s*/gm, '');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/^\s*\|.*\|\s*$/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '- ');
  text = text.replace(/\*\*|__|`/g, '');
  return text;
}

export function readmeExcerpt(markdown, maxLength = 600) {
  const paragraphs = cleanMarkdown(markdown)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 2);
  let excerpt = '';
  for (const paragraph of paragraphs) {
    if (excerpt.length + paragraph.length + 1 > maxLength) {
      if (!excerpt) excerpt = truncate(paragraph, maxLength);
      break;
    }
    excerpt += (excerpt ? '\n' : '') + paragraph;
  }
  return excerpt;
}

export function cleanPrBody(body, maxLength = 1200) {
  const text = cleanMarkdown(body)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^- \[[ x]\]\s*$/i.test(line))
    .join('\n');
  return truncate(text, maxLength);
}

const CURSEFORGE_LINK = /https?:\/\/(?:www\.|legacy\.)?curseforge\.com\/wow\/addons\/([A-Za-z0-9_-]+)/gi;
const CURSEFORGE_HOME = /^https?:\/\/(?:www\.|legacy\.)?curseforge\.com\/wow\/addons\/([A-Za-z0-9_-]+)/i;
const squash = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function curseforgeUrl(slug) {
  return `https://www.curseforge.com/wow/addons/${slug.toLowerCase().replace(/_/g, '-')}`;
}

// READMEs also link dependencies (HandyNotes, TomTom, ...), so only accept a link whose slug matches the project name.
export function findCurseForgeUrl({ name, homepage }, readme) {
  const home = String(homepage ?? '').trim().match(CURSEFORGE_HOME);
  if (home) return curseforgeUrl(home[1]);
  const target = squash(name);
  if (target.length < 3) return null;
  let prefixMatch = null;
  for (const match of String(readme ?? '').matchAll(CURSEFORGE_LINK)) {
    const slug = squash(match[1]);
    if (slug === target) return curseforgeUrl(match[1]);
    if (!prefixMatch && slug.startsWith(target)) prefixMatch = match[1];
  }
  return prefixMatch ? curseforgeUrl(prefixMatch) : null;
}

export function projectKind({ name = '', language = '', topics = [], description = '' }, readme = '', hasCurseForge = false) {
  const text = `${name} ${topics.join(' ')} ${description} ${String(readme).slice(0, 4000)}`.toLowerCase();
  if (hasCurseForge || (language === 'Lua' && /world of warcraft|warcraft|\bwow\b|curseforge|handynotes|add-?on/.test(text))) {
    return 'World of Warcraft add-on';
  }
  if (/discord/.test(`${name} ${topics.join(' ')} ${description}`.toLowerCase()) && /\bbot\b/.test(text)) return 'Discord bot';
  if (/\.github\.io$/i.test(name) || /\b(website|homepage|wiki|blog)\b/i.test(description)) return 'Website';
  return null;
}

export function normalizePatch(patch) {
  return String(patch ?? '')
    .split('\n')
    .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
    .map((line) => `${line[0]}${line.slice(1).trim().replace(/\s+/g, ' ')}`)
    .join('\n');
}

function normalizeMessage(message) {
  return stripCiMarkers(message)
    .replace(TRAILERS, '')
    .replace(/\(?#\d+\)?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Identical changes (same notes, same files, same edits) get the same key, so one summary covers them all.
export function contentKey(messages, files) {
  const payload = {
    m: messages.filter((message) => !isMergeMessage(message)).map(normalizeMessage),
    f: files
      .map((file) => `${file.filename}|${file.status}|${file.patch ? hash(normalizePatch(file.patch)) : `${file.additions}/${file.deletions}`}`)
      .sort(),
  };
  return hash(JSON.stringify(payload));
}

export function parseJsonArray(text) {
  const value = String(text ?? '').trim();
  const start = value.indexOf('[');
  const end = value.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function cleanAiText(value, maxLength) {
  const text = String(value ?? '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, maxLength);
}

const LANGUAGE_COLORS = {
  Astro: '#ff5a03',
  Batchfile: '#c1f12e',
  C: '#555555',
  'C#': '#178600',
  'C++': '#f34b7d',
  CSS: '#663399',
  Dockerfile: '#384d54',
  Go: '#00add8',
  HTML: '#e34c26',
  Java: '#b07219',
  JavaScript: '#f1e05a',
  Kotlin: '#a97bff',
  Lua: '#000080',
  MDX: '#fcb32c',
  Makefile: '#427819',
  PHP: '#4f5d95',
  PowerShell: '#012456',
  Python: '#3572a5',
  Ruby: '#701516',
  Rust: '#dea584',
  SCSS: '#c6538c',
  Shell: '#89e051',
  Svelte: '#ff3e00',
  Swift: '#f05138',
  TypeScript: '#3178c6',
  Vue: '#41b883',
};

export function languageColor(language) {
  return LANGUAGE_COLORS[language] || '#8b949e';
}
