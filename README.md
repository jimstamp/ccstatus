# ccstatus

A context-reflective statusline for Claude Code. Displays auth state, rate limits, context window usage, git/PR/CI status, and optional project integrations in a single ANSI-coloured bar.

## Segments

| Segment | What it shows |
|---|---|
| **Auth guard** | Warns when Claude auth and GitHub org don't match (data governance risk) |
| **Location** | Working directory, prefixed with `MT/` when on a Made Tech GitHub org |
| **Model** | Active model (opus, sonnet, haiku) |
| **Rate limits** | 5h/7d usage percentages, reset time when critical (>80%) |
| **Context window** | Progress bar with colour thresholds |
| **Git / PR / CI** | Branch, PR number + review state, per-PR CI status |
| **CI health** | Red flag (`⚑ CI`) when the default branch has failing pipelines |
| **Alan** | Methodology phase + installed component counts (when `.claude/manifest.yaml` exists) |
| **Blueprint** | Engagement name, initiative phase, risk count (when `BLUEPRINT_PATH` is set) |

Segments only appear when relevant data exists. Colours shift green/yellow/red at configurable thresholds.

## Install

```sh
npx ccstatus
```

This copies `statusline.sh` to `~/.claude/` and wires it into `~/.claude/settings.json`.

### Dependencies

- `jq` — JSON parsing
- `gh` — GitHub CLI (PR state, org membership, CI health)
- `claude` — Claude CLI (auth status)

## Configuration

Set `BLUEPRINT_PATH` to a directory containing Blueprint engagement data to enable the Blueprint segment:

```sh
export BLUEPRINT_PATH=/path/to/blueprint/data
```

## Caching

External calls are cached in `/tmp/claude-statusline/` to keep the statusline fast:

| Data | TTL |
|---|---|
| Auth status | 5 min |
| GitHub orgs | 5 min |
| PR state | 30s |
| CI health | 60s |
| Alan manifest | 10s |
| Blueprint | 30s |
