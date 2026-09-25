(function () {
const { request, notice, setCsrf } = window.LLS;
const loginPanel = document.getElementById('login-panel');
const passwordPanel = document.getElementById('password-panel');

function showPasswordSetup() {
  document.body.dataset.view = 'password';
  loginPanel.hidden = true;
  passwordPanel.hidden = false;
}

request('session').then((session) => {
  setCsrf(session.csrf);
  if (session.mustChangePassword) showPasswordSetup();
  else location.replace('/library');
}).catch((error) => {
  if (error.message !== 'unauthorized') notice(`读取登录状态失败：${error.message}`);
});

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request('login', 'POST', { user: form.elements.user.value, password: form.elements.password.value });
    setCsrf(result.csrf);
    if (result.mustChangePassword) showPasswordSetup();
    else location.assign('/library');
  } catch (error) { notice(`登录失败：${error.message}`); }
  finally { button.disabled = false; }
});

document.getElementById('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request('password', 'POST', { newPassword: form.elements.newPassword.value });
    setCsrf(result.csrf);
    location.assign('/library');
  } catch (error) {
    const message = error.message === 'invalid_new_password' ? '新密码无效，请使用至少 6 位且不同于旧密码的内容' : error.message;
    notice(`修改失败：${message}`);
  } finally { button.disabled = false; }
});
})();
