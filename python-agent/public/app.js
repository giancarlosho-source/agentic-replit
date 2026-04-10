// ── State ─────────────────────────────────────────────────────────────
let conversations = JSON.parse(localStorage.getItem('agent-conversations') || '[]');
let currentId = null;
let isRunning = false;
let abortController = null;
let pendingImages = []; // { dataUrl, mimeType, base64 }

// ── DOM refs ──────────────────────────────────────────────────────────
const messagesEl     = document.getElementById('messages');
const welcomeEl      = document.getElementById('welcomeScreen');
const userInput      = document.getElementById('userInput');
const sendBtn        = document.getElementById('sendBtn');
const stopBtn        = document.getElementById('stopBtn');
const newChatBtn     = document.getElementById('newChatBtn');
const historyList    = document.getElementById('historyList');
const statusDot      = document.getElementById('statusDot');
const statusText     = document.getElementById('statusText');
const workdirDisplay = document.getElementById('workdirDisplay');
const workdirInline  = document.getElementById('workdirInline');
const workdirModal   = document.getElementById('workdirModal');
const workdirInput   = document.getElementById('workdirInput');
const changeWorkdirBtn  = document.getElementById('changeWorkdirBtn');
const cancelWorkdir     = document.getElementById('cancelWorkdir');
const confirmWorkdir    = document.getElementById('confirmWorkdir');
const chatArea          = document.getElementById('chatArea');
const attachBtn         = document.getElementById('attachBtn');
const imageInput        = document.getElementById('imageInput');
const imagePreviewStrip = document.getElementById('imagePreviewStrip');
const inputArea         = document.querySelector('.input-area');

// ── Status ────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    statusText.textContent = data.message;
    statusDot.className = 'status-dot ' + (data.ready ? 'ready' : 'error');
    if (data.workDir) {
      const short = data.workDir.length > 26 ? '...' + data.workDir.slice(-23) : data.workDir;
      workdirDisplay.textContent = short;
      workdirDisplay.title = data.workDir;
      workdirInline.textContent = data.workDir;
    }
  } catch {
    statusDot.className = 'status-dot error';
    statusText.textContent = 'Server not reachable';
  }
}

// ── Image handling ────────────────────────────────────────────────────
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(',')[1];
      resolve({ dataUrl, base64, mimeType: file.type || 'image/png', name: file.name });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const img = await readImageFile(file);
    pendingImages.push(img);
  }
  renderImagePreviews();
}

function renderImagePreviews() {
  imagePreviewStrip.innerHTML = '';
  if (pendingImages.length === 0) {
    imagePreviewStrip.style.display = 'none';
    attachBtn.classList.remove('has-images');
    return;
  }

  imagePreviewStrip.style.display = 'flex';
  attachBtn.classList.add('has-images');

  pendingImages.forEach((img, i) => {
    const item = document.createElement('div');
    item.className = 'image-preview-item';

    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    imgEl.alt = img.name;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'image-preview-remove';
    removeBtn.textContent = '×';
    removeBtn.onclick = () => {
      pendingImages.splice(i, 1);
      renderImagePreviews();
    };

    item.appendChild(imgEl);
    item.appendChild(removeBtn);
    imagePreviewStrip.appendChild(item);
  });
}

// ── Conversations ─────────────────────────────────────────────────────
function save() { localStorage.setItem('agent-conversations', JSON.stringify(conversations)); }

function createConvo() {
  const convo = { id: Date.now().toString(), title: 'New chat', messages: [] };
  conversations.unshift(convo);
  save();
  return convo;
}

function getCurrentConvo() { return conversations.find(c => c.id === currentId); }

function updateTitle(convo, text) {
  if (convo.title === 'New chat' && text.trim()) {
    convo.title = text.trim().slice(0, 38) + (text.length > 38 ? '…' : '');
    save();
    renderHistory();
  }
}

function loadConvo(id) {
  currentId = id;
  const convo = conversations.find(c => c.id === id);
  if (!convo) return;
  messagesEl.innerHTML = '';
  welcomeEl.style.display = 'none';
  messagesEl.style.display = 'flex';
  convo.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .forEach(m => renderMessage(m.role, m.textContent || m.content, m.toolCalls || [], m.images || [], false));
  renderHistory();
  scrollDown();
}

function renderHistory() {
  historyList.innerHTML = '';
  conversations.forEach(convo => {
    const item = document.createElement('div');
    item.className = 'history-item' + (convo.id === currentId ? ' active' : '');
    item.textContent = convo.title;
    item.onclick = () => loadConvo(convo.id);
    historyList.appendChild(item);
  });
}

// ── Tool icons ────────────────────────────────────────────────────────
function toolIcon(name) {
  const icons = {
    list_files:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    read_file:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    write_file:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    edit_file:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    delete_file:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
    search_files: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    run_command:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
  };
  return icons[name] || '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
}

function toolArgSummary(name, args) {
  if (args.command) return args.command;
  if (args.path && name !== 'list_files') return args.path;
  if (args.path) return args.path;
  if (args.pattern) return `"${args.pattern}"`;
  return JSON.stringify(args).slice(0, 60);
}

