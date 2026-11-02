#!/usr/bin/env bash
#
# demo-assignment.sh
#
# Demonstrates task assignment and completion using the TaskList CLI.
#
# Expected budget changes:
#   Initial:          20 hours
#   After assignment: 16 hours
#   After completion: 20 hours
#
# Requires the TaskList API server to be running.
#

set -euo pipefail

# Resolve the repository root relative to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CLI="$ROOT_DIR/client/cli.mjs"

echo "=== Create user Alice (20 hours) ==="
node "$CLI" users create --id U100 --name Alice --budget 20

echo
echo "=== Create task T100 (4 hours) ==="
node "$CLI" tasks create \
  --id T100 \
  --title "Review proposal" \
  --hours 4

echo
echo "=== Assign T100 to Alice ==="
node "$CLI" tasks assign T100 U100

echo
echo "=== Alice's budget after assignment (expected: 16) ==="
node "$CLI" users show U100

echo
echo "=== Complete task T100 ==="
node "$CLI" tasks complete T100

echo
echo "=== Alice's budget after completion (expected: 20) ==="
node "$CLI" users show U100

echo
echo "=== Demo completed successfully ==="
