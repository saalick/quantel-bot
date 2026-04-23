require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const https       = require("https");
const crypto      = require("crypto");

const TOKEN          = process.env.TELEGRAM_TOKEN;
const SIGNAL_CHATS   = process.env.SIGNAL_CHAT_IDS.split(",").map(id => id.trim());
const EXEC_CHAT      = process.env.EXEC_CHAT_ID;
const BINANCE_KEY    = process.env.BINANCE_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;
const LEVERAGE       = parseInt(process.env.LEVERAGE ?? "20");
const MARGIN_USDT    = parseFloat(process.env.MARGIN_USDT ?? "5");

const bot = new TelegramBot(TOKEN, { polling: true });

// ── Log outbound IP on startup ────────────────────────────────────────────────
fetchJson("https://api.ipify.org?format=json")
  .then(d => console.log("✅ Quantel Nexus bot running... Outbound IP:", d.ip))
  .catch(() => console.log("✅ Quantel Nexus bot running..."));

// ── Dedup: skip same symbol+side within 60s ───────────────────────────────────
const recentTrades = new Map();

function isDuplicate(symbol, side) {
  const key       = `${symbol}_${side}`;
  const lastFired = recentTrades.get(key) ?? 0;
  if (Date.now() - lastFired < 60_000) return true;
  recentTrades.set(key, Date.now());
  return false;
}

// ── Listen to signal groups ───────────────────────────────────────────────────
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id.toString();
    const text   = msg.text ?? msg.caption ?? "";

    if (!SIGNAL_CHATS.includes(chatId)) return;
    if (!text.includes("Entry")) return;
    if (!text.includes("LONG") && !text.includes("SHORT")) return;

    const isLong = text.includes("LONG");
    const side   = isLong ? "LONG" : "SHORT";

    // Parse symbol — matches "· TRXUSDT" in new signal format
    const symMatch = text.match(/·\s*([A-Z0-9]+)/);
    if (!symMatch) {
      console.log("Symbol not found in message:", text.slice(0, 100));
      return;
    }
    let symbol = symMatch[1].trim();
    if (!symbol.endsWith("USDT")) symbol += "USDT";

    // Parse TP1 and SL
    const tp1Match = text.match(/TP1\s*[▶:→]?\s*([\d.]+)/);
    const slMatch  = text.match(/SL\s*[▶:→]?\s*([\d.]+)/);

    const tp1 = tp1Match ? parseFloat(tp1Match[1]) : null;
    const sl  = slMatch  ? parseFloat(slMatch[1])  : null;

    console.log(`Signal: ${symbol} ${side} | TP1: ${tp1} | SL: ${sl}`);

    if (isDuplicate(symbol, side)) {
      console.log(`Duplicate skipped: ${symbol} ${side}`);
      return;
    }

    try {
      const result = await executeBinanceTrade(symbol, side, tp1, sl);
      await bot.sendMessage(EXEC_CHAT, result, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Execution error:", err.message);
      await bot.sendMessage(EXEC_CHAT,
        `❌ <b>Execution failed</b>\n<b>${symbol} ${side}</b>\n<code>${err.message}</code>`,
        { parse_mode: "HTML" }
      );
    }
  } catch (err) {
    console.error("Message handler error:", err.message);
  }
});

