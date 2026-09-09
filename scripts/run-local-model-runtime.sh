#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
base_url="${LOCAL_MODEL_BASE_URL:-http://127.0.0.1:11434/v1}"
host_port="${base_url#*://}"
host_port="${host_port%%/*}"
host="${host_port%%:*}"
if [[ "$host" != "localhost" && "$host" != "127.0.0.1" && "$host" != "[::1]" ]]; then
  print -u2 "Local model runtime: refusing non-loopback bind from LOCAL_MODEL_BASE_URL."
  exit 64
fi
export OLLAMA_HOST="$host_port"
if [[ "${AGENTFLOW_LOCAL_MODEL_RUNTIME:-ollama}" == "llama-server" ]]; then
  llama_bin="/opt/homebrew/opt/ollama/libexec/lib/ollama/llama-server"
  [[ -x "$llama_bin" ]] || llama_bin="/usr/local/opt/ollama/libexec/lib/ollama/llama-server"
  if [[ ! -x "$llama_bin" || -z "${LOCAL_MODEL_FILE:-}" || ! -f "$LOCAL_MODEL_FILE" ]]; then
    print -u2 "Local model runtime: llama-server binary or LOCAL_MODEL_FILE is missing."
    exit 127
  fi
  model_alias="${LOCAL_MODEL_FAST:-${LOCAL_MODEL_NAME:-local-model}}"
  exec "$llama_bin" --model "$LOCAL_MODEL_FILE" --alias "$model_alias" --host "$host" --port "${host_port##*:}" -c "${LOCAL_MODEL_CONTEXT_SIZE:-8192}" -np 1 --no-webui
fi
ollama_bin="$(command -v ollama || true)"
if [[ -z "$ollama_bin" ]]; then
  print -u2 "Local model runtime: Ollama was not found on the stable developer PATH."
  exit 127
fi
exec "$ollama_bin" serve