// ── Render message ────────────────────────────────────────────────────
function renderMessage(role, content, toolCalls = [], images = [], animate = true) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? 'You' : 'AI';

  const body = document.createElement('div');
  body.className = 'message-body';

  // Show attached images for user messages
  if (images && images.length > 0) {
    const imgRow = document.createElement('div');
    imgRow.className = 'message-images';
    images.forEach(img => {
      const imgEl = document.createElement('img');
      imgEl.src = img.dataUrl;
      imgEl.alt = 'Attached image';
      imgEl.onclick = () => window.open(img.dataUrl, '_blank');
      imgRow.appendChild(imgEl);
    });
    body.appendChild(imgRow);
  }

  // Render tool calls above content (for assistant messages)
  if (toolCalls.length > 0) {
    const tcContainer = document.createElement('div');
    tcContainer.className = 'tool-calls';
    toolCalls.forEach(tc => {
      tcContainer.appendChild(renderToolCall(tc.name, tc.args, tc.result, 'done'));
    });
    body.appendChild(tcContainer);
  }

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (role === 'assistant') {
    contentDiv.innerHTML = marked.parse(content || '');
  } else {
    contentDiv.textContent = content;
  }

  body.appendChild(contentDiv);
  div.appendChild(avatar);
  div.appendChild(body);
  messagesEl.appendChild(div);

  if (animate) scrollDown();
  return { div, body, contentDiv };
}

function renderToolCall(name, args, result, status) {
  const tc = document.createElement('div');
  tc.className = 'tool-call';

  const header = document.createElement('div');
  header.className = 'tool-call-header';

  const icon = document.createElement('div');
  icon.className = 'tool-icon';
  icon.innerHTML = toolIcon(name);

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = name;

  const argsSummary = document.createElement('span');
  argsSummary.className = 'tool-args-summary';
  argsSummary.textContent = toolArgSummary(name, args);

  const statusEl = document.createElement('div');
  statusEl.className = 'tool-status ' + status;

  if (status === 'running') {
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    statusEl.appendChild(spinner);
    statusEl.appendChild(document.createTextNode(' running'));
  } else {
    statusEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> done`;
  }

  header.appendChild(icon);
  header.appendChild(nameEl);
  header.appendChild(argsSummary);
  header.appendChild(statusEl);
  tc.appendChild(header);

  if (result !== undefined) {
    const resultEl = document.createElement('div');
    resultEl.className = 'tool-call-body';
    resultEl.textContent = result;
    tc.appendChild(resultEl);
    header.addEventListener('click', () => tc.classList.toggle('expanded'));
  }

  return tc;
}

// ── Scroll ────────────────────────────────────────────────────────────
function scrollDown() {
  requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; });
}

// ── Build OpenAI message content with optional images ─────────────────
function buildUserContent(text, images) {
  if (!images || images.length === 0) return text;
  const parts = [];
  if (text.trim()) parts.push({ type: 'text', text });
  images.forEach(img => {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'auto' }
    });
  });
  return parts;
}

// ── Send message ──────────────────────────────────────────────────────
async function sendMessage(text) {
  if ((!text.trim() && pendingImages.length === 0) || isRunning) return;

  if (!currentId) {
    const convo = createConvo();
    currentId = convo.id;
  }

  const convo = getCurrentConvo();
  if (!convo) return;

  welcomeEl.style.display = 'none';
  messagesEl.style.display = 'flex';

  const displayText = text.trim() || '(image attached)';
  updateTitle(convo, displayText);

  // Snapshot images before clearing
  const attachedImages = [...pendingImages];
  pendingImages = [];
  renderImagePreviews();

  // Build the message content for the API
  const apiContent = buildUserContent(text, attachedImages);

  // Store in conversation (keep dataUrls for display, don't persist base64 in localStorage)
  convo.messages.push({
    role: 'user',
    content: apiContent,
    textContent: displayText,
    images: attachedImages.map(i => ({ dataUrl: i.dataUrl }))
  });
  save();

  renderMessage('user', displayText, [], attachedImages.map(i => ({ dataUrl: i.dataUrl })));
  renderHistory();

  userInput.value = '';
  autoResize();
  setLoading(true);

  // Create assistant message shell
  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'message assistant';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = 'AI';

  const body = document.createElement('div');
  body.className = 'message-body';

  const tcContainer = document.createElement('div');
  tcContainer.className = 'tool-calls';
  body.appendChild(tcContainer);

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  body.appendChild(contentDiv);

  assistantDiv.appendChild(avatar);
  assistantDiv.appendChild(body);
  messagesEl.appendChild(assistantDiv);
  scrollDown();

  const collectedToolCalls = [];
  abortController = new AbortController();

  try {
    // Build API messages — only send role + content (no extra fields)
    const apiMessages = convo.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: apiMessages }),
      signal: abortController.signal
    });

    if (!res.ok) {
      const err = await res.json();
      contentDiv.innerHTML = `<strong style="color:var(--red)">Error:</strong> ${err.error}`;
      setLoading(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }

        if (event.type === 'provider_switch') {
          const notice = document.createElement('div');
          notice.className = 'provider-switch-notice';
          notice.textContent = `${event.from} unavailable (${event.reason}) — trying next provider…`;
          tcContainer.appendChild(notice);
          scrollDown();
        }

        if (event.type === 'tool_start') {
          const tcEl = renderToolCall(event.tool, event.args, undefined, 'running');
          tcEl.dataset.callId = event.callId;
          tcContainer.appendChild(tcEl);
          scrollDown();
        }

        if (event.type === 'tool_result') {
          const el = tcContainer.querySelector(`[data-call-id="${event.callId}"]`);
          if (el) {
            const statusEl = el.querySelector('.tool-status');
            if (statusEl) {
              statusEl.className = 'tool-status done';
              statusEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> done`;
            }
            const resultEl = document.createElement('div');
            resultEl.className = 'tool-call-body';
            resultEl.textContent = event.result;
            el.appendChild(resultEl);
            el.querySelector('.tool-call-header').addEventListener('click', () => el.classList.toggle('expanded'));
          }
          collectedToolCalls.push({ name: event.tool, args: {}, result: event.result });
          scrollDown();
        }

        if (event.type === 'done') {
          contentDiv.innerHTML = marked.parse(event.reply || '');
          convo.messages.push({
            role: 'assistant',
            content: event.reply,
            textContent: event.reply,
            toolCalls: collectedToolCalls
          });
          save();
          scrollDown();
        }

        if (event.type === 'error') {
          contentDiv.innerHTML = `<strong style="color:var(--red)">Error:</strong> ${event.message}`;
        }
      }
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      contentDiv.innerHTML = `<em style="color:var(--text-muted)">Stopped.</em>`;
    } else {
      contentDiv.innerHTML = `<strong style="color:var(--red)">Connection error.</strong> Is the server still running?`;
    }
  }

  abortController = null;
  setLoading(false);
}

