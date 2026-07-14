// Marker execution engine: direction-aware cross detection, atomic claim,
// USD-intent sizing, risk guards, capped retries, and real-fill trade records.
//
// All executions run sequentially inside one process, so transactions from the
// single trading account go out one nonce at a time by construction.
import { ethers } from 'ethers';
import {
  getDecimals, getTokenBalance, ensureAllowance, getOpenOceanSwap,
  sendBuiltTx, parseSwapFill, getBnbPriceUsd,
} from './chain.js';
import {
  detectCross, countTradesToday, sizeTrade, priceImpactPct,
  bracketChildMarkers, bracketSiblingIds, isBuyMarker, immediateFireState,
} from './pure.js';

const SOFT_SKIP_COOLDOWN_MS = 60_000;   // paused / daily-cap / size-cap skips
const FAILURE_COOLDOWN_MS = 30_000;     // wait after a failed attempt

export class MarkerEngine {
  constructor({ api, provider, wallet, config, log }) {
    this.api = api;                 // ApiClient (index.js)
    this.provider = provider;
    this.wallet = wallet;           // null = observe-only mode
    this.config = config;           // { gasPriceGwei, slippagePct, quickBuyPercent, quickSellPercent }
    this.log = log;                 // (level, message, meta?) -> console + POST /debug/logs

    this.sides = new Map();         // marker id -> 'above' | 'below'
    this.attempts = new Map();      // marker id -> failed attempt count
    this.cooldownUntil = new Map(); // marker id -> earliest next try (ms)
    this.tokenAddrMap = new Map();  // SYMBOL -> checksummed contract address
    this.tickerMap = new Map();     // SYMBOL -> display ticker
    this.staleWarnAt = new Map();   // symbol -> next stale-price warning (ms)
    this.apiBnbPrice = 0;           // fresh WBNB_bsc price from the overview
    this.lastTokenRefresh = 0;
    this.lastWatchCount = -1;
    this.lastReconcile = 0;
    this.settings = {               // refreshed each tick; safe defaults if API omits
      paused: 0, max_trades_per_day: 20, max_trade_usd: 250,
      max_price_impact_pct: 3, max_retry_attempts: 3,
    };
  }

  sym(symbol) { return this.tickerMap.get(symbol) || symbol; }

  async refreshTokenMap() {
    if (Date.now() - this.lastTokenRefresh < 5 * 60_000 && this.tokenAddrMap.size > 0) return;
    const tokens = await this.api.getTokens();
    for (const t of tokens) {
      if (!t.symbol || !t.contract_address || !ethers.isAddress(t.contract_address)) continue;
      // Tokens exist on several chains; an EVM-looking address on Base or
      // Ethereum would pass isAddress but point at the wrong (or no) contract
      // on BSC. This engine only trades BSC (AD-D8) — skip everything else.
      // Normalize the numeric BSC id if an older local row still carries it.
      if (t.chain_id && t.chain_id !== 'bsc' && t.chain_id !== '56') continue;
      if (t.status && t.status !== 'active') continue;   // retired/staged/blacklisted
      this.tokenAddrMap.set(t.symbol, ethers.getAddress(t.contract_address));
      // Display name: new-format rows carry a clean display_symbol; legacy
      // rows fall back to the name-derived ticker.
      const name = t.name || '';
      const i = name.indexOf(' (');
      this.tickerMap.set(t.symbol,
        t.display_symbol || (i > 0 ? name.slice(0, i) : name).trim() || t.symbol);
    }
    this.lastTokenRefresh = Date.now();
  }

