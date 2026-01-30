#!/usr/bin/env bash
set -euo pipefail

# docker-multi-setup.sh - Multi-instance Docker deployment
#
# Creates isolated Moltbot Gateway instances for multiple users.
# Each instance gets its own:
# - Port (18789 + offset)
# - Config directory
# - State directory
# - Workspace
#
# Usage:
#   ./docker-multi-setup.sh create <name> [--no-onboard]
#   ./docker-multi-setup.sh onboard <name>
#   ./docker-multi-setup.sh start <name>
#   ./docker-multi-setup.sh stop <name>
#   ./docker-multi-setup.sh list
#   ./docker-multi-setup.sh remove <name>

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCES_DIR="${CLAWDBOT_INSTANCES_DIR:-$HOME/.clawdbot-instances}"
IMAGE_NAME="${CLAWDBOT_IMAGE:-moltbot:local}"
BASE_PORT="${CLAWDBOT_BASE_PORT:-18789}"
GATEWAY_BIND="${CLAWDBOT_GATEWAY_BIND:-lan}"

# Helper to generate random tokens
random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  fi
}

# Get instance directory
get_instance_dir() {
  local name="$1"
  echo "$INSTANCES_DIR/$name"
}

# Get instance port (deterministic based on instance number)
get_instance_port() {
  local name="$1"
  local index
  index=$(get_instance_index "$name")
  echo $((BASE_PORT + index * 20))
}

# Get instance bridge port
get_instance_bridge_port() {
  local name="$1"
  local port
  port=$(get_instance_port "$name")
  echo $((port + 1))
}

