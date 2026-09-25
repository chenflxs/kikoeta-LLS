(function () {
let csrfToken = '';
const message = document.getElementById('message');

async function request(route, method = 'GET', data) {
  const response = await fetch(`/api/${route}`, {
    method,
    headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrfToken ? { 'X-LLS-CSRF': csrfToken } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

let noticeTimer;
let noticeExitTimer;
function notice(value) {
  if (!message) return;
  clearTimeout(noticeTimer);
  clearTimeout(noticeExitTimer);
  message.classList.remove('notice-leaving');
  message.textContent = value;
  if (value) noticeTimer = setTimeout(() => {
    message.classList.add('notice-leaving');
    noticeExitTimer = setTimeout(() => {
      message.textContent = '';
      message.classList.remove('notice-leaving');
    }, 200);
  }, 2800);
}

function setCsrf(value) { csrfToken = value || ''; }
function getCsrf() { return csrfToken; }

async function ensureSession() {
  try {
    const session = await request('session');
    setCsrf(session.csrf);
    if (session.mustChangePassword) {
      location.replace('/login');
      return null;
    }
    return session;
  } catch (error) {
    if (error.message === 'unauthorized') location.replace('/login');
    else notice(`读取登录状态失败：${error.message}`);
    return null;
  }
}

let savedTheme;
try { savedTheme = localStorage.getItem('lls-theme'); } catch { /* Private browsing may block storage. */ }
const initialTheme = savedTheme === 'light' || savedTheme === 'dark'
  ? savedTheme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const themeToggle = document.getElementById('theme-toggle');
const preferenceForm = document.getElementById('preferences-form');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (themeToggle) {
    themeToggle.textContent = theme === 'dark' ? '☀' : '☾';
    themeToggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  }
  if (preferenceForm) preferenceForm.elements.theme.value = theme;
}
setTheme(initialTheme);
themeToggle?.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  try { localStorage.setItem('lls-theme', theme); } catch { /* Theme remains active for this page. */ }
});

document.getElementById('logout')?.addEventListener('click', async () => {
  try { await request('logout', 'POST'); } catch (error) { notice(error.message); }
  try { sessionStorage.removeItem('lls-current-zip-job'); } catch { /* Storage may be unavailable. */ }
  location.assign('/login');
});

window.LLS = { request, notice, setCsrf, getCsrf, ensureSession, setTheme };
})();
