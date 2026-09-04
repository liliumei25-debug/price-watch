const STORAGE = {
  symbols: 'pricewatch_symbols_v1',
  alerts: 'pricewatch_alerts_v1',
  sound: 'pricewatch_sound_v1',
  backendUrl: 'pricewatch_backend_url_v2',
  backendToken: 'pricewatch_backend_token_v2',
  clientId: 'pricewatch_client_id_v2',
  markets: 'pricewatch_markets_v3',
  expandedCharts: 'pricewatch_expanded_charts_v1',
  chartIntervals: 'pricewatch_chart_intervals_v1'
};

const VAPID_PUBLIC_KEY = 'BDOPB7t_5ss8hWCqrcCZO-fj3CM87At5ytLrA-dcek75GptW7kg-ZD3XC2i9vMHeMN2f3jQ_0FC2bMajAG-NzrE';
const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
// Binance TradFi USDⓈ-M perpetuals that should be treated as futures even when REST market detection is unavailable.
const KNOWN_FUTURES_SYMBOLS = new Set(['XAUUSDT', 'XAGUSDT', 'XPTUSDT', 'XPDUSDT', 'COPPERUSDT']);
const TRADFI_SYMBOLS = new Set(['XAUUSDT', 'XAGUSDT', 'XPTUSDT', 'XPDUSDT', 'COPPERUSDT']);
let symbols = loadJSON(STORAGE.symbols, DEFAULT_SYMBOLS);
let alerts = loadJSON(STORAGE.alerts, []);
let markets = loadJSON(STORAGE.markets, {});
let prices = {};
let sockets = { spot: null, futures: null, tradfi: null, tradfiStats: null };
let reconnectTimer = null;
let toastTimer = null;
let audioCtx = null;
let backendSyncTimer = null;
let quotePollTimer = null;
let quotePollBusy = false;
let futuresRestTimer = null;
let futuresRestBusy = false;
let undoTimer = null;
let undoAction = null;
let expandedCharts = new Set(loadJSON(STORAGE.expandedCharts, []));
let chartIntervals = loadJSON(STORAGE.chartIntervals, {});
const chartStates = new Map();
let chartRefreshTimer = null;

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
  if (markets[symbol] === 'futures') return TRADFI_SYMBOLS.has(symbol) ? 'Binance TradFi Futures' : 'Binance USDⓈ-M Futures';
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

  // Gold/silver/copper TradFi perps are known USDⓈ-M Futures symbols.
  // This prevents a temporary REST/network failure from leaving them permanently 'unrecognized'.
  if (KNOWN_FUTURES_SYMBOLS.has(symbol)) {
    markets[symbol] = 'futures';
    saveState(false);
    return 'futures';
  }

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

function migrateLegacySymbols() {
  // Older builds could save a bare symbol such as 'ETH'. Normalize existing local data once on startup.
  const normalizedSymbols = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
  const normalizedMarkets = {};
  for (const [key, value] of Object.entries(markets || {})) {
    const normalized = normalizeSymbol(key);
    if (normalized && (value === 'spot' || value === 'futures')) normalizedMarkets[normalized] = value;
  }
  alerts = (alerts || []).map(a => ({...a, symbol: normalizeSymbol(a.symbol)})).filter(a => a.symbol);
  symbols = normalizedSymbols;
  markets = normalizedMarkets;
  // Known TradFi symbols should always be marked futures locally.
  for (const symbol of symbols) if (KNOWN_FUTURES_SYMBOLS.has(symbol)) markets[symbol] = 'futures';
  localStorage.setItem(STORAGE.symbols, JSON.stringify(symbols));
  localStorage.setItem(STORAGE.alerts, JSON.stringify(alerts));
  localStorage.setItem(STORAGE.markets, JSON.stringify(markets));
}
migrateLegacySymbols();
expandedCharts = new Set([...expandedCharts].filter(symbol => symbols.includes(symbol)));
saveExpandedCharts();
function formatPrice(n) {
  const value = Number(n); if (!Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 5 : 8;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: value >= 1000 ? 2 : 0 });
}
function saveExpandedCharts() {
  localStorage.setItem(STORAGE.expandedCharts, JSON.stringify([...expandedCharts]));
}
const CHART_INTERVALS = ['5m','15m','30m','1h','2h','4h','1d'];
const CHART_INTERVAL_LABELS = {'5m':'5m','15m':'15m','30m':'30m','1h':'1H','2h':'2H','4h':'4H','1d':'1D'};
const CHART_LIMIT = 260;