// ── Binance Futures execution ─────────────────────────────────────────────────
async function executeBinanceTrade(symbol, side, tp1, sl) {
  const binanceSide      = side === "LONG" ? "BUY" : "SELL";
  const binanceCloseSide = side === "LONG" ? "SELL" : "BUY";

  // 1. Set leverage
  await fapiRequest("/fapi/v1/leverage", {
    symbol, leverage: LEVERAGE.toString()
  });

  // 2. Get mark price + precision
  const { markPrice, tickSize, stepSize } = await getSymbolInfo(symbol);

  // 3. Calculate quantity
  const notional = MARGIN_USDT * LEVERAGE;
  const rawQty   = notional / markPrice;
  const quantity = roundToStep(rawQty, stepSize).toString();

  // 4. Market entry
  const entryResult = await fapiRequest("/fapi/v1/order", {
    symbol, side: binanceSide, type: "MARKET", quantity
  });

  const fillPrice = parseFloat(entryResult.avgPrice ?? markPrice);
  if (!entryResult.orderId) throw new Error(JSON.stringify(entryResult).slice(0, 200));

  let tpStatus = "—";
  let slStatus = "—";

  // 5. TP1 limit order
  if (tp1) {
    const tpPrice  = roundToTick(tp1, tickSize).toString();
    const tpResult = await fapiRequest("/fapi/v1/order", {
      symbol, side: binanceCloseSide,
      type: "TAKE_PROFIT", timeInForce: "GTC",
      quantity, price: tpPrice, stopPrice: tpPrice,
      reduceOnly: "true"
    });
    tpStatus = tpResult.orderId ? "✅" : "❌";
  }

  // 6. SL stop market
  if (sl) {
    const slPrice  = roundToTick(sl, tickSize).toString();
    const slResult = await fapiRequest("/fapi/v1/order", {
      symbol, side: binanceCloseSide,
      type: "STOP_MARKET", stopPrice: slPrice,
      quantity, reduceOnly: "true"
    });
    slStatus = slResult.orderId ? "✅" : "❌";
  }

  return (
    `⚡ <b>Trade Executed</b>\n` +
    `─────────────────────\n` +
    `📊 <b>${symbol} ${side} ${LEVERAGE}x</b>\n` +
    `💵 Margin   : <code>${MARGIN_USDT} USDT</code>\n` +
    `📦 Notional : <code>${notional} USDT</code>\n` +
    `🔢 Qty      : <code>${quantity}</code>\n` +
    `💰 Fill     : <code>${fillPrice}</code>\n` +
    `🎯 TP1      : <code>${tp1 ?? "—"}</code> ${tpStatus}\n` +
    `🛑 SL       : <code>${sl ?? "—"}</code> ${slStatus}\n` +
    `─────────────────────`
  );
}

// ── Binance signed request ────────────────────────────────────────────────────
async function fapiRequest(path, params) {
  params.timestamp = Date.now().toString();
  const query     = new URLSearchParams(params).toString();
  const signature = crypto.createHmac("sha256", BINANCE_SECRET).update(query).digest("hex");
  const url       = `https://fapi.binance.com${path}?${query}&signature=${signature}`;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method:  "POST",
      headers: { "X-MBX-APIKEY": BINANCE_KEY }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(data)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Get symbol info ───────────────────────────────────────────────────────────
async function getSymbolInfo(symbol) {
  const [priceData, infoData] = await Promise.all([
    fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${symbol}`)
  ]);

  if (!priceData.markPrice) throw new Error(`${symbol} not on Binance Futures`);
  const markPrice = parseFloat(priceData.markPrice);
  const symInfo   = infoData.symbols?.[0];
  if (!symInfo) throw new Error(`${symbol} not found`);
  const priceFilt = symInfo.filters.find(f => f.filterType === "PRICE_FILTER");
  const lotFilt   = symInfo.filters.find(f => f.filterType === "LOT_SIZE");
  return {
    markPrice,
    tickSize: parseFloat(priceFilt.tickSize),
    stepSize: parseFloat(lotFilt.stepSize)
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(data)); }
      });
    }).on("error", reject);
  });
}

// ── Rounding helpers ──────────────────────────────────────────────────────────
function roundToTick(price, tickSize) {
  const precision = Math.round(-Math.log10(tickSize));
  return parseFloat((Math.round(price / tickSize) * tickSize).toFixed(precision));
}

function roundToStep(qty, stepSize) {
  const precision = Math.round(-Math.log10(stepSize));
  return parseFloat((Math.floor(qty / stepSize) * stepSize).toFixed(precision));
}
