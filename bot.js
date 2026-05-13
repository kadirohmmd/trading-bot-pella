// bot.js – FVG Strategy 15m for Pella (Node.js)
import { createHmac } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { createServer } from 'http';

// ==================== إعدادات البوت ====================
const CONFIG = {
  SYMBOLS: ["BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT","LINKUSDT","ADAUSDT","XRPUSDT","MATICUSDT","AVAXUSDT","DOTUSDT"],
  TREND_TF: "4h", ENTRY_TF: "15m",
  RISK_PERCENT: 10, RR_RATIO: 2, MAX_LEVERAGE: 10, MARGIN_USD: 3.0,
  COOLDOWN_AFTER_LOSSES: 4, COOLDOWN_BARS: 40,
  RESET_STREAK_AFTER_COOLDOWN: 0,
  PENDING_TTL: 10,
};

const API_KEY = process.env.API_KEY || '';
const API_SECRET = process.env.API_SECRET || '';
const IS_LIVE = (process.env.LIVE || 'true') === 'true';
const BASE_URL = IS_LIVE ? 'https://fapi.binance.com' : 'https://testnet.binancefuture.com';

// ==================== متجر محلي بسيط (KV بديل) ====================
let store = {};
const storeFile = './bot_state.json';
async function loadStore() {
  try { const d = await readFile(storeFile, 'utf8'); store = JSON.parse(d); } catch { store = {}; }
}
async function saveStore() {
  await writeFile(storeFile, JSON.stringify(store, null, 2));
}
async function kvGet(key) { await loadStore(); return store[key] ?? null; }
async function kvSet(key, value) { await loadStore(); store[key] = value; await saveStore(); }

// ==================== توقيع HMAC ====================
function hmacSha256(key, data) { return createHmac('sha256', key).update(data).digest('hex'); }

// ==================== طلب API ====================
async function binanceRequest(endpoint, params = {}, method = 'GET') {
  const ts = Date.now();
  const qp = new URLSearchParams({ ...params, timestamp: ts });
  qp.append('signature', hmacSha256(API_SECRET, qp.toString()));
  const url = `${BASE_URL}${endpoint}?${qp.toString()}`;
  const resp = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/json' } });
  if (!resp.ok) { const text = await resp.text(); throw new Error(`Binance API ${resp.status}: ${text}`); }
  return resp.json();
}

