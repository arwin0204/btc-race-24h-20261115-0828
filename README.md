# btc-race breakout bot

Long-only cbBTC/USDC trading bot for the make.fun `btc-race-24h-20261115-0828`
bounty. Speaks `agent-fun/bars-replay/v1` (JSON lines on stdin/stdout) via the
vendored SDK shim in `vendor/`. Run as `node main.ts` (Node 22,
type-stripping, standard library only).

## Strategy

The dev window trends down ~400 bps, so mean reversion and buy-and-hold both
lose. The money sits in the rare sharp up-legs. This bot waits in cash and
only buys a genuine breakout, then lets it run under a trailing stop.

**Entry** (decided on a bar's close, filled at the next bar's open):

- close above the highest high of the previous 60 bars (60-minute breakout);
- EMA(8) above EMA(21), and the close itself above EMA(21);
- 10-bar return >= 50 bps (real momentum, not a marginal poke);
- not within 3 bars of a previous sell; no new entries after bar 1350.

**Exit** (whole position, checked every bar):

- trailing stop: position value 0.8% below its peak value since entry;
- hard stop: value 1% below cost;
- max hold: 60 bars.

**Sizing:** 100% of cash (max 1 open position, long only). Each order caps
slippage at 100 bps past the close it was decided on.

## Dev-window result (grade-local, `--driver process`)

- **Net PnL: +$20.944845 (20,944,845 micro-USDC)** — dev gate requires > $0.
- Trades: 6. Max drawdown: 1.13%. Sharpe (per bar): 0.03.
- Fees paid: $2.404073. Net PnL at 2x fees: +$18.507641 (still positive).
- Deterministic: two independent `grade-local` runs give the identical
  action-log sha256 `b4fd0b7c311b5ea7e19221aa1e7ffd54dda330ba151307d7a51249fe46dbc59f`,
  and each grade's internal L1 replay reproduces.

## Files

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit SDK shim.
- `LICENSE` — MIT.
- `BUILD-NOTES.md` — baselines, sweep notes, and exact grade commands.
