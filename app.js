const STORAGE = {
  symbols: 'pricewatch_symbols_v1',
  alerts: 'pricewatch_alerts_v1',
  sound: 'pricewatch_sound_v1',
  backendUrl: 'pricewatch_backend_url_v2',
  backendToken: 'pricewatch_backend_token_v2',
  clientId: 'pricewatch_client_id_v2',
  markets: 'pricewatch_markets_v3'
};

const VAPID_PUBLIC_KEY = 'BDOPB7t_5ss8hWCqrcCZO-fj3CM87At5ytLrA-dcek75GptW7kg-ZD3XC2i9vMHeMN2f3jQ_0FC2bMajAG-NzrE';
const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
let symbols = loadJSON(STORAGE.symbols, DEFAULT_SYMBOLS);
let alerts = loadJSON(STORAGE.alerts, []);
let markets = loadJSON(STORAGE.markets, {});
let prices = {};
let sockets = { spot: null, futures: null };
let reconnectTimer = null;
let toastTimer = null;
let audioCtx = null;
let backendSyncTimer = null;
let quotePollTimer = null;
let quotePollBusy = false;
let undoTimer = null;
let undoAction = null;

const el = {
  priceList: document.querySelector('#priceList'), alertList: document.querySelector('#alertList'),
  addSymbolBtn: document.querySelector('#addSymbolBtn'), addAlertBtn: document.querySelector('#addAlertBtn'),
  symbolDialog: document.querySelector('#symbolDialog'), alertDialog: document.querySelector('#alertDialog'),
  backendDialog: document.querySelector('#backendDialog'), symbolForm: document.querySelector('#symbolForm'),
  alertForm: document.querySelector('#alertForm'), backendForm: document.querySelector('#backendForm'),
  symbolInput: document.querySelector('#symbolInput'), alertSymbol: document.querySelector('#alertSymbol'),
  alertDirection: document.querySelector('#alertDirection'), alertPrice: document.querySelector('#alertPrice'),
  connectionStatus: document.querySelector('#connectionStatus'), notificationBtn: document.querySelector('#notificationBtn'),
  notificationHint: document.querySelector('#notificationHint'), soundToggle: document.querySelector('#soundToggle'),
  backendBtn: document.querySelector('#backendBtn'), backendHint: document.querySelector('#backendHint'),
  backendTestRow: document.querySelector('#backendTestRow'), backendTestBtn: document.querySelector('#backendTestBtn'),
  backendUrlInput: document.querySelector('#backendUrlInput'), backendTokenInput: document.querySelector('#backendTokenInput'),
  toast: document.querySelector('#toast')
};

function loadJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : structuredClone(fallback); }
  catch { return structuredClone(fallback); }
}
function getClientId() {
  let id = localStorage.getItem(STORAGE.clientId);
  if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; localStorage.setItem(STORAGE.clientId, id); }
  return id;
}
function backendConfig() {
  return { url: (localStorage.getItem(STORAGE.backendUrl) || '').replace(/\/+$/, ''), token: localStorage.getItem(STORAGE.backendToken) || '' };
}
function saveState(sync = true) {
  localStorage.setItem(STORAGE.symbols, JSON.stringify(symbols));
  localStorage.setItem(STORAGE.alerts, JSON.stringify(alerts));
  localStorage.setItem(STORAGE.markets, JSON.stringify(markets));
  if (sync) scheduleBackendSync();
}
function marketLabel(symbol) {
  if (markets[symbol] === 'futures') return 'Binance USDⓈ-M Futures';
  if (markets[symbol] === 'spot') return 'Binance Spot';
  return '正在识别市场…';
}
async function fetchWithTimeout(url, timeout=7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { cache:'no-store', signal:controller.signal }); }
  finally { clearTimeout(timer); }
}
async function detectMarket(symbol, force=false) {
  if (!force && (markets[symbol] === 'spot' || markets[symbol] === 'futures')) return markets[symbol];

  // 已配置 Cloudflare 后台时，优先通过中转识别市场。这样前端无需直连 Binance。
  const cfg = backendConfig();
  if (cfg.url && cfg.token) {
    try {
      const quotes = await fetchBackendQuotes([symbol]);
      const q = quotes[symbol];
      if (q && (q.market === 'spot' || q.market === 'futures') && Number.isFinite(Number(q.price))) {
        markets[symbol] = q.market;
        prices[symbol] = {
          price:Number(q.price), open:Number(q.open), high:Number(q.high), low:Number(q.low),
          changePct:Number(q.changePct)||0, updatedAt:Date.now(), market:q.market
        };
        saveState(false);
        return q.market;
      }
    } catch (e) {
      console.warn('Cloudflare market detection failed', symbol, e);
    }
  }

  let accessProblem = false;
  let spotInvalid = false;
  let futuresInvalid = false;

  async function probe(url, market) {
    try {
      const r = await fetchWithTimeout(url);
      let d = null;
      try { d = await r.json(); } catch {}
      if (r.ok && Number.isFinite(Number(d?.price))) {
        markets[symbol] = market;
        saveState(false);
        return market;
      }
      const message = String(d?.msg || d?.message || '').toLowerCase();
      const invalid = r.status === 400 && (Number(d?.code) === -1121 || message.includes('invalid symbol'));
      if (invalid) {
        if (market === 'spot') spotInvalid = true;
        else futuresInvalid = true;
        return null;
      }
      if ([403, 418, 429, 451].includes(r.status) || r.status >= 500) accessProblem = true;
    } catch {
      accessProblem = true;
    }
    return null;
  }

  const spot = await probe(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`, 'spot');
  if (spot) return spot;
  const futures = await probe(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`, 'futures');
  if (futures) return futures;

  if (spotInvalid && futuresInvalid) throw new Error(`${symbol} 在 Binance Spot / USDⓈ-M Futures 中未找到`);
  if (accessProblem || spotInvalid || futuresInvalid) {
    const err = new Error('当前网络暂时无法完成市场识别，已可先加入列表，恢复连接后会自动重试');
    err.code = 'MARKET_PENDING';
    throw err;
  }
  const err = new Error('暂时无法识别交易对市场，已可先加入列表，稍后会自动重试');
  err.code = 'MARKET_PENDING';
  throw err;
}
async function resolveMarkets() {
  await Promise.all(symbols.map(async symbol => {
    if (markets[symbol] === 'spot' || markets[symbol] === 'futures') return;
    try { await detectMarket(symbol); } catch (e) { console.warn('Market detection failed', symbol, e); }
  }));
  renderPrices();
}
function normalizeSymbol(input) {
  let value = String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!value) return '';
  const commonQuotes = ['USDT','USDC','FDUSD','BTC','ETH','BNB','TRY','EUR'];
  if (!commonQuotes.some(q => value.endsWith(q))) value += 'USDT';
  return value;
}
function formatPrice(n) {
  const value = Number(n); if (!Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 5 : 8;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: value >= 1000 ? 2 : 0 });
}
function renderPrices() {
  el.priceList.innerHTML = '';
  if (!symbols.length) { el.priceList.innerHTML = '<div class="empty">还没有监控币种，点右上角添加。</div>'; return; }
  symbols.forEach(symbol => {
    const data = prices[symbol], change = data?.changePct ?? null;
    const card = document.createElement('div'); card.className = 'price-card';
    const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
    const changeText = change == null ? '等待行情…' : `${change > 0 ? '+' : ''}${change.toFixed(2)}% · 24h`;
    card.innerHTML = `<div class="price-main"><div><div class="symbol">${symbol}</div><div class="pair-sub">${marketLabel(symbol)}</div></div><div><div class="price-value">${data ? '$'+formatPrice(data.price) : '—'}</div><div class="change ${changeClass}">${changeText}</div></div></div><div class="row-actions"><button class="ghost" data-action="quick-alert" data-symbol="${symbol}">设提醒</button><button class="danger compact-danger" data-action="remove-symbol" data-symbol="${symbol}">移除</button></div>`;
    el.priceList.appendChild(card);
  });
}
function renderAlerts() {
  el.alertList.innerHTML = '';
  if (!alerts.length) { el.alertList.innerHTML = '<div class="empty">还没有提醒。可以设置“ETH ≥ 5000”或“BTC ≤ 110000”。</div>'; return; }
  alerts.forEach(alert => {
    const card = document.createElement('div'); card.className = `alert-card${alert.triggered ? ' triggered' : ''}`;
    const sign = alert.direction === 'above' ? '≥' : '≤', current = prices[alert.symbol]?.price;
    const statusClass = alert.triggered ? 'hit' : alert.enabled ? 'active' : '';
    const statusText = alert.triggered ? '已触发' : alert.enabled ? '监控中' : '已暂停';
    card.innerHTML = `<div class="alert-main"><div><div class="alert-condition">${alert.symbol} ${sign} $${formatPrice(alert.target)}</div><div class="alert-meta">当前 ${current ? '$'+formatPrice(current) : '等待行情…'}</div></div><span class="alert-badge ${statusClass}">${statusText}</span></div><div class="row-actions"><button class="ghost" data-action="toggle-alert" data-id="${alert.id}">${alert.enabled && !alert.triggered ? '暂停' : '重新启用'}</button><button class="danger compact-danger" data-action="delete-alert" data-id="${alert.id}">删除</button></div>`;
    el.alertList.appendChild(card);
  });
}
function renderAlertSymbolOptions(preselect) {
  el.alertSymbol.innerHTML = symbols.map(s => `<option value="${s}">${s}</option>`).join('');
  if (preselect && symbols.includes(preselect)) el.alertSymbol.value = preselect;
}
function setConnection(state, text) { el.connectionStatus.className = `status-pill ${state}`; el.connectionStatus.querySelector('span:last-child').textContent = text; }
function closeSockets() {
  for (const key of ['spot','futures']) {
    const ws = sockets[key];
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
    sockets[key] = null;
  }
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectSocket, 3000);
}
function handleTicker(data, market) {
  const symbol = data?.s;
  if (!symbol || !symbols.includes(symbol) || markets[symbol] !== market) return;
  const price = Number(data.c), open = Number(data.o);
  if (!Number.isFinite(price)) return;
  prices[symbol] = { price, open, high:Number(data.h), low:Number(data.l), changePct:open ? ((price-open)/open)*100 : 0, updatedAt:Date.now(), market };
  renderPrices(); renderAlerts(); checkAlerts(symbol, price);
}
function openMarketSocket(market, marketSymbols) {
  if (!marketSymbols.length) return;
  const streams = marketSymbols.map(s=>`${s.toLowerCase()}@miniTicker`).join('/');
  const url = market === 'spot'
    ? `wss://stream.binance.com:9443/stream?streams=${streams}`
    : `wss://fstream.binance.com/stream?streams=${streams}`;
  const ws = new WebSocket(url); sockets[market] = ws;
  ws.onopen = () => setConnection('online','实时');
  ws.onmessage = event => { try { const msg=JSON.parse(event.data), data=msg.data||msg; handleTicker(data,market); } catch(e) { console.warn('Ticker parse error',market,e); } };
  ws.onerror = () => setConnection('offline','连接异常');
  ws.onclose = () => scheduleReconnect();
}
function stopBackendQuotePolling() {
  clearTimeout(quotePollTimer);
  quotePollTimer = null;
  quotePollBusy = false;
}
function scheduleBackendQuotePoll(delay=2000) {
  clearTimeout(quotePollTimer);
  if (document.visibilityState === 'hidden') return;
  quotePollTimer = setTimeout(pollBackendQuotes, delay);
}
function applyBackendQuotes(quotes) {
  let got = 0;
  let marketChanged = false;
  for (const symbol of symbols) {
    const q = quotes?.[symbol];
    const price = Number(q?.price);
    if (!Number.isFinite(price)) continue;
    const market = q.market === 'futures' ? 'futures' : 'spot';
    if (markets[symbol] !== market) { markets[symbol] = market; marketChanged = true; }
    prices[symbol] = {
      price,
      open:Number(q.open), high:Number(q.high), low:Number(q.low),
      changePct:Number(q.changePct)||0,
      updatedAt:Date.now(), market
    };
    got += 1;
    checkAlerts(symbol, price);
  }
  if (marketChanged) saveState(false);
  renderPrices(); renderAlerts();
  return got;
}
async function pollBackendQuotes() {
  if (quotePollBusy) return;
  const cfg = backendConfig();
  if (!cfg.url || !cfg.token || !symbols.length) return;
  quotePollBusy = true;
  try {
    const quotes = await fetchBackendQuotes(symbols);
    const got = applyBackendQuotes(quotes);
    setConnection(got ? 'online' : 'offline', got ? 'Cloudflare 实时' : '等待行情');
  } catch (e) {
    console.warn('Cloudflare quote polling failed', e);
    setConnection('offline','中转异常');
  } finally {
    quotePollBusy = false;
    scheduleBackendQuotePoll(2000);
  }
}
async function connectDirectSocket() {
  setConnection('','识别市场');
  await resolveMarkets();
  const spot = symbols.filter(s=>markets[s]==='spot');
  const futures = symbols.filter(s=>markets[s]==='futures');
  const unresolved = symbols.filter(s=>!markets[s]);
  if (!spot.length && !futures.length) { setConnection('offline', unresolved.length ? '市场未识别' : '无交易对'); return; }
  setConnection('','连接中');
  openMarketSocket('spot', spot);
  openMarketSocket('futures', futures);
}
async function connectSocket() {
  clearTimeout(reconnectTimer);
  stopBackendQuotePolling();
  closeSockets();
  if (!symbols.length) { setConnection('offline','无交易对'); return; }

  // 后台配置存在时，前台行情也通过 Cloudflare 中转。
  // 这样所在网络无法直接访问 Binance 时，仍能看到约 2 秒级更新。
  const cfg = backendConfig();
  if (cfg.url && cfg.token) {
    setConnection('','连接 Cloudflare');
    await pollBackendQuotes();
    return;
  }
  await connectDirectSocket();
}

