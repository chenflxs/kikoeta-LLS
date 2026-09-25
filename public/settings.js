(function () {
const { request, notice, setCsrf, ensureSession, setTheme } = window.LLS;
const preferenceForm = document.getElementById('preferences-form');

function accountErrorMessage(code) {
  return {
    invalid_current_password: '当前密码错误',
    invalid_new_password: '新密码无效，请使用至少 6 位且不同于旧密码的内容',
    invalid_new_user: '新账号需为 3～32 位字母、数字、点、下划线或连字符，且不能与当前账号相同',
    unauthorized: '登录已失效，请重新登录',
  }[code] || code;
}

document.getElementById('username-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request('username', 'POST', { newUser: form.elements.newUser.value, currentPassword: form.elements.currentPassword.value });
    setCsrf(result.csrf);
    document.getElementById('current-user').textContent = result.user;
    form.reset();
    notice('账号已更新，其他设备需要重新登录。');
  } catch (error) { notice(`修改账号失败：${accountErrorMessage(error.message)}`); }
  finally { button.disabled = false; }
});

document.getElementById('settings-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.elements.newPassword.value !== form.elements.confirmPassword.value) return notice('两次输入的新密码不一致。');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request('password', 'POST', { currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value });
    setCsrf(result.csrf);
    form.reset();
    notice('密码已更新，其他设备需要重新登录。');
  } catch (error) { notice(`修改密码失败：${accountErrorMessage(error.message)}`); }
  finally { button.disabled = false; }
});

let zipDefaults = { conflict: 'skip', isAi: false };
try {
  const conflict = localStorage.getItem('lls-zip-conflict');
  if (conflict === 'skip' || conflict === 'overwrite') zipDefaults.conflict = conflict;
  zipDefaults.isAi = localStorage.getItem('lls-zip-ai') === 'true';
} catch { /* Local storage may be unavailable. */ }
preferenceForm.elements.conflict.value = zipDefaults.conflict;
preferenceForm.elements.isAi.checked = zipDefaults.isAi;
preferenceForm.addEventListener('submit', (event) => {
  event.preventDefault();
  setTheme(preferenceForm.elements.theme.value);
  zipDefaults = { conflict: preferenceForm.elements.conflict.value, isAi: preferenceForm.elements.isAi.checked };
  try {
    localStorage.setItem('lls-theme', preferenceForm.elements.theme.value);
    localStorage.setItem('lls-zip-conflict', zipDefaults.conflict);
    localStorage.setItem('lls-zip-ai', String(zipDefaults.isAi));
    notice('使用偏好已保存到当前浏览器。');
  } catch { notice('浏览器禁止本地存储，偏好仅在当前页面有效。'); }
});

const translKeyInput = document.querySelector('#transl-key-form [name="key"]');
function clearTranslKeyInput() {
  translKeyInput.value = '';
  maskTranslKeyInput();
}
function maskTranslKeyInput() {
  translKeyInput.type = 'password';
  const button = document.getElementById('transl-show-key');
  button.textContent = '显示密钥';
  button.setAttribute('aria-pressed', 'false');
}

let translAuthMode = 'password';
function setTranslAuthMode(mode) {
  if (mode !== 'password' && mode !== 'key') return;
  if (translAuthMode === 'key' && mode !== 'key') maskTranslKeyInput();
  translAuthMode = mode;
  document.getElementById('transl-password-form').hidden = mode !== 'password';
  document.getElementById('transl-key-form').hidden = mode !== 'key';
  for (const [id, selected] of [['transl-mode-password', mode === 'password'], ['transl-mode-key', mode === 'key']]) {
    document.getElementById(id).setAttribute('aria-pressed', String(selected));
  }
}
document.getElementById('transl-mode-password').addEventListener('click', () => setTranslAuthMode('password'));
document.getElementById('transl-mode-key').addEventListener('click', () => setTranslAuthMode('key'));
document.getElementById('transl-show-key').addEventListener('click', (event) => {
  const showing = translKeyInput.type === 'password';
  translKeyInput.type = showing ? 'text' : 'password';
  event.currentTarget.textContent = showing ? '隐藏密钥' : '显示密钥';
  event.currentTarget.setAttribute('aria-pressed', String(showing));
});

function showTranslAuthStatus(data) {
  document.getElementById('transl-auth-status').textContent = data.hasPassword
    ? `当前启用：账号密码（${data.username}）`
    : data.hasKey ? '当前启用：密钥' : '当前未配置上传验证';
  document.getElementById('transl-clear-password').disabled = !data.hasPassword;
  document.getElementById('transl-clear-key').disabled = !data.hasKey;
  document.querySelector('#transl-password-form [name="username"]').value = data.username || '';
  if (data.hasKey) {
    setTranslAuthMode('key');
    translKeyInput.value = data.key || '';
    maskTranslKeyInput();
  } else if (data.hasPassword) {
    setTranslAuthMode('password');
    clearTranslKeyInput();
  } else {
    clearTranslKeyInput();
  }
}

async function refreshTranslAuth() {
  const data = await request('transl-auth');
  showTranslAuthStatus(data);
  if (data.hasKey && !data.key) notice('当前密钥由旧版仅保存摘要，无法读取；请重新设置一次密钥，此后可随时返回查看。');
}

async function updateTranslAuth(data) {
  const result = await request('transl-auth', 'POST', data);
  showTranslAuthStatus(result);
  if (data.action === 'set_password' || data.action === 'clear_key') clearTranslKeyInput();
  notice(result.hasKey ? '密钥已保存，可在此页面随时显示并复制到 Kikoeta Transl；之后重新打开设置也会自动载入。' : 'Transl 上传授权已更新。');
}

document.getElementById('transl-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await updateTranslAuth({ action: 'set_password', username: form.elements.username.value, password: form.elements.password.value });
    form.elements.password.value = '';
  } catch (error) { notice(`保存上传账号失败：${error.message}`); }
  finally { button.disabled = false; }
});

document.getElementById('transl-key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try { await updateTranslAuth({ action: 'set_key', key: form.elements.key.value }); }
  catch (error) { notice(`保存密钥失败：${error.message}`); }
  finally { button.disabled = false; }
});

for (const [id, action] of [
  ['transl-generate-key', 'generate_key'],
  ['transl-clear-key', 'clear_key'],
  ['transl-clear-password', 'clear_password'],
]) {
  document.getElementById(id).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await updateTranslAuth({ action }); }
    catch (error) { notice(`更新 Transl 授权失败：${error.message}`); }
    finally { if (action === 'generate_key') button.disabled = false; }
  });
}

ensureSession().then((session) => {
  if (!session) return;
  document.getElementById('current-user').textContent = session.user;
  refreshTranslAuth().catch((error) => notice(`读取 Transl 授权失败：${error.message}`));
});
})();
