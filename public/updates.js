(function () {
const { request } = window.LLS;
const button = document.getElementById('check-updates');
const autoCheck = document.getElementById('auto-check-updates');
const status = document.getElementById('update-status');
const versionElement = document.getElementById('current-version');
const preferenceKey = 'lls-auto-update-check';
let autoEnabled = true;
let initialized = false;
let pending;
try { autoEnabled = localStorage.getItem(preferenceKey) !== 'false'; } catch { /* Use the default if storage is unavailable. */ }
if (autoCheck) autoCheck.checked = autoEnabled;

function render(result) {
  if (versionElement) versionElement.textContent = result.currentVersion;
  for (const id of ['update-available', 'update-release']) {
    const link = document.getElementById(id);
    if (!link) continue;
    link.hidden = !result.updateAvailable;
    if (result.updateAvailable) {
      link.href = result.releaseUrl;
      if (id === 'update-available') link.textContent = `新版本 ${result.latestVersion}`;
    }
  }
  if (!status) return;
  const messages = {
    timeout: '连接 GitHub 超时，请稍后重试。',
    rate_limited: 'GitHub 请求受限，请稍后重试。',
    invalid_release: '发布版本信息无效，请稍后重试。',
    check_failed: '无法连接 GitHub，请稍后重试。',
    unauthorized: '登录已失效，请重新登录。',
  };
  status.textContent = result.error ? messages[result.error] || '检查更新失败，请稍后重试。'
    : result.updateAvailable ? `发现新版本 ${result.latestVersion}`
      : result.latestVersion ? '当前已是最新版本' : '暂无正式发布版本';
}

function check(force = false) {
  if (pending) return pending;
  if (button) { button.disabled = true; button.textContent = '正在检查…'; }
  if (status) status.textContent = '正在检查更新…';
  pending = request(force ? 'updates?force=1' : 'updates').then(render).catch((error) => {
    // Background failures remain in the settings card instead of interrupting work.
    if (status) render({ currentVersion: versionElement.textContent, error: error.message });
  }).finally(() => {
    pending = null;
    if (button) { button.disabled = false; button.textContent = '检查更新'; }
  });
  return pending;
}

button?.addEventListener('click', () => check(true));
autoCheck?.addEventListener('change', () => {
  autoEnabled = autoCheck.checked;
  try { localStorage.setItem(preferenceKey, String(autoEnabled)); } catch { /* The choice still applies to this page. */ }
  if (initialized && autoEnabled) check();
  else if (status && !pending) status.textContent = '自动检查已关闭';
});

function initialize(version) {
  if (initialized) return;
  initialized = true;
  if (versionElement) versionElement.textContent = version;
  if (button) button.disabled = false;
  if (autoEnabled) check();
  else if (status) status.textContent = '自动检查已关闭';
}

window.LLSUpdates = { initialize };
})();
