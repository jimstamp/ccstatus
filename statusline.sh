#!/usr/bin/env bash
set -eo pipefail

# =============================================================================
# Claude Code Statusline — Context-Reflective Dashboard
# =============================================================================
#
# Receives JSON via stdin from Claude Code after each assistant message.
# Outputs ANSI-coloured segments to stdout.
#
# Layers:
#   Auth guard     — cross-refs account vs git org
#   Location       — MT/folder or folder
#   Model          — display name
#   Rate limits    — 5h/7d usage, reset time when critical
#   Context window — progress bar with colour thresholds
#   Git/PR/CI      — branch, PR state, CI status
#   CI health      — red flag when default branch pipelines failing
#   Alan           — methodology phase + stack (when manifest exists)
#   Blueprint      — engagement context (when BLUEPRINT_PATH set)
# =============================================================================

# -- Colours ------------------------------------------------------------------
RST='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
MAGENTA='\033[35m'
CYAN='\033[36m'
WHITE='\033[37m'
BG_RED='\033[41m'

# -- Read JSON from stdin -----------------------------------------------------
INPUT=$(cat)
jq_val() { echo "$INPUT" | jq -r "$1 // empty" 2>/dev/null || true; }
jq_num() { echo "$INPUT" | jq -r "$1 // 0" 2>/dev/null || echo "0"; }

# -- Cache helper -------------------------------------------------------------
CACHE_DIR="/tmp/claude-statusline"
mkdir -p "$CACHE_DIR"

# Read from cache. Sets CACHE_RESULT and returns 0 if fresh, 1 if stale/missing.
cache_read() {
    local file="$CACHE_DIR/$1" max_age="$2"
    CACHE_RESULT=""
    if [ -f "$file" ]; then
        local age=$(( $(date +%s) - $(stat -f %m "$file" 2>/dev/null || echo 0) ))
        if [ "$age" -lt "$max_age" ]; then
            CACHE_RESULT=$(cat "$file")
            return 0
        fi
    fi
    return 1
}

cache_write() {
    echo "$2" > "$CACHE_DIR/$1"
}

path_hash() {
    echo "$1" | md5 -q 2>/dev/null || echo "$1" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "fallback"
}

# -- Segment collector --------------------------------------------------------
SEGMENTS=()
seg() { SEGMENTS+=("$1"); }

colour_for_pct() {
    local pct="${1:-0}" low="${2:-50}" high="${3:-80}"
    pct=${pct%.*}
    if (( pct >= high )); then echo -n "$RED"
    elif (( pct >= low )); then echo -n "$YELLOW"
    else echo -n "$GREEN"
    fi
}

# =============================================================================
# AUTH DETECTION (cached 5 min — won't change mid-session)
# =============================================================================
auth_json="{}"
if cache_read "auth" 300; then
    auth_json="$CACHE_RESULT"
else
    auth_json=$(claude auth status 2>/dev/null || echo '{}')
    cache_write "auth" "$auth_json"
fi

auth_email=$(echo "$auth_json" | jq -r '.email // empty' 2>/dev/null || true)
auth_domain="${auth_email##*@}"

is_mt_claude=false
[[ "$auth_domain" == "madetech.com" ]] && is_mt_claude=true

# GitHub org membership (cached 5 min — won't change mid-session)
is_mt_github=false
if cache_read "gh-orgs" 300; then
    gh_orgs="$CACHE_RESULT"
else
    gh_orgs=$(gh api user/orgs --jq '.[].login' 2>/dev/null || echo "")
    cache_write "gh-orgs" "$gh_orgs"
fi
echo "$gh_orgs" | grep -q "^madetech$" && is_mt_github=true

# =============================================================================
# LOCATION + AUTH GUARD
# =============================================================================
cwd=$(jq_val '.cwd')
if [ -z "$cwd" ]; then cwd=$(pwd); fi
folder=$(basename "$cwd")

