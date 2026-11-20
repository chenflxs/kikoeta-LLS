const semver = require('semver');
const { version: currentVersion } = require('../package.json');

const RELEASES_URL = 'https://github.com/chenflxs/kikoeta-LLS/releases';
const RELEASE_API = 'https://api.github.com/repos/chenflxs/kikoeta-LLS/releases/latest';
const CACHE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

function createUpdateChecker({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cached;
  let expiresAt = 0;
  let retryAt = 0;
  let pending;

  async function fetchLatest() {
    const result = { currentVersion, latestVersion: null, updateAvailable: false, releaseUrl: null, checkedAt: null, error: null };
    try {
      const response = await fetchImpl(RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Kikoeta-LLS/${currentVersion}`,
          'X-GitHub-Api-Version': '2026-03-10',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) return result;
        throw new Error([403, 429].includes(response.status) ? 'rate_limited' : 'check_failed');
      }
      const release = await response.json();
      const tag = typeof release?.tag_name === 'string' ? release.tag_name.trim() : '';
      const latest = semver.valid(tag.replace(/^[vV]/, ''));
      if (!latest || release.draft || release.prerelease || semver.prerelease(latest)) throw new Error('invalid_release');
      result.latestVersion = latest;
      result.updateAvailable = semver.gt(latest, currentVersion);
      result.releaseUrl = `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
    } catch (error) {
      result.error = ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout'
        : ['rate_limited', 'invalid_release'].includes(error.message) ? error.message : 'check_failed';
    } finally {
      result.checkedAt = new Date(now()).toISOString();
    }
    return result;
  }

  return function check({ force = false } = {}) {
    if (pending) return pending;
    if (cached && now() < (force ? retryAt : expiresAt)) return Promise.resolve(cached);
    pending = fetchLatest().then((result) => {
      cached = result;
      retryAt = now() + RETRY_MS;
      expiresAt = result.error ? retryAt : now() + CACHE_MS;
      return result;
    }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createUpdateChecker, currentVersion };
