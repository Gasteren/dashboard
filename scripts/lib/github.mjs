import { sleep } from './util.mjs';

const API = 'https://api.github.com';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`GitHub API ${status} for ${url}${body ? `: ${body}` : ''}`);
    this.status = status;
  }
}

export class RateLimitError extends Error {}

export function linkTarget(linkHeader, rel) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match && match[2] === rel) return match[1];
  }
  return null;
}

export function lastPage(linkHeader) {
  const url = linkTarget(linkHeader, 'last');
  if (!url) return null;
  const page = Number(new URL(url).searchParams.get('page'));
  return Number.isFinite(page) && page > 0 ? page : null;
}

export class GitHubClient {
  constructor({ token = '', userAgent = 'gasteren-dashboard', minRemaining = 100 } = {}) {
    this.token = token;
    this.userAgent = userAgent;
    this.minRemaining = minRemaining;
    this.remaining = null;
    this.limit = null;
    this.resetAt = null;
    this.requests = 0;
    this.notModified = 0;
  }

  get lowOnBudget() {
    return this.remaining !== null && this.remaining < this.minRemaining;
  }

  trackRateLimit(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    if (remaining !== null && remaining !== '') this.remaining = Number(remaining);
    const limit = headers.get('x-ratelimit-limit');
    if (limit !== null && limit !== '') this.limit = Number(limit);
    const reset = headers.get('x-ratelimit-reset');
    if (reset !== null && reset !== '') this.resetAt = new Date(Number(reset) * 1000).toISOString();
  }

  async request(pathOrUrl, { raw = false, accept, etag, allowStatuses = [], retries = 2 } = {}) {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${API}${pathOrUrl}`;
    const headers = {
      Accept: accept || (raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json'),
      'User-Agent': this.userAgent,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (etag) headers['If-None-Match'] = etag;

    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        if (attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`Request failed for ${url}: ${error.message}`);
      }
      this.trackRateLimit(response.headers);

      if (response.status === 304) {
        this.notModified++;
        return { status: 304, headers: response.headers, data: null, etag };
      }
      this.requests++;

      if (response.ok) {
        const text = await response.text();
        let data = text;
        if (!raw) data = text ? JSON.parse(text) : null;
        return { status: response.status, headers: response.headers, data, etag: response.headers.get('etag') };
      }

      const body = await response.text().catch(() => '');
      if (allowStatuses.includes(response.status)) {
        return { status: response.status, headers: response.headers, data: null };
      }
      if (response.status === 403 || response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        if (this.remaining === 0) {
          throw new RateLimitError(`GitHub API rate limit used up (resets ${this.resetAt || 'soon'})`);
        }
        if (retryAfter > 0 && retryAfter <= 60 && attempt < retries) {
          await sleep(retryAfter * 1000);
          continue;
        }
        if (/rate limit/i.test(body)) throw new RateLimitError(`GitHub API rate limit hit for ${url}`);
      }
      if (response.status >= 500 && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new HttpError(response.status, url, body.slice(0, 300));
    }
  }

  async json(path, options) {
    return (await this.request(path, options)).data;
  }

  // Counts items of a list endpoint with one request by reading the "last" page link at per_page=1.
  async count(path, options = {}) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await this.request(`${path}${separator}per_page=1`, options);
    if (response.status !== 200) return { count: 0, first: null };
    const items = Array.isArray(response.data) ? response.data : [];
    const pages = lastPage(response.headers.get('link'));
    return { count: pages ?? items.length, first: items[0] ?? null };
  }

  // The /stats endpoints answer 202 while GitHub computes them; retry a few times, then give up.
  async stats(path, { attempts = 3 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const response = await this.request(path, { allowStatuses: [404, 409, 422] });
      if (response.status === 200) return Array.isArray(response.data) ? response.data : [];
      if (response.status === 204) return [];
      if (response.status !== 202) return null;
      if (attempt < attempts) await sleep(3000 * attempt);
    }
    return null;
  }
}
