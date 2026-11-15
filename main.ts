// btc-race breakout bot (long only, cbBTC/USDC, 1-minute bars). Dev: +$20.94, 6 trades.
//
// Idea: the dev window trends down ~400 bps, so mean reversion loses and
// buy-and-hold loses. The money sits in the rare sharp up-legs (e.g. a
// +287 bps hour after a -196 bps hour). This bot waits in cash and only
// buys a genuine breakout, then lets it run under a trailing stop.
//
// Entry (decided on a bar's close, filled at the next bar's open):
//   - close above the highest high of the previous 60 bars (Turtle-style
//     60-minute breakout: only ~3 entries per 24 h on the dev window),
//   - EMA(8) above EMA(21) and the close itself above EMA(21)
//     (short-term trend up),
//   - 10-bar return >= 50 bps (the breakout has real momentum, not a
//     marginal poke above the high),
//   - not within 3 bars of a previous sell (cooldown), not after bar 1350
//     (leave room to exit before the end-of-window flatten).
// Exit (whole position, checked every bar):
//   - trailing stop: position value 0.8% below its peak value since entry,
//   - hard stop: value 1% below cost,
//   - max hold: 60 bars.
// Sizing: 100% of cash (one open position max, long only). Each order caps
// slippage at 100 bps past the close it was decided on, like the baselines.
//
// Protocol: agent-fun/bars-replay/v1 via the vendored shim. One reply per
// batch, echoing its seq. Deterministic: float64 EMA math only, no wall
// clock, no network, no files outside the repo, no randomness (hello.seed
// is not even needed: there is no random choice anywhere).
import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 8;
const SLOW_SPAN = 21;
const BREAKOUT_BARS = 60;
const CONFIRM_BARS = 10;
const CONFIRM_BPS = 50; // 10-bar return must be >= 0.5%
const TRAIL_BPS = 80; // 0.8% trailing stop, in bps of peak value
const STOP_BPS = 100; // 1.0% hard stop under cost
const MAX_HOLD_BARS = 60;
const COOLDOWN_BARS = 3;
const LATE_CUTOFF_BARS = 1350; // no new entries after this many bars seen
const MAX_SLIPPAGE_BPS = 100;

interface Ema { span: number; warm: number[]; value: number | null; }

const closes: number[] = [];
const highs: number[] = [];
const fast: Ema = { span: FAST_SPAN, warm: [], value: null };
const slow: Ema = { span: SLOW_SPAN, warm: [], value: null };

let barsSeen = 0;
let entryBar = -1;
let peakValue = 0n; // peak position value (quote units) since entry
let lastSellBar = -1000;

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    if (state.warmingUp) return [];

    // Breakout level: highest high of the previous BREAKOUT_BARS bars,
    // computed BEFORE this bar's high joins the history.
    let breakoutHigh: number | null = null;
    if (highs.length >= BREAKOUT_BARS) {
      breakoutHigh = highs[highs.length - 1];
      for (let i = highs.length - 2; i >= highs.length - BREAKOUT_BARS; i--) {
        if (highs[i]! > breakoutHigh) breakoutHigh = highs[i]!;
      }
    }

    const close = Number(bar.c);
    const high = Number(bar.h);
    closes.push(close);
    highs.push(high);
    stepEma(fast, close);
    stepEma(slow, close);
    barsSeen++;
    const myBar = barsSeen; // 1-based index of this bar

    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;

    // --- exit: whole position -------------------------------------------
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (value > peakValue) peakValue = value;
      const age = myBar - entryBar;
      // trailing stop: value <= peak * (1 - TRAIL_BPS/10000)
      const trailed = value * BigInt(10000) <= peakValue * BigInt(10000 - TRAIL_BPS);
      // hard stop: value <= cost * (1 - STOP_BPS/10000)
      const stopped = value * BigInt(10000) <= held.cost * BigInt(10000 - STOP_BPS);
      if (trailed || stopped || age >= MAX_HOLD_BARS) {
        lastSellBar = myBar;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entry ----------------------------------------------------------
    if (breakoutHigh === null) return [];
    if (fast.value === null || slow.value === null) return [];
    if (myBar >= LATE_CUTOFF_BARS) return [];
    if (myBar - lastSellBar < COOLDOWN_BARS) return [];
    if (!(close > breakoutHigh)) return [];
    if (!(fast.value > slow.value)) return [];
    // Trend confirmation: the close itself must sit above the slow EMA,
    // not just the fast EMA above the slow one (a breakout that is still
    // below its own 21-bar average is a weak one).
    if (!(close > slow.value)) return [];
    if (closes.length <= CONFIRM_BARS) return [];
    const tenAgo = closes[closes.length - 1 - CONFIRM_BARS]!;
    // 10-bar return in bps, integer math on the float closes
    if ((close - tenAgo) * 10000 < tenAgo * CONFIRM_BPS) return [];

    let size = state.cash;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    if (size > byWeight) size = byWeight;
    if (size < BigInt(fees.min_notional_quote_units)) return [];
    entryBar = myBar;
    // Peak starts at zero and is set from the first observed position
    // value after the fill: the fill price (next bar's open) can differ
    // from the notional, so the notional is not a real peak to trail from.
    peakValue = 0n;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
