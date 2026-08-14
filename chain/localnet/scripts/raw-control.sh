#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
localnet_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
state_root=${TORIUM_RAW_STATE_ROOT:-"$localnet_dir/.state/raw"}
binary=${TORIUMD_BINARY:-"$localnet_dir/../app/build/toriumd"}
action=${1:-status}
selected=${2:-${NODE:-}}

validate_node() {
  case "$1" in
    validator-0|validator-1|validator-2|validator-3) ;;
    *) echo "invalid node '$1'; expected validator-0 through validator-3" >&2; exit 64 ;;
  esac
}

nodes() {
  if [ -n "$selected" ]; then
    validate_node "$selected"
    echo "$selected"
  else
    echo "validator-0 validator-1 validator-2 validator-3"
  fi
}

pid_is_ours() {
  node=$1
  pid=$2
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command" in
    *toriumd*"--home $state_root/$node"*) return 0 ;;
    *) return 1 ;;
  esac
}

start_node() {
  node=$1
  home="$state_root/$node"
  pid_file="$home/data/toriumd.pid"
  log_file="$home/data/toriumd.log"
  [ -x "$binary" ] || { echo "missing executable toriumd binary: $binary" >&2; exit 1; }
  [ -f "$home/config/genesis.json" ] || { echo "missing prepared home for $node" >&2; exit 1; }
  if [ -f "$pid_file" ]; then
    pid=$(sed -n '1p' "$pid_file")
    if pid_is_ours "$node" "$pid"; then
      echo "$node already running (pid $pid)"
      return
    fi
    rm -f "$pid_file"
  fi
  nohup "$binary" start --home "$home" --log_format json --log_no_color --metrics >"$log_file" 2>&1 &
  pid=$!
  echo "$pid" >"$pid_file"
  sleep 1
  if ! pid_is_ours "$node" "$pid"; then
    echo "$node failed to start; inspect $log_file" >&2
    exit 1
  fi
  echo "$node started (pid $pid)"
}

stop_node() {
  node=$1
  pid_file="$state_root/$node/data/toriumd.pid"
  if [ ! -f "$pid_file" ]; then
    echo "$node is not running"
    return
  fi
  pid=$(sed -n '1p' "$pid_file")
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_file"
    echo "$node is not running (removed stale pid file)"
    return
  fi
  if ! pid_is_ours "$node" "$pid"; then
    echo "$node pid file is stale or belongs to another process; refusing to signal pid ${pid:-empty}" >&2
    exit 1
  fi
  kill -TERM "$pid"
  attempts=0
  while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 30 ]; do
    sleep 1
    attempts=$((attempts + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "$node did not stop after 30 seconds; refusing to force-kill it" >&2
    exit 1
  fi
  rm -f "$pid_file"
  echo "$node stopped"
}

status_node() {
  node=$1
  pid_file="$state_root/$node/data/toriumd.pid"
  port=$((26657 + ${node#validator-} * 100))
  if [ -f "$pid_file" ]; then
    pid=$(sed -n '1p' "$pid_file")
    if pid_is_ours "$node" "$pid"; then
      height=$(curl --silent --max-time 1 "http://127.0.0.1:$port/status" | jq -r '.result.sync_info.latest_block_height // "starting"' 2>/dev/null || echo starting)
      echo "$node running pid=$pid height=$height rpc=http://127.0.0.1:$port"
      return
    fi
  fi
  echo "$node stopped"
}

case "$action" in
  start)
    for node in $(nodes); do start_node "$node"; done
    ;;
  stop)
    reverse="validator-3 validator-2 validator-1 validator-0"
    if [ -n "$selected" ]; then reverse=$(nodes); fi
    for node in $reverse; do stop_node "$node"; done
    ;;
  restart)
    "$0" stop "$selected"
    "$0" start "$selected"
    ;;
  status)
    for node in $(nodes); do status_node "$node"; done
    ;;
  logs)
    files=""
    for node in $(nodes); do files="$files $state_root/$node/data/toriumd.log"; done
    # shellcheck disable=SC2086
    tail -n 200 -F $files
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs} [validator-0..validator-3]" >&2
    exit 64
    ;;
esac
