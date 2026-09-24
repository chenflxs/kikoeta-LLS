const message = document.getElementById('message');
const loginPanel = document.getElementById('login-panel');
const passwordPanel = document.getElementById('password-panel');
const libraryPanel = document.getElementById('library-panel');
const logoutButton = document.getElementById('logout');
const changePasswordButton = document.getElementById('change-password');
const cancelPasswordButton = document.getElementById('cancel-password');
const worksElement = document.getElementById('works');
let csrf = '';
let passwordRequired = false;

function notice(value) { message.textContent = value; }
function showView(view) {
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

async function refresh() {
  const { works } = await request('works');
  worksElement.replaceChildren();
  if (!works.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '暂无歌词。上传文件后，作品会出现在这里。';
    worksElement.append(empty);
    return;
  }
  for (const work of works) {
    const section = document.createElement('section');
    section.className = 'work';
    const title = document.createElement('h3');
    title.textContent = `${work.workId} · ${work.fileCount} 个文件${work.isAi ? ' · 含 AI 歌词' : ''}`;
    section.append(title);
    for (const file of work.files) {
      const row = document.createElement('div');
      row.className = 'file';
      const name = document.createElement('span');
      name.textContent = file.relativePath;
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      const aiLabel = document.createElement('label');
      aiLabel.className = 'check';
      const ai = document.createElement('input');
      ai.type = 'checkbox';
      ai.checked = file.isAi;
      ai.addEventListener('change', async () => {
        try { await request('files/ai', 'PATCH', { workId: work.workId, relativePath: file.relativePath, isAi: ai.checked }); notice('AI 标记已保存'); }
        catch (error) { ai.checked = !ai.checked; notice(`保存失败：${error.message}`); }
      });
      aiLabel.append(ai, ' AI');
      const remove = document.createElement('button');
      remove.className = 'danger small';
      remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        if (!confirm(`删除 ${work.workId}/${file.relativePath}？`)) return;
        try { await request('files', 'DELETE', { workId: work.workId, relativePath: file.relativePath }); notice('已删除'); await refresh(); }
        catch (error) { notice(`删除失败：${error.message}`); }
      });
      actions.append(aiLabel, remove);
      row.append(name, actions);
      section.append(row);
    }
    worksElement.append(section);
  }
}

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

logoutButton.addEventListener('click', async () => {
  try { await request('logout', 'POST'); } catch (error) { notice(error.message); }
  csrf = '';
  passwordRequired = false;
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