  // One poll cycle: read state, detect crosses, execute fires sequentially.
  async tick() {
    try {
      this.settings = await this.api.getEngineSettings();
    } catch { /* keep last known settings */ }

    const overview = await this.api.getOverview();
    await this.refreshTokenMap().catch(() => {});
    if (Date.now() - this.lastReconcile > 60_000) {
      this.lastReconcile = Date.now();
      await this.reconcilePendingTrades().catch(e =>
        this.log('ERROR', `Trade reconciliation failed: ${e.message}`));
    }

    const markers = (overview.open_markers || []).filter(m => m.active);
    const prices = overview.token_prices || {};
    const priceUpdated = overview.price_updated || {};
    this.openMarkers = markers; // snapshot for OCO sibling lookup at fill time

    // Fresh BNB/USD from Haven's server-side Binance Alpha feed. No fallback provider.
    this.apiBnbPrice = this.isStale('BNB', prices, priceUpdated)
      ? 0 : (prices.BNB || 0);

    // Forget state for markers that are gone (filled, deleted, deactivated)
    const activeIds = new Set(markers.map(m => m.id));
    for (const id of this.sides.keys()) if (!activeIds.has(id)) this.sides.delete(id);
    for (const id of this.attempts.keys()) if (!activeIds.has(id)) this.attempts.delete(id);
    for (const id of this.cooldownUntil.keys()) if (!activeIds.has(id)) this.cooldownUntil.delete(id);

    if (markers.length !== this.lastWatchCount) {
      this.lastWatchCount = markers.length;
      this.log('INFO', `Engine watching ${markers.length} active marker(s).`);
    }

    const fired = [];
    for (const marker of markers) {
      const price = prices[marker.symbol];

      // STRAT_BUY/STRAT_SELL fire on sight (no cross); past their TTL they are
      // claimed-and-discarded — the engine was down when the strategy signaled
      // and executing now would trade at a stale price.
      const immediate = immediateFireState(marker, Date.now());
      if (immediate === 'expired') {
        const { claimed } = await this.api.claimMarker(marker.id).catch(() => ({ claimed: false }));
        if (claimed) {
          this.log('ERROR',
            `Stale ${marker.marker_type} for ${this.sym(marker.symbol)} discarded ` +
            `(queued ${Math.round((Date.now() - marker.created_at) / 1000)}s ago, TTL exceeded) — NOT traded.`,
            { marker_id: marker.id, strategy_id: marker.strategy_id });
        }
        continue;
      }
      // Stale-price guard (DATA-ROADMAP M3, owner decision M0.1): a price the
      // Binance Alpha feed hasn't refreshed within stalePriceMs must never drive an
      // execution — data outage = loud log + safe pause, not a trade against
      // a frozen price. Skipped immediate markers age out via the TTL above.
      if (price > 0 && this.isStale(marker.symbol, prices, priceUpdated)) {
        this.warnStale(marker.symbol, priceUpdated[marker.symbol]);
        continue;
      }

      if (immediate === 'fire') {
        if (!(price > 0)) continue;   // sizing/impact need a live price; TTL cleans up
        if (Date.now() < (this.cooldownUntil.get(marker.id) || 0)) continue;
        fired.push({ marker, price, prevSide: 'signal', side: 'signal' });
        continue;
      }

      if (!(price > 0)) continue;

      const prevSide = this.sides.get(marker.id);
      const { side, fires } = detectCross(prevSide, price, marker.price, marker.direction);
      this.sides.set(marker.id, side);

      if (!fires) continue;
      if (Date.now() < (this.cooldownUntil.get(marker.id) || 0)) continue;

      fired.push({ marker, price, prevSide, side });
    }

    const dailyCount = countTradesToday(overview.trades || []);
    let executedThisTick = 0;
    for (const fire of fired) {
      executedThisTick += await this.handleCross(fire, dailyCount + executedThisTick) ? 1 : 0;
    }
  }