function chartIntervalFor(symbol) {
  const saved = chartIntervals?.[symbol];
  return CHART_INTERVALS.includes(saved) ? saved : '1h';
}
function saveChartIntervals() {
  localStorage.setItem(STORAGE.chartIntervals, JSON.stringify(chartIntervals));
}
function intervalMs(interval) {
  return ({'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'1d':86400000})[interval] || 3600000;
}
function chartButtonsHtml(symbol) {
  return CHART_INTERVALS.map(i=>`<button type="button" class="chart-interval" data-action="chart-interval" data-symbol="${symbol}" data-interval="${i}">${CHART_INTERVAL_LABELS[i]}</button>`).join('');
}
function normalizeKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    if (Array.isArray(row)) return {time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5])||0,closeTime:Number(row[6])||0};
    return {time:Number(row?.time ?? row?.openTime),open:Number(row?.open),high:Number(row?.high),low:Number(row?.low),close:Number(row?.close),volume:Number(row?.volume)||0,closeTime:Number(row?.closeTime)||0};
  }).filter(k=>Number.isFinite(k.time)&&Number.isFinite(k.open)&&Number.isFinite(k.high)&&Number.isFinite(k.low)&&Number.isFinite(k.close)).sort((a,b)=>a.time-b.time);
}
async function fetchDirectKlines(symbol, interval, limit=CHART_LIMIT) {
  const market = markets[symbol] || (KNOWN_FUTURES_SYMBOLS.has(symbol) ? 'futures' : 'spot');
  const encoded = encodeURIComponent(symbol);
  const common = `interval=${encodeURIComponent(interval)}&limit=${Math.max(50,Math.min(500,Number(limit)||CHART_LIMIT))}`;
  const urls = [];
  if (market === 'spot') {
    urls.push(
      `https://data-api.binance.vision/api/v3/klines?symbol=${encoded}&${common}`,
      `https://api.binance.com/api/v3/klines?symbol=${encoded}&${common}`
    );
  } else {
    urls.push(
      `https://www.binance.com/fapi/v1/klines?symbol=${encoded}&${common}`,
      `https://fapi.binance.com/fapi/v1/klines?symbol=${encoded}&${common}`,
      `https://www.binance.com/fapi/v1/continuousKlines?pair=${encoded}&contractType=PERPETUAL&${common}`,
      `https://fapi.binance.com/fapi/v1/continuousKlines?pair=${encoded}&contractType=PERPETUAL&${common}`
    );
  }
  let lastError = null;
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, 9000);
      if (!r.ok) { lastError = new Error(`HTTP ${r.status}`); continue; }
      const rows = normalizeKlines(await r.json());
      if (rows.length) return rows;
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('无法取得 K 线数据');
}
async function fetchChartKlines(symbol, interval, limit=CHART_LIMIT) {
  const cfg = backendConfig();
  if (cfg.url && cfg.token) {
    try {
      const data = await backendFetch('/api/klines', {method:'POST', body:JSON.stringify({symbol,market:markets[symbol]||'',interval,limit})});
      const rows = normalizeKlines(data.klines);
      if (rows.length) return rows;
    } catch (e) {
      console.warn('Backend kline route unavailable, trying direct Binance', symbol, interval, e);
    }
  }
  return fetchDirectKlines(symbol, interval, limit);
}
function cleanupChartState(symbol) {
  const state = chartStates.get(symbol);
  if (!state) return;
  try { state.resizeObserver?.disconnect(); } catch {}
  chartStates.delete(symbol);
}
function ensureChartState(symbol, card) {
  let state = chartStates.get(symbol);
  const canvas = card.querySelector('[data-role="kline-canvas"]');
  if (state && state.canvas === canvas) return state;
  if (state) cleanupChartState(symbol);
  state = {
    symbol, card, canvas, ctx:canvas.getContext('2d'), data:[], interval:chartIntervalFor(symbol),
    visibleCount:80, rightOffset:0, hoverIndex:null, hoverY:null, loading:false, requestId:0, drawPending:false,
    pointers:new Map(), dragStartX:0, dragStartOffset:0, pinchStartDistance:0, pinchStartCount:80
  };
  const draw = ()=>drawKlineChart(state);
  if ('ResizeObserver' in window) {
    state.resizeObserver = new ResizeObserver(draw);
    state.resizeObserver.observe(canvas.parentElement);
  } else window.addEventListener('resize', draw);

  canvas.addEventListener('wheel', e=>{
    e.preventDefault();
    const delta = e.deltaY > 0 ? 10 : -10;
    state.visibleCount = Math.max(20, Math.min(Math.min(180,state.data.length||180), state.visibleCount + delta));
    state.rightOffset = Math.min(state.rightOffset, Math.max(0,(state.data.length||0)-state.visibleCount));
    draw();
  }, {passive:false});
  canvas.addEventListener('pointerdown', e=>{
    canvas.setPointerCapture?.(e.pointerId);
    state.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if (state.pointers.size === 1) {
      state.dragStartX=e.clientX; state.dragStartOffset=state.rightOffset;
    } else if (state.pointers.size === 2) {
      const pts=[...state.pointers.values()];
      state.pinchStartDistance=Math.max(1,Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y));
      state.pinchStartCount=state.visibleCount;
    }
  });
  canvas.addEventListener('pointermove', e=>{
    const rect=canvas.getBoundingClientRect();
    state.hoverY=e.clientY-rect.top;
    if (state.pointers.has(e.pointerId)) state.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if (state.pointers.size >= 2) {
      const pts=[...state.pointers.values()];
      const d=Math.max(1,Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y));
      const ratio=state.pinchStartDistance/d;
      state.visibleCount=Math.max(20,Math.min(Math.min(180,state.data.length||180),Math.round(state.pinchStartCount*ratio)));
      state.rightOffset=Math.min(state.rightOffset,Math.max(0,(state.data.length||0)-state.visibleCount));
    } else if (state.pointers.size === 1 && state.data.length) {
      const plotW=Math.max(80,rect.width-76);
      const candleW=plotW/Math.max(1,state.visibleCount);
      const shift=Math.round((e.clientX-state.dragStartX)/Math.max(2,candleW));
      state.rightOffset=Math.max(0,Math.min(Math.max(0,state.data.length-state.visibleCount),state.dragStartOffset+shift));
    }
    updateHoverIndex(state,e.clientX-rect.left);
    draw();
  });
  const endPointer=e=>{ state.pointers.delete(e.pointerId); if(!state.pointers.size){state.dragStartX=0;} };
  canvas.addEventListener('pointerup',endPointer);
  canvas.addEventListener('pointercancel',endPointer);
  canvas.addEventListener('pointerleave',e=>{ if(!state.pointers.size){state.hoverIndex=null; state.hoverY=null; draw();} });
  return state;
}
function visibleSlice(state) {
  const n=state.data.length;
  const count=Math.max(1,Math.min(state.visibleCount,n||1));
  const end=Math.max(count, n-state.rightOffset);
  const start=Math.max(0,end-count);
  return {rows:state.data.slice(start,end),start,end};
}
function updateHoverIndex(state, x) {
  if (!state.data.length) { state.hoverIndex=null; return; }
  const {rows,start}=visibleSlice(state);
  const rect=state.canvas.getBoundingClientRect();
  const left=8, right=68, plotW=Math.max(1,rect.width-left-right);
  if (x < left || x > left+plotW) { state.hoverIndex=null; return; }
  const idx=Math.max(0,Math.min(rows.length-1,Math.floor((x-left)/plotW*rows.length)));
  state.hoverIndex=start+idx;
}
function formatAxisPrice(n, range) {
  if (!Number.isFinite(n)) return '';
  const abs=Math.abs(n);
  let digits=2;
  if (abs<1) digits=5; else if (abs<100) digits=3; else if (range<5) digits=3;
  return n.toLocaleString('en-US',{maximumFractionDigits:digits,minimumFractionDigits:0});
}
function formatChartTime(ms, interval) {
  const d=new Date(ms);
  if (interval==='1d') return new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric'}).format(d);
  return new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);
}
function drawKlineChart(state) {
  const canvas=state.canvas;
  if (!canvas || !canvas.isConnected) return;
  const rect=canvas.getBoundingClientRect();
  const cssW=Math.max(280,Math.floor(rect.width)), cssH=Math.max(260,Math.floor(rect.height));
  const dpr=Math.min(2,window.devicePixelRatio||1);
  if(canvas.width!==Math.round(cssW*dpr)||canvas.height!==Math.round(cssH*dpr)){canvas.width=Math.round(cssW*dpr);canvas.height=Math.round(cssH*dpr);}
  const ctx=state.ctx; ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,cssW,cssH);
  ctx.fillStyle='#0b0d12'; ctx.fillRect(0,0,cssW,cssH);
  const left=8,right=68,top=20,bottom=30,plotW=cssW-left-right,plotH=cssH-top-bottom;
  ctx.strokeStyle='rgba(143,151,168,.13)';ctx.lineWidth=1;
  for(let i=0;i<=5;i++){const y=top+plotH*i/5;ctx.beginPath();ctx.moveTo(left,y+.5);ctx.lineTo(left+plotW,y+.5);ctx.stroke();}
  for(let i=0;i<=5;i++){const x=left+plotW*i/5;ctx.beginPath();ctx.moveTo(x+.5,top);ctx.lineTo(x+.5,top+plotH);ctx.stroke();}
  const {rows,start}=visibleSlice(state);
  if (!rows.length) return;
  let min=Math.min(...rows.map(k=>k.low)), max=Math.max(...rows.map(k=>k.high));
  let range=Math.max(1e-9,max-min); const pad=range*.07; min-=pad; max+=pad; range=max-min;
  const yOf=p=>top+(max-p)/range*plotH;
  ctx.font='11px -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillStyle='#8f97a8';
  for(let i=0;i<=5;i++){const p=max-range*i/5;const y=top+plotH*i/5;ctx.fillText(formatAxisPrice(p,range),left+plotW+7,y);}
  const step=plotW/rows.length, bodyW=Math.max(1,Math.min(12,step*.68));
  rows.forEach((k,i)=>{
    const x=left+step*(i+.5), yo=yOf(k.open), yc=yOf(k.close), yh=yOf(k.high), yl=yOf(k.low);
    const up=k.close>=k.open, color=up?'#34c759':'#ff453a';ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x,yh);ctx.lineTo(x,yl);ctx.stroke();
    const y=Math.min(yo,yc), h=Math.max(1,Math.abs(yc-yo));ctx.fillRect(x-bodyW/2,y,bodyW,h);
  });
  ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle='#8f97a8';
  const marks=[0,.25,.5,.75,1];
  marks.forEach(frac=>{const i=Math.min(rows.length-1,Math.round((rows.length-1)*frac));const x=left+step*(i+.5);ctx.fillText(formatChartTime(rows[i].time,state.interval),x,top+plotH+8);});
  if (state.hoverIndex!=null && state.hoverIndex>=start && state.hoverIndex<start+rows.length) {
    const local=state.hoverIndex-start,k=state.data[state.hoverIndex],x=left+step*(local+.5);const y=Math.max(top,Math.min(top+plotH,state.hoverY??yOf(k.close)));
    ctx.strokeStyle='rgba(244,246,251,.42)';ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+plotH);ctx.moveTo(left,y);ctx.lineTo(left+plotW,y);ctx.stroke();ctx.setLineDash([]);
    const hover=state.card.querySelector('[data-role="chart-ohlc"]');
    if(hover) hover.textContent=`${formatChartTime(k.time,state.interval)}  O ${formatPrice(k.open)}  H ${formatPrice(k.high)}  L ${formatPrice(k.low)}  C ${formatPrice(k.close)}`;
  } else {
    const last=rows[rows.length-1]; const hover=state.card.querySelector('[data-role="chart-ohlc"]');
    if(hover) hover.textContent=`O ${formatPrice(last.open)}  H ${formatPrice(last.high)}  L ${formatPrice(last.low)}  C ${formatPrice(last.close)}`;
  }
}
async function loadKlineChart(symbol, card, {resetView=false,force=false}={}) {
  const state=ensureChartState(symbol,card); const interval=chartIntervalFor(symbol);
  if(!force && state.interval===interval && state.data.length)return;
  if(force && state.loading && state.interval===interval)return;
  const hadData=state.data.length>0;
  state.interval=interval; state.loading=true; const requestId=++state.requestId;
  const status=card.querySelector('[data-role="chart-status"]');
  if(status && (!hadData || resetView)){status.textContent=`正在加载 ${CHART_INTERVAL_LABELS[interval]} K线…`;status.className='chart-status loading';}
  try {
    const rows=await fetchChartKlines(symbol,interval,CHART_LIMIT); if(requestId!==state.requestId)return;
    state.data=rows; if(resetView||!state.visibleCount)state.visibleCount=Math.min(80,rows.length); else state.visibleCount=Math.max(20,Math.min(state.visibleCount,rows.length)); state.rightOffset=Math.min(state.rightOffset,Math.max(0,rows.length-state.visibleCount));
    if(status){status.textContent=`${CHART_INTERVAL_LABELS[interval]} · ${rows.length} 根 · 拖动平移 / 双指或滚轮缩放`;status.className='chart-status';}
    drawKlineChart(state);
  } catch(e) {
    console.warn('Kline load failed',symbol,interval,e);
    if(status){status.textContent='K线加载失败。开 VPN 可直连；若想无 VPN 使用，请同时更新 v13 后端。';status.className='chart-status error';}
    drawKlineChart(state);
  } finally {if(requestId===state.requestId)state.loading=false;}
}
function scheduleChartDraw(state) {
  if (!state || state.drawPending) return;
  state.drawPending = true;
  requestAnimationFrame(() => {
    state.drawPending = false;
    drawKlineChart(state);
  });
}
function updateOpenChartLive(symbol) {
  const state=chartStates.get(symbol); const price=Number(prices[symbol]?.price);
  if(!state||!expandedCharts.has(symbol)||!state.data.length||!Number.isFinite(price))return;
  const bucket=Math.floor(Date.now()/intervalMs(state.interval))*intervalMs(state.interval),last=state.data[state.data.length-1];
  if(last.time===bucket){
    last.close=price;last.high=Math.max(last.high,price);last.low=Math.min(last.low,price);
    scheduleChartDraw(state);
  } else if (bucket > last.time) {
    state.data.push({time:bucket,open:last.close,high:price,low:price,close:price});
    if (state.data.length > CHART_LIMIT) state.data.shift();
    state.rightOffset = 0;
    scheduleChartDraw(state);
  }
}
function scheduleChartRefresh() {
  clearInterval(chartRefreshTimer);
  chartRefreshTimer=setInterval(()=>{
    if(document.visibilityState==='hidden')return;
    for(const symbol of expandedCharts){const card=el.priceList.querySelector(`[data-price-card-symbol="${CSS.escape(symbol)}"]`);if(card)loadKlineChart(symbol,card,{force:true}).catch(()=>{});}
  },30000);
}
function createPriceCard(symbol) {
  const card = document.createElement('article');
  card.className = 'price-card';
  card.dataset.priceCardSymbol = symbol;
  card.innerHTML = `<div class="price-main"><div><div class="symbol" data-role="symbol"></div><div class="pair-sub" data-role="market"></div></div><div><div class="price-value" data-role="price">—</div><div class="change" data-role="change">等待行情…</div></div></div><div class="row-actions price-actions"><button class="ghost chart-toggle" data-action="toggle-chart" data-symbol="${symbol}">展开图表</button><button class="ghost" data-action="quick-alert" data-symbol="${symbol}">设提醒</button><button class="danger compact-danger" data-action="remove-symbol" data-symbol="${symbol}">移除</button></div><div class="chart-wrap" data-role="chart-wrap" hidden><div class="chart-toolbar"><div class="chart-intervals">${chartButtonsHtml(symbol)}</div><div class="chart-tools"><button type="button" class="chart-tool" data-action="chart-zoom-in" data-symbol="${symbol}" aria-label="放大">＋</button><button type="button" class="chart-tool" data-action="chart-zoom-out" data-symbol="${symbol}" aria-label="缩小">－</button><button type="button" class="chart-tool reset" data-action="chart-reset" data-symbol="${symbol}">最新</button></div></div><div class="kline-shell"><canvas class="kline-canvas" data-role="kline-canvas" aria-label="${symbol} K线图"></canvas><div class="chart-ohlc" data-role="chart-ohlc"></div></div><div class="chart-status" data-role="chart-status">展开后加载 K 线</div></div>`;
  return card;
}
function updatePriceCard(card, symbol) {
  const data = prices[symbol], change = data?.changePct ?? null;
  const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
  const changeText = change == null ? '等待行情…' : `${change > 0 ? '+' : ''}${change.toFixed(2)}% · 24h`;
  card.querySelector('[data-role="symbol"]').textContent = symbol;
  card.querySelector('[data-role="market"]').textContent = marketLabel(symbol);
  card.querySelector('[data-role="price"]').textContent = data ? '$'+formatPrice(data.price) : '—';
  const changeEl = card.querySelector('[data-role="change"]');
  changeEl.className = `change ${changeClass}`.trim(); changeEl.textContent = changeText;
  const wrap = card.querySelector('[data-role="chart-wrap"]'), btn = card.querySelector('[data-action="toggle-chart"]'), open = expandedCharts.has(symbol);
  const wasHidden = wrap.hidden;
  wrap.hidden = !open; btn.textContent = open ? '收起图表' : '展开图表'; btn.setAttribute('aria-expanded', String(open));
  const interval=chartIntervalFor(symbol); card.querySelectorAll('[data-action="chart-interval"]').forEach(b=>b.classList.toggle('active',b.dataset.interval===interval));
  if (open) {
    const state=chartStates.get(symbol);
    if (!state || !state.data.length || state.interval!==interval) loadKlineChart(symbol,card).catch(()=>{});
    else if (wasHidden) scheduleChartDraw(state);
    updateOpenChartLive(symbol);
  }
}
function updateSinglePriceCard(symbol) {
  const card = el.priceList.querySelector(`[data-price-card-symbol="${CSS.escape(symbol)}"]`);
  if (!card) { renderPrices(); return; }
  updatePriceCard(card, symbol);
}
function renderPrices() {
  if (!symbols.length) {
    expandedCharts.clear(); saveExpandedCharts();
    el.priceList.innerHTML = '<div class="empty">还没有监控币种，点右上角添加。</div>';
    return;
  }
  el.priceList.querySelector('.empty')?.remove();
  for (const card of [...el.priceList.querySelectorAll('[data-price-card-symbol]')]) {
    if (!symbols.includes(card.dataset.priceCardSymbol)) { cleanupChartState(card.dataset.priceCardSymbol); card.remove(); }
  }
  symbols.forEach((symbol,index) => {
    let card = el.priceList.querySelector(`[data-price-card-symbol="${CSS.escape(symbol)}"]`);
    if (!card) {
      card = createPriceCard(symbol);
      const cards = [...el.priceList.querySelectorAll('[data-price-card-symbol]')];
      const target = cards[index] || null;
      if (target) el.priceList.insertBefore(card,target); else el.priceList.appendChild(card);
    }
    updatePriceCard(card, symbol);
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
  for (const key of Object.keys(sockets)) {
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
  updateSinglePriceCard(symbol); renderAlerts(); checkAlerts(symbol, price);
}
function openMarketSocket(market, marketSymbols, candidateIndex=0) {
  if (!marketSymbols.length) return;
  const streams = marketSymbols.map(s=>`${s.toLowerCase()}@${market==='futures'?'ticker':'miniTicker'}`).join('/');
  const urls = market === 'spot'
    ? [`wss://data-stream.binance.vision:443/stream?streams=${streams}`, `wss://stream.binance.com:443/stream?streams=${streams}`]
    : [
        // Current Binance ticker streams are documented under /market.
        `wss://fstream.binance.com/market/stream?streams=${streams}`,
        `wss://fstream.binance.com/public/stream?streams=${streams}`,
        `wss://fstream.binance.com/stream?streams=${streams}`
      ];
  const url = urls[Math.min(candidateIndex, urls.length-1)];
  const ws = new WebSocket(url); sockets[market] = ws;
  let gotTicker = false;
  let fallbackTimer = null;
  ws.onopen = () => {
    setConnection('online','实时');
    // If a route opens but never delivers a ticker, try the next documented route.
    fallbackTimer = setTimeout(() => {
      if (!gotTicker && candidateIndex + 1 < urls.length && sockets[market] === ws) {
        ws.onclose = null;
        try { ws.close(); } catch {}
        openMarketSocket(market, marketSymbols, candidateIndex + 1);
      }
    }, 4500);
  };
  ws.onmessage = event => {
    try {
      const msg=JSON.parse(event.data), data=msg.data||msg;
      const before=prices[data?.s]?.updatedAt||0;
      handleTicker(data,market);
      if ((prices[data?.s]?.updatedAt||0) > before) {
        gotTicker = true;
        clearTimeout(fallbackTimer);
      }
    } catch(e) { console.warn('Ticker parse error',market,e); }
  };
  ws.onerror = () => {
    const fresh = Object.values(prices).some(p=>p?.updatedAt && Date.now()-p.updatedAt<10000);
    if (!fresh) setConnection('offline','直连异常');
  };
  ws.onclose = () => {
    clearTimeout(fallbackTimer);
    if (!gotTicker && candidateIndex + 1 < urls.length) {
      setTimeout(() => openMarketSocket(market, marketSymbols, candidateIndex + 1), 250);
    } else {
      scheduleReconnect();
    }
  };
}

function handleTradFiKline(data) {
  const symbol = String(data?.ps || '').toUpperCase();
  const k = data?.k;
  if (!symbol || !k || !symbols.includes(symbol) || !TRADFI_SYMBOLS.has(symbol)) return;
  const price = Number(k.c);
  if (!Number.isFinite(price)) return;
  const prev = prices[symbol] || {};
  prices[symbol] = {
    price,
    open: Number.isFinite(Number(prev.open)) ? Number(prev.open) : Number(k.o),
    high: Number.isFinite(Number(prev.high)) ? Math.max(Number(prev.high), Number(k.h)||price) : Number(k.h)||price,
    low: Number.isFinite(Number(prev.low)) ? Math.min(Number(prev.low), Number(k.l)||price) : Number(k.l)||price,
    changePct: Number.isFinite(Number(prev.changePct)) ? Number(prev.changePct) : 0,
    updatedAt: Date.now(), market: 'futures'
  };
  updateSinglePriceCard(symbol); renderAlerts(); checkAlerts(symbol, price);
}
function openTradFiSocket(tradfiSymbols, candidateIndex=0) {
  if (!tradfiSymbols.length) return;
  const streams = tradfiSymbols.map(s => `${s.toLowerCase()}_tradifi_perpetual@continuousKline_1s`).join('/');
  const urls = [
    `wss://fstream.binance.com/market/stream?streams=${streams}`,
    `wss://fstream.binance.com/public/stream?streams=${streams}`
  ];
  const url = urls[Math.min(candidateIndex, urls.length-1)];
  const ws = new WebSocket(url); sockets.tradfi = ws;
  let got = false;
  let fallbackTimer = null;
  ws.onopen = () => {
    setConnection('online','实时');
    fallbackTimer = setTimeout(() => {
      if (!got && candidateIndex + 1 < urls.length && sockets.tradfi === ws) {
        ws.onclose = null;
        try { ws.close(); } catch {}
        openTradFiSocket(tradfiSymbols, candidateIndex + 1);
      }
    }, 5000);
  };
  ws.onmessage = event => {
    try {
      const msg = JSON.parse(event.data), data = msg.data || msg;
      const before = prices[String(data?.ps||'').toUpperCase()]?.updatedAt || 0;
      handleTradFiKline(data);
      const sym = String(data?.ps||'').toUpperCase();
      if ((prices[sym]?.updatedAt||0) > before) { got = true; clearTimeout(fallbackTimer); }
    } catch(e) { console.warn('TradFi kline parse error', e); }
  };
  ws.onerror = () => { if (!hasFreshPrice()) setConnection('offline','TradFi 直连异常'); };
  ws.onclose = () => {
    clearTimeout(fallbackTimer);
    if (!got && candidateIndex + 1 < urls.length) setTimeout(()=>openTradFiSocket(tradfiSymbols,candidateIndex+1),250);
    else scheduleReconnect();
  };
}

function openTradFiStatsSocket(tradfiSymbols) {
  if (!tradfiSymbols.length) return;
  const urls = [
    'wss://fstream.binance.com/market/ws/!ticker@arr',
    'wss://fstream.binance.com/public/ws/!ticker@arr'
  ];
  let candidateIndex = 0;
  const connect = () => {
    if (!tradfiSymbols.length) return;
    const ws = new WebSocket(urls[candidateIndex]);
    sockets.tradfiStats = ws;
    let got = false;
    let fallbackTimer = null;
    ws.onopen = () => {
      fallbackTimer = setTimeout(() => {
        if (!got && candidateIndex + 1 < urls.length && sockets.tradfiStats === ws) {
          ws.onclose = null;
          try { ws.close(); } catch {}
          candidateIndex += 1;
          connect();
        }
      }, 6000);
    };
    ws.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        const rows = Array.isArray(msg?.data) ? msg.data : Array.isArray(msg) ? msg : [];
        let changed = false;
        for (const row of rows) {
          const symbol = String(row?.ps || row?.s || '').toUpperCase();
          if (!tradfiSymbols.includes(symbol)) continue;
          const price = Number(row?.c), open = Number(row?.o), pct = Number(row?.P);
          if (!Number.isFinite(price)) continue;
          const prev = prices[symbol] || {};
          const changePct = Number.isFinite(pct) ? pct : (Number.isFinite(open) && open !== 0 ? ((price-open)/open)*100 : (Number(prev.changePct)||0));
          prices[symbol] = {
            ...prev,
            price: Number.isFinite(Number(prev.price)) ? Number(prev.price) : price,
            open: Number.isFinite(open) ? open : Number(prev.open),
            high: Number.isFinite(Number(row?.h)) ? Number(row.h) : Number(prev.high),
            low: Number.isFinite(Number(row?.l)) ? Number(row.l) : Number(prev.low),
            changePct,
            updatedAt: Math.max(Number(prev.updatedAt)||0, Date.now()),
            market: 'futures'
          };
          got = true;
          changed = true;
        }
        if (changed) {
          clearTimeout(fallbackTimer);
          for (const symbol of tradfiSymbols) updateSinglePriceCard(symbol);
          renderAlerts();
        }
      } catch (e) { console.warn('TradFi 24h ticker parse error', e); }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(fallbackTimer);
      if (!got && candidateIndex + 1 < urls.length) { candidateIndex += 1; setTimeout(connect, 300); }
    };
  };
  connect();
}

function stopFuturesRestFallback() {
  clearTimeout(futuresRestTimer);
  futuresRestTimer = null;
  futuresRestBusy = false;
}
function scheduleFuturesRestFallback(delay=2500) {
  clearTimeout(futuresRestTimer);
  if (document.visibilityState === 'hidden') return;
  futuresRestTimer = setTimeout(pollFuturesRestFallback, delay);
}
async function pollFuturesRestFallback() {
  if (futuresRestBusy) return;
  const list = symbols.filter(s => markets[s] === 'futures' && (!prices[s]?.updatedAt || Date.now()-prices[s].updatedAt > 5000));
  if (!list.length) { scheduleFuturesRestFallback(3000); return; }
  futuresRestBusy = true;
  try {
    const touched = [];
    for (const symbol of list) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(()=>controller.abort(), 4500);
        const bases = TRADFI_SYMBOLS.has(symbol) ? ['https://www.binance.com','https://fapi.binance.com'] : ['https://fapi.binance.com'];
        let d = null;
        for (const base of bases) {
          try {
            const res = await fetch(`${base}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {signal:controller.signal, cache:'no-store'});
            if (res.ok) { d = await res.json(); break; }
          } catch {}
        }
        clearTimeout(timer);
        if (!d) continue;
        const price=Number(d?.lastPrice), open=Number(d?.openPrice);
        if (!Number.isFinite(price)) continue;
        prices[symbol]={price,open,high:Number(d.highPrice),low:Number(d.lowPrice),changePct:Number(d.priceChangePercent)||0,updatedAt:Date.now(),market:'futures'};
        touched.push(symbol);
        checkAlerts(symbol,price);
      } catch (e) { console.warn('Futures REST fallback failed',symbol,e); }
    }
    for (const symbol of touched) updateSinglePriceCard(symbol);
    renderAlerts();
  } finally {
    futuresRestBusy = false;
    scheduleFuturesRestFallback(2500);
  }
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
  const touched = [];
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
    touched.push(symbol);
    checkAlerts(symbol, price);
  }
  if (marketChanged) saveState(false);
  for (const symbol of touched) updateSinglePriceCard(symbol);
  renderAlerts();
  return got;
}
function hasFreshPrice(maxAge=10000) {
  return symbols.some(symbol => prices[symbol]?.updatedAt && Date.now()-prices[symbol].updatedAt < maxAge);
}
async function pollBackendQuotes() {
  if (quotePollBusy) return;
  const cfg = backendConfig();
  if (!cfg.url || !cfg.token || !symbols.length) return;
  quotePollBusy = true;
  try {
    const quotes = await fetchBackendQuotes(symbols);
    const got = applyBackendQuotes(quotes);
    if (got) setConnection('online','Cloudflare 实时');
    else if (!hasFreshPrice()) setConnection('offline','中转暂无行情');
  } catch (e) {
    console.warn('Cloudflare quote polling failed', e);
    if (!hasFreshPrice()) setConnection('offline','中转异常');
  } finally {
    quotePollBusy = false;
    scheduleBackendQuotePoll(2000);
  }
}
async function connectDirectSocket(silent=false) {
  if (!silent) setConnection('','识别市场');
  await resolveMarkets();
  const spot = symbols.filter(s=>markets[s]==='spot');
  const tradfi = symbols.filter(s=>markets[s]==='futures' && TRADFI_SYMBOLS.has(s));
  const futures = symbols.filter(s=>markets[s]==='futures' && !TRADFI_SYMBOLS.has(s));
  const unresolved = symbols.filter(s=>!markets[s]);
  if (!spot.length && !futures.length && !tradfi.length) {
    if (!silent && !hasFreshPrice()) setConnection('offline', unresolved.length ? '市场未识别' : '无交易对');
    return;
  }
  if (!silent) setConnection('','连接中');
  openMarketSocket('spot', spot);
  openMarketSocket('futures', futures);
  openTradFiSocket(tradfi);
  openTradFiStatsSocket(tradfi);
}
async function connectSocket() {
  clearTimeout(reconnectTimer);
  stopBackendQuotePolling();
  stopFuturesRestFallback();
  closeSockets();
  if (!symbols.length) { setConnection('offline','无交易对'); return; }

  const cfg = backendConfig();
  if (cfg.url && cfg.token) {
    // 双通道：Cloudflare 中转 + Binance 公开行情直连同时尝试。
    // 中转失败时，有 VPN 的设备仍可自动退回直连，不会出现整页“等待行情”。
    setConnection('','连接行情');
    connectDirectSocket(true).catch(e=>console.warn('Direct fallback failed',e));
    pollBackendQuotes().catch(e=>console.warn('Cloudflare polling start failed',e));
    scheduleFuturesRestFallback(3500);
    return;
  }
  await connectDirectSocket();
  scheduleFuturesRestFallback(3500);
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
  if(btn.dataset.action==='toggle-chart'){
    if(expandedCharts.has(symbol)) expandedCharts.delete(symbol); else expandedCharts.add(symbol);
    saveExpandedCharts();
    const card=btn.closest('[data-price-card-symbol]');
    if(card) updatePriceCard(card,symbol);
    return;
  }
  if(btn.dataset.action==='chart-interval'){
    const interval=btn.dataset.interval;
    if(!CHART_INTERVALS.includes(interval))return;
    chartIntervals[symbol]=interval; saveChartIntervals();
    const card=btn.closest('[data-price-card-symbol]');
    if(card){card.querySelectorAll('[data-action="chart-interval"]').forEach(b=>b.classList.toggle('active',b.dataset.interval===interval));loadKlineChart(symbol,card,{resetView:true,force:true}).catch(()=>{});}
    return;
  }
  if(btn.dataset.action==='chart-zoom-in'||btn.dataset.action==='chart-zoom-out'||btn.dataset.action==='chart-reset'){
    const card=btn.closest('[data-price-card-symbol]'),state=chartStates.get(symbol)|| (card?ensureChartState(symbol,card):null); if(!state)return;
    if(btn.dataset.action==='chart-reset'){state.visibleCount=Math.min(80,state.data.length||80);state.rightOffset=0;}
    else {const delta=btn.dataset.action==='chart-zoom-in'?-12:12;state.visibleCount=Math.max(20,Math.min(Math.min(180,state.data.length||180),state.visibleCount+delta));state.rightOffset=Math.min(state.rightOffset,Math.max(0,(state.data.length||0)-state.visibleCount));}
    drawKlineChart(state); return;
  }
  if(btn.dataset.action==='remove-symbol'){
    const symbolIndex=symbols.indexOf(symbol);
    const removedMarket=markets[symbol];
    const removedPrice=prices[symbol];
    const removedChartOpen=expandedCharts.has(symbol);
    const removedAlerts=alerts.map((a,index)=>({a,index})).filter(x=>x.a.symbol===symbol);
    symbols=symbols.filter(s=>s!==symbol);
    alerts=alerts.filter(a=>a.symbol!==symbol);
    delete prices[symbol];
    delete markets[symbol];
    expandedCharts.delete(symbol);
    cleanupChartState(symbol);
    saveExpandedCharts();
    saveState();
    renderPrices(); renderAlerts(); renderAlertSymbolOptions(); connectSocket();
    offerUndo(`已移除 ${symbol}`, ()=>{
      if(!symbols.includes(symbol)) symbols.splice(Math.max(0, symbolIndex),0,symbol);
      if(removedMarket) markets[symbol]=removedMarket;
      if(removedPrice) prices[symbol]=removedPrice;
      if(removedChartOpen) { expandedCharts.add(symbol); saveExpandedCharts(); }
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

renderPrices(); renderAlerts(); renderAlertSymbolOptions(); updateNotificationUI(); connectSocket(); getClientId(); scheduleChartRefresh();
