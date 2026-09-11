#!/usr/bin/env python3
"""bench/hero.py — render the rlm.pi hero chart (assets/hero.png).

Single source of truth: the bench journals in bench/runs/*.jsonl. For each
model only the NEWEST journal that contains its rows is charted (older files
are stale history). Three panels:

  1. Score (%)            — mean(correct) over all (task, run) rows
  2. Avg tokens / task    — stacked input+output tokens per completed task
  3. Avg cost / task ($)  — mean(costUsd) per row, straight from the journal

The header names the benchmark and its hardness so the chart is self-describing:
OOLONG (oolong-synth) · 24 tasks x 3 runs · context <= 65,536 tok · max 16
iterations · temp 0.

Usage (matplotlib lives in a venv):
    python3 -m venv /tmp/venv-mpl && /tmp/venv-mpl/bin/pip install matplotlib
    /tmp/venv-mpl/bin/python bench/hero.py [--out assets/hero.png]
"""

import argparse
import glob
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.getcwd()
RUNS = os.path.join(ROOT, "bench", "runs")
OUT_DEFAULT = os.path.join(ROOT, "assets", "hero.png")

BENCH_LINE = "OOLONG (oolong-synth)  ·  context ≤ 65,536 tok  ·  temp 0  ·  newest full journal per model"

# Canonical model set — anything else in the journals must never chart.
CANONICAL_MODELS = frozenset({"qwen3.8-27b", "mercury-2.5", "glm-4.7"})

# A journal with fewer scored rows is a smoke/sanity probe, not a sample —
# it must never hijack a model's bar via mtime ordering.
MIN_CHART_ROWS = 6

# Model display order palette: green = flagship, red/coral = challengers.
PALETTE = ["#2e7d32", "#c62828", "#ef6c00", "#6a1b9a", "#00838f"]

TITLE = "rlm.pi — RLM benchmark hero"
SUBTITLE = "Pi coding agent, harness-controlled runs"


def short_model(model: str) -> str:
    """'openrouter/qwen/qwen3.8-27b' -> 'qwen3.8-27b'."""
    return model.rstrip("/").split("/")[-1]


def load_rows():
    """Read every bench/runs/*.jsonl row; tag each row with its source mtime."""
    rows = []
    for path in sorted(glob.glob(os.path.join(RUNS, "*.jsonl"))):
        try:
            mtime = os.path.getmtime(path)
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(r.get("model"), str):
                        continue
                    r["_mtime"] = mtime
                    rows.append(r)
        except OSError:
            continue  # fail-soft: unreadable journal, skip it
    return rows


def aggregate(rows):
    """Group by model; newest journal (>= MIN_CHART_ROWS rows) per model; canonical trio only."""
    counts: dict = {}
    for r in rows:
        key = (r["model"], r["_mtime"])
        counts[key] = counts.get(key, 0) + 1
    newest: dict = {}
    for (m, mt), n in counts.items():
        if n < MIN_CHART_ROWS:
            continue
        if m not in newest or mt > newest[m]:
            newest[m] = mt
    # Stray vendors / typos must never chart — hard canonical whitelist.
    newest = {m: mt for m, mt in newest.items()
              if short_model(m) in CANONICAL_MODELS}
    stats = []
    for m, mt in newest.items():
        mine = [r for r in rows if r["model"] == m and r["_mtime"] == mt]
        n = len(mine)
        if n == 0:
            continue
        score = sum(1 for r in mine if r.get("correct") is True) / n * 100.0
        in_tok = sum(float(r.get("inputTokens") or 0) for r in mine) / n
        out_tok = sum(float(r.get("outputTokens") or 0) for r in mine) / n
        cost = sum(float(r.get("costUsd") or 0) for r in mine) / n
        stats.append({
            "model": m,
            "label": short_model(m),
            "score": score,
            "in_tok": in_tok,
            "out_tok": out_tok,
            "cost": cost,
            "n": n,
        })
    stats.sort(key=lambda s: (-s["score"], s["label"]))
    return stats


