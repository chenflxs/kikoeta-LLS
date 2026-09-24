const message = document.getElementById('message');
const loginPanel = document.getElementById('login-panel');
const passwordPanel = document.getElementById('password-panel');
const libraryPanel = document.getElementById('library-panel');
const logoutButton = document.getElementById('logout');
const changePasswordButton = document.getElementById('change-password');
const cancelPasswordButton = document.getElementById('cancel-password');
const themeToggle = document.getElementById('theme-toggle');
const searchInput = document.getElementById('work-search');
const worksElement = document.getElementById('works');
let csrf = '';
let passwordRequired = false;
let cachedWorks = [];
let nextCursor = null;
let listVersion = 0;
let searchTimer;

let savedTheme;
try { savedTheme = localStorage.getItem('lls-theme'); } catch { /* Private browsing may block storage. */ }
const initialTheme = savedTheme === 'light' || savedTheme === 'dark'
  ? savedTheme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === 'dark' ? '☀' : '☾';
  themeToggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
}
setTheme(initialTheme);
themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  try { localStorage.setItem('lls-theme', theme); } catch { /* Theme remains active for this page. */ }
});

function notice(value) { message.textContent = value; }
function showView(view) {
  document.body.dataset.view = view;
  loginPanel.hidden = view !== 'login';
  passwordPanel.hidden = view !== 'password';
  libraryPanel.hidden = view !== 'library';
  logoutButton.hidden = view === 'login';
  changePasswordButton.hidden = view !== 'library';
  cancelPasswordButton.hidden = passwordRequired;
  document.getElementById('current-password-label').hidden = passwordRequired;
  document.getElementById('confirm-password-label').hidden = passwordRequired;
  document.querySelector('#password-form [name="currentPassword"]').required = !passwordRequired;
  document.querySelector('#password-form [name="confirmPassword"]').required = !passwordRequired;
  document.getElementById('password-hint').textContent = passwordRequired
    ? '首次登录只需设置一次新密码，完成后才能管理歌词。'
    : '输入当前密码并设置新密码。';
}

async function request(route, method = 'GET', data) {
  const response = await fetch(`/admin/api/${route}`, {
    method,
    headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-LLS-CSRF': csrf } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function renderWorks(appendFrom = 0) {
  const openIds = appendFrom ? new Set() : new Set([...worksElement.querySelectorAll('details[open]')].map((item) => item.dataset.workId));
  const query = searchInput.value.trim();
  const works = cachedWorks.slice(appendFrom);
  document.getElementById('visible-count').textContent = `已显示 ${cachedWorks.length} 部作品`;
  document.getElementById('load-more').hidden = !nextCursor;
  if (!appendFrom) worksElement.replaceChildren();
  if (!cachedWorks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.textContent = query ? '⌕' : '♫';
    const title = document.createElement('strong');
    title.textContent = query ? '没有找到匹配的作品' : '还没有歌词作品';
    const hint = document.createElement('p');
    hint.textContent = query ? '试试其他作品号或文件名。' : '上传歌词后，作品会出现在这里。';
    empty.append(icon, title, hint);
    worksElement.append(empty);
    return;
  }
  for (const work of works) {
    const section = document.createElement('details');
    section.className = 'work';
    section.dataset.workId = work.workId;
    const summary = document.createElement('summary');
    summary.className = 'work-summary';
    const art = document.createElement('span');
    art.className = 'work-art';
    art.textContent = '♫';
    art.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'work-name';
    const id = document.createElement('strong');
    id.textContent = work.workId;
    const count = document.createElement('small');
    count.textContent = `${work.fileCount} 个歌词文件`;
    name.append(id, count);
    summary.append(art, name);
    if (work.isAi) {
      const badge = document.createElement('span');
      badge.className = 'ai-pill';
      badge.textContent = 'AI 歌词';
      summary.append(badge);
    }
    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '›';
    chevron.setAttribute('aria-hidden', 'true');
    summary.append(chevron);
    section.append(summary);
    section.addEventListener('toggle', async () => {
      if (!section.open || section.dataset.loaded) return;
      section.dataset.loaded = 'loading';
      const fileList = document.createElement('div');
      fileList.className = 'file-list';
      let files;
      try { ({ files } = await request(`files?workId=${encodeURIComponent(work.workId)}`)); }
      catch (error) { section.dataset.loaded = ''; notice(`读取文件失败：${error.message}`); return; }
      section.dataset.loaded = 'true';
      for (const file of files) {
        const row = document.createElement('div');
        row.className = 'file';
        const fileName = document.createElement('span');
        fileName.className = 'file-name';
        const extension = document.createElement('span');
        extension.className = 'extension';
        extension.textContent = file.extension.slice(1);
        const pathText = document.createElement('span');
        pathText.textContent = file.relativePath;
        fileName.append(extension, pathText);
        const actions = document.createElement('div');
        actions.className = 'file-actions';
        const aiLabel = document.createElement('label');
        aiLabel.className = 'check';
        const ai = document.createElement('input');
        ai.type = 'checkbox';
        ai.checked = file.isAi;
        ai.addEventListener('change', async () => {
          try { await request('files/ai', 'PATCH', { workId: work.workId, relativePath: file.relativePath, isAi: ai.checked }); notice('AI 标记已保存'); await refresh(); }
          catch (error) { ai.checked = !ai.checked; notice(`保存失败：${error.message}`); }
        });
        aiLabel.append(ai, ' AI');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'danger-button';
        remove.textContent = '删除';
        remove.addEventListener('click', async () => {
          if (!confirm(`删除 ${work.workId}/${file.relativePath}？`)) return;
          try { await request('files', 'DELETE', { workId: work.workId, relativePath: file.relativePath }); notice('已删除'); await refresh(); }
          catch (error) { notice(`删除失败：${error.message}`); }
        });
        actions.append(aiLabel, remove);
        row.append(fileName, actions);
        fileList.append(row);
      }
      section.append(fileList);
    });
    worksElement.append(section);
    if (openIds.has(work.workId)) section.open = true;
  }
}

async function refresh() {
  const version = ++listVersion;
  const result = await request(`works?q=${encodeURIComponent(searchInput.value.trim())}`);
  if (version !== listVersion) return;
  cachedWorks = result.works;
  nextCursor = result.nextCursor;
  document.getElementById('work-count').textContent = String(result.workCount);
  document.getElementById('file-count').textContent = String(result.fileCount);
  renderWorks();
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh().catch((error) => notice(`搜索失败：${error.message}`)), 250);
});
document.getElementById('load-more').addEventListener('click', async (event) => {
  const cursor = nextCursor;
  if (!cursor) return;
  const button = event.currentTarget;
  const version = listVersion;
  button.disabled = true;
  try {
    const result = await request(`works?q=${encodeURIComponent(searchInput.value.trim())}&after=${encodeURIComponent(cursor)}`);
    if (version !== listVersion) return;
    const appendFrom = cachedWorks.length;
    cachedWorks.push(...result.works);
    nextCursor = result.nextCursor;
    renderWorks(appendFrom);
  } catch (error) { notice(`加载失败：${error.message}`); }
  finally { button.disabled = false; }
});

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const result = await request('login', 'POST', { user: form.elements.user.value, password: form.elements.password.value });
    csrf = result.csrf;
    passwordRequired = result.mustChangePassword;
    form.reset();
    showView(passwordRequired ? 'password' : 'library');
    notice(passwordRequired ? '请先修改默认密码。' : '');
    if (!passwordRequired) await refresh();
  } catch (error) { notice(`登录失败：${error.message}`); }
  finally { button.disabled = false; }
});