  async reconcilePendingTrades() {
    const pending = await this.api.getTrades({ status: 'PENDING', limit: 100 });
    for (const trade of pending) {
      const receipt = await this.provider.getTransactionReceipt(trade.tx_hash);
      if (!receipt) continue;
      const isBuy = trade.direction === 'BUY';
      const tokenAddress = this.tokenAddrMap.get(trade.symbol);
      let amountOut = trade.amount_out;
      let executionPrice = trade.execution_price;
      let blockTime = trade.block_time || Date.now();
      if (receipt.status === 1 && tokenAddress) {
        const decimals = await getDecimals(tokenAddress, this.provider).catch(() => 18);
        const fill = await parseSwapFill(
          receipt, tokenAddress, decimals, this.wallet.address, isBuy, this.provider);
        const bnbPrice = await getBnbPriceUsd(this.provider, this.apiBnbPrice);
        blockTime = fill.blockTimestampMs || blockTime;
        if (isBuy && fill.tokenAmount > 0) {
          amountOut = fill.tokenAmount;
          if (bnbPrice > 0) executionPrice = (trade.amount_in * bnbPrice) / amountOut;
        } else if (!isBuy && fill.bnbAmount > 0) {
          amountOut = fill.bnbAmount;
          if (bnbPrice > 0 && trade.amount_in > 0) executionPrice = (amountOut * bnbPrice) / trade.amount_in;
        }
      }
      const gasUsed = Number(receipt.gasUsed || 0n);
      const gasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
      const gasCost = parseFloat(ethers.formatEther(BigInt(gasUsed) * BigInt(gasPrice || 0n)));
      await this.api.recordTrade({
        ...trade, execution_price: executionPrice, amount_out: amountOut,
        gas_used: gasUsed, gas_price_gwei: parseFloat(ethers.formatUnits(gasPrice || 0n, 'gwei')),
        gas_cost_native: gasCost, fee_amount: gasCost, block_time: blockTime,
        status: receipt.status === 1 ? 'FILLED' : 'FAILED',
      });
      this.log(receipt.status === 1 ? 'TRADE' : 'ERROR',
        `Reconciled ${trade.tx_hash}: ${receipt.status === 1 ? 'FILLED' : 'FAILED'}`);
    }
  }

  // True when Binance Alpha's last_updated for the symbol is older than the
  // configured threshold. Symbols with no freshness info (old API, or a price
  // that never came from Binance Alpha are NOT considered stale — the guard
  // only acts on positive evidence of a frozen feed.
  isStale(symbol, prices, priceUpdated) {
    if (!(prices[symbol] > 0)) return false;
    const updatedAt = priceUpdated[symbol];
    if (!updatedAt) return false;
    return Date.now() - updatedAt > (this.config.stalePriceMs || 180_000);
  }

  warnStale(symbol, updatedAt) {
    const now = Date.now();
    if (now < (this.staleWarnAt.get(symbol) || 0)) return;
    this.staleWarnAt.set(symbol, now + 60_000);
    const ageSec = Math.round((now - updatedAt) / 1000);
    const limitSec = Math.round((this.config.stalePriceMs || 180_000) / 1000);
    this.log('ERROR',
      `STALE PRICE: ${this.sym(symbol)} last Binance Alpha update ${ageSec}s ago ` +
      `(limit ${limitSec}s) — marker evaluation for this token is PAUSED until data resumes.`,
      { symbol });
  }

  softSkip(marker, message) {
    this.cooldownUntil.set(marker.id, Date.now() + SOFT_SKIP_COOLDOWN_MS);
    this.log('ERROR', message, { marker_id: marker.id });
  }

  // Returns true if a trade was executed (counts toward the daily cap).
  async handleCross({ marker, price, prevSide, side }, tradesToday) {
    const name = this.sym(marker.symbol);
    const crossMsg = `Marker CROSS: ${name} ${marker.marker_type} @ ${marker.price} (price ${price}, ${prevSide}→${side})`;

    // ALERT markers notify once and deactivate — never trade.
    if (marker.marker_type === 'ALERT') {
      const { claimed } = await this.api.claimMarker(marker.id).catch(() => ({ claimed: false }));
      if (claimed) this.log('INFO', `ALERT: ${name} crossed ${marker.price} (price ${price})`);
      return false;
    }

    if (!this.wallet) {
      this.log('ERROR', `${crossMsg} — no private key configured, skipped`);
      return false;
    }
    if (this.settings.paused) {
      this.softSkip(marker, `${crossMsg} — engine is PAUSED, skipped`);
      return false;
    }
    if (tradesToday >= this.settings.max_trades_per_day) {
      this.softSkip(marker, `${crossMsg} — daily trade cap (${this.settings.max_trades_per_day}) reached, skipped`);
      return false;
    }

    const tokenAddress = this.tokenAddrMap.get(marker.symbol);
    if (!tokenAddress) {
      this.softSkip(marker, `${crossMsg} — no contract address known, skipped`);
      return false;
    }

    this.log('TRADE', crossMsg, { marker_id: marker.id, symbol: marker.symbol, marker_type: marker.marker_type });

    // Claim BEFORE any on-chain work: the atomic UPDATE in the API guarantees a
    // marker executes at most once even if another engine instance races us.
    const { claimed } = await this.api.claimMarker(marker.id).catch(() => ({ claimed: false }));
    if (!claimed) {
      this.log('INFO', `Marker ${name} @ ${marker.price} already claimed elsewhere — skipping.`);
      return false;
    }

    try {
      await this.executeSwap(marker, price, tokenAddress, name);
      this.attempts.delete(marker.id);
      this.cooldownUntil.delete(marker.id);
      return true;
    } catch (e) {
      return this.handleFailure(marker, name, e);
    }
  }

