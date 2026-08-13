#!/bin/sh
set -eu

REPO="${REPO:-freecodexyz/ship}"
REF="${REF:-main}"
SKILL_NAME="${SKILL_NAME:-onboard-ship-project}"
SKILL_PATH="${SKILL_PATH:-skills/${SKILL_NAME}}"
REQUESTED_AGENT="${SHIP_SKILL_AGENT:-${AGENT:-auto}}"
TEMP_DOWNLOAD_DIR=""
STAGED_SKILL=""

cleanup() {
  if [ -n "$TEMP_DOWNLOAD_DIR" ]; then
    rm -rf "$TEMP_DOWNLOAD_DIR"
  fi
  if [ -n "$STAGED_SKILL" ]; then
    rm -rf "$STAGED_SKILL"
  fi
}
trap cleanup EXIT INT TERM

case "$SKILL_NAME" in
''|.|..|*[!A-Za-z0-9._-]*)
  echo "Error: SKILL_NAME must be a simple directory name" >&2
  exit 1
  ;;
esac

case "$REQUESTED_AGENT" in
auto|claude|codex)
  AGENT="$REQUESTED_AGENT"
  ;;
*)
  echo "Error: AGENT must be one of: auto, claude, codex" >&2
  exit 1
  ;;
esac

download() {
  url="$1"
  out="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
    return
  fi

  echo "Error: curl or wget is required" >&2
  exit 1
}

resolve_skills_dir() {
  case "$AGENT" in
  claude)
    printf '%s\n' "${SKILLS_DIR:-${CLAUDE_CODE_SKILLS_DIR:-$HOME/.claude/skills}}"
    ;;
  codex)
    if [ -n "${SKILLS_DIR:-}" ]; then
      printf '%s\n' "$SKILLS_DIR"
    elif [ -n "${CODEX_HOME:-}" ]; then
      printf '%s\n' "$CODEX_HOME/skills"
    else
      printf '%s\n' "$HOME/.codex/skills"
    fi
    ;;
  auto)
    if [ -n "${SKILLS_DIR:-}" ]; then
      printf '%s\n' "$SKILLS_DIR"
    elif [ -n "${CLAUDE_CODE_SKILLS_DIR:-}" ]; then
      printf '%s\n' "$CLAUDE_CODE_SKILLS_DIR"
    elif [ -n "${CODEX_HOME:-}" ]; then
      printf '%s\n' "$CODEX_HOME/skills"
    elif [ -d "$HOME/.claude" ]; then
      printf '%s\n' "$HOME/.claude/skills"
    elif [ -d "$HOME/.codex" ]; then
      printf '%s\n' "$HOME/.codex/skills"
    else
      printf '%s\n' "$HOME/.claude/skills"
    fi
    ;;
  esac
}

install_skill() {
  src="$1"
  skills_dir="$(resolve_skills_dir)"
  dst="${skills_dir%/}/${SKILL_NAME}"
  staged="${skills_dir%/}/.${SKILL_NAME}.ship-install.$$"
  STAGED_SKILL="$staged"

  if [ ! -f "$src/SKILL.md" ]; then
    echo "Error: skill entry point not found at $src/SKILL.md" >&2
    exit 1
  fi

  mkdir -p "$skills_dir"
  rm -rf "$staged"
  cp -R "$src" "$staged"
  rm -rf "$dst"
  mv "$staged" "$dst"
  STAGED_SKILL=""

  printf 'Installed %s skill to %s\n' "$SKILL_NAME" "$dst"
  printf 'Restart your agent, then use $%s.\n' "$SKILL_NAME"
}

if [ -n "${SOURCE_DIR:-}" ]; then
  src="${SOURCE_DIR%/}/${SKILL_PATH}"
  if [ ! -d "$src" ]; then
    echo "Error: skill directory not found at $src" >&2
    exit 1
  fi
  install_skill "$src"
  exit 0
fi

tmpdir="$(mktemp -d)"
TEMP_DOWNLOAD_DIR="$tmpdir"

archive="$tmpdir/repo.tar.gz"
download "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}" "$archive"
tar -xzf "$archive" -C "$tmpdir"

root_dir=""
for entry in "$tmpdir"/*; do
  if [ -d "$entry" ]; then
    root_dir="$entry"
    break
  fi
done

if [ -z "$root_dir" ]; then
  echo "Error: could not extract repository archive" >&2
  exit 1
fi

src="${root_dir}/${SKILL_PATH}"
if [ ! -d "$src" ]; then
  echo "Error: skill directory not found in downloaded archive: $src" >&2
  exit 1
fi

install_skill "$src"
