#!/usr/bin/env bash
# start-geneweave.sh — One-shot installer + launcher for geneWeave.
#
# Walks a fresh clone of weaveintel from zero to a running app at
# http://localhost:3500 (or $PORT). Safe to re-run; each step is
# idempotent and skipped when already satisfied.
#
# Usage:
#   ./scripts/start-geneweave.sh              # interactive setup + start
#   ./scripts/start-geneweave.sh --no-start   # install + build + seed only
#   ./scripts/start-geneweave.sh --prod       # use deploy/server.ts
#   ./scripts/start-geneweave.sh --rebuild    # force a clean rebuild
#
# Env overrides:
#   PORT, DATABASE_PATH, OPENAI_API_KEY, ANTHROPIC_API_KEY,
#   JWT_SECRET, VAULT_KEY

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

START=1
PROD=0
REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --prod)     PROD=1 ;;
    --rebuild)  REBUILD=1 ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= 20 (e.g. brew install node@20)."
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

# ─── 4. .env ────────────────────────────────────────────────────────────────
step "Configuring environment (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  info "Created .env from .env.example"
fi

# Helper: ensure a KEY=VALUE line exists in .env (appends if missing).
ensure_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    return
  fi
  printf "%s=%s\n" "$key" "$value" >> .env
  info "Added ${key} to .env"
}

# Helper: get current value of KEY in .env (strips surrounding quotes).
get_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env | head -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Helper: check if a value looks like a placeholder (contains "your-" or "replace-").
is_placeholder() {
  case "$1" in
    *your-*|*replace-*|*-here|""|sk-your-*) return 0 ;;
    *) return 1 ;;
  esac
}

# Helper: set/overwrite KEY=VALUE in .env.
set_env() {
  local key="$1" value="$2"
  # Remove existing line(s) for KEY, then append.
  sed -i.bak "/^${key}=/d" .env && rm -f .env.bak
  printf "%s=%s\n" "$key" "$value" >> .env
}

gen_secret() { node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"; }

# Auto-generate JWT_SECRET / VAULT_KEY if missing or still placeholders.
for k in JWT_SECRET VAULT_KEY; do
  cur="$(get_env_value "$k")"
  if [ -z "$cur" ] || is_placeholder "$cur"; then
    set_env "$k" "$(gen_secret)"
    info "Generated ${k}"
  fi
done

ensure_env PORT "${PORT:-3500}"
ensure_env DATABASE_PATH "${DATABASE_PATH:-./geneweave.db}"

# Honor inline env overrides for provider keys.
# Set if the .env value is missing OR still a placeholder.
for k in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OLLAMA_BASE_URL OLLAMA_API_KEY LLAMACPP_BASE_URL LLAMACPP_API_KEY; do
  inline="$(eval echo "\${$k:-}")"
  cur="$(get_env_value "$k")"
  if [ -n "$inline" ] && { [ -z "$cur" ] || is_placeholder "$cur"; }; then
    set_env "$k" "$inline"
    info "Set ${k} from environment"
  fi
done

# Validate at least one real provider is present (cloud key OR reachable local endpoint).
have_provider=0
openai_val="$(get_env_value OPENAI_API_KEY)"
anthropic_val="$(get_env_value ANTHROPIC_API_KEY)"
gemini_val="$(get_env_value GEMINI_API_KEY)"
[ -z "$gemini_val" ] && gemini_val="$(get_env_value GOOGLE_API_KEY)"
ollama_url="$(get_env_value OLLAMA_BASE_URL)"
llamacpp_url="$(get_env_value LLAMACPP_BASE_URL)"
if [ -n "$openai_val" ] && ! is_placeholder "$openai_val" && [ "${openai_val#sk-}" != "$openai_val" ]; then
  have_provider=1
fi
if [ -n "$anthropic_val" ] && ! is_placeholder "$anthropic_val" && [ "${anthropic_val#sk-ant-}" != "$anthropic_val" ]; then
  have_provider=1
fi
if [ -n "$gemini_val" ] && ! is_placeholder "$gemini_val"; then
  have_provider=1
fi
if [ -n "$ollama_url" ] && ! is_placeholder "$ollama_url"; then
  have_provider=1
fi
if [ -n "$llamacpp_url" ] && ! is_placeholder "$llamacpp_url"; then
  have_provider=1
fi
if [ "$have_provider" = "0" ]; then
  warn "No provider configured. Set one of:"
  warn "  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,"
  warn "  OLLAMA_BASE_URL (e.g. http://localhost:11434), or"
  warn "  LLAMACPP_BASE_URL (e.g. http://localhost:8080)"
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

# ─── 6. Start ────────────────────────────────────────────────────────────────
if [ "$START" = "0" ]; then
  step "Setup complete (--no-start)"
  echo "    Run: set -a && source .env && set +a && npx tsx examples/12-geneweave.ts"
  exit 0
fi

ENTRY="examples/12-geneweave.ts"
[ "$PROD" = "1" ] && ENTRY="deploy/server.ts"

step "Starting geneWeave  →  http://localhost:${PORT:-3500}"
info "entry: $ENTRY  (Ctrl+C to stop)"
exec npx tsx "$ENTRY"