  handleFailure(marker, name, e) {
    const message = e?.message || String(e);
    const terminal = /balance to sell/i.test(message);
    const attempts = (this.attempts.get(marker.id) || 0) + 1;
    this.attempts.set(marker.id, attempts);

    if (terminal) {
      this.log('ERROR', `Marker ${name} failed permanently (${message}) — line removed.`);
      return false;
    }
    if (attempts >= this.settings.max_retry_attempts) {
      // Leave the marker inactive (the claim already deactivated it).
      this.log('ERROR', `Marker ${name} @ ${marker.price} DISABLED after ${attempts} failed attempt(s): ${message}`);
      return false;
    }
    // Re-arm for another try after a cooldown.
    this.cooldownUntil.set(marker.id, Date.now() + FAILURE_COOLDOWN_MS);
    this.api.rearmMarker(marker.id).catch(() => {});
    this.log('ERROR', `Marker execution failed for ${name} (attempt ${attempts}/${this.settings.max_retry_attempts}): ${message}`);
    return false;
  }

  // Binance Alpha DEX security gate — MUST pass before any approve() or swap.
  // Chart is always allowed (API). Strategy/auto markers are blocked on risk.
  // Manual markers may carry an explicit risk acknowledgment (user warned +
  // verified contract) so research trades can still probe carefully.
  async assertTokenSafeToTrade(symbol, name, meta = {}) {
    const requireScan = process.env.SECURITY_REQUIRE_SCAN !== '0'; // default on
    if (!requireScan) return { override: false };
    let sec;
    try {
      sec = await this.api.checkTokenSecurity(symbol, { force: false });
    } catch (e) {
      throw new Error(
        `Security check unavailable for ${name} (${e.message}). ` +
        `Refuse to approve/swap until Binance Alpha security data is reachable.`);
    }

    const elevated = !!(sec.blocked || (sec.critical && sec.critical.length)
      || sec.safe === false || sec.safe !== true);
    const manualOverride = meta.tag === 'manual'
      && meta.risk_ack === true
      && meta.contract_verified === true
      && meta.risk_warned === true;

    if (elevated && !manualOverride) {
      const why = (sec.critical || sec.flags || [sec.message || 'blocked']).join(', ');
      throw new Error(
        `SECURITY BLOCK ${name}: ${why}. No approve, no swap for auto/strategy. ` +
        `Manual trade requires contract verification + risk acknowledgment in the UI.`);
    }
    if (elevated && manualOverride) {
      const why = (sec.critical || sec.flags || ['elevated_risk']).join(', ');
      this.log('WARNING',
        `MANUAL RISK OVERRIDE ${name}: ${why}. User verified contract and accepted warnings. `
        + `Probe recommended; creator can still blacklist wallet after small buy.`);
      return { override: true, security: sec };
    }
    return { override: false, security: sec };
  }

