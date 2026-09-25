(function () {
const { request, notice, ensureSession, getCsrf } = window.LLS;
const zipForm = document.getElementById('zip-form');
const uploadForm = document.getElementById('upload-form');
const searchInput = document.getElementById('work-search');
const worksElement = document.getElementById('works');
const listStatus = document.getElementById('list-status');
let cachedWorks = [];
let nextCursor = null;
let listVersion = 0;
let listLoading = false;
let loadingMore = false;
let loadFailed = false;

function setImportMode(mode) {
  uploadForm.hidden = mode !== 'lyrics';
  zipForm.hidden = mode !== 'zip';
  document.getElementById('import-mode-description').textContent = mode === 'zip' ? '批量导入 ZIP 压缩包' : '上传文件到指定作品';
  for (const [id, active] of [['mode-lyrics', mode === 'lyrics'], ['mode-zip', mode === 'zip']]) {
    const button = document.getElementById(id);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}
document.getElementById('mode-lyrics').addEventListener('click', () => setImportMode('lyrics'));
document.getElementById('mode-zip').addEventListener('click', () => setImportMode('zip'));

const zipConflictSelect = zipForm.elements.conflict;
const zipConflictRoot = document.getElementById('zip-conflict-select');
const zipConflictTrigger = document.getElementById('zip-conflict-trigger');
const zipConflictMenu = document.getElementById('zip-conflict-menu');
const zipConflictOptions = [...zipConflictMenu.querySelectorAll('[role="option"]')];
function syncZipConflictMenu() {
  const selected = zipConflictSelect.value;
  const option = zipConflictOptions.find((item) => item.dataset.value === selected);
  document.getElementById('zip-conflict-value').textContent = option?.querySelector('span').textContent || '跟随设置（默认）';
  zipConflictOptions.forEach((item) => item.setAttribute('aria-selected', String(item === option)));
}
function closeZipConflictMenu({ restoreFocus = false } = {}) {
  zipConflictMenu.hidden = true;
  zipConflictTrigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) zipConflictTrigger.focus();
}
function openZipConflictMenu() {
  zipConflictMenu.hidden = false;
  zipConflictTrigger.setAttribute('aria-expanded', 'true');
  (zipConflictOptions.find((item) => item.getAttribute('aria-selected') === 'true') || zipConflictOptions[0]).focus();
}
zipConflictTrigger.addEventListener('click', () => zipConflictMenu.hidden ? openZipConflictMenu() : closeZipConflictMenu());
zipConflictTrigger.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openZipConflictMenu();
  }
});
zipConflictOptions.forEach((option, index) => {
  option.addEventListener('click', () => {
    zipConflictSelect.value = option.dataset.value;
    zipConflictSelect.dispatchEvent(new Event('change', { bubbles: true }));
    syncZipConflictMenu();
    closeZipConflictMenu({ restoreFocus: true });
  });
  option.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeZipConflictMenu({ restoreFocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? zipConflictOptions.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + zipConflictOptions.length) % zipConflictOptions.length;
      zipConflictOptions[next].focus();
    }
  });
});
document.addEventListener('click', (event) => {
  if (!zipConflictRoot.contains(event.target)) closeZipConflictMenu();
});
syncZipConflictMenu();
zipForm.addEventListener('reset', () => requestAnimationFrame(syncZipConflictMenu));

function renderWorks(appendFrom = 0) {
  const openIds = appendFrom ? new Set() : new Set([...worksElement.querySelectorAll('details[open]')].map((item) => item.dataset.workId));
  const query = searchInput.value.trim();
  const works = cachedWorks.slice(appendFrom);
  document.getElementById('visible-count').textContent = `已显示 ${cachedWorks.length} 部作品`;
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
  requestAnimationFrame(maybeLoadMore);
}

async function refresh() {
  const version = ++listVersion;
  listLoading = true;
  nextCursor = null;
  loadFailed = false;
  listStatus.hidden = true;
  try {
    const result = await request(`works?q=${encodeURIComponent(searchInput.value.trim())}`);
    if (version !== listVersion) return;
    cachedWorks = result.works;
    nextCursor = result.nextCursor;
    document.getElementById('work-count').textContent = String(result.workCount);
    document.getElementById('file-count').textContent = String(result.fileCount);
    renderWorks();
  } finally {
    if (version === listVersion) listLoading = false;
  }
}

searchInput.addEventListener('input', () => {
  worksElement.scrollTop = 0;
  document.getElementById('visible-count').textContent = '搜索中…';
  refresh().catch((error) => notice(`搜索失败：${error.message}`));
});

function maybeLoadMore() {
  if (document.body.dataset.view !== 'library' || listLoading || loadingMore || loadFailed || !nextCursor) return;
  if (worksElement.scrollHeight - worksElement.scrollTop - worksElement.clientHeight > 100) return;
  loadMore();
}