function checkAlerts(symbol, price) {
  let changed = false;
  alerts.forEach(alert => {
    if (alert.symbol !== symbol || !alert.enabled || alert.triggered) return;
    const hit = alert.direction === 'above' ? price >= alert.target : price <= alert.target;
    if (!hit) return;
    alert.triggered = true; alert.enabled = false; alert.triggeredAt = Date.now(); changed = true; fireAlert(alert, price);
  });
  if (changed) { saveState(true); renderAlerts(); }
}
function fireAlert(alert, currentPrice) {
  const sign = alert.direction === 'above' ? '≥' : '≤';
  const title = `${alert.symbol} 价格提醒`, body = `当前 $${formatPrice(currentPrice)}，已达到 ${sign} $${formatPrice(alert.target)}`;
  showToast(`${title}：${body}`); if (el.soundToggle.checked) playBeep();
  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) navigator.serviceWorker.ready.then(reg => reg.showNotification(title,{body,icon:'./icons/icon-192.png',tag:`pricewatch-${alert.id}`,data:{url:location.origin}})).catch(console.warn);
  if (navigator.vibrate) navigator.vibrate([120,80,120]);
}
function playBeep() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); const osc=audioCtx.createOscillator(), gain=audioCtx.createGain(); osc.frequency.value=880; gain.gain.setValueAtTime(.001,audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(.18,audioCtx.currentTime+.02); gain.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.45); osc.connect(gain).connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime+.48); } catch(e){console.warn(e);} }
function showToast(message, actionLabel='', actionFn=null, duration=3600) {
  clearTimeout(toastTimer);
  el.toast.innerHTML = '';
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  el.toast.appendChild(text);
  if (actionLabel && actionFn) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      clearTimeout(toastTimer);
      actionFn();
      el.toast.classList.remove('show');
    }, { once:true });
    el.toast.appendChild(action);
  }
  el.toast.classList.add('show');
  toastTimer=setTimeout(()=>el.toast.classList.remove('show'),duration);
}
function offerUndo(message, fn) {
  clearTimeout(undoTimer);
  undoAction = fn;
  showToast(message, '撤销', () => {
    const action = undoAction;
    undoAction = null;
    clearTimeout(undoTimer);
    if (action) action();
  }, 6000);
  undoTimer = setTimeout(() => { undoAction = null; }, 6000);
}


