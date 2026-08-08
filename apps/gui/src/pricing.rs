//! A local price table and a pre-send cost estimate.
//!
//! `agent-abstraction` deliberately never infers a dollar cost from a price
//! table — "a guessed cost is worse than no cost" — so Claude turns carry a
//! real `cost_usd` and Codex turns carry none. That rule is right for the
//! recorded past: a stored cost should be the one the provider charged.
//!
//! An *estimate before you press Enter* is a different thing, and the honesty
//! is in the label. Nothing is priced until it runs; the number by the Send
//! button is a projection either way, for Claude and Codex alike, so both use
//! this table. What the model actually charges still comes back on the turn and
//! overwrites the guess. The estimate exists to answer one question the real
//! cost answers too late: is this next turn about to be expensive, and what can
//! I do about it.
//!
//! Prices are per 1,000,000 tokens, in USD, current as of 2026-08-06. They are
//! a moving target; when a turn's real cost diverges from the estimate, the
//! table is stale, and the real cost is the one shown afterwards regardless.

use serde::Serialize;

/// Per-million-token prices for one model. Cache-read is the cheap replay of a
/// prompt prefix the provider already has; on a long conversation it is where
/// almost all the input tokens go, so leaving it out would over-estimate a
/// continued session several-fold.
#[derive(Clone, Copy)]
struct Price {
    /// Substring the model id must contain, most specific first.
    key: &'static str,
    input: f64,
    output: f64,
    cache_read: f64,
}

/// The write premium a fresh cache prefix pays, as a multiple of input price.
/// Claude is explicitly configured for a one-hour cache in `build_proxy_request`,
/// whose write price is 2x input. Use that conservative rate for cross-provider
/// handoffs too: understating a large cold transfer is the dangerous error.
const CACHE_WRITE_MULTIPLE: f64 = 2.0;

/// Claude and Codex/GPT prices, longest key first so `gpt-5.4-mini` is matched
/// before `gpt-5.4`. Matched by substring, and the Claude keys are the bare
/// model *name* (`opus`, not `claude-opus`) on purpose: a tab stores Claude's
/// model as the short alias the picker uses — `opus`, `sonnet` — not the full
/// `claude-opus-4-8` id. A `claude-opus` key would miss `opus` and the estimate
/// would silently never price a Claude turn, which is exactly the bug this
/// fixes. `opus` still matches the full id too, so both spellings resolve.
const PRICES: &[Price] = &[
    // Claude — keyed by the bare name so the picker's short aliases match.
    Price {
        key: "opus",
        input: 5.00,
        output: 25.00,
        cache_read: 0.50,
    },
    Price {
        key: "fable",
        input: 10.00,
        output: 50.00,
        cache_read: 1.00,
    },
    Price {
        key: "mythos",
        input: 10.00,
        output: 50.00,
        cache_read: 1.00,
    },
    Price {
        key: "sonnet",
        input: 3.00,
        output: 15.00,
        cache_read: 0.30,
    },
    Price {
        key: "haiku",
        input: 1.00,
        output: 5.00,
        cache_read: 0.10,
    },
    // Codex / GPT — mini before the family it belongs to.
    Price {
        key: "gpt-5.4-mini",
        input: 0.75,
        output: 4.50,
        cache_read: 0.075,
    },
    Price {
        key: "gpt-5.6-sol",
        input: 5.00,
        output: 30.00,
        cache_read: 0.50,
    },
    Price {
        key: "gpt-5.6-terra",
        input: 2.00,
        output: 12.00,
        cache_read: 0.20,
    },
    Price {
        key: "gpt-5.6-luna",
        input: 0.20,
        output: 1.20,
        cache_read: 0.02,
    },
    Price {
        key: "gpt-5.5",
        input: 5.00,
        output: 30.00,
        cache_read: 0.50,
    },
    Price {
        key: "gpt-5.4",
        input: 2.50,
        output: 15.00,
        cache_read: 0.25,
    },
];

// The estimate itself runs in the frontend, per keystroke and offline, from the
// table `pricing_table` serves — so the Rust `estimate`/`price_for` below are
// not called by the binary. They are kept as the reference implementation the
// TypeScript mirrors (`apps/gui/frontend/src/lib/pricing.ts`), and are exercised
// by the tests in this module, so a drift between the two shows up as a Rust
// test failure. `allow(dead_code)` marks that they are spec, not dead weight.
#[allow(dead_code)]
fn price_for(model: &str) -> Option<Price> {
    let model = model.to_ascii_lowercase();
    PRICES
        .iter()
        .copied()
        .find(|price| model.contains(price.key))
}