  // Size, quote, guard, execute, and record one marker swap.
  async executeSwap(marker, currentPrice, tokenAddress, name) {
    const w = this.wallet;
    const isBuy = isBuyMarker(marker.marker_type);
    const { gasPriceGwei, slippagePct } = this.config;

    // Marker sizing intent: new markers store {usd}; legacy ones {amount} (token qty).
    // meta may also carry {tp, sl} (bracket entry) or {bracketId} (an OCO leg).
    let meta = {};
    try { meta = marker.metadata_json ? JSON.parse(marker.metadata_json) : {}; } catch { /* unsized */ }
    const metaUsd = parseFloat(meta.usd) || 0;
    const metaAmount = parseFloat(meta.amount) || 0;

    // Security FIRST — never approve a token we haven't cleared (or user risk-acked).
    const secGate = await this.assertTokenSafeToTrade(marker.symbol, name, meta);
    if (secGate?.override) {
      const probeMax = parseFloat(process.env.HAVEN_RISK_PROBE_USD || '1');
      // Larger-than-probe on elevated risk requires extra ack flag from the UI.
      if (metaUsd > probeMax && meta.risk_ack_large !== true) {
        throw new Error(
          `Risky token — first trades should stay near $${probeMax} probe size. `
          + `Confirm the larger-size warning in the UI if you insist.`);
      }
    }

    const bnbPrice = await getBnbPriceUsd(this.provider, this.apiBnbPrice);

    let decimalsIn = 18, balance;
    if (isBuy) {
      balance = parseFloat(ethers.formatEther(await this.provider.getBalance(w.address)));
    } else {
      const bal = await getTokenBalance(tokenAddress, w.address, this.provider);
      decimalsIn = bal.decimals;
      balance = bal.formatted;
      if (!(balance > 0)) throw new Error(`No ${name} balance to sell`);
    }

    let amountInStr, usdNotional;
    try {
      ({ amountIn: amountInStr, usdNotional } = sizeTrade({
        isBuy, metaUsd, metaAmount, currentPrice, bnbPrice, balance, decimalsIn,
        quickBuyPercent: this.config.quickBuyPercent,
        quickSellPercent: this.config.quickSellPercent,
      }));
    } catch (e) {
      // Normalize the generic "No balance to sell" into the named form the
      // failure handler treats as terminal.
      throw new Error(/no balance to sell/i.test(e.message) ? `No ${name} balance to sell` : e.message);
    }

    if (usdNotional > this.settings.max_trade_usd) {
      throw new Error(`trade size $${usdNotional.toFixed(2)} exceeds max_trade_usd ($${this.settings.max_trade_usd})`);
    }

    const fromAddr = isBuy ? ethers.ZeroAddress : tokenAddress;
    const toAddr = isBuy ? tokenAddress : ethers.ZeroAddress;
    const quote = await getOpenOceanSwap(fromAddr, toAddr, amountInStr, slippagePct, w.address, gasPriceGwei);

    // Price-impact guard: compare the quoted output to the Binance Alpha market price.
    const outDecimals = isBuy ? Number(quote.outToken?.decimals ?? 18) : 18;
    const quotedOut = parseFloat(ethers.formatUnits(BigInt(quote.outAmount), outDecimals));
    const impactPct = priceImpactPct({ isBuy, usdNotional, currentPrice, bnbPrice, quotedOut });
    if (impactPct > this.settings.max_price_impact_pct) {
      throw new Error(`quote implies ${impactPct.toFixed(2)}% price impact (max ${this.settings.max_price_impact_pct}%)`);
    }

    if (!isBuy) {
      // Exact-amount approve only (never MaxUint256) — limits blast radius if
      // the token or router is malicious. Security gate already ran above.
      const amountRaw = ethers.parseUnits(amountInStr, decimalsIn);
      const approved = await ensureAllowance(tokenAddress, quote.to, amountRaw, w, {
        exactAmount: true,
      });
      if (approved) {
        this.log('INFO', `Approved exact ${amountInStr} ${name} for this swap only (not unlimited).`);
      }
    }

    const maxValueWei = isBuy ? ethers.parseUnits(amountInStr, 18) : 0n;
    const tx = await sendBuiltTx(quote, gasPriceGwei, w, {
      validation: { maxValueWei },
      onPrepared: async (txHash) => {
        // The API must durably record the signed transaction before broadcast.
        // Retrying this POST is idempotent by tx_hash.
        await this.api.recordTrade({
          symbol: marker.symbol, direction: isBuy ? 'BUY' : 'SELL',
          marker_id: marker.id, expected_price: marker.price,
          execution_price: currentPrice, amount_in: parseFloat(amountInStr),
          amount_out: quotedOut, fee_token: 'BNB', fee_amount: 0,
          gas_used: 0, gas_price_gwei: parseFloat(gasPriceGwei || 0),
          gas_cost_native: 0, tx_hash: txHash, block_time: Date.now(),
          status: 'PENDING', strategy_id: marker.strategy_id ?? null,
        });
      },
    });
    this.log('TRADE', `Marker ${isBuy ? 'BUY' : 'SELL'} ${name} submitted (${amountInStr} in, ~$${usdNotional.toFixed(2)})`,
      { tx_hash: tx.hash, symbol: marker.symbol });

    const receipt = await tx.wait();
    if (receipt && receipt.status === 0) {
      throw new Error(`swap reverted on-chain (tx ${receipt.hash || tx.hash})`);
    }

    // Record what ACTUALLY happened, not what the quote predicted.
    const tokenDecimals = isBuy ? await getDecimals(tokenAddress, this.provider).catch(() => outDecimals) : decimalsIn;
    const fill = await parseSwapFill(receipt, tokenAddress, tokenDecimals, w.address, isBuy, this.provider);

    const amountIn = parseFloat(amountInStr);
    let amountOut, executionPrice = currentPrice;
    if (isBuy) {
      amountOut = fill.tokenAmount > 0 ? fill.tokenAmount : quotedOut;
      if (amountOut > 0 && bnbPrice > 0) executionPrice = (amountIn * bnbPrice) / amountOut;
    } else {
      amountOut = fill.bnbAmount > 0 ? fill.bnbAmount : quotedOut;
      if (amountIn > 0 && bnbPrice > 0) executionPrice = (amountOut * bnbPrice) / amountIn;
    }

    const gasUsed = Number(receipt.gasUsed || 0n);
    const effGasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
    const gasCostBnb = parseFloat(ethers.formatEther(BigInt(gasUsed) * BigInt(effGasPrice || 0n)));

    await this.api.recordTrade({
      symbol: marker.symbol,
      direction: isBuy ? 'BUY' : 'SELL',
      marker_id: marker.id,
      expected_price: marker.price,
      execution_price: executionPrice,
      amount_in: amountIn,
      amount_out: amountOut,
      fee_token: 'BNB',
      fee_amount: gasCostBnb,
      gas_used: gasUsed,
      gas_price_gwei: parseFloat(ethers.formatUnits(effGasPrice || 0n, 'gwei')),
      gas_cost_native: gasCostBnb,
      tx_hash: receipt.hash || tx.hash,
      block_time: fill.blockTimestampMs || Date.now(),
      status: 'FILLED',
      strategy_id: marker.strategy_id ?? null,
    }).catch(e => this.log('ERROR', `Trade executed but failed to record: ${e.message}`));

    this.log('TRADE',
      `Marker ${isBuy ? 'BUY' : 'SELL'} ${name} FILLED @ ~$${executionPrice.toPrecision(6)} ` +
      `(in ${amountIn}, out ${amountOut}, block ${receipt.blockNumber})`,
      { tx_hash: receipt.hash || tx.hash });

    await this.handleBracket(marker, meta, name, isBuy, amountOut);
  }