async function backendFetch(path, options={}) {
  const cfg = backendConfig(); if (!cfg.url || !cfg.token) throw new Error('后台尚未配置');
  const headers = { 'Content-Type':'application/json', 'X-Price-Watch-Token':cfg.token, ...(options.headers||{}) };
  const res = await fetch(`${cfg.url}${path}`, {...options, headers});
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `后台请求失败 ${res.status}`);
  return data;
}
async function fetchBackendQuotes(symbolList=symbols) {
  const list=[...new Set((symbolList||[]).map(normalizeSymbol).filter(Boolean))].slice(0,30);
  if(!list.length) return {};
  const data=await backendFetch('/api/quotes',{method:'POST',body:JSON.stringify({symbols:list})});
  return data.quotes||{};
}
function base64UrlToUint8Array(value) {
  const clean=String(value||'').trim();
  const padding='='.repeat((4-clean.length%4)%4), base64=(clean+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64), out=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i);
  if(out.length!==65 || out[0]!==4) throw new Error(`VAPID 公钥格式异常（${out.length} bytes）`);
  return out;
}
function arrayBufferToBase64Url(buf){
  if(!buf) return '';
  const bytes=new Uint8Array(buf); let bin=''; for(const b of bytes) bin+=String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function getPushSubscription(createIfMissing=false) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('当前环境不支持 Web Push');
  const reg=await navigator.serviceWorker.ready; let sub=await reg.pushManager.getSubscription();
  if(sub && createIfMissing){
    const existing=arrayBufferToBase64Url(sub.options?.applicationServerKey);
    if(existing && existing!==VAPID_PUBLIC_KEY){ await sub.unsubscribe(); sub=null; }
  }
  if (!sub && createIfMissing) {
    if (!('Notification' in window)) throw new Error('当前环境不支持通知');
    if (Notification.permission !== 'granted') { const p=await Notification.requestPermission(); if(p!=='granted') throw new Error('通知权限未开启'); }
    const key=base64UrlToUint8Array(VAPID_PUBLIC_KEY);
    sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  }
  return sub;
}
async function registerBackend(createSubscription=false) {
  const sub=await getPushSubscription(createSubscription); if(!sub) throw new Error('还没有 Web Push 订阅，请点“设置后台”');
  await backendFetch('/api/register',{method:'POST',body:JSON.stringify({clientId:getClientId(),subscription:sub.toJSON?sub.toJSON():sub,alerts,appUrl:location.origin})});
  const status=await backendFetch(`/api/status?clientId=${encodeURIComponent(getClientId())}`);
  if(!status.registered) throw new Error('Web Push 订阅未写入后台');
  return status;
}
function scheduleBackendSync() {
  clearTimeout(backendSyncTimer); const cfg=backendConfig(); if(!cfg.url||!cfg.token) return;
  backendSyncTimer=setTimeout(async()=>{ try { const sub=await getPushSubscription(false); if(sub) await backendFetch('/api/alerts',{method:'POST',body:JSON.stringify({clientId:getClientId(),alerts,appUrl:location.origin})}); } catch(e){ console.warn('Backend sync failed',e); } },500);
}
async function pullBackendState() {
  const data = await backendFetch(`/api/state?clientId=${encodeURIComponent(getClientId())}`);
  if (!Array.isArray(data.alerts)) return;
  const remote = new Map(data.alerts.map(a=>[a.id,a])); let changed=false;
  alerts = alerts.map(a=>{ const r=remote.get(a.id); if(!r) return a; if(Boolean(a.triggered)!==Boolean(r.triggered) || Boolean(a.enabled)!==Boolean(r.enabled) || a.triggeredAt!==r.triggeredAt){ changed=true; return {...a,triggered:Boolean(r.triggered),enabled:Boolean(r.enabled),triggeredAt:r.triggeredAt||a.triggeredAt}; } return a; });
  if(changed){ saveState(false); renderAlerts(); }
}
function setBackendUI(state,text) {
  el.backendHint.textContent=text; el.backendHint.className = state==='good'?'backend-good':state==='bad'?'backend-bad':'backend-warn';
  el.backendBtn.textContent = state==='good' ? '已连接' : '设置后台'; el.backendTestRow.hidden = state!=='good';
}
async function refreshBackendStatus() {
  const cfg=backendConfig(); if(!cfg.url||!cfg.token){ setBackendUI('warn','未配置，前台提醒仍可正常使用'); return; }
  try {
    await backendFetch('/health');
    let sub=await getPushSubscription(false);
    if(!sub && 'Notification' in window && Notification.permission==='granted') {
      try { await registerBackend(true); sub=await getPushSubscription(false); } catch(e) { console.warn('Auto push restore failed',e); }
    }
    if(!sub){ setBackendUI('warn','后台地址已保存，点“设置后台”完成推送订阅'); return; }
    await registerBackend(false); await pullBackendState(); setBackendUI('good','已连接，后台约每 1 分钟检查一次');
  } catch(e){ setBackendUI('bad',e.message||'后台连接失败'); }
}

