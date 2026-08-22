const STORAGE = {
  symbols: 'pricewatch_symbols_v1',
  alerts: 'pricewatch_alerts_v1',
  sound: 'pricewatch_sound_v1'
};

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
let symbols = loadJSON(STORAGE.symbols, DEFAULT_SYMBOLS);
let alerts = loadJSON(STORAGE.alerts, []);
let prices = {};
let socket = null;
let reconnectTimer = null;
let toastTimer = null;
let audioCtx = null;

const el = {
  priceList: document.querySelector('#priceList'),
  alertList: document.querySelector('#alertList'),
  addSymbolBtn: document.querySelector('#addSymbolBtn'),
  addAlertBtn: document.querySelector('#addAlertBtn'),
  symbolDialog: document.querySelector('#symbolDialog'),
  alertDialog: document.querySelector('#alertDialog'),
  symbolForm: document.querySelector('#symbolForm'),
  alertForm: document.querySelector('#alertForm'),
  symbolInput: document.querySelector('#symbolInput'),
  alertSymbol: document.querySelector('#alertSymbol'),
  alertDirection: document.querySelector('#alertDirection'),
  alertPrice: document.querySelector('#alertPrice'),
  connectionStatus: document.querySelector('#connectionStatus'),
  notificationBtn: document.querySelector('#notificationBtn'),
  notificationHint: document.querySelector('#notificationHint'),
  soundToggle: document.querySelector('#soundToggle'),
  toast: document.querySelector('#toast')
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function saveState() {
  localStorage.setItem(STORAGE.symbols, JSON.stringify(symbols));
  localStorage.setItem(STORAGE.alerts, JSON.stringify(alerts));
}

function normalizeSymbol(input) {
  let value = String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!value) return '';
  const commonQuotes = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR'];
  if (!commonQuotes.some(q => value.endsWith(q))) value += 'USDT';
  return value;
}

function formatPrice(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 5 : 8;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: value >= 1000 ? 2 : 0 });
}

function renderPrices() {
  el.priceList.innerHTML = '';
  if (!symbols.length) {
    el.priceList.innerHTML = '<div class="empty">还没有监控币种，点右上角添加。</div>';
    return;
  }
  symbols.forEach(symbol => {
    const data = prices[symbol];
    const card = document.createElement('div');
    card.className = 'price-card';
    const change = data?.changePct ?? null;
    const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
    const changeText = change == null ? '等待行情…' : `${change > 0 ? '+' : ''}${change.toFixed(2)}% · 24h`;
    card.innerHTML = `
      <div class="price-main">
        <div>
          <div class="symbol">${symbol}</div>
          <div class="pair-sub">Binance Spot</div>
        </div>
        <div>
          <div class="price-value">${data ? '$' + formatPrice(data.price) : '—'}</div>
          <div class="change ${changeClass}">${changeText}</div>
        </div>
      </div>
      <div class="row-actions">
        <button class="ghost" data-action="quick-alert" data-symbol="${symbol}">设提醒</button>
        <button class="danger" data-action="remove-symbol" data-symbol="${symbol}">移除</button>
      </div>`;
    el.priceList.appendChild(card);
  });
}

function renderAlerts() {
  el.alertList.innerHTML = '';
  if (!alerts.length) {
    el.alertList.innerHTML = '<div class="empty">还没有提醒。可以设置“ETH ≥ 5000”或“BTC ≤ 110000”。</div>';
    return;
  }
  alerts.forEach(alert => {
    const card = document.createElement('div');
    card.className = `alert-card${alert.triggered ? ' triggered' : ''}`;
    const sign = alert.direction === 'above' ? '≥' : '≤';
    const current = prices[alert.symbol]?.price;
    const statusClass = alert.triggered ? 'hit' : alert.enabled ? 'active' : '';
    const statusText = alert.triggered ? '已触发' : alert.enabled ? '监控中' : '已暂停';
    card.innerHTML = `
      <div class="alert-main">
        <div>
          <div class="alert-condition">${alert.symbol} ${sign} $${formatPrice(alert.target)}</div>
          <div class="alert-meta">当前 ${current ? '$' + formatPrice(current) : '等待行情…'}</div>
        </div>
        <span class="alert-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="row-actions">
        <button class="ghost" data-action="toggle-alert" data-id="${alert.id}">${alert.enabled && !alert.triggered ? '暂停' : '重新启用'}</button>
        <button class="danger" data-action="delete-alert" data-id="${alert.id}">删除</button>
      </div>`;
    el.alertList.appendChild(card);
  });
}