// ── Helpers ───────────────────────────────────────────────────────────
function setLoading(loading) {
  isRunning = loading;
  sendBtn.style.display = loading ? 'none' : 'flex';
  stopBtn.style.display = loading ? 'flex' : 'none';
  userInput.disabled = loading;
  if (!loading) sendBtn.disabled = userInput.value.trim() === '' && pendingImages.length === 0;
}

function autoResize() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 180) + 'px';
}

// ── Events ────────────────────────────────────────────────────────────
userInput.addEventListener('input', () => {
  autoResize();
  sendBtn.disabled = isRunning || (userInput.value.trim() === '' && pendingImages.length === 0);
});

userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled && !isRunning) sendMessage(userInput.value);
  }
});

sendBtn.addEventListener('click', () => sendMessage(userInput.value));

stopBtn.addEventListener('click', () => {
  if (abortController) abortController.abort();
});

newChatBtn.addEventListener('click', () => {
  currentId = null;
  messagesEl.innerHTML = '';
  welcomeEl.style.display = 'flex';
  messagesEl.style.display = 'none';
  pendingImages = [];
  renderImagePreviews();
  renderHistory();
});

document.querySelectorAll('.suggestion').forEach(btn => {
  btn.addEventListener('click', () => sendMessage(btn.dataset.text));
});

// Image attach button
attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', async e => {
  await addImages(Array.from(e.target.files));
  imageInput.value = '';
  sendBtn.disabled = isRunning || (userInput.value.trim() === '' && pendingImages.length === 0);
});

// Drag and drop images onto the input area
inputArea.addEventListener('dragover', e => {
  e.preventDefault();
  inputArea.classList.add('drag-over');
});

inputArea.addEventListener('dragleave', () => inputArea.classList.remove('drag-over'));

inputArea.addEventListener('drop', async e => {
  e.preventDefault();
  inputArea.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  if (files.length) {
    await addImages(files);
    sendBtn.disabled = isRunning || (userInput.value.trim() === '' && pendingImages.length === 0);
  }
});

// Paste images from clipboard
document.addEventListener('paste', async e => {
  const items = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/'));
  if (items.length === 0) return;
  const files = items.map(i => i.getAsFile());
  await addImages(files);
  sendBtn.disabled = isRunning || (userInput.value.trim() === '' && pendingImages.length === 0);
});

// Working dir modal
changeWorkdirBtn.addEventListener('click', () => {
  workdirInput.value = workdirDisplay.title || '';
  workdirModal.style.display = 'flex';
  setTimeout(() => workdirInput.focus(), 50);
});

cancelWorkdir.addEventListener('click', () => { workdirModal.style.display = 'none'; });

confirmWorkdir.addEventListener('click', async () => {
  const dir = workdirInput.value.trim();
  if (!dir) return;
  try {
    const res = await fetch('/api/workdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    workdirModal.style.display = 'none';
    checkStatus();
  } catch { alert('Could not change directory.'); }
});

workdirInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmWorkdir.click(); });
workdirModal.addEventListener('click', e => { if (e.target === workdirModal) workdirModal.style.display = 'none'; });

// ── Init ──────────────────────────────────────────────────────────────
checkStatus();
setInterval(checkStatus, 20000);
renderHistory();
