#!/usr/bin/env python3
"""bench/hero.py — render the rlm.pi hero chart from the LATEST bench/runs journals.

For every (suite, model) pair only the newest journal file wins. By default the
suite with the newest activity is charted (override with --suite). Two panels,
hero.png style: Score (%) and Avg. cost per task ($). Cost is the journal's
costUsd when present; older journals (pre cost-tracking) are estimated from
tokens at OpenRouter list prices (public catalog, no key).

Usage (matplotlib lives in a venv — see repo notes):
    python3 -m venv /tmp/venv-mpl && /tmp/venv-mpl/bin/pip install matplotlib
    /tmp/venv-mpl/bin/python bench/hero.py [--suite oolong] [--out assets/hero-r3.png]
"""

import argparse
import glob
import json
import os
import textwrap
import urllib.request

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

ROOT = os.getcwd()
RUNS = os.path.join(ROOT, "bench", "runs")
HF_CATALOG = "https://openrouter.ai/api/v1/models"

# Palette matched to the original hero (cycled by bar index).
COLORS = ["#F2695C", "#F8C9C3", "#3EC3AD", "#9BE3D6", "#A275D8",
          "#7FB2E5", "#F2D06B", "#95D0A6"]


def load(path):
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("{"):
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def fetch_prices():
    """model id -> (usd/token in, usd/token out); empty dict on any failure."""
    try:
        with urllib.request.urlopen(HF_CATALOG, timeout=30) as res:
            data = json.load(res).get("data", [])
        return {m["id"]: (float(m["pricing"]["prompt"]), float(m["pricing"]["completion"]))
                for m in data if "pricing" in m}
    except Exception as err:  # noqa: BLE001 — chart must survive offline runs
        print(f"[hero] pricing fetch failed ({err}); cost bars will be 0 for old journals")
        return {}


def latest_per_model(suite=None):
    """(suite, model) -> (mtime, rows), keeping only the newest journal per pair."""
    groups = {}
    for path in glob.glob(os.path.join(RUNS, "*.jsonl")):
        rows = load(path)
        if not rows:
            continue
        mtime = os.path.getmtime(path)
        key = (rows[0]["suite"], rows[0].get("model", "?"))
        if suite is not None and key[0] != suite:
            continue
        if key not in groups or mtime > groups[key][0]:
            groups[key] = (mtime, rows)
    return groups


def estimate_cost(rows, prices):
    total = sum(r.get("costUsd", 0.0) for r in rows)
    if total > 0:
        return total
    model_id = rows[0].get("model", "").replace("openrouter/", "")
    rates = prices.get(model_id)
    if not rates:
        return 0.0
    pin, pout = rates
    return sum(r.get("inputTokens", 0) * pin + r.get("outputTokens", 0) * pout for r in rows)


def short(model_ref):
    return model_ref.replace("openrouter/", "").split("/")[-1]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--suite", default=None, help="chart one suite (default: newest activity)")
    ap.add_argument("--out", default=os.path.join(ROOT, "assets", "hero.png"))
    args = ap.parse_args()

    groups = latest_per_model(args.suite)
    if not groups:
        raise SystemExit("no journals matched")

    if args.suite is None:  # the suite whose newest journal is the newest overall
        suite = max(groups.items(), key=lambda kv: kv[1][0])[0][0]
        groups = {k: v for k, v in groups.items() if k[0] == suite}
    else:
        suite = args.suite

    prices = fetch_prices()
    bars = []
    for (s, model), (_, rows) in sorted(groups.items()):
        n = len(rows)
        bars.append({
            "model": short(model),
            "score": 100.0 * sum(r.get("correct", False) for r in rows) / n,
            "cost": estimate_cost(rows, prices) / n,
            "tasks": n,
        })
    bars.sort(key=lambda b: (-b["score"], b["cost"]))

    for b in bars:
        print(f"  {b['model']:36s} {b['score']:5.1f}%  ${b['cost']:.4f}/task  (n={b['tasks']})")

    # ---------------------------------------------------------------- render --
    fig = plt.figure(figsize=(15, 10), dpi=100, facecolor="white")
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    fig.text(0.125, 0.92, "rlm.pi", fontsize=46, fontweight="bold", color="#111111", va="top")
    for y in (0.775, 0.635):
        fig.add_artist(Line2D([0.0, 1.0], [y, y], color="#DDDDDD", lw=1.2))
    for label, value, x in [("AUTHOR", "hicaru", 0.125), ("PACKAGE", "pi.dev", 0.4375), ("LICENSE", "MIT", 0.70)]:
        fig.text(x, 0.715, label, fontsize=12, color="#555555")
        fig.text(x, 0.678, value, fontsize=18, fontweight="bold", color="#111111")

    def style_axis(ax, title):
        ax.set_title(title, fontsize=15, fontweight="bold", pad=14)
        ax.yaxis.grid(True, linestyle=":", color="#BBBBBB", lw=0.9)
        ax.set_axisbelow(True)
        for side in ("top", "right"):
            ax.spines[side].set_color("#888888")
        for side in ("left", "bottom"):
            ax.spines[side].set_color("#333333")
        ax.tick_params(colors="#333333", labelsize=9.5)

    n = len(bars)
    xs = range(n)
    names = [textwrap.fill(b["model"], width=15) for b in bars]
    scores = [b["score"] for b in bars]
    costs = [b["cost"] for b in bars]
    palette = [COLORS[i % len(COLORS)] for i in xs]

    ax_l = fig.add_axes([0.115, 0.12, 0.39, 0.42])
    ax_l.bar(xs, scores, color=palette, edgecolor="#333333", lw=0.8, width=0.62)
    ax_l.set_xticks(xs, names)
    ax_l.set_ylabel("Score (%)", fontsize=12.5, fontweight="bold")
    style_axis(ax_l, f"{suite} — Score (%) — latest runs")
    ax_l.set_ylim(0, 112)
    ax_l.set_yticks(range(0, 101, 20))
    ax_l.axhline(min(scores), color="#666666", linestyle="--", lw=1.1)
    for i, v in enumerate(scores):
        ax_l.text(i, v + 2.5, f"{v:.1f}%", ha="center", fontsize=11.5, fontweight="bold")

    ax_r = fig.add_axes([0.585, 0.12, 0.39, 0.42])
    ax_r.bar(xs, costs, color=palette, edgecolor="#333333", lw=0.8, width=0.62)
    ax_r.set_xticks(xs, names)
    ax_r.set_ylabel("Avg. Cost per Task ($)", fontsize=12.5, fontweight="bold")
    style_axis(ax_r, f"{suite} — Avg. Cost per Task ($)")
    ax_r.set_ylim(0, max(costs) * 1.3 if max(costs) > 0 else 1)
    ax_r.set_yticks([])
    for i, v in enumerate(costs):
        ax_r.text(i, v + max(costs) * 0.035, f"\\${v:.4f}", ha="center", fontsize=11.5,
                  fontweight="bold")

    out = os.path.join(ROOT, args.out) if not os.path.isabs(args.out) else args.out
    fig.savefig(out, facecolor="white")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
