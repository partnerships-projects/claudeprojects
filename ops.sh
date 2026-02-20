#!/usr/bin/env bash
# =============================================================================
# ops.sh — Manual operations script for Campaign Performance Dashboard
#
# Usage:
#   ./ops.sh <command> [options]
#
# Commands:
#   setup       Install dependencies (Node tools for linting, formatting, etc.)
#   lint        Run linting on HTML, CSS, and JS
#   format      Auto-format code with Prettier
#   build       Extract CSS/JS into separate files and minify for production
#   serve       Start a local dev server
#   validate    Validate data integrity in the dashboard
#   backup      Create a timestamped backup of the project
#   release     Tag a new version and push
#   deploy      Deploy to GitHub Pages
#   status      Show project status (git, file sizes, etc.)
#   help        Show this help message
# =============================================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$PROJECT_DIR/dist"
BACKUP_DIR="$PROJECT_DIR/backups"
MAIN_FILE="$PROJECT_DIR/index.html"
LOG_FILE="$PROJECT_DIR/ops.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ── Helpers ──────────────────────────────────────────────────────────────────
log()   { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
ts()    { date '+%Y-%m-%d_%H-%M-%S'; }

need_cmd() {
    if ! command -v "$1" &>/dev/null; then
        err "'$1' is not installed. Run: ./ops.sh setup"
        return 1
    fi
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_help() {
    sed -n '2,/^# =====/{ /^# =====/d; s/^# \?//; p }' "$0"
}

cmd_setup() {
    log "Installing project dependencies..."

    if ! command -v node &>/dev/null; then
        err "Node.js is required. Install it from https://nodejs.org"
        return 1
    fi

    # Initialize package.json if absent
    if [ ! -f "$PROJECT_DIR/package.json" ]; then
        log "Initializing package.json..."
        cat > "$PROJECT_DIR/package.json" << 'PKGJSON'
{
  "name": "campaign-dashboard",
  "version": "1.0.0",
  "private": true,
  "description": "Campaign Performance Dashboard",
  "scripts": {
    "lint": "./ops.sh lint",
    "format": "./ops.sh format",
    "build": "./ops.sh build",
    "serve": "./ops.sh serve",
    "validate": "./ops.sh validate"
  }
}
PKGJSON
    fi

    log "Installing dev tools..."
    cd "$PROJECT_DIR"
    npm install --save-dev \
        prettier \
        html-validate \
        eslint \
        html-minifier-terser \
        clean-css-cli \
        terser \
        serve \
        2>&1 | tail -1

    ok "Setup complete. All tools installed."
}

cmd_lint() {
    log "Running linters..."
    local errors=0

    # HTML validation
    if command -v npx &>/dev/null && [ -d "$PROJECT_DIR/node_modules/html-validate" ]; then
        log "Checking HTML..."
        if npx html-validate "$MAIN_FILE" 2>&1; then
            ok "HTML: valid"
        else
            warn "HTML: issues found (see above)"
            errors=$((errors + 1))
        fi
    else
        warn "Skipping HTML lint (run ./ops.sh setup first)"
    fi

    # JavaScript lint via ESLint (extract inline JS)
    if command -v npx &>/dev/null && [ -d "$PROJECT_DIR/node_modules/eslint" ]; then
        log "Checking JavaScript..."
        # Extract JS from <script> tags (excluding CDN) into a temp file
        local tmpjs
        tmpjs=$(mktemp /tmp/dashboard-lint-XXXXXX.js)
        sed -n '/<script>/,/<\/script>/{ /<\/?script>/d; p }' "$MAIN_FILE" > "$tmpjs"
        if npx eslint --no-eslintrc --env browser,es2021 --rule '{"no-unused-vars":"warn","no-undef":"off"}' "$tmpjs" 2>&1; then
            ok "JavaScript: no major issues"
        else
            warn "JavaScript: issues found (see above)"
            errors=$((errors + 1))
        fi
        rm -f "$tmpjs"
    else
        warn "Skipping JS lint (run ./ops.sh setup first)"
    fi

    if [ "$errors" -eq 0 ]; then
        ok "All lint checks passed."
    else
        warn "$errors lint check(s) reported issues."
    fi
    return "$errors"
}

cmd_format() {
    need_cmd npx || return 1
    log "Formatting index.html with Prettier..."
    npx prettier --write "$MAIN_FILE" 2>&1
    ok "Formatting complete."
}

cmd_build() {
    log "Building production files into $BUILD_DIR ..."
    mkdir -p "$BUILD_DIR"

    # Extract CSS
    log "Extracting and minifying CSS..."
    sed -n '/<style>/,/<\/style>/{ /<\/?style>/d; p }' "$MAIN_FILE" > "$BUILD_DIR/styles.css"
    if command -v npx &>/dev/null && [ -d "$PROJECT_DIR/node_modules/clean-css-cli" ]; then
        npx cleancss -o "$BUILD_DIR/styles.min.css" "$BUILD_DIR/styles.css"
        ok "CSS minified: $(wc -c < "$BUILD_DIR/styles.min.css") bytes"
    fi

    # Extract JS (inline script blocks, not CDN)
    log "Extracting and minifying JavaScript..."
    sed -n '/<script>/,/<\/script>/{ /<\/?script>/d; p }' "$MAIN_FILE" > "$BUILD_DIR/app.js"
    if command -v npx &>/dev/null && [ -d "$PROJECT_DIR/node_modules/terser" ]; then
        npx terser "$BUILD_DIR/app.js" -o "$BUILD_DIR/app.min.js" --compress --mangle
        ok "JS minified: $(wc -c < "$BUILD_DIR/app.min.js") bytes"
    fi

    # Build production HTML that references external files
    log "Generating production HTML..."
    cat > "$BUILD_DIR/index.html" << 'PRODHTML'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Campaign Performance Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
    <link rel="stylesheet" href="styles.min.css">
</head>
<body>
PRODHTML

    # Extract just the body content
    sed -n '/<body>/,/<\/body>/{ /<body>/d; /<\/body>/d; /<style>/,/<\/style>/d; /<script/d; /src="https/d; /<\/script>/d; p }' "$MAIN_FILE" >> "$BUILD_DIR/index.html"

    cat >> "$BUILD_DIR/index.html" << 'PRODHTML'
    <script src="app.min.js"></script>
</body>
</html>
PRODHTML

    ok "Production build complete in $BUILD_DIR/"
    log "Files:"
    ls -lh "$BUILD_DIR/"
}

cmd_serve() {
    if command -v npx &>/dev/null && [ -d "$PROJECT_DIR/node_modules/serve" ]; then
        log "Starting local server at http://localhost:3000 ..."
        log "Press Ctrl+C to stop."
        npx serve "$PROJECT_DIR" -l 3000
    elif command -v python3 &>/dev/null; then
        log "Starting Python server at http://localhost:8000 ..."
        log "Press Ctrl+C to stop."
        cd "$PROJECT_DIR" && python3 -m http.server 8000
    else
        err "No server available. Run ./ops.sh setup or install python3."
        return 1
    fi
}

cmd_validate() {
    log "Validating dashboard data..."
    local errors=0

    # Check that the DATA object exists and has expected keys
    if grep -q 'const DATA' "$MAIN_FILE"; then
        ok "DATA object found"
    else
        err "DATA object not found in $MAIN_FILE"
        errors=$((errors + 1))
    fi

    # Check required data sections
    local sections=("overall" "weeklyPerformance" "audienceSegments" "emailVariants" "sequenceSteps" "dayOfWeek" "campaigns")
    for section in "${sections[@]}"; do
        if grep -q "\"$section\"" "$MAIN_FILE" || grep -q "'$section'" "$MAIN_FILE" || grep -q "$section:" "$MAIN_FILE"; then
            ok "Section '$section' present"
        else
            warn "Section '$section' may be missing"
            errors=$((errors + 1))
        fi
    done

    # Check Chart.js CDN is reachable
    log "Checking Chart.js CDN..."
    if command -v curl &>/dev/null; then
        if curl -sI "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js" | head -1 | grep -q "200"; then
            ok "Chart.js CDN reachable"
        else
            warn "Chart.js CDN may be unreachable"
        fi
    fi

    # Check file size
    local size
    size=$(wc -c < "$MAIN_FILE")
    log "index.html size: $size bytes"
    if [ "$size" -gt 100000 ]; then
        warn "File is large (>100KB). Consider running ./ops.sh build to split it."
    fi

    if [ "$errors" -eq 0 ]; then
        ok "All validations passed."
    else
        warn "$errors validation issue(s) found."
    fi
}

cmd_backup() {
    mkdir -p "$BACKUP_DIR"
    local backup_name="backup_$(ts).tar.gz"
    log "Creating backup: $backup_name"
    tar -czf "$BACKUP_DIR/$backup_name" \
        --exclude=node_modules \
        --exclude=.git \
        --exclude=dist \
        --exclude=backups \
        -C "$PROJECT_DIR" .
    ok "Backup saved to $BACKUP_DIR/$backup_name ($(du -h "$BACKUP_DIR/$backup_name" | cut -f1))"
    log "Existing backups:"
    ls -lht "$BACKUP_DIR/" | head -10
}

cmd_release() {
    local version="${1:-}"
    if [ -z "$version" ]; then
        # Auto-generate version from date
        version="v$(date '+%Y.%m.%d')"
        log "No version specified, using: $version"
    fi

    cd "$PROJECT_DIR"

    # Check for uncommitted changes
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        warn "You have uncommitted changes."
        read -rp "Commit them before tagging? [y/N] " yn
        if [[ "$yn" =~ ^[Yy]$ ]]; then
            git add -A
            git commit -m "Release $version"
        else
            err "Commit changes first, then re-run."
            return 1
        fi
    fi

    log "Tagging release: $version"
    git tag -a "$version" -m "Release $version"
    ok "Tagged $version. Push with: git push origin $version"
}

cmd_deploy() {
    log "Deploying to GitHub Pages..."
    cd "$PROJECT_DIR"

    # Build first
    cmd_build

    # Check if gh-pages branch exists
    if git show-ref --verify --quiet refs/heads/gh-pages 2>/dev/null; then
        git checkout gh-pages
        cp "$BUILD_DIR"/* .
        git add -A
        git commit -m "Deploy $(ts)" || { warn "Nothing to deploy."; git checkout -; return 0; }
        git push origin gh-pages
        git checkout -
    else
        log "Creating gh-pages branch..."
        git checkout --orphan gh-pages
        git rm -rf . 2>/dev/null || true
        cp "$BUILD_DIR"/* .
        git add -A
        git commit -m "Initial deploy $(ts)"
        git push -u origin gh-pages
        git checkout -
    fi

    ok "Deployed to GitHub Pages."
}

cmd_status() {
    log "Project status:"
    echo ""

    # Git status
    echo "── Git ──"
    cd "$PROJECT_DIR"
    git log --oneline -5 2>/dev/null || echo "  (no commits)"
    echo ""
    git status --short 2>/dev/null
    echo ""

    # File sizes
    echo "── Files ──"
    echo "  index.html: $(du -h "$MAIN_FILE" | cut -f1)"
    if [ -d "$BUILD_DIR" ]; then
        echo "  dist/:      $(du -sh "$BUILD_DIR" | cut -f1)"
    fi
    if [ -d "$BACKUP_DIR" ]; then
        echo "  backups/:   $(du -sh "$BACKUP_DIR" | cut -f1) ($(ls "$BACKUP_DIR" | wc -l) files)"
    fi
    echo ""

    # Node tools
    echo "── Tools ──"
    for tool in node npm prettier eslint; do
        if command -v "$tool" &>/dev/null; then
            echo "  $tool: $(command -v "$tool")"
        else
            echo "  $tool: not installed"
        fi
    done
}

# ── Cron / Scheduled Runs ───────────────────────────────────────────────────
# To run operations on a schedule without daily prompts, add to your crontab:
#
#   crontab -e
#
# Examples:
#   # Run validation every day at 9 AM
#   0 9 * * * /path/to/ops.sh validate >> /path/to/ops.log 2>&1
#
#   # Create a backup every Sunday at midnight
#   0 0 * * 0 /path/to/ops.sh backup >> /path/to/ops.log 2>&1
#
#   # Run lint check every weekday at 8 AM
#   0 8 * * 1-5 /path/to/ops.sh lint >> /path/to/ops.log 2>&1
#
# ─────────────────────────────────────────────────────────────────────────────

# ── Main Dispatch ────────────────────────────────────────────────────────────
main() {
    local cmd="${1:-help}"
    shift 2>/dev/null || true

    case "$cmd" in
        setup)    cmd_setup ;;
        lint)     cmd_lint ;;
        format)   cmd_format ;;
        build)    cmd_build ;;
        serve)    cmd_serve ;;
        validate) cmd_validate ;;
        backup)   cmd_backup ;;
        release)  cmd_release "$@" ;;
        deploy)   cmd_deploy ;;
        status)   cmd_status ;;
        help|-h|--help) cmd_help ;;
        *)
            err "Unknown command: $cmd"
            cmd_help
            return 1
            ;;
    esac
}

main "$@"