// ==================== جلب الشموع ====================
async function fetchKlines(sym, interval, limit = 100) {
  const url = `${BASE_URL}/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Klines fetch failed');
  const data = await resp.json();
  return data.map(c => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
}

// ==================== مؤشرات ====================
function computeEMA(data, period) {
  if (data.length < period) return null;
  const k = 2/(period+1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) ema = data[i]*k + ema*(1-k);
  return ema;
}

function getSwings(candles) {
  const highs = [], lows = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i], p = candles[i-1], n = candles[i+1];
    if (c.high >= p.high && c.high >= n.high) highs.push({ index: i, price: c.high, time: c.time });
    if (c.low <= p.low && c.low <= n.low) lows.push({ index: i, price: c.low, time: c.time });
  }
  return { highs, lows };
}

function detectFVG(candles, i) {
  if (i < 2) return null;
  const b0 = candles[i], b2 = candles[i-2];
  if (b0.low > b2.high) return { type: 'bullish', high: b0.low, low: b2.high, time: b0.time, index: i };
  if (b0.high < b2.low) return { type: 'bearish', high: b0.high, low: b2.low, time: b0.time, index: i };
  return null;
}

function roundToTick(price, tickSize, dir) {
  const prec = (tickSize.toString().split('.')[1] || '').length;
  let r;
  if (dir === 'up') r = Math.ceil(price / tickSize) * tickSize;
  else if (dir === 'down') r = Math.floor(price / tickSize) * tickSize;
  else r = Math.round(price / tickSize) * tickSize;
  return parseFloat(r.toFixed(prec));
}

// ==================== معلومات الأزواج ====================
async function getExchangeInfo() {
  let info = await kvGet("symbolsInfo");
  if (info) return info;
  const url = `${BASE_URL}/fapi/v1/exchangeInfo`;
  const data = await (await fetch(url)).json();
  info = {};
  for (const sym of CONFIG.SYMBOLS) {
    const s = data.symbols.find(x => x.symbol === sym);
    if (s) info[sym] = {
      tickSize: parseFloat(s.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize),
      stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize),
      minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL').notional),
    };
  }
  await kvSet("symbolsInfo", info);
  return info;
}

async function getUSDTBalance() {
  try {
    const balances = await binanceRequest("/fapi/v2/balance");
    const usdt = balances.find(b => b.asset === "USDT");
    return usdt && !isNaN(parseFloat(usdt.balance)) ? parseFloat(usdt.balance) : null;
  } catch (e) { console.error("Balance error:", e.message); return null; }
}

// ==================== فتح الصفقة ====================
async function openPosition(sym, dir, entryPrice, stopPrice, tpPrice, riskDist) {
  const info = await getExchangeInfo();
  const symInfo = info[sym];
  if (!symInfo) throw new Error("Symbol info missing");
  const { tickSize, stepSize, minNotional } = symInfo;

  const balance = await getUSDTBalance();
  if (!balance || balance <= 0) throw new Error("Balance unavailable");

  const riskAmt = balance * (CONFIG.RISK_PERCENT / 100);
  let qty = riskAmt / riskDist;
  let notional = qty * entryPrice;
  let leverage = notional / CONFIG.MARGIN_USD;
  if (leverage > CONFIG.MAX_LEVERAGE) {
    leverage = CONFIG.MAX_LEVERAGE;
    qty = (CONFIG.MARGIN_USD * leverage) / entryPrice;
  }
  qty = Math.floor(qty / stepSize) * stepSize;
  if (qty * entryPrice < minNotional) throw new Error("Notional too low");

  await binanceRequest("/fapi/v1/leverage", { symbol: sym, leverage: Math.floor(leverage) }, "POST");
  try { await binanceRequest("/fapi/v1/marginType", { symbol: sym, marginType: "ISOLATED" }, "POST"); } catch (e) {}

  const side = dir === 'LONG' ? "BUY" : "SELL";
  const order = await binanceRequest("/fapi/v1/order", {
    symbol: sym, side, type: "LIMIT", price: entryPrice, quantity: qty, timeInForce: "GTC"
  }, "POST");

  console.log(`🔵 Limit ${dir} ${sym} @ ${entryPrice} qty=${qty}`);
  await kvSet("pendingOrder", { ...arguments[0], qty, orderId: order.orderId, createdAt: Date.now() });
}

// ==================== البحث عن إشارة ====================
async function scanForEntry() {
  let idx = (await kvGet("scanIndex")) || 0;
  const batchSize = 3;
  for (let i = 0; i < batchSize; i++) {
    const sym = CONFIG.SYMBOLS[(idx + i) % CONFIG.SYMBOLS.length];
    try {
      const candles = await fetchKlines(sym, CONFIG.ENTRY_TF, 80);
      if (candles.length < 70) continue;

      const c4 = await fetchKlines(sym, CONFIG.TREND_TF, 60);
      if (c4.length < 50) continue;
      const ema50_4h = computeEMA(c4.map(b => b.close), 50);
      if (!ema50_4h) continue;

      const priceNow = candles[candles.length-1].close;
      const { highs, lows } = getSwings(candles);

      // LONG
      if (priceNow > ema50_4h) {
        const recentHighs = highs.filter(h => h.index <= candles.length - 4);
        if (recentHighs.length === 0) continue;
        const lastHigh = recentHighs[recentHighs.length-1];
        let mother = null;
        for (let j = lastHigh.index - 1; j >= 2; j--) {
          const f = detectFVG(candles, j);
          if (f && f.type === 'bullish') { mother = f; break; }
        }
        if (!mother) continue;
        let swept = false;
        for (let j = lastHigh.index + 1; j < candles.length; j++) {
          if (candles[j].low <= mother.low) { swept = true; break; }
        }
        if (!swept) continue;
        for (let j = candles.length-1; j >= lastHigh.index + 1; j--) {
          const nf = detectFVG(candles, j);
          if (nf && nf.type === 'bullish' && nf.index > lastHigh.index && nf.low > mother.low) {
            const entry = nf.high, stop = nf.low, risk = entry - stop;
            if (risk <= 0) continue;
            const tp = entry + risk * CONFIG.RR_RATIO;
            await kvSet("scanIndex", (idx + batchSize) % CONFIG.SYMBOLS.length);
            return { sym, dir: 'LONG', entry, stop, tp, risk };
          }
        }
      }

      // SHORT
      if (priceNow < ema50_4h) {
        const recentLows = lows.filter(l => l.index <= candles.length - 4);
        if (recentLows.length === 0) continue;
        const lastLow = recentLows[recentLows.length-1];
        let mother = null;
        for (let j = lastLow.index - 1; j >= 2; j--) {
          const f = detectFVG(candles, j);
          if (f && f.type === 'bearish') { mother = f; break; }
        }
        if (!mother) continue;
        let swept = false;
        for (let j = lastLow.index + 1; j < candles.length; j++) {
          if (candles[j].high >= mother.high) { swept = true; break; }
        }
        if (!swept) continue;
        for (let j = candles.length-1; j >= lastLow.index + 1; j--) {
          const nf = detectFVG(candles, j);
          if (nf && nf.type === 'bearish' && nf.index > lastLow.index && nf.high < mother.high) {
            const entry = nf.low, stop = nf.high, risk = stop - entry;
            if (risk <= 0) continue;
            const tp = entry - risk * CONFIG.RR_RATIO;
            await kvSet("scanIndex", (idx + batchSize) % CONFIG.SYMBOLS.length);
            return { sym, dir: 'SHORT', entry, stop, tp, risk };
          }
        }
      }
    } catch (e) {}
  }
  await kvSet("scanIndex", (idx + batchSize) % CONFIG.SYMBOLS.length);
  return null;
}

// ==================== دورة التداول ====================
async function handleScheduled() {
  try {
    let cooldown = (await kvGet("cooldownRemaining")) || 0;
    if (cooldown > 0) { await kvSet("cooldownRemaining", cooldown - 1); return; }

    const pending = await kvGet("pendingOrder");
    const activeExists = await manageOpenPosition();

    if (pending && activeExists) {
      const posArr = await binanceRequest("/fapi/v2/positionRisk");
      const pos = posArr.find(p => p.symbol === pending.sym && Math.abs(parseFloat(p.positionAmt)) > 0);
      if (pos) {
        await kvSet("currentTrade", {
          symbol: pending.sym, side: pending.dir,
          entryPrice: parseFloat(pos.entryPrice),
          qty: Math.abs(parseFloat(pos.positionAmt)),
          risk: pending.risk,
          protectionPlaced: false
        });
        await kvSet("pendingOrder", null);
        console.log(`📈 Pending order filled: ${pending.dir} ${pending.sym}`);
      }
      return;
    }

    if (pending) {
      const ageMin = (Date.now() - pending.createdAt) / 60000;
      if (ageMin > CONFIG.PENDING_TTL) {
        try { await binanceRequest("/fapi/v1/order", { symbol: pending.sym, orderId: pending.orderId }, "DELETE"); } catch(e) {}
        await kvSet("pendingOrder", null);
        console.log(`⏰ Pending order expired: ${pending.sym}`);
      }
      return;
    }

    if (!activeExists) {
      const signal = await scanForEntry();
      if (signal) {
        console.log(`🔎 Signal: ${signal.dir} ${signal.sym} @ ${signal.entry}`);
        await openPosition(signal.sym, signal.dir, signal.entry, signal.stop, signal.tp, signal.risk);
      } else {
        console.log("No signal found");
      }
    }
  } catch (e) {
    console.error("Scheduled error:", e.message);
  }
}

// ==================== إدارة المراكز (وضع SL/TP) ====================
async function manageOpenPosition() {
  const posArr = await binanceRequest("/fapi/v2/positionRisk");
  const activePos = posArr.find(p => Math.abs(parseFloat(p.positionAmt)) > 0);
  if (!activePos) {
    await kvSet("currentTrade", null);
    return false;
  }

  const sym = activePos.symbol;
  const qty = Math.abs(parseFloat(activePos.positionAmt));
  const entryPrice = parseFloat(activePos.entryPrice);
  const side = parseFloat(activePos.positionAmt) > 0 ? 'LONG' : 'SHORT';
  const stored = await kvGet("currentTrade");

  if (stored && stored.symbol === sym && stored.protectionPlaced) return true;

  if (stored && stored.symbol === sym && stored.risk) {
    const risk = stored.risk;
    const tp = side === 'LONG' ? entryPrice + risk * CONFIG.RR_RATIO : entryPrice - risk * CONFIG.RR_RATIO;
    const sl = side === 'LONG' ? entryPrice - risk : entryPrice + risk;
    const info = await getExchangeInfo();
    const tickSize = info[sym]?.tickSize || 0.01;
    const slRound = roundToTick(sl, tickSize, side === 'LONG' ? 'down' : 'up');
    const tpRound = roundToTick(tp, tickSize, side === 'LONG' ? 'up' : 'down');
    try {
      await binanceRequest("/fapi/v1/algoOrder", {
        symbol: sym, side: side === 'LONG' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET', algoType: 'CONDITIONAL', triggerPrice: slRound,
        closePosition: 'true', timeInForce: 'GTC', workingType: 'CONTRACT_PRICE'
      }, "POST");
      await binanceRequest("/fapi/v1/algoOrder", {
        symbol: sym, side: side === 'LONG' ? 'SELL' : 'BUY',
        type: 'TAKE_PROFIT_MARKET', algoType: 'CONDITIONAL', triggerPrice: tpRound,
        closePosition: 'true', timeInForce: 'GTC', workingType: 'CONTRACT_PRICE'
      }, "POST");
      await kvSet("currentTrade", { symbol: sym, side, entryPrice, qty, risk: stored.risk, protectionPlaced: true });
      console.log(`✅ SL/TP placed for ${sym}`);
    } catch (e) { if (!e.message.includes('-4130')) console.error(e.message); }
  }

  return true;
}

// ==================== خادم HTTP بسيط (متطلب Pella) ====================
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('FVG Bot is running\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bot server running on port ${PORT}`);
  handleScheduled();
  setInterval(() => {
    try { handleScheduled(); } catch(e) { console.error(e.message); }
  }, 300_000); // كل 5 دقائق
});