# Auth guard — cross-reference Claude auth vs GitHub identity
# RED:   work GitHub (madetech org member) + personal Claude auth = data governance risk
# AMBER: personal GitHub + work Claude auth = quota waste
if $is_mt_github && ! $is_mt_claude; then
    seg "${BG_RED}${WHITE}${BOLD} ⚠ PERSONAL CLAUDE ON WORK GITHUB ${RST}"
    seg "${RED}${BOLD}MT${RST}${DIM}/${RST}${WHITE}${folder}${RST}"
elif $is_mt_github && $is_mt_claude; then
    seg "${BLUE}${BOLD}MT${RST}${DIM}/${RST}${WHITE}${folder}${RST}"
elif ! $is_mt_github && $is_mt_claude; then
    seg "${YELLOW}MT⊘${RST} ${WHITE}${folder}${RST}"
else
    seg "${WHITE}${folder}${RST}"
fi

# =============================================================================
# MODEL
# =============================================================================
model=$(jq_val '.model.display_name')
if [ -n "$model" ]; then
    case "$model" in
        *Opus*)   model_short="opus" ;;
        *Sonnet*) model_short="sonnet" ;;
        *Haiku*)  model_short="haiku" ;;
        *)        model_short="$model" ;;
    esac
    seg "${DIM}${model_short}${RST}"
fi

# =============================================================================
# RATE LIMITS
# =============================================================================
rl_5h=$(jq_num '.rate_limits.five_hour.used_percentage')
rl_7d=$(jq_num '.rate_limits.seven_day.used_percentage')
rl_5h_reset=$(jq_val '.rate_limits.five_hour.resets_at')

rl_5h_int=${rl_5h%.*}
rl_7d_int=${rl_7d%.*}

if [ "${rl_5h_int:-0}" -gt 0 ] 2>/dev/null; then
    rl_colour=$(colour_for_pct "$rl_5h_int" 50 80)
    rl_text="${rl_colour}${rl_5h_int}%${RST}${DIM}/5h${RST}"

    # Show 7d when >30%
    if [ "${rl_7d_int:-0}" -gt 30 ] 2>/dev/null; then
        rl_7d_colour=$(colour_for_pct "$rl_7d_int" 40 70)
        rl_text="${rl_text} ${rl_7d_colour}${rl_7d_int}%${RST}${DIM}/7d${RST}"
    fi

    # Show reset time when 5h >80%
    if [ "${rl_5h_int:-0}" -gt 80 ] 2>/dev/null && [ -n "${rl_5h_reset:-}" ]; then
        reset_time=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${rl_5h_reset%%.*}" "+%H:%M" 2>/dev/null || echo "${rl_5h_reset}")
        rl_text="${rl_text} ${DIM}resets ${reset_time}${RST}"
    fi

    seg "$rl_text"
fi

# =============================================================================
# CONTEXT WINDOW
# =============================================================================
ctx_pct=$(jq_num '.context_window.used_percentage')
ctx_int=${ctx_pct%.*}

if [ "${ctx_int:-0}" -gt 0 ] 2>/dev/null; then
    filled=$(( ctx_int / 10 ))
    empty=$(( 10 - filled ))
    bar=""
    for ((i=0; i<filled; i++)); do bar+="█"; done
    for ((i=0; i<empty; i++)); do bar+="░"; done

    ctx_colour=$(colour_for_pct "$ctx_int" 60 85)
    seg "${ctx_colour}${bar} ${ctx_int}%${RST}${DIM} ctx${RST}"
fi

# =============================================================================
# GIT / PR / CI
# =============================================================================
is_git_repo=false
git -C "$cwd" rev-parse --git-dir &>/dev/null && is_git_repo=true

