const RUNTIME_RECEIPT = '$HOME/.orca-cloud/runtime'
const COMPILE_CACHE = '$HOME/.orca-cloud/node-cache'

// Use the installed app's selector and preflight without starting a server in the builder.
const prepareRuntime = `
const { mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const prefix = 'ORCA_SERVE_RUNTIME '
const line = process.env.ORCA_SELECTION.split('\\n').find((line) => line.startsWith(prefix))
if (line) {
  const { kind, runtime, entry, version } = JSON.parse(line.slice(prefix.length))
  if (kind === 'orcad') {
    const result = spawnSync(runtime, [entry, '--orcad-startup-preflight', randomUUID()], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 90_000
    })
    if (result.status !== 0) process.exit(1)
    const receipt = process.env.ORCA_RUNTIME_RECEIPT
    mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 })
    writeFileSync(receipt, [runtime, entry, version, process.env.ORCA_RESOURCES, ''].join('\\n'), { mode: 0o600 })
  }
}
`

export const prepareOrcad = [
  'orca_resources=$(dirname "$(dirname "$(readlink -f "$(command -v orca-ide)")")")',
  'orca_app="$orca_resources/app.asar"',
  'orca_entry=out/main/orcad/orcad-local-serve-selection-entry.js',
  'if [ -f "$orca_resources/app.asar.unpacked/$orca_entry" ]; then',
  '  selection=$(ELECTRON_RUN_AS_NODE=1 "$orca_resources/../orca-ide" "$orca_app/$orca_entry" --user-data "${XDG_CONFIG_HOME:-$HOME/.config}/orca" --app-root "$orca_app")',
  `  ORCA_SELECTION="$selection" ORCA_RESOURCES="$orca_resources" ORCA_RUNTIME_RECEIPT="${RUNTIME_RECEIPT}" NODE_COMPILE_CACHE="${COMPILE_CACHE}" node --input-type=commonjs <<'ORCA_PREPARE_RUNTIME' || echo "Orca will verify and compile its runtime at launch." >&2`,
  prepareRuntime,
  'ORCA_PREPARE_RUNTIME',
  'fi'
].join('\n')

export const serveOrca = [
  'serve_orca() (',
  '  set -- --port "$ORCA_PORT" --project-root "$ORCA_PROJECT_ROOT" --pairing-address "$ORCA_PAIRING_ADDRESS" --recipe-json',
  `  runtime_receipt="${RUNTIME_RECEIPT}"`,
  '  if [ ! -r "$runtime_receipt" ] || ! { IFS= read -r runtime && IFS= read -r entry && IFS= read -r version && IFS= read -r resources; } < "$runtime_receipt" || [ ! -x "${runtime:-}" ] || [ ! -f "${entry:-}" ]; then',
  '    exec orca-ide serve "$@" 2>"$HOME/.orca-cloud-serve.log"',
  '  fi',
  '  export ORCA_USER_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/orca" ORCA_VERSION="$version"',
  `  export NODE_COMPILE_CACHE="${COMPILE_CACHE}"`,
  '  unset ELECTRON_RUN_AS_NODE',
  '  set -- --bind 0.0.0.0 "$@"',
  '  web="$resources/app.asar.unpacked/out/renderer"',
  '  if [ -f "$web/web-index.html" ] && [ -f "$web/.orca-web-client-files.json" ]; then',
  '    set -- "$@" --web-client-root "$web"',
  '  fi',
  '  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) arch= ;; esac',
  '  speech="$resources/node_modules/sherpa-onnx-linux-$arch"',
  '  if [ -f "$speech/sherpa-onnx.node" ]; then export ORCA_SPEECH_RECOGNIZER_DIR="$speech"; fi',
  '  receipt=$(mktemp "$HOME/.orca-cloud/ready.XXXXXX") || exit 1',
  '  trap \'rm -f "$receipt"\' EXIT',
  '  cd "$(dirname "$entry")" || exit 1',
  '  setsid "$runtime" "$entry" "$@" </dev/null >"$receipt" 2>"$HOME/.orca-cloud-serve.log" &',
  '  pid=$!',
  '  for attempt in $(seq 1 1200); do',
  '    if IFS= read -r line < "$receipt"; then printf "%s\\n" "$line"; exit 0; fi',
  '    if ! kill -0 "$pid" 2>/dev/null; then exit 1; fi',
  '    sleep 0.05',
  '  done',
  '  kill -TERM "$pid" 2>/dev/null || true',
  '  exit 1',
  ')'
].join('\n')