/// Price the consumption reported so far for a running turn.
///
/// Unlike the durable ledger this is deliberately an estimate: it uses the
/// current local price table and may include a character-derived output count
/// while a provider withholds unfinished output tokens. It exists while Cancel
/// can still change the result; the provider's terminal cost remains canonical.
#[must_use]
pub fn estimate_running_cost(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
) -> Option<f64> {
    let price = price_for(model)?;
    let cost = (input_tokens as f64 * price.input
        + output_tokens as f64 * price.output
        + cache_read_tokens as f64 * price.cache_read
        + cache_write_tokens as f64 * price.input * CACHE_WRITE_MULTIPLE)
        / 1_000_000.0;
    (cost > 0.0 && cost.is_finite()).then_some(cost)
}

/// One row of the price table, for the frontend to do its own per-keystroke
/// math. The estimate updates as the user types and on every model switch, so
/// it has to be local: a Tauri round-trip per keystroke would lag the composer
/// and hammer the bridge. The backend owns the numbers (one place to update
/// when prices move); the frontend owns the arithmetic (instant, offline).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PriceRow {
    pub key: String,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

/// The whole table plus the constants the frontend needs to reproduce the
/// estimate and the alert exactly as the Rust side would.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PricingTable {
    pub rows: Vec<PriceRow>,
    pub cache_write_multiple: f64,
    pub warn_usd: f64,
    pub high_usd: f64,
}

/// The price table for the webview. Longest-key-first order is preserved so the
/// frontend's substring match resolves `gpt-5.4-mini` before `gpt-5.4` exactly
/// as `price_for` does here.
#[tauri::command]
#[must_use]
pub fn pricing_table() -> PricingTable {
    PricingTable {
        rows: PRICES
            .iter()
            .map(|p| PriceRow {
                key: p.key.to_string(),
                input: p.input,
                output: p.output,
                cache_read: p.cache_read,
            })
            .collect(),
        cache_write_multiple: CACHE_WRITE_MULTIPLE,
        warn_usd: WARN_USD,
        high_usd: HIGH_USD,
    }
}

/// Roughly how many tokens a piece of prompt text is. Deliberately an
/// approximation: the app has no tokenizer for either provider, and a turn's
/// real token count comes back afterwards. `chars / 4` is the standard
/// English-text rule of thumb and errs high on code (more punctuation), which
/// is the safe direction for a "will this be expensive" warning.
#[allow(dead_code)]
#[must_use]
pub fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

/// A pre-send estimate, broken into the components that explain it.
///
/// The breakdown is the point. A single dollar figure invites "why is it that
/// much"; splitting it into the cache-read of the resent history, the fresh
/// input of the new prompt, and the projected output shows *where* the cost is
/// — and therefore which lever (compact the history, trim the prompt, ask for
/// less output) actually moves it.
#[allow(dead_code)]
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    /// True when the model was found in the table. False means the numbers are
    /// zero and the UI should say "no price on file" rather than "$0.00".
    pub priced: bool,
    /// The dominant cost on a long conversation: the prior context, resent and
    /// mostly served from cache. This is the number that makes "start fresh"
    /// worth it — it is paid *every* turn until the session is reset.
    pub context_cost: f64,
    /// The new prompt, billed at full input price (no cache prefix yet).
    pub input_cost: f64,
    /// The reply, at output price. The largest per-token rate, so the verbosity
    /// setting bites here.
    pub output_cost: f64,
    /// context + input + output — the projected total for this one turn.
    pub total: f64,
    /// Token counts behind the figures, so the UI can show "≈ 4.2k tokens".
    pub context_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// `warning` past a soft threshold, `high` past a hard one — the cue for the
    /// pre-send alert. `low` is the quiet default.
    pub severity: Severity,
}

#[allow(dead_code)]
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    #[default]
    Low,
    Warning,
    High,
}

/// A turn over this many dollars warns; over this many is flagged high. Chosen
/// for a subscription user watching a weekly window, not an enterprise bill:
/// the point is to catch the runaway wedged session (dollars per turn), not to
/// nag on an ordinary reply (fractions of a cent).
const WARN_USD: f64 = 0.75;
const HIGH_USD: f64 = 2.00;