# Get instance index (for port calculation)
get_instance_index() {
  local name="$1"
  local count=0

  # Create instances dir if it doesn't exist
  mkdir -p "$INSTANCES_DIR"

  # Check if this instance already has an assigned index
  local instance_dir="$INSTANCES_DIR/$name"
  if [[ -f "$instance_dir/.instance-index" ]]; then
    cat "$instance_dir/.instance-index"
    return
  fi

  # Find the next available index
  for dir in "$INSTANCES_DIR"/*/; do
    if [[ -d "$dir" && -f "$dir/.instance-index" ]]; then
      local idx
      idx=$(cat "$dir/.instance-index")
      if [[ $idx -ge $count ]]; then
        count=$((idx + 1))
      fi
    fi
  done

  echo "$count"
}

# Create a new instance
cmd_create() {
  local name="$1"
  shift
  local no_onboard=false

  # Parse options
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-onboard)
        no_onboard=true
        shift
        ;;
      *)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done

  local instance_dir
  instance_dir=$(get_instance_dir "$name")

  if [[ -d "$instance_dir" ]]; then
    echo "Instance '$name' already exists at $instance_dir" >&2
    exit 1
  fi

  echo "==> Creating instance: $name"
  mkdir -p "$instance_dir"

  # Assign index for port calculation
  local index
  index=$(get_instance_index "$name")
  echo "$index" > "$instance_dir/.instance-index"

  # Create directories
  local config_dir="$instance_dir/config"
  local state_dir="$instance_dir/state"
  local workspace_dir="$instance_dir/workspace"

  mkdir -p "$config_dir"
  mkdir -p "$state_dir"
  mkdir -p "$workspace_dir"

  # Generate token
  local gateway_token
  gateway_token=$(random_token)
  echo "$gateway_token" > "$instance_dir/.gateway-token"

  # Get ports
  local port
  port=$(get_instance_port "$name")
  local bridge_port
  bridge_port=$(get_instance_bridge_port "$name")

  # Create docker-compose.override.yml for this instance
  cat > "$instance_dir/docker-compose.yml" <<YAML
services:
  moltbot-gateway-${name}:
    image: ${IMAGE_NAME}
    container_name: moltbot-gateway-${name}
    environment:
      HOME: /home/node
      TERM: xterm-256color
      CLAWDBOT_GATEWAY_TOKEN: ${gateway_token}
      CLAWDBOT_STATE_DIR: /home/node/.clawdbot
    volumes:
      - ${config_dir}:/home/node/.clawdbot
      - ${workspace_dir}:/home/node/clawd
    ports:
      - "${port}:${port}"
      - "${bridge_port}:${bridge_port}"
    init: true
    restart: unless-stopped
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${GATEWAY_BIND}",
        "--port",
        "${port}"
      ]

  moltbot-cli-${name}:
    image: ${IMAGE_NAME}
    container_name: moltbot-cli-${name}
    environment:
      HOME: /home/node
      TERM: xterm-256color
      BROWSER: echo
      CLAWDBOT_STATE_DIR: /home/node/.clawdbot
      CLAWDBOT_GATEWAY_PORT: "${port}"
      CLAWDBOT_GATEWAY_TOKEN: ${gateway_token}
    volumes:
      - ${config_dir}:/home/node/.clawdbot
      - ${workspace_dir}:/home/node/clawd
    stdin_open: true
    tty: true
    init: true
    entrypoint: ["node", "dist/index.js"]
YAML

  # Save instance metadata
  cat > "$instance_dir/.instance.json" <<JSON
{
  "name": "${name}",
  "index": ${index},
  "port": ${port},
  "bridgePort": ${bridge_port},
  "configDir": "${config_dir}",
  "stateDir": "${state_dir}",
  "workspaceDir": "${workspace_dir}",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

  echo ""
  echo "Instance created:"
  echo "  Name:      $name"
  echo "  Port:      $port"
  echo "  Bridge:    $bridge_port"
  echo "  Config:    $config_dir"
  echo "  Workspace: $workspace_dir"
  echo "  Token:     $gateway_token"
  echo ""

  if [[ "$no_onboard" == "false" ]]; then
    cmd_onboard "$name"
  else
    echo "Run './docker-multi-setup.sh onboard $name' to configure this instance."
  fi
}

# Onboard an instance
cmd_onboard() {
  local name="$1"
  shift
  local auth_choice=""
  local anthropic_key=""
  local openai_key=""

  # Parse options
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --auth-choice)
        auth_choice="$2"
        shift 2
        ;;
      --anthropic-api-key)
        anthropic_key="$2"
        shift 2
        ;;
      --openai-api-key)
        openai_key="$2"
        shift 2
        ;;
      *)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done

  local instance_dir
  instance_dir=$(get_instance_dir "$name")

  if [[ ! -d "$instance_dir" ]]; then
    echo "Instance '$name' does not exist. Create it first." >&2
    exit 1
  fi

  local port
  port=$(get_instance_port "$name")
  local gateway_token
  gateway_token=$(cat "$instance_dir/.gateway-token")

  echo "==> Onboarding instance: $name (port: $port)"
  echo ""
  echo "Configuration:"
  echo "  - Gateway port: $port"
  echo "  - Gateway bind: $GATEWAY_BIND"
  echo "  - Gateway auth: token"
  echo "  - Gateway token: $gateway_token"
  echo ""

  # Build onboard command with optional auth parameters
  local onboard_args=(
    onboard
    --non-interactive
    --accept-risk
    --gateway-port "$port"
    --gateway-bind "$GATEWAY_BIND"
    --gateway-auth token
    --gateway-token "$gateway_token"
    --no-install-daemon
    --skip-health
    --skip-channels
  )

  # Add auth choice if specified
  if [[ -n "$auth_choice" ]]; then
    onboard_args+=(--auth-choice "$auth_choice")
  fi

  # Add API keys if specified
  if [[ -n "$anthropic_key" ]]; then
    onboard_args+=(--anthropic-api-key "$anthropic_key")
  fi
  if [[ -n "$openai_key" ]]; then
    onboard_args+=(--openai-api-key "$openai_key")
  fi

  # Run non-interactive onboarding with all required flags
  # --skip-health: Gateway isn't running yet (started after onboarding)
  # --skip-channels: Skip interactive channel setup
  # --accept-risk: Required for non-interactive mode
  docker compose -f "$instance_dir/docker-compose.yml" run --rm "moltbot-cli-${name}" "${onboard_args[@]}"

  echo ""
  echo "Instance '$name' onboarded successfully."
  echo "Start it with: ./docker-multi-setup.sh start $name"
}

# Start an instance
cmd_start() {
  local name="$1"
  local instance_dir
  instance_dir=$(get_instance_dir "$name")

  if [[ ! -d "$instance_dir" ]]; then
    echo "Instance '$name' does not exist." >&2
    exit 1
  fi

  echo "==> Starting instance: $name"
  docker compose -f "$instance_dir/docker-compose.yml" up -d "moltbot-gateway-${name}"

  local port
  port=$(get_instance_port "$name")
  echo ""
  echo "Instance '$name' started on port $port"
  echo "Logs: docker compose -f $instance_dir/docker-compose.yml logs -f moltbot-gateway-${name}"
}

# Stop an instance
cmd_stop() {
  local name="$1"
  local instance_dir
  instance_dir=$(get_instance_dir "$name")

  if [[ ! -d "$instance_dir" ]]; then
    echo "Instance '$name' does not exist." >&2
    exit 1
  fi

  echo "==> Stopping instance: $name"
  docker compose -f "$instance_dir/docker-compose.yml" down
  echo "Instance '$name' stopped."
}

# List all instances
cmd_list() {
  echo "Moltbot Instances"
  echo "================="
  echo ""

  if [[ ! -d "$INSTANCES_DIR" ]]; then
    echo "No instances found."
    return
  fi

  local found=false
  printf "%-15s %-8s %-10s %-20s\n" "NAME" "PORT" "STATUS" "CREATED"
  printf "%-15s %-8s %-10s %-20s\n" "----" "----" "------" "-------"

  for instance_dir in "$INSTANCES_DIR"/*/; do
    if [[ -f "$instance_dir/.instance.json" ]]; then
      found=true
      local name
      name=$(basename "$instance_dir")
      local port
      port=$(get_instance_port "$name")
      local created
      created=$(jq -r '.createdAt // "unknown"' < "$instance_dir/.instance.json" 2>/dev/null || echo "unknown")

      # Check if running
      local status="stopped"
      if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^moltbot-gateway-${name}$"; then
        status="running"
      fi

      printf "%-15s %-8s %-10s %-20s\n" "$name" "$port" "$status" "${created:0:10}"
    fi
  done

  if [[ "$found" == "false" ]]; then
    echo "No instances found."
  fi
}