if $is_git_repo; then
    branch=$(git -C "$cwd" branch --show-current 2>/dev/null || echo "")

    if [ -n "$branch" ]; then
        branch_display="${CYAN}${branch}${RST}"
        pr_info=""

        # PR state (cached 30s)
        pr_cache_key="pr-$(path_hash "$cwd")"

        pr_data="{}"
        if cache_read "$pr_cache_key" 30; then
            pr_data="$CACHE_RESULT"
        else
            pr_data=$(cd "$cwd" && gh pr view --json number,state,reviewDecision,statusCheckRollup 2>/dev/null || echo "{}")
            cache_write "$pr_cache_key" "$pr_data"
        fi

        pr_number=$(echo "$pr_data" | jq -r '.number // empty' 2>/dev/null || true)
        pr_state=$(echo "$pr_data" | jq -r '.state // empty' 2>/dev/null || true)
        pr_review=$(echo "$pr_data" | jq -r '.reviewDecision // empty' 2>/dev/null || true)

        if [ -n "$pr_number" ]; then
            case "$pr_state" in
                OPEN)
                    case "$pr_review" in
                        APPROVED)          pr_info="${GREEN}⬆#${pr_number}✓${RST}" ;;
                        CHANGES_REQUESTED) pr_info="${RED}⬆#${pr_number}✗${RST}" ;;
                        *)                 pr_info="${YELLOW}⬆#${pr_number}${RST}" ;;
                    esac
                    ;;
                MERGED) pr_info="${MAGENTA}⬆#${pr_number}merged${RST}" ;;
            esac

            # CI status from statusCheckRollup
            ci_state=$(echo "$pr_data" | jq -r '
                if (.statusCheckRollup // [] | length) > 0 then
                    if [.statusCheckRollup[] | select(.conclusion == "FAILURE")] | length > 0 then "fail"
                    elif [.statusCheckRollup[] | select(.status == "IN_PROGRESS" or .status == "QUEUED")] | length > 0 then "pending"
                    else "pass"
                    end
                else empty
                end' 2>/dev/null || true)

            case "${ci_state:-}" in
                pass)    pr_info="${pr_info} ${GREEN}✓CI${RST}" ;;
                fail)    pr_info="${pr_info} ${RED}✗CI${RST}" ;;
                pending) pr_info="${pr_info} ${YELLOW}⏳CI${RST}" ;;
            esac
        fi

        if [ -n "$pr_info" ]; then
            seg "${branch_display} ${pr_info}"
        else
            seg "${branch_display}"
        fi
    fi
fi