document.getElementById('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!passwordRequired && form.elements.newPassword.value !== form.elements.confirmPassword.value) {
    notice('两次输入的新密码不一致。');
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = { newPassword: form.elements.newPassword.value };
    if (!passwordRequired) data.currentPassword = form.elements.currentPassword.value;
    const result = await request('password', 'POST', data);
    csrf = result.csrf;
    passwordRequired = false;
    form.reset();
    showView('library');
    notice('新密码已保存。');
    await refresh();
  } catch (error) { notice(`修改失败：${error.message}`); }
  finally { button.disabled = false; }
});

changePasswordButton.addEventListener('click', () => { notice(''); showView('password'); });
cancelPasswordButton.addEventListener('click', () => {
  document.getElementById('password-form').reset();
  notice('');
  showView('library');
});

document.getElementById('upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const files = [...form.elements.files.files];
  const workId = form.elements.workId.value.trim().toUpperCase();
  const prefix = form.elements.prefix.value.trim().replace(/\/$/, '');
  button.disabled = true;
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (file.size === 0 || file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 大小不在 1 字节至 8 MiB 之间`);
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      notice(`上传 ${index + 1}/${files.length}：${file.name}`);
      await request('files', 'POST', { workId, relativePath: [prefix, file.webkitRelativePath || file.name].filter(Boolean).join('/'), isAi: form.elements.isAi.checked, content });
    }
    form.reset();
    notice(`已上传 ${files.length} 个文件`);
    await refresh();
  } catch (error) { notice(`上传中断：${error.message}`); await refresh(); }
  finally { button.disabled = false; }
});

document.getElementById('zip-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const files = [...form.elements.archive.files];
  button.disabled = true;
  let imported = 0, overwritten = 0, skipped = 0, ignored = 0;
  const workIds = new Set();
  try {
    for (const [index, file] of files.entries()) {
      if (!/\.zip$/i.test(file.name) || !file.size || file.size > 128 * 1024 * 1024) throw new Error(`${file.name} 不是有效的 ZIP 文件或超过 128 MiB`);
      notice(`正在导入 ${index + 1}/${files.length}：${file.name}`);
      const query = new URLSearchParams({ name: file.name, conflict: form.elements.conflict.value, ai: String(form.elements.isAi.checked) });
      const response = await fetch(`/admin/api/import/zip?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-LLS-CSRF': csrf }, body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${file.name}：${result.error || `HTTP ${response.status}`}`);
      imported += result.imported; overwritten += result.overwritten; skipped += result.skipped; ignored += result.ignored;
      for (const id of result.workIds) workIds.add(id);
    }
    form.reset();
    notice(`导入完成：${workIds.size} 部作品，新增 ${imported} 个、覆盖 ${overwritten} 个、跳过 ${skipped} 个歌词文件；忽略 ${ignored} 个其他条目。`);
    await refresh();
  } catch (error) { notice(`导入中断：${error.message}`); await refresh(); }
  finally { button.disabled = false; }
});

logoutButton.addEventListener('click', async () => {
  try { await request('logout', 'POST'); } catch (error) { notice(error.message); }
  csrf = '';
  passwordRequired = false;
  cachedWorks = [];
  searchInput.value = '';
  worksElement.replaceChildren();
  showView('login');
});

document.getElementById('refresh').addEventListener('click', () => refresh().catch((error) => notice(`刷新失败：${error.message}`)));

request('session').then((session) => {
  csrf = session.csrf;
  passwordRequired = session.mustChangePassword;
  showView(passwordRequired ? 'password' : 'library');
  if (passwordRequired) notice('请先修改默认密码。');
  else return refresh();
}).catch((error) => {
  showView('login');
  if (error.message !== 'unauthorized') notice(error.message);
});