# Remove an instance
cmd_remove() {
  local name="$1"
  local instance_dir
  instance_dir=$(get_instance_dir "$name")

  if [[ ! -d "$instance_dir" ]]; then
    echo "Instance '$name' does not exist." >&2
    exit 1
  fi

  echo "==> Removing instance: $name"

  # Stop if running
  docker compose -f "$instance_dir/docker-compose.yml" down 2>/dev/null || true

  # Remove directory
  rm -rf "$instance_dir"

  echo "Instance '$name' removed."
}

# Run CLI command on an instance
cmd_exec() {
  local name="$1"
  shift
  local instance_dir
  instance_dir=$(get_instance_dir "$name")

  if [[ ! -d "$instance_dir" ]]; then
    echo "Instance '$name' does not exist." >&2
    exit 1
  fi

  docker compose -f "$instance_dir/docker-compose.yml" run --rm "moltbot-cli-${name}" "$@"
}

# Show help
cmd_help() {
  cat <<EOF
docker-multi-setup.sh - Multi-instance Moltbot Docker deployment

USAGE:
  ./docker-multi-setup.sh <command> [arguments]

COMMANDS:
  create <name> [--no-onboard]   Create a new instance
  onboard <name> [options]       Run onboarding for an instance
    --auth-choice <choice>       Auth: apiKey|setup-token|skip
    --anthropic-api-key <key>    Anthropic API key
    --openai-api-key <key>       OpenAI API key
  start <name>                   Start an instance
  stop <name>                    Stop an instance
  list                           List all instances
  remove <name>                  Remove an instance
  exec <name> <cmd...>           Run CLI command on an instance
  help                           Show this help

ENVIRONMENT:
  CLAWDBOT_INSTANCES_DIR   Base directory for instances (default: ~/.clawdbot-instances)
  CLAWDBOT_IMAGE           Docker image to use (default: moltbot:local)
  CLAWDBOT_BASE_PORT       Starting port number (default: 18789)
  CLAWDBOT_GATEWAY_BIND    Gateway bind mode (default: lan)

EXAMPLES:
  # Create 3 user instances without interactive onboarding
  ./docker-multi-setup.sh create user1 --no-onboard
  ./docker-multi-setup.sh create user2 --no-onboard
  ./docker-multi-setup.sh create user3 --no-onboard

  # View all instances
  ./docker-multi-setup.sh list

  # Onboard each instance (non-interactive with defaults)
  ./docker-multi-setup.sh onboard user1 --auth-choice skip
  ./docker-multi-setup.sh onboard user2 --auth-choice skip
  ./docker-multi-setup.sh onboard user3 --auth-choice skip

  # Or onboard with API key
  ./docker-multi-setup.sh onboard user1 --auth-choice apiKey --anthropic-api-key sk-xxx

  # Start instances
  ./docker-multi-setup.sh start user1
  ./docker-multi-setup.sh start user2
  ./docker-multi-setup.sh start user3

  # Run CLI commands on an instance
  ./docker-multi-setup.sh exec user1 health --json
  ./docker-multi-setup.sh exec user1 providers add --provider telegram --token <token>

PORT ALLOCATION:
  Each instance gets ports spaced 20 apart to avoid conflicts:
  - user1: 18789, 18790 (bridge)
  - user2: 18809, 18810 (bridge)
  - user3: 18829, 18830 (bridge)

NOTE:
  This creates multiple isolated gateway instances, each with its own port.
  For scaling within a single gateway, use the worker pool feature instead:
    moltbot workers demo --workers 3
EOF
}