/// Estimate the cost of the next turn.
///
/// - `prompt` is what the user has typed (its tokens are new input).
/// - `context_tokens` is the size of the conversation the agent will resend,
///   taken from the last turn's reported `context_tokens`; zero on a fresh
///   session. Treated as a cache read because on turn N>1 the prefix is warm.
/// - `expected_output` is a fixed, deliberately generous projection of the
///   reply — the app cannot know it in advance, and under-guessing output (the
///   priciest tokens) would make the estimate read low exactly when it matters.
#[allow(dead_code)]
#[must_use]
pub fn estimate(
    model: &str,
    prompt: &str,
    context_tokens: u64,
    expected_output: u64,
) -> CostEstimate {
    let Some(price) = price_for(model) else {
        return CostEstimate::default();
    };
    let input_tokens = estimate_tokens(prompt);
    let per_million = |tokens: u64, rate: f64| (tokens as f64) * rate / 1_000_000.0;

    let context_cost = per_million(context_tokens, price.cache_read);
    let input_cost = per_million(input_tokens, price.input);
    let output_cost = per_million(expected_output, price.output);
    let total = context_cost + input_cost + output_cost;

    let severity = if total >= HIGH_USD {
        Severity::High
    } else if total >= WARN_USD {
        Severity::Warning
    } else {
        Severity::Low
    };

    CostEstimate {
        priced: true,
        context_cost,
        input_cost,
        output_cost,
        total,
        context_tokens,
        input_tokens,
        output_tokens: expected_output,
        severity,
    }
}

// The compaction-cost and cold-prefix-cost guidance (does a /compact pay for
// itself, start fresh vs continue) is computed in the frontend from the price
// table this module exposes, so the arithmetic lives beside the UI that shows
// it. `CACHE_WRITE_MULTIPLE` rides along on `PricingTable` for the cold-write
// half of that math.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specific_keys_win_over_general_ones() {
        // gpt-5.4-mini must not be priced as gpt-5.4.
        assert_eq!(price_for("gpt-5.4-mini").unwrap().input, 0.75);
        assert_eq!(price_for("gpt-5.4").unwrap().input, 2.50);
        // A dated or suffixed id still resolves by substring.
        assert_eq!(price_for("claude-opus-4-8").unwrap().output, 25.00);
        assert_eq!(price_for("gpt-5.6-terra-2026").unwrap().input, 2.00);
    }

    #[test]
    fn bare_picker_aliases_price() {
        // The regression that shipped an estimate that never appeared: a tab
        // stores Claude's model as the short alias, so the table must price
        // `opus`/`sonnet`/etc., not only the full `claude-opus-4-8` id.
        assert_eq!(price_for("opus").unwrap().output, 25.00);
        assert_eq!(price_for("sonnet").unwrap().output, 15.00);
        assert_eq!(price_for("haiku").unwrap().input, 1.00);
        assert_eq!(price_for("fable").unwrap().input, 10.00);
    }

    #[test]
    fn an_unpriced_model_is_marked_not_priced_rather_than_zero() {
        let est = estimate("some-unknown-model", "hello", 1000, 500);
        assert!(!est.priced);
        assert_eq!(est.total, 0.0);
    }

    #[test]
    fn context_dominates_a_long_conversation() {
        // A big warm context should cost more than a short new prompt, which is
        // the whole reason "start fresh" is ever the cheaper move.
        let est = estimate("claude-opus-4-8", "one short line", 500_000, 1_000);
        assert!(est.context_cost > est.input_cost);
        assert!(est.priced);
    }

    #[test]
    fn a_dollar_heavy_turn_is_flagged_high() {
        // 900k context on Fable at $1/M read = $0.90 just for context, plus
        // output — comfortably past the high threshold.
        let est = estimate("claude-fable-5", "do a big thing", 900_000, 40_000);
        assert_eq!(est.severity, Severity::High);
    }

    #[test]
    fn a_tiny_turn_stays_quiet() {
        let est = estimate("claude-haiku-4-5", "hi", 200, 100);
        assert_eq!(est.severity, Severity::Low);
    }

    #[test]
    fn token_estimate_errs_high_not_low() {
        // Four chars per token; a 40-char line is ~10 tokens.
        assert_eq!(
            estimate_tokens("0123456789012345678901234567890123456789"),
            10
        );
    }

    #[test]
    fn running_cost_prices_the_reported_cache_split() {
        let cost =
            estimate_running_cost("gpt-5.6-sol", 1_502, 101, 202_496, 0).expect("Sol is priced");
        assert!((cost - 0.111_788).abs() < 0.000_001);
    }
}