el.addSymbolBtn.addEventListener('click',()=>{ el.symbolInput.value=''; el.symbolDialog.showModal(); setTimeout(()=>el.symbolInput.focus(),80); });
el.symbolForm.addEventListener('submit',async event=>{
  const submitter=event.submitter;
  if(!submitter||submitter.value==='cancel') return;
  event.preventDefault();
  const symbol=normalizeSymbol(el.symbolInput.value);
  if(!symbol)return showToast('请输入交易对');
  if(symbols.includes(symbol))return showToast(`${symbol} 已经在列表里`);
  const oldText=submitter.textContent;
  submitter.disabled=true;
  submitter.textContent='识别市场…';
  try {
    const market=await detectMarket(symbol,true);
    symbols.push(symbol);
    saveState();
    renderPrices();
    renderAlertSymbolOptions();
    await connectSocket();
    el.symbolDialog.close();
    showToast(`已添加 ${symbol} · ${market==='spot'?'Spot':'USDⓈ-M Futures'}`);
  } catch(e) {
    if (e?.code === 'MARKET_PENDING') {
      symbols.push(symbol);
      delete markets[symbol];
      saveState();
      renderPrices();
      renderAlertSymbolOptions();
      connectSocket();
      el.symbolDialog.close();
      showToast(`已添加 ${symbol}，市场待识别；网络恢复后会自动重试`, '', null, 4800);
    } else {
      showToast(e.message||'无法添加交易对');
    }
  } finally {
    submitter.disabled=false;
    submitter.textContent=oldText;
  }
});
el.addAlertBtn.addEventListener('click',()=>{ if(!symbols.length)return showToast('请先添加至少一个交易对'); renderAlertSymbolOptions(); el.alertPrice.value=''; el.alertDirection.value='above'; el.alertDialog.showModal(); });
el.alertForm.addEventListener('submit',event=>{ const submitter=event.submitter; if(!submitter||submitter.value==='cancel')return; event.preventDefault(); const target=Number(el.alertPrice.value); if(!Number.isFinite(target)||target<=0)return showToast('请输入有效目标价格'); alerts.unshift({id:crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`,symbol:el.alertSymbol.value,direction:el.alertDirection.value,target,enabled:true,triggered:false,createdAt:Date.now()}); saveState(); renderAlerts(); el.alertDialog.close(); showToast('提醒已保存'); });
el.priceList.addEventListener('click',event=>{
  const btn=event.target.closest('button');
  if(!btn)return;
  const symbol=btn.dataset.symbol;
  if(btn.dataset.action==='remove-symbol'){
    const symbolIndex=symbols.indexOf(symbol);
    const removedMarket=markets[symbol];
    const removedPrice=prices[symbol];
    const removedAlerts=alerts.map((a,index)=>({a,index})).filter(x=>x.a.symbol===symbol);
    symbols=symbols.filter(s=>s!==symbol);
    alerts=alerts.filter(a=>a.symbol!==symbol);
    delete prices[symbol];
    delete markets[symbol];
    saveState();
    renderPrices(); renderAlerts(); renderAlertSymbolOptions(); connectSocket();
    offerUndo(`已移除 ${symbol}`, ()=>{
      if(!symbols.includes(symbol)) symbols.splice(Math.max(0, symbolIndex),0,symbol);
      if(removedMarket) markets[symbol]=removedMarket;
      if(removedPrice) prices[symbol]=removedPrice;
      removedAlerts.sort((x,y)=>x.index-y.index).forEach(({a,index})=>{
        if(!alerts.some(existing=>existing.id===a.id)) alerts.splice(Math.min(index,alerts.length),0,a);
      });
      saveState(); renderPrices(); renderAlerts(); renderAlertSymbolOptions(); connectSocket();
      showToast(`已恢复 ${symbol}`);
    });
  }
  if(btn.dataset.action==='quick-alert'){
    renderAlertSymbolOptions(symbol);
    const current=prices[symbol]?.price;
    el.alertPrice.value=current?String(current):'';
    el.alertDirection.value='above';
    el.alertDialog.showModal();
  }
});
el.alertList.addEventListener('click',event=>{
  const btn=event.target.closest('button');
  if(!btn)return;
  const id=btn.dataset.id, alert=alerts.find(a=>a.id===id);
  if(btn.dataset.action==='delete-alert' && alert){
    const index=alerts.findIndex(a=>a.id===id);
    const snapshot={...alert};
    alerts=alerts.filter(a=>a.id!==id);
    saveState(); renderAlerts();
    offerUndo(`已删除 ${snapshot.symbol} 提醒`, ()=>{
      if(!alerts.some(a=>a.id===snapshot.id)) alerts.splice(Math.max(0,Math.min(index,alerts.length)),0,snapshot);
      saveState(); renderAlerts();
      showToast('提醒已恢复');
    });
    return;
  }
  if(btn.dataset.action==='toggle-alert'&&alert){
    const shouldEnable=alert.triggered||!alert.enabled;
    alert.enabled=shouldEnable;
    if(shouldEnable){ alert.triggered=false; delete alert.triggeredAt; }
    saveState(); renderAlerts();
  }
});
async function updateNotificationUI(){ if(!('Notification' in window)){el.notificationBtn.disabled=true;el.notificationBtn.textContent='不支持';el.notificationHint.textContent='当前环境不支持 Notification API';return;} const p=Notification.permission; if(p==='granted'){el.notificationBtn.textContent='已开启';el.notificationHint.textContent='前台与 Web Push 都可使用';} else if(p==='denied'){el.notificationBtn.textContent='已拒绝';el.notificationHint.textContent='请到系统通知设置中重新授权';} else {el.notificationBtn.textContent='开启通知';el.notificationHint.textContent='需要你主动授权';}}
el.notificationBtn.addEventListener('click',async()=>{ if(!('Notification' in window))return; try{const result=await Notification.requestPermission();await updateNotificationUI();if(result==='granted'){showToast('通知已开启');playBeep();}}catch{showToast('通知授权失败');} });
el.soundToggle.checked=localStorage.getItem(STORAGE.sound)!=='0'; el.soundToggle.addEventListener('change',()=>{localStorage.setItem(STORAGE.sound,el.soundToggle.checked?'1':'0');if(el.soundToggle.checked)playBeep();});

el.backendBtn.addEventListener('click',()=>{ const cfg=backendConfig(); el.backendUrlInput.value=cfg.url; el.backendTokenInput.value=cfg.token; el.backendDialog.showModal(); });
el.backendForm.addEventListener('submit',async event=>{ const submitter=event.submitter; if(!submitter||submitter.value==='cancel')return; event.preventDefault(); const url=el.backendUrlInput.value.trim().replace(/\/+$/,''); const token=el.backendTokenInput.value.trim(); if(!/^https:\/\//i.test(url))return showToast('Worker 地址需要以 https:// 开头'); if(!token)return showToast('请输入后台密钥'); localStorage.setItem(STORAGE.backendUrl,url);localStorage.setItem(STORAGE.backendToken,token); setBackendUI('warn','正在连接…'); try{await registerBackend(true); await pullBackendState(); el.backendDialog.close(); setBackendUI('good','已连接，后台约每 1 分钟检查一次'); await connectSocket(); showToast('后台锁屏提醒已开启');}catch(e){setBackendUI('bad',e.message||'连接失败');showToast(e.message||'后台连接失败');} });
el.backendTestBtn.addEventListener('click',async()=>{ try{el.backendTestBtn.disabled=true;await backendFetch('/api/test',{method:'POST',body:JSON.stringify({clientId:getClientId()})});showToast('测试推送已发送');}catch(e){showToast(e.message||'测试失败');}finally{el.backendTestBtn.disabled=false;} });

window.addEventListener('online',()=>{connectSocket();refreshBackendStatus();}); window.addEventListener('offline',()=>setConnection('offline','离线'));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){const cfg=backendConfig();const active=Object.values(sockets).some(ws=>ws&&ws.readyState===1);if((cfg.url&&cfg.token)||!active)connectSocket();refreshBackendStatus();}else{stopBackendQuotePolling();}});
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').then(()=>refreshBackendStatus()).catch(console.warn));

renderPrices(); renderAlerts(); renderAlertSymbolOptions(); updateNotificationUI(); connectSocket(); getClientId();
