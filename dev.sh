#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Checking Node dependencies..."
if [ ! -d "node_modules" ]; then
  npm install
fi
if [ ! -d "renderer/node_modules" ]; then
  npm install --prefix renderer
fi

echo "==> Checking Python virtual environment..."
VENV_DIR="backend/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"

if [ ! -f "$PYTHON_BIN" ]; then
  echo "    Creating Python venv at $VENV_DIR..."
  python3 -m venv "$VENV_DIR"
fi

echo "==> Checking Python dependencies..."
"$PYTHON_BIN" -m pip install -q -r backend/requirements.txt

echo "==> Starting development environment..."
npm run dev