# =============================================================================
# DEFAULT BRANCH CI HEALTH (cached 5 min)
# =============================================================================
if $is_git_repo; then
    ci_health_cache_key="ci-health-$(path_hash "$cwd")"

    ci_health=""
    if cache_read "$ci_health_cache_key" 300; then
        ci_health="$CACHE_RESULT"
    else
        default_branch=$(git -C "$cwd" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
        ci_health=$(cd "$cwd" && gh run list --branch "$default_branch" --limit 5 --json conclusion,status \
            --jq 'if [.[] | select(.conclusion == "failure")] | length > 0 then "fail"
                  else "pass"
                  end' 2>/dev/null || echo "pass")
        cache_write "$ci_health_cache_key" "$ci_health"
    fi

    if [ "$ci_health" = "fail" ]; then
        seg "${RED}${BOLD}⚑ CI${RST}"
    fi
fi

# =============================================================================
# ALAN METHODOLOGY (when .claude/manifest.yaml exists)
# =============================================================================
manifest_path="$cwd/.claude/manifest.yaml"
if [ -f "$manifest_path" ]; then
    alan_cache_key="alan-$(path_hash "$cwd")"

    alan_data=""
    if cache_read "$alan_cache_key" 10; then
        alan_data="$CACHE_RESULT"
    else
        phase=$(grep -m1 '^project_phase:' "$manifest_path" 2>/dev/null | sed 's/^project_phase: *//' | tr -d '"' || echo "")

        # Count installed components per category using awk for reliability
        count_in_section() {
            awk "/^${1}:/{found=1; next} /^[a-z]/{found=0} found && /^ *- name:/{count++} END{print count+0}" "$manifest_path" 2>/dev/null
        }
        principles=$(count_in_section "principles")
        practices=$(count_in_section "practices")
        skills_count=$(count_in_section "skills")
        updates=$(count_in_section "available_updates")

        alan_data="${phase}|${principles}|${practices}|${skills_count}|${updates}"
        cache_write "$alan_cache_key" "$alan_data"
    fi

    IFS='|' read -r a_phase a_prin a_prac a_skill a_updates <<< "$alan_data"

    if [ -n "${a_phase:-}" ]; then
        alan_text="${MAGENTA}${a_phase}${RST}"

        stack_parts=()
        [ "${a_prin:-0}" -gt 0 ] 2>/dev/null && stack_parts+=("${a_prin}P")
        [ "${a_prac:-0}" -gt 0 ] 2>/dev/null && stack_parts+=("${a_prac}Pr")
        [ "${a_skill:-0}" -gt 0 ] 2>/dev/null && stack_parts+=("${a_skill}Sk")
        if [ ${#stack_parts[@]} -gt 0 ]; then
            stack=$(IFS='+'; echo "${stack_parts[*]}")
            alan_text="${alan_text} ${DIM}${stack}${RST}"
        fi

        [ "${a_updates:-0}" -gt 0 ] 2>/dev/null && alan_text="${alan_text} ${YELLOW}${a_updates}⬆${RST}"

        seg "$alan_text"
    fi
fi

# =============================================================================
# BLUEPRINT ENGAGEMENT (when BLUEPRINT_PATH is set)
# =============================================================================
if [ -n "${BLUEPRINT_PATH:-}" ] && [ -d "${BLUEPRINT_PATH}" ]; then
    bp_cache_key="bp-$(path_hash "$BLUEPRINT_PATH")"

    bp_data=""
    if cache_read "$bp_cache_key" 30; then
        bp_data="$CACHE_RESULT"
    else
        # Find engagement entity
        engagement_name=""
        engagement_file=$(find "$BLUEPRINT_PATH/commercial" -name "eng-*.md" -maxdepth 1 2>/dev/null | head -1 || true)
        if [ -n "$engagement_file" ]; then
            engagement_name=$(grep -m1 '^name:' "$engagement_file" 2>/dev/null | sed 's/^name: *//' | tr -d '"' || echo "")
        fi

        # Find active initiative phase
        init_phase=""
        init_file=$(find "$BLUEPRINT_PATH/delivery" -name "init-*.md" -maxdepth 1 2>/dev/null | head -1 || true)
        if [ -n "$init_file" ]; then
            init_phase=$(grep -m1 '^phase:' "$init_file" 2>/dev/null | sed 's/^phase: *//' | tr -d '"' || echo "")
        fi

        # Count risks
        risk_count=$(find "$BLUEPRINT_PATH/delivery" -name "risk-*.md" -maxdepth 1 2>/dev/null | wc -l | tr -d ' ' || echo "0")

        # Count low-confidence entities
        low_conf=$(grep -rl 'confidence: LOW\|confidence: SPECULATIVE' "$BLUEPRINT_PATH" 2>/dev/null | wc -l | tr -d ' ' || echo "0")

        bp_data="${engagement_name}|${init_phase}|${risk_count}|${low_conf}"
        cache_write "$bp_cache_key" "$bp_data"
    fi

    IFS='|' read -r bp_eng bp_phase bp_risks bp_lowconf <<< "$bp_data"

    bp_text=""
    [ -n "${bp_eng:-}" ] && bp_text="${BOLD}${bp_eng}${RST}"
    [ -n "${bp_phase:-}" ] && bp_text="${bp_text} ${DIM}→${RST}${CYAN}${bp_phase}${RST}"
    [ "${bp_risks:-0}" -gt 0 ] 2>/dev/null && bp_text="${bp_text} ${RED}${bp_risks} risks${RST}"
    [ "${bp_lowconf:-0}" -gt 0 ] 2>/dev/null && bp_text="${bp_text} ${YELLOW}${bp_lowconf}?${RST}"

    [ -n "$bp_text" ] && seg "$bp_text"
fi

# =============================================================================
# OUTPUT
# =============================================================================
if [ ${#SEGMENTS[@]} -gt 0 ]; then
    output=""
    for i in "${!SEGMENTS[@]}"; do
        [ "$i" -gt 0 ] && output+=" ${DIM}│${RST} "
        output+="${SEGMENTS[$i]}"
    done
    echo -e "$output"
fi