async function loadMore() {
  const cursor = nextCursor;
  if (!cursor || loadingMore) return;
  const version = listVersion;
  loadingMore = true;
  listStatus.textContent = '正在加载更多作品…';
  listStatus.hidden = false;
  try {
    const result = await request(`works?q=${encodeURIComponent(searchInput.value.trim())}&after=${encodeURIComponent(cursor)}`);
    if (version !== listVersion) return;
    const appendFrom = cachedWorks.length;
    cachedWorks.push(...result.works);
    nextCursor = result.nextCursor;
    renderWorks(appendFrom);
  } catch (error) {
    if (version === listVersion) {
      loadFailed = true;
      listStatus.textContent = `加载失败：${error.message}。再次滚动可重试。`;
    }
  } finally {
    loadingMore = false;
    if (version === listVersion && !loadFailed) listStatus.hidden = true;
    requestAnimationFrame(maybeLoadMore);
  }
}

worksElement.addEventListener('scroll', () => { loadFailed = false; maybeLoadMore(); });
window.addEventListener('resize', () => requestAnimationFrame(maybeLoadMore));

let zipDefaults = { conflict: 'skip', isAi: false };
function applyZipDefaults() {
  zipForm.elements.isAi.checked = zipDefaults.isAi;
}
try {
  const conflict = localStorage.getItem('lls-zip-conflict');
  if (conflict === 'skip' || conflict === 'overwrite') zipDefaults.conflict = conflict;
  zipDefaults.isAi = localStorage.getItem('lls-zip-ai') === 'true';
} catch { /* Local storage may be unavailable. */ }
applyZipDefaults();

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

const zipProgress = document.getElementById('zip-progress');
const zipProgressTitle = document.getElementById('zip-progress-title');
const zipProgressDetail = document.getElementById('zip-progress-detail');
const zipProgressBar = document.getElementById('zip-progress-bar');
const zipJobKey = 'lls-current-zip-job';
let zipStatusTimer;

function saveZipState(value) {
  try { sessionStorage.setItem(zipJobKey, JSON.stringify(value)); } catch { /* Progress remains visible until this page closes. */ }
}

function readZipState() {
  try { return JSON.parse(sessionStorage.getItem(zipJobKey) || 'null'); } catch { return null; }
}

async function restoreZipProgress() {
  const saved = readZipState();
  if (!saved) return;
  setImportMode('zip');
  if (!saved.id) {
    showZipProgress(saved.state, saved.title, saved.detail, saved.percent);
    return;
  }
  clearTimeout(zipStatusTimer);
  const update = async () => {
    let job;
    try { job = await request(`import/jobs/${encodeURIComponent(saved.id)}`); }
    catch (error) {
      showZipProgress('error', '无法恢复导入状态', `服务器未找到任务：${error.message}。请重新选择压缩包。`);
      return;
    }
    const label = saved.label || job.name || '压缩包';
    if (job.state === 'uploading') {
      const percent = job.total ? Math.min(100, Math.round(job.received / job.total * 100)) : undefined;
      showZipProgress('uploading', `正在上传 ${label}`, percent === undefined ? '正在接收压缩包' : `已接收 ${percent}%`, percent);
    } else if (job.state === 'processing') {
      showZipProgress('processing', `正在处理 ${label}`, '服务器正在解压、识别作品并写入 SQLite。');
    } else if (job.state === 'success') {
      const result = job.result;
      const remaining = saved.remaining ? `；刷新前未开始的 ${saved.remaining} 个压缩包需要重新选择` : '';
      showZipProgress('success', '导入完成', `${label}：新增 ${result.imported} 个、覆盖 ${result.overwritten} 个、跳过 ${result.skipped} 个歌词文件${remaining}。`, 100);
      await refresh().catch((error) => notice(`刷新作品列表失败：${error.message}`));
      return;
    } else if (job.state === 'error') {
      showZipProgress('error', '导入中断', `${label}：${zipErrorMessage(job.error)}。请重新选择压缩包。`);
      await refresh().catch((error) => notice(`刷新作品列表失败：${error.message}`));
      return;
    } else {
      showZipProgress('error', '上传未开始', `${label} 的上传在刷新时中断，请重新选择压缩包。`);
      return;
    }
    zipStatusTimer = setTimeout(update, 1000);
  };
  await update();
}

function showZipProgress(state, title, detail, percent) {
  zipProgress.hidden = false;
  zipProgress.dataset.state = state;
  zipProgressTitle.textContent = title;
  zipProgressDetail.textContent = detail;
  zipProgressBar.hidden = state === 'error';
  if (percent === undefined) zipProgressBar.removeAttribute('value');
  else zipProgressBar.value = percent;
}