# Main
main() {
  if [[ $# -eq 0 ]]; then
    cmd_help
    exit 0
  fi

  local cmd="$1"
  shift

  case "$cmd" in
    create)
      if [[ $# -lt 1 ]]; then
        echo "Usage: $0 create <name> [--no-onboard]" >&2
        exit 1
      fi
      cmd_create "$@"
      ;;
    onboard)
      if [[ $# -lt 1 ]]; then
        echo "Usage: $0 onboard <name>" >&2
        exit 1
      fi
      cmd_onboard "$1"
      ;;
    start)
      if [[ $# -lt 1 ]]; then
        echo "Usage: $0 start <name>" >&2
        exit 1
      fi
      cmd_start "$1"
      ;;
    stop)
      if [[ $# -lt 1 ]]; then
        echo "Usage: $0 stop <name>" >&2
        exit 1
      fi
      cmd_stop "$1"
      ;;
    list)
      cmd_list
      ;;
    remove)
      if [[ $# -lt 1 ]]; then
        echo "Usage: $0 remove <name>" >&2
        exit 1
      fi
      cmd_remove "$1"
      ;;
    exec)
      if [[ $# -lt 2 ]]; then
        echo "Usage: $0 exec <name> <command...>" >&2
        exit 1
      fi
      cmd_exec "$@"
      ;;
    help|--help|-h)
      cmd_help
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      echo "Run '$0 help' for usage." >&2
      exit 1
      ;;
  esac
}

main "$@"
