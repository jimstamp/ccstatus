# ccstatus

A context-reflective statusline for Claude Code. Displays auth state, rate limits, context window usage, git/PR/CI status, and optional project integrations in a single ANSI-coloured bar.

## Segments

| Segment | What it shows |
|---|---|
| **Auth guard** | Warns when Claude auth and GitHub org don't match (data governance risk) |
| **Location** | Working directory, prefixed with `MT/` when on a Made Tech GitHub org |
| **Model** | Active model — colour-coded: opus (red), sonnet (blue), haiku (green) |
| **Rate limits** | Subscription: 5h/7d usage percentages, reset time when critical (>80%) |
| **Cost** | Token-based: session spend with $/min rate, lines changed (`+N -N`) |
| **Context window** | Progress bar with colour thresholds |
| **Git / PR / CI** | Branch, PR number + review state, per-PR CI status |
| **CI health** | Red flag (`⚑ CI`) when the default branch has failing pipelines |
| **Alan** | Methodology phase + installed component counts (when `.claude/manifest.yaml` exists) |
| **Blueprint** | Engagement name, initiative phase, risk count (when `BLUEPRINT_PATH` is set) |

Segments only appear when relevant data exists. Colours shift green/yellow/red at configurable thresholds. The statusline auto-detects whether you're on a subscription (rate limits) or token-based (cost) plan — no configuration needed.

## Install

```sh
npx ccstatus
```

This copies `statusline.sh` to `~/.claude/` and wires it into `~/.claude/settings.json`.

### Dependencies

- `jq` — JSON parsing
- `gh` — GitHub CLI (PR state, org membership, CI health)
- `claude` — Claude CLI (auth status)

## Platform support

Works on macOS and Linux/WSL. Platform-specific commands (stat, date) are detected automatically.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CCSTATUS_COST_WARN` | `1.00` | Token cost threshold for yellow (USD) |
| `CCSTATUS_COST_CRIT` | `5.00` | Token cost threshold for red (USD) |
| `CCSTATUS_CACHE_DIR` | `/tmp/claude-statusline` | Cache directory for external call results |
| `BLUEPRINT_PATH` | — | Path to Blueprint engagement data directory |

```sh
export CCSTATUS_COST_WARN=2.00
export CCSTATUS_COST_CRIT=10.00
export BLUEPRINT_PATH=/path/to/blueprint/data
```

## Caching

External calls are cached in `/tmp/claude-statusline/` to keep the statusline fast:

| Data | TTL |
|---|---|
| Auth status | 5 min |
| GitHub orgs | 5 min |
| PR state | 30s |
| CI health | 5 min |
| Alan manifest | 10s |
| Blueprint | 30s |