function renderAlertSymbolOptions(preselect) {
  el.alertSymbol.innerHTML = symbols.map(s => `<option value="${s}">${s}</option>`).join('');
  if (preselect && symbols.includes(preselect)) el.alertSymbol.value = preselect;
}

function setConnection(state, text) {
  el.connectionStatus.className = `status-pill ${state}`;
  el.connectionStatus.querySelector('span:last-child').textContent = text;
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  if (!symbols.length) {
    setConnection('offline', '无交易对');
    return;
  }
  setConnection('', '连接中');
  const streams = symbols.map(s => `${s.toLowerCase()}@miniTicker`).join('/');
  const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
  socket = new WebSocket(url);

  socket.onopen = () => setConnection('online', '实时');
  socket.onmessage = event => {
    try {
      const msg = JSON.parse(event.data);
      const data = msg.data || msg;
      const symbol = data.s;
      if (!symbol || !symbols.includes(symbol)) return;
      const price = Number(data.c);
      const open = Number(data.o);
      prices[symbol] = {
        price,
        open,
        high: Number(data.h),
        low: Number(data.l),
        changePct: open ? ((price - open) / open) * 100 : 0,
        updatedAt: Date.now()
      };
      renderPrices();
      renderAlerts();
      checkAlerts(symbol, price);
    } catch (err) {
      console.warn('Ticker parse error', err);
    }
  };
  socket.onerror = () => setConnection('offline', '连接异常');
  socket.onclose = () => {
    setConnection('offline', '重连中');
    reconnectTimer = setTimeout(connectSocket, 3000);
  };
}

function checkAlerts(symbol, price) {
  let changed = false;
  alerts.forEach(alert => {
    if (alert.symbol !== symbol || !alert.enabled || alert.triggered) return;
    const hit = alert.direction === 'above' ? price >= alert.target : price <= alert.target;
    if (!hit) return;
    alert.triggered = true;
    alert.enabled = false;
    alert.triggeredAt = Date.now();
    changed = true;
    fireAlert(alert, price);
  });
  if (changed) {
    saveState();
    renderAlerts();
  }
}

function fireAlert(alert, currentPrice) {
  const sign = alert.direction === 'above' ? '≥' : '≤';
  const title = `${alert.symbol} 价格提醒`;
  const body = `当前 $${formatPrice(currentPrice)}，已达到 ${sign} $${formatPrice(alert.target)}`;
  showToast(`${title}：${body}`);
  if (el.soundToggle.checked) playBeep();
  if ('Notification' in window && Notification.permission === 'granted') {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready
        .then(reg => reg.showNotification(title, { body, icon: './icons/icon-192.png', tag: `pricewatch-${alert.id}` }))
        .catch(e => console.warn('Notification failed', e));
    }
  }
  if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
}

function playBeep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.48);
  } catch (e) {
    console.warn('Audio failed', e);
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('show');
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
}

el.addSymbolBtn.addEventListener('click', () => {
  el.symbolInput.value = '';
  el.symbolDialog.showModal();
  setTimeout(() => el.symbolInput.focus(), 80);
});

el.symbolForm.addEventListener('submit', event => {
  const submitter = event.submitter;
  if (!submitter || submitter.value === 'cancel') return;
  event.preventDefault();
  const symbol = normalizeSymbol(el.symbolInput.value);
  if (!symbol) return showToast('请输入交易对');
  if (symbols.includes(symbol)) return showToast(`${symbol} 已经在列表里`);
  symbols.push(symbol);
  saveState();
  renderPrices();
  renderAlertSymbolOptions();
  connectSocket();
  el.symbolDialog.close();
  showToast(`已添加 ${symbol}`);
});