  // Bracket (OCO) side-effects after a fill:
  //  - a BUY entry carrying tp/sl spawns SELL legs sized to the tokens just bought;
  //  - a filled TP/SL leg cancels its still-open sibling.
  async handleBracket(marker, meta, name, isBuy, tokenAmount) {
    if (isBuy && (meta.tp || meta.sl)) {
      const children = bracketChildMarkers({
        symbol: marker.symbol, entryId: marker.id, entryMeta: meta, tokenAmount,
        strategyId: marker.strategy_id ?? null,
      });
      for (const child of children) {
        try {
          await this.api.createMarker(child);
          this.log('INFO', `Bracket: placed ${child.marker_type} for ${name} @ ${child.price} (${tokenAmount} tokens)`);
        } catch (e) {
          this.log('ERROR', `Bracket: failed to place ${child.marker_type} for ${name}: ${e.message}`);
        }
      }
    }

    const siblings = bracketSiblingIds(marker, this.openMarkers || []);
    for (const id of siblings) {
      try {
        await this.api.deleteMarker(id);
        this.log('INFO', `Bracket: cancelled OCO sibling ${id} after ${name} ${marker.marker_type} filled.`);
      } catch (e) {
        this.log('ERROR', `Bracket: failed to cancel sibling ${id}: ${e.message}`);
      }
    }
  }
}
