#!/usr/bin/env bash
# start-geneweave-profile.sh — One-shot installer + launcher for geneWeave with optional Node profiling.
#
# Usage:
#   ./scripts/start-geneweave-profile.sh                         # normal setup + start
#   ./scripts/start-geneweave-profile.sh --profile-cpu            # start with V8 CPU profiling
#   ./scripts/start-geneweave-profile.sh --profile-heap           # start with heap profiling
#   ./scripts/start-geneweave-profile.sh --profile                # CPU + heap + diagnostic reports
#   ./scripts/start-geneweave-profile.sh --inspect                # enable Node inspector on 9229
#   ./scripts/start-geneweave-profile.sh --inspect=9230           # enable Node inspector on custom port
#   ./scripts/start-geneweave-profile.sh --trace-gc               # print GC traces
#   ./scripts/start-geneweave-profile.sh --no-start               # install + build only
#   ./scripts/start-geneweave-profile.sh --prod                   # use deploy/server.ts
#   ./scripts/start-geneweave-profile.sh --rebuild                # force clean rebuild
#
# Recommended profiling run:
#   ./scripts/start-geneweave-profile.sh --profile --inspect
#
# Profiles are written to:
#   ./profiles/geneweave/<timestamp>/
#
# Env overrides:
#   PORT, DATABASE_PATH, OPENAI_API_KEY, ANTHROPIC_API_KEY,
#   JWT_SECRET, VAULT_KEY, PROFILE_DIR, INSPECT_PORT, NODE_EXTRA_OPTIONS

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

START=1
PROD=0
REBUILD=0
PROFILE_CPU=0
PROFILE_HEAP=0
PROFILE_REPORTS=0
INSPECT=0
INSPECT_PORT="${INSPECT_PORT:-9229}"
TRACE_GC=0

for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --prod) PROD=1 ;;
    --rebuild) REBUILD=1 ;;
    --profile) PROFILE_CPU=1; PROFILE_HEAP=1; PROFILE_REPORTS=1 ;;
    --profile-cpu) PROFILE_CPU=1 ;;
    --profile-heap) PROFILE_HEAP=1 ;;
    --profile-reports|--reports) PROFILE_REPORTS=1 ;;
    --inspect) INSPECT=1 ;;
    --inspect=*) INSPECT=1; INSPECT_PORT="${arg#--inspect=}" ;;
    --trace-gc) TRACE_GC=1 ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ─── Colors ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_BLUE='\033[1;34m'; C_GREEN='\033[1;32m'; C_YELLOW='\033[1;33m'
  C_RED='\033[1;31m'; C_DIM='\033[2m'; C_RESET='\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_RESET=''
fi
step()  { printf "\n${C_BLUE}==>${C_RESET} ${C_GREEN}%s${C_RESET}\n" "$1"; }
info()  { printf "    ${C_DIM}%s${C_RESET}\n" "$1"; }
warn()  { printf "    ${C_YELLOW}!${C_RESET} %s\n" "$1"; }
fail()  { printf "${C_RED}✗ %s${C_RESET}\n" "$1" >&2; exit 1; }

# ─── 1. Prerequisites ────────────────────────────────────────────────────────
step "Checking prerequisites"

command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= 20."
command -v npm  >/dev/null 2>&1 || fail "npm not found."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js >= 20 required (have $(node -v))."
fi
info "node $(node -v) / npm $(npm -v)"

# ─── 2. Dependencies ─────────────────────────────────────────────────────────
step "Installing workspace dependencies"
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
  npm install
else
  info "node_modules up to date — skipping (delete node_modules to force)"
fi

# ─── 3. Build ────────────────────────────────────────────────────────────────
step "Building all workspace packages"
if [ "$REBUILD" = "1" ]; then
  info "--rebuild requested: cleaning turbo cache and dist outputs"
  npm run clean >/dev/null 2>&1 || true
fi
npm run build

# ─── 4. .env ─────────────────────────────────────────────────────────────────
step "Configuring environment (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  info "Created .env from .env.example"
fi

ensure_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    return
  fi
  printf "%s=%s\n" "$key" "$value" >> .env
  info "Added ${key} to .env"
}

get_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env | head -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

is_placeholder() {
  case "$1" in
    *your-*|*replace-*|*-here|""|sk-your-*) return 0 ;;
    *) return 1 ;;
  esac
}

set_env() {
  local key="$1" value="$2"
  sed -i.bak "/^${key}=/d" .env && rm -f .env.bak
  printf "%s=%s\n" "$key" "$value" >> .env
}