function zipErrorMessage(code) {
  return {
    invalid_zip: 'ZIP 文件损坏或格式不受支持',
    invalid_file: '文件名或文件类型无效',
    zip_limit_exceeded: '压缩包内容超过导入限制',
    body_too_large: '压缩包超过 512 MiB',
    work_full: '作品文件数或容量已达上限',
    unauthorized: '登录已失效，请重新登录',
    forbidden: '请求被拒绝，请刷新页面后重试',
    upload_interrupted: '上传连接中断',
    request_failed: '服务器处理失败',
  }[code] || code;
}

function uploadZip(file, query, onProgress, onProcessing) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/import/zip?${query}`);
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.setRequestHeader('X-LLS-CSRF', getCsrf());
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
    });
    xhr.upload.addEventListener('load', onProcessing);
    xhr.addEventListener('load', () => {
      let result;
      try { result = JSON.parse(xhr.responseText); } catch { /* A proxy may return a non-JSON error. */ }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(zipErrorMessage(result?.error || `HTTP ${xhr.status}`)));
      if (!result || !Array.isArray(result.workIds)) return reject(new Error('服务器返回了无效结果'));
      resolve(result);
    });
    xhr.addEventListener('error', () => reject(new Error('网络连接中断')));
    xhr.addEventListener('abort', () => reject(new Error('请求已取消')));
    xhr.send(file);
  });
}

zipForm.elements.archive.addEventListener('change', () => {
  clearTimeout(zipStatusTimer);
  zipProgress.hidden = true;
  try { sessionStorage.removeItem(zipJobKey); } catch { /* Storage may be unavailable. */ }
});
zipForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const controls = [...form.querySelectorAll('input, select, button')];
  const disabled = controls.map((control) => control.disabled);
  const button = form.querySelector('button[type="submit"]');
  const buttonText = button.textContent;
  const files = [...form.elements.archive.files];
  if (!files.length) return;
  const conflict = form.elements.conflict.value === 'follow' ? zipDefaults.conflict : form.elements.conflict.value;
  const isAi = form.elements.isAi.checked;
  controls.forEach((control) => { control.disabled = true; });
  button.textContent = '正在导入…';
  notice('');
  showZipProgress('uploading', '准备上传压缩包', `共 ${files.length} 个 ZIP 文件`, 0);
  let imported = 0, overwritten = 0, skipped = 0, ignored = 0;
  let currentJobId = null;
  const workIds = new Set();
  try {
    for (const [index, file] of files.entries()) {
      currentJobId = null;
      if (!/\.zip$/i.test(file.name) || !file.size || file.size > 512 * 1024 * 1024) throw new Error(`${file.name} 不是有效的 ZIP 文件或超过 512 MiB`);
      const label = `${index + 1}/${files.length}：${file.name}`;
      const { id } = await request('import/jobs', 'POST');
      currentJobId = id;
      saveZipState({ id, label, remaining: files.length - index - 1 });
      showZipProgress('uploading', `正在上传 ${label}`, '上传进度 0%', 0);
      const query = new URLSearchParams({ job: id, name: file.name, conflict, ai: String(isAi) });
      let result;
      try {
        result = await uploadZip(file, query,
          (percent) => showZipProgress('uploading', `正在上传 ${label}`, `上传进度 ${percent}%`, percent),
          () => showZipProgress('processing', `正在处理 ${label}`, '服务器正在解压、识别作品并写入 SQLite；此阶段无法提供精确百分比。'));
      } catch (error) { throw new Error(`${file.name}：${error.message}`); }
      imported += result.imported; overwritten += result.overwritten; skipped += result.skipped; ignored += result.ignored;
      for (const id of result.workIds) workIds.add(id);
    }
    form.reset();
    applyZipDefaults();
    showZipProgress('success', '导入完成', `${workIds.size} 部作品；新增 ${imported} 个、覆盖 ${overwritten} 个、跳过 ${skipped} 个歌词文件；忽略 ${ignored} 个其他条目。`, 100);
    saveZipState({ state: 'success', title: '导入完成', detail: zipProgressDetail.textContent, percent: 100 });
  } catch (error) {
    showZipProgress('error', '导入中断', `${error.message}；此前已新增 ${imported} 个、覆盖 ${overwritten} 个歌词文件。`);
    if (!currentJobId) saveZipState({ state: 'error', title: '导入中断', detail: zipProgressDetail.textContent });
  } finally {
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    button.textContent = buttonText;
    try { await refresh(); } catch (error) { notice(`刷新作品列表失败：${error.message}`); }
  }
});

document.getElementById('refresh').addEventListener('click', () => refresh().catch((error) => notice(`刷新失败：${error.message}`)));

const initialWorks = refresh().then(() => null, (error) => error);
ensureSession().then((session) => {
  if (!session) return;
  return Promise.all([
    initialWorks.then((error) => { if (error) notice(`读取作品列表失败：${error.message}`); }),
    restoreZipProgress(),
  ]);
});
})();
