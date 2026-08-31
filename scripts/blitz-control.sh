#!/usr/bin/env sh

set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "blitz-control.sh currently supports macOS only (it reads the descriptor with plutil)" >&2
  exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
descriptor=${TAURI_BLITZ_DRIVER_DESCRIPTOR:-$repo_root/target/blitz-driver.json}
command=${1:-status}
session_id=
driver_address=

json_field() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

delete_session() {
  if [ -n "$session_id" ] && [ -n "$driver_address" ]; then
    /usr/bin/curl --silent --max-time 2 -X DELETE \
      "http://$driver_address/session/$session_id" >/dev/null 2>&1 || true
  fi
}
trap delete_session EXIT HUP INT TERM

wait_for_descriptor() {
  previous_pid=${1:-}
  attempts=0
  while [ "$attempts" -lt 300 ]; do
    if [ -f "$descriptor" ]; then
      candidate_pid=$(json_field "$descriptor" pid || true)
      candidate_address=$(json_field "$descriptor" address || true)
      if [ -n "$candidate_pid" ] && [ "$candidate_pid" != "$previous_pid" ] \
        && [ -n "$candidate_address" ] \
        && /usr/bin/curl --silent --fail --max-time 1 \
          "http://$candidate_address/status" >/dev/null 2>&1
      then
        /usr/bin/printf '%s\n' "$candidate_pid"
        return 0
      fi
    fi
    attempts=$((attempts + 1))
    /bin/sleep 0.1
  done
  return 1
}

if [ ! -f "$descriptor" ]; then
  /usr/bin/printf 'Blitz inspector descriptor is missing: %s\n' "$descriptor" >&2
  exit 1
fi

driver_pid=$(json_field "$descriptor" pid)
driver_address=$(json_field "$descriptor" address)

case "$command" in
  status)
    /usr/bin/curl --silent --show-error --fail --max-time 3 \
      "http://$driver_address/status"
    /usr/bin/printf '\n'
    exit 0
    ;;
  restart) ;;
  *)
    /usr/bin/printf 'usage: %s [status|restart]\n' "$0" >&2
    exit 2
    ;;
esac

driver_token=$(json_field "$descriptor" token)
session_response=$(/usr/bin/curl --silent --show-error --fail --max-time 5 \
  -X POST "http://$driver_address/session" \
  -H 'Content-Type: application/json' \
  --data "{\"capabilities\":{\"alwaysMatch\":{\"blitz:token\":\"$driver_token\"}}}")
session_id=$(/usr/bin/printf '%s' "$session_response" \
  | /usr/bin/sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
if [ -z "$session_id" ]; then
  /usr/bin/printf 'Could not create a Blitz inspector session; another client may still own it.\n' >&2
  exit 1
fi

/usr/bin/curl --silent --show-error --fail --max-time 5 \
  -X POST "http://$driver_address/session/$session_id/execute/sync" \
  -H 'Content-Type: application/json' \
  --data '{"script":"window.__TAURI_INTERNALS__.invoke(\"relaunch_app\"); return null;","args":[]}' \
  >/dev/null

# The process owns this session and is exiting, so there is nothing useful to
# delete. Clearing it also prevents the cleanup request from racing relaunch.
session_id=
if replacement_pid=$(wait_for_descriptor "$driver_pid"); then
  /usr/bin/printf 'Blitz restarted: %s -> %s\n' "$driver_pid" "$replacement_pid"
else
  /usr/bin/printf 'Blitz did not publish a healthy replacement within 30 seconds.\n' >&2
  exit 1
fi