def render(stats, out_path: str) -> None:
    fig, axes = plt.subplots(1, 3, figsize=(15.5, 5.6))
    fig.patch.set_facecolor("white")

    fig.suptitle(TITLE, fontsize=17, fontweight="bold", y=0.985)
    fig.text(0.5, 0.905, BENCH_LINE, ha="center", fontsize=10.5, color="#37474f")
    fig.text(0.5, 0.865, SUBTITLE, ha="center", fontsize=9, color="#78909c")

    labels = [s["label"] for s in stats]
    colors = [PALETTE[i % len(PALETTE)] for i in range(len(stats))]

    # Panel 1 — Score
    ax = axes[0]
    scores = [s["score"] for s in stats]
    bars = ax.bar(labels, scores, color=colors, width=0.62)
    for b, v, s in zip(bars, scores, stats):
        ax.text(b.get_x() + b.get_width() / 2, v + 2.5, f"{v:.0f}%",
                ha="center", fontsize=12, fontweight="bold")
        # n= rides inside the bar base — outside placement collided with tick labels
        ax.text(b.get_x() + b.get_width() / 2, 5, f"n={s['n']}",
                ha="center", fontsize=8.5, color="white")
    ax.set_ylim(0, 108)
    ax.set_ylabel("Score (%)", fontsize=11)
    ax.set_title("Score — tasks survived", fontsize=12, pad=10)

    # Panel 2 — Avg tokens per task (stacked in/out)
    ax = axes[1]
    in_toks = [s["in_tok"] for s in stats]
    out_toks = [s["out_tok"] for s in stats]
    bars_in = ax.bar(labels, in_toks, color=colors, width=0.62, label="input")
    bars_out = ax.bar(labels, out_toks, bottom=in_toks, color=colors,
                      width=0.62, alpha=0.45, label="output")
    totals = [s["in_tok"] + s["out_tok"] for s in stats]
    for i, total in enumerate(totals):
        ax.text(i, total + max(totals) * 0.03, f"{total / 1000:.1f}k",
                ha="center", fontsize=12, fontweight="bold")
    # ylim from in+out, not in alone — otherwise tall stacks clip and
    # their totals land on the panel title
    ax.set_ylim(0, max(totals) * 1.18)
    ax.set_ylabel("Avg tokens / task", fontsize=11)
    ax.set_title("Context appetite (in + out)", fontsize=12, pad=10)
    ax.legend(loc="upper left", fontsize=8.5, frameon=False)

    # Panel 3 — Avg cost per task
    ax = axes[2]
    costs = [s["cost"] for s in stats]
    bars = ax.bar(labels, costs, color=colors, width=0.62)
    for b, v in zip(bars, costs):
        ax.text(b.get_x() + b.get_width() / 2, v + max(costs) * 0.03,
                f"${v:.4f}", ha="center", fontsize=12, fontweight="bold")
    ax.set_ylim(0, max(costs) * 1.18 if max(costs) > 0 else 1)
    ax.set_ylabel("Avg cost / task ($)", fontsize=11)
    ax.set_title("Price per task", fontsize=12, pad=10)

    for ax in axes:
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.tick_params(axis="x", labelsize=9.5, rotation=12)
        ax.set_axisbelow(True)
        ax.grid(axis="y", color="#eceff1", linewidth=0.8)

    fig.text(0.5, 0.035,
             "canonical set: qwen3.8-27b · mercury-2.5 · zai/glm-4.7   ·   n = scored rows   ·   glm-4.7 unpriced (cost $0)",
             ha="center", fontsize=8, color="#90a4ae")
    fig.text(0.5, 0.012,
             "rows: bench/runs/*.jsonl (latest journal per model) · regenerate: python3 bench/hero.py",
             ha="center", fontsize=8, color="#b0bec5")
    fig.tight_layout(rect=[0, 0.05, 1, 0.84])
    fig.savefig(out_path, facecolor="white", dpi=150)
    print(f"wrote {out_path}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Render rlm.pi bench hero chart")
    ap.add_argument("--out", default=OUT_DEFAULT, help="output PNG path")
    args = ap.parse_args()

    rows = load_rows()
    if not rows:
        raise SystemExit("no journal rows found in bench/runs/*.jsonl")
    stats = aggregate(rows)
    if not stats:
        raise SystemExit("no model rows aggregated")
    out = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
    render(stats, out)


if __name__ == "__main__":
    main()