gen_secret() { node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"; }

for k in JWT_SECRET VAULT_KEY; do
  cur="$(get_env_value "$k")"
  if [ -z "$cur" ] || is_placeholder "$cur"; then
    set_env "$k" "$(gen_secret)"
    info "Generated ${k}"
  fi
done

ensure_env PORT "${PORT:-3500}"
ensure_env DATABASE_PATH "${DATABASE_PATH:-./geneweave.db}"

for k in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OLLAMA_BASE_URL OLLAMA_API_KEY LLAMACPP_BASE_URL LLAMACPP_API_KEY; do
  inline="$(eval echo "\${$k:-}")"
  cur="$(get_env_value "$k")"
  if [ -n "$inline" ] && { [ -z "$cur" ] || is_placeholder "$cur"; }; then
    set_env "$k" "$inline"
    info "Set ${k} from environment"
  fi
done

have_provider=0
openai_val="$(get_env_value OPENAI_API_KEY)"
anthropic_val="$(get_env_value ANTHROPIC_API_KEY)"
gemini_val="$(get_env_value GEMINI_API_KEY)"
[ -z "$gemini_val" ] && gemini_val="$(get_env_value GOOGLE_API_KEY)"
ollama_url="$(get_env_value OLLAMA_BASE_URL)"
llamacpp_url="$(get_env_value LLAMACPP_BASE_URL)"
if [ -n "$openai_val" ] && ! is_placeholder "$openai_val" && [ "${openai_val#sk-}" != "$openai_val" ]; then have_provider=1; fi
if [ -n "$anthropic_val" ] && ! is_placeholder "$anthropic_val" && [ "${anthropic_val#sk-ant-}" != "$anthropic_val" ]; then have_provider=1; fi
if [ -n "$gemini_val" ] && ! is_placeholder "$gemini_val"; then have_provider=1; fi
if [ -n "$ollama_url" ] && ! is_placeholder "$ollama_url"; then have_provider=1; fi
if [ -n "$llamacpp_url" ] && ! is_placeholder "$llamacpp_url"; then have_provider=1; fi
if [ "$have_provider" = "0" ]; then
  warn "No provider configured. Set one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OLLAMA_BASE_URL, or LLAMACPP_BASE_URL."
  if [ "$START" = "1" ]; then
    fail "Refusing to start without a provider. Re-run after editing .env, or pass --no-start."
  fi
fi

# ─── 5. Load env into this shell ─────────────────────────────────────────────
step "Loading .env into shell"
set -a
# shellcheck disable=SC1091
source .env
set +a
info "PORT=${PORT:-3500}  DATABASE_PATH=${DATABASE_PATH:-./geneweave.db}"

# ─── 6. Profiling config ─────────────────────────────────────────────────────
RUN_TS="$(date +%Y%m%d-%H%M%S)"
PROFILE_BASE="${PROFILE_DIR:-$REPO_ROOT/profiles/geneweave/$RUN_TS}"
NODE_PROFILE_OPTIONS=()

if [ "$PROFILE_CPU" = "1" ] || [ "$PROFILE_HEAP" = "1" ] || [ "$PROFILE_REPORTS" = "1" ]; then
  mkdir -p "$PROFILE_BASE"
  info "Profile output directory: $PROFILE_BASE"
fi

if [ "$PROFILE_CPU" = "1" ]; then
  NODE_PROFILE_OPTIONS+=("--cpu-prof" "--cpu-prof-dir=$PROFILE_BASE" "--cpu-prof-name=geneweave-${RUN_TS}.cpuprofile")
fi

if [ "$PROFILE_HEAP" = "1" ]; then
  NODE_PROFILE_OPTIONS+=("--heap-prof" "--heap-prof-dir=$PROFILE_BASE" "--heap-prof-name=geneweave-${RUN_TS}.heapprofile")
fi

if [ "$PROFILE_REPORTS" = "1" ]; then
  NODE_PROFILE_OPTIONS+=("--report-on-fatalerror" "--report-on-signal" "--report-signal=SIGUSR2" "--report-directory=$PROFILE_BASE")
fi

if [ "$INSPECT" = "1" ]; then
  NODE_PROFILE_OPTIONS+=("--inspect=127.0.0.1:${INSPECT_PORT}")
fi

if [ "$TRACE_GC" = "1" ]; then
  NODE_PROFILE_OPTIONS+=("--trace-gc" "--trace-gc-verbose")
fi

if [ -n "${NODE_EXTRA_OPTIONS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_ARR=(${NODE_EXTRA_OPTIONS})
  NODE_PROFILE_OPTIONS+=("${EXTRA_ARR[@]}")
fi

# NODE_OPTIONS is inherited by the tsx child Node process.
# Preserve any existing NODE_OPTIONS while appending profiling options.
# Bash 3.x + `set -u` can treat `${empty_array[*]}` as an unbound variable,
# so only expand the array when it actually contains values.
EXISTING_NODE_OPTIONS="${NODE_OPTIONS:-}"
if [ "${#NODE_PROFILE_OPTIONS[@]}" -gt 0 ]; then
  PROFILE_OPTIONS_JOINED="${NODE_PROFILE_OPTIONS[*]}"
  COMBINED_NODE_OPTIONS="$EXISTING_NODE_OPTIONS $PROFILE_OPTIONS_JOINED"
else
  COMBINED_NODE_OPTIONS="$EXISTING_NODE_OPTIONS"
fi
export NODE_OPTIONS="${COMBINED_NODE_OPTIONS# }"

# ─── 7. Start ────────────────────────────────────────────────────────────────
if [ "$START" = "0" ]; then
  step "Setup complete (--no-start)"
  echo "    Run: set -a && source .env && set +a && npx tsx examples/12-geneweave.ts"
  exit 0
fi

ENTRY="examples/12-geneweave.ts"
[ "$PROD" = "1" ] && ENTRY="deploy/server.ts"

step "Starting geneWeave  →  http://localhost:${PORT:-3500}"
info "entry: $ENTRY  (Ctrl+C to stop)"
if [ -n "$NODE_OPTIONS" ]; then
  info "NODE_OPTIONS=$NODE_OPTIONS"
fi
if [ "$PROFILE_REPORTS" = "1" ]; then
  info "During a CPU hang, in another terminal you can capture a diagnostic report with:"
  info "  kill -USR2 \$(lsof -i :${PORT:-3500} -t | head -1)"
fi
if [ "$INSPECT" = "1" ]; then
  info "Inspector: chrome://inspect → 127.0.0.1:${INSPECT_PORT}"
fi

exec npx tsx "$ENTRY"
