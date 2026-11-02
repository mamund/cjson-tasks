#!/usr/bin/env bash
#
# reset-db.sh
#
# Resets the local TaskList development database.
#
# Removes all stored tasks, users, activities, and journal entries.
# Recreates an empty data directory.
#
# IMPORTANT:
#   Stop the TaskList API server before running this script.
#   This operation permanently deletes local database contents.
#
# Usage:
#   ./scripts/reset-db.sh
#

set -euo pipefail

# Resolve repository root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="$ROOT_DIR/data"

# Verify the expected project structure.
if [[ ! -f "$ROOT_DIR/package.json" ||
        ! -f "$ROOT_DIR/server/index.mjs" ]]; then
  echo "ERROR: TaskList repository structure not found."
    exit 1
fi

# Refuse to follow a symlink at the database path.
if [[ -L "$DATA_DIR" ]]; then
    echo "ERROR: Data directory is a symbolic link."
      exit 1
fi

echo "TaskList development database reset"
echo
echo "Target: $DATA_DIR"
echo
echo "WARNING: This will permanently delete all local database contents."
echo "Make sure the API server is stopped."
echo

read -r -p "Type RESET to continue: " CONFIRM

if [[ "$CONFIRM" != "RESET" ]]; then
    echo "Reset cancelled."
      exit 0
fi

# Delete and recreate the development database.
if [[ -d "$DATA_DIR" ]]; then
    rm -rf -- "$DATA_DIR"
fi

mkdir -p -- "$DATA_DIR"

echo
echo "Database reset completed."
echo "Start the API server to initialize an empty database."