el.addAlertBtn.addEventListener('click', () => {
  if (!symbols.length) return showToast('请先添加至少一个交易对');
  renderAlertSymbolOptions();
  el.alertPrice.value = '';
  el.alertDirection.value = 'above';
  el.alertDialog.showModal();
});

el.alertForm.addEventListener('submit', event => {
  const submitter = event.submitter;
  if (!submitter || submitter.value === 'cancel') return;
  event.preventDefault();
  const target = Number(el.alertPrice.value);
  if (!Number.isFinite(target) || target <= 0) return showToast('请输入有效目标价格');
  alerts.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    symbol: el.alertSymbol.value,
    direction: el.alertDirection.value,
    target,
    enabled: true,
    triggered: false,
    createdAt: Date.now()
  });
  saveState();
  renderAlerts();
  el.alertDialog.close();
  showToast('提醒已保存');
});

el.priceList.addEventListener('click', event => {
  const btn = event.target.closest('button');
  if (!btn) return;
  const symbol = btn.dataset.symbol;
  if (btn.dataset.action === 'remove-symbol') {
    symbols = symbols.filter(s => s !== symbol);
    alerts = alerts.filter(a => a.symbol !== symbol);
    delete prices[symbol];
    saveState();
    renderPrices();
    renderAlerts();
    renderAlertSymbolOptions();
    connectSocket();
    showToast(`已移除 ${symbol}`);
  }
  if (btn.dataset.action === 'quick-alert') {
    renderAlertSymbolOptions(symbol);
    const current = prices[symbol]?.price;
    el.alertPrice.value = current ? String(current) : '';
    el.alertDirection.value = 'above';
    el.alertDialog.showModal();
  }
});

el.alertList.addEventListener('click', event => {
  const btn = event.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  const alert = alerts.find(a => a.id === id);
  if (btn.dataset.action === 'delete-alert') {
    alerts = alerts.filter(a => a.id !== id);
  }
  if (btn.dataset.action === 'toggle-alert' && alert) {
    const shouldEnable = alert.triggered || !alert.enabled;
    alert.enabled = shouldEnable;
    if (shouldEnable) alert.triggered = false;
  }
  saveState();
  renderAlerts();
});

async function updateNotificationUI() {
  if (!('Notification' in window)) {
    el.notificationBtn.disabled = true;
    el.notificationBtn.textContent = '不支持';
    el.notificationHint.textContent = '当前浏览器不支持 Notification API';
    return;
  }
  const permission = Notification.permission;
  if (permission === 'granted') {
    el.notificationBtn.textContent = '已开启';
    el.notificationHint.textContent = '前台触发时可弹出本机通知';
  } else if (permission === 'denied') {
    el.notificationBtn.textContent = '已拒绝';
    el.notificationHint.textContent = '请到系统通知设置中重新授权';
  } else {
    el.notificationBtn.textContent = '开启通知';
    el.notificationHint.textContent = '需要你主动授权';
  }
}

el.notificationBtn.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  try {
    const result = await Notification.requestPermission();
    await updateNotificationUI();
    if (result === 'granted') {
      showToast('通知已开启');
      playBeep();
    }
  } catch {
    showToast('通知授权失败');
  }
});

el.soundToggle.checked = localStorage.getItem(STORAGE.sound) !== '0';
el.soundToggle.addEventListener('change', () => {
  localStorage.setItem(STORAGE.sound, el.soundToggle.checked ? '1' : '0');
  if (el.soundToggle.checked) playBeep();
});

window.addEventListener('online', connectSocket);
window.addEventListener('offline', () => setConnection('offline', '离线'));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!socket || socket.readyState > 1)) connectSocket();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
}

renderPrices();
renderAlerts();
renderAlertSymbolOptions();
updateNotificationUI();
connectSocket();
