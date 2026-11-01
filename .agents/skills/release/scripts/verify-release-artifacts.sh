#!/bin/bash

set -euo pipefail

usage() {
  echo "Usage: verify-release-artifacts.sh <version> <artifact-root> <ad-hoc|self-signed|developer-id> [github-tag]" >&2
}

if [[ "$#" -lt 3 || "$#" -gt 4 ]]; then
  usage
  exit 2
fi

version="$1"
artifact_root="$2"
signing_mode="$3"
github_tag="${4:-}"

case "$signing_mode" in
  ad-hoc | self-signed | developer-id) ;;
  *)
    usage
    exit 2
    ;;
esac

artifact_root="$(cd "$artifact_root" && pwd -P)"

for required_command in awk codesign ditto file find grep hdiutil jq pgrep pkill sed shasum stat unzip; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $required_command" >&2
    exit 1
  fi
done

if [[ -n "$github_tag" ]] && ! command -v gh >/dev/null 2>&1; then
  echo "Required command is unavailable: gh" >&2
  exit 1
fi
if [[ "$signing_mode" == "developer-id" ]] && ! command -v xcrun >/dev/null 2>&1; then
  echo "Required command is unavailable: xcrun" >&2
  exit 1
fi

find_artifact() {
  local filename="$1"
  local matches
  local match_count

  matches="$(find "$artifact_root" -type f -name "$filename" -print)"
  if [[ -z "$matches" ]]; then
    echo "Missing release artifact: $filename" >&2
    return 1
  fi

  match_count="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
  if [[ "$match_count" != "1" ]]; then
    echo "Expected one $filename under $artifact_root, found $match_count." >&2
    return 1
  fi

  printf '%s' "$matches"
}

require_architecture() {
  local file_path="$1"
  local architecture="$2"
  local description="$3"
  local expected_architecture
  local file_output

  case "$architecture" in
    arm64) expected_architecture="arm64" ;;
    x64) expected_architecture="x86_64" ;;
  esac

  file_output="$(file "$file_path")"
  if ! grep -q "$expected_architecture" <<<"$file_output"; then
    echo "$description has the wrong architecture: $file_output" >&2
    return 1
  fi
}

signing_metadata() {
  codesign -dv --verbose=4 "$1" 2>&1
}

verify_signing() {
  local signed_path="$1"
  local description="$2"
  local metadata

  codesign --verify --deep --strict "$signed_path"
  metadata="$(signing_metadata "$signed_path")"

  case "$signing_mode" in
    ad-hoc)
      grep -q '^Signature=adhoc$' <<<"$metadata" ||
        {
          echo "$description is not ad hoc signed." >&2
          return 1
        }
      grep -q '^TeamIdentifier=not set$' <<<"$metadata" ||
        {
          echo "$description has an unexpected TeamIdentifier." >&2
          return 1
        }
      grep -q '^CodeDirectory .*flags=.*adhoc' <<<"$metadata" ||
        {
          echo "$description does not have the ad hoc CodeDirectory flag." >&2
          return 1
        }
      if grep -q '^CodeDirectory .*flags=.*runtime' <<<"$metadata"; then
        echo "$description unexpectedly enables hardened runtime." >&2
        return 1
      fi
      ;;
    self-signed)
      grep -q '^Authority=Fluxmail Self-Signed Code Signing$' <<<"$metadata" ||
        {
          echo "$description does not use the persistent Fluxmail certificate." >&2
          return 1
        }
      grep -q '^TeamIdentifier=not set$' <<<"$metadata" ||
        {
          echo "$description has an unexpected TeamIdentifier." >&2
          return 1
        }
      if grep -Eq '^CodeDirectory .*flags=.*(adhoc|runtime)' <<<"$metadata"; then
        echo "$description has an unexpected signing flag." >&2
        return 1
      fi
      ;;
    developer-id)
      grep -q '^Authority=Developer ID Application:' <<<"$metadata" ||
        {
          echo "$description is not signed with a Developer ID Application certificate." >&2
          return 1
        }
      grep -q '^CodeDirectory .*flags=.*runtime' <<<"$metadata" ||
        {
          echo "$description does not enable hardened runtime." >&2
          return 1
        }
      ;;
  esac
}

designated_requirement() {
  codesign -d -r- "$1" 2>&1 | sed -n 's/^.*designated =>/designated =>/p'
}

smoke_launch() {
  local executable="$1"
  local architecture="$2"
  local source_name="$3"
  local smoke_root="$verification_root/smoke-$architecture-$source_name"
  local log_path="$smoke_root/launch.log"
  local process_id
  local wait_status
  local shutdown_attempt

  mkdir -p "$smoke_root/user-data" "$smoke_root/fluxmail-data"

  FLUXMAIL_DESKTOP_E2E_HEADLESS=1 \
    FLUXMAIL_DATA_DIR="$smoke_root/fluxmail-data" \
    FLUXMAIL_TELEMETRY=0 \
    "$executable" \
    --use-mock-keychain \
    "--user-data-dir=$smoke_root/user-data" \
    >"$log_path" 2>&1 &
  process_id=$!

  sleep 3
  if ! kill -0 "$process_id" 2>/dev/null; then
    wait_status=0
    wait "$process_id" || wait_status=$?
    echo "Fluxmail ${architecture} ${source_name} exited during the launch smoke test with status $wait_status." >&2
    sed -n '1,120p' "$log_path" >&2
    return 1
  fi

  kill -TERM "$process_id" 2>/dev/null || true
  pkill -TERM -f "$smoke_root" 2>/dev/null || true
  for shutdown_attempt in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$process_id" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if kill -0 "$process_id" 2>/dev/null; then
    kill -KILL "$process_id" 2>/dev/null || true
  fi
  pkill -KILL -f "$smoke_root" 2>/dev/null || true
  wait "$process_id" 2>/dev/null || true
  sleep 1
}

verified_requirement=""

verify_app_bundle() {
  local app_path="$1"
  local architecture="$2"
  local source_name="$3"
  local executable="$app_path/Contents/MacOS/Fluxmail"
  local resources="$app_path/Contents/Resources"
  local framework="$app_path/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
  local better_sqlite_path
  local argon2_path
  local requirement

  if [[ ! -d "$app_path" || ! -x "$executable" ]]; then
    echo "$source_name does not contain an executable Fluxmail.app for $architecture." >&2
    return 1
  fi

  better_sqlite_path="$(find "$resources" -type f -name 'better_sqlite3.node' -print -quit)"
  argon2_path="$(find "$resources" -type f -path "*@node-rs/argon2-darwin-${architecture}/*" -name '*.node' -print -quit)"

  if [[ -z "$better_sqlite_path" || -z "$argon2_path" ]]; then
    echo "$source_name is missing a required native module for $architecture." >&2
    return 1
  fi

  require_architecture "$executable" "$architecture" "Fluxmail executable ($source_name)"
  require_architecture "$better_sqlite_path" "$architecture" "better-sqlite3 ($source_name)"
  require_architecture "$argon2_path" "$architecture" "Argon2 ($source_name)"
  verify_signing "$app_path" "Fluxmail.app ($source_name)"
  verify_signing "$framework" "Electron Framework ($source_name)"

  requirement="$(designated_requirement "$app_path")"
  if [[ "$signing_mode" != "ad-hoc" && -z "$requirement" ]]; then
    echo "Fluxmail.app in $source_name has no designated requirement." >&2
    return 1
  fi
  if [[ "$signing_mode" == "self-signed" ]]; then
    grep -q 'identifier "ai.fluxmail.desktop"' <<<"$requirement" ||
      {
        echo "The self-signed designated requirement in $source_name has the wrong identifier." >&2
        return 1
      }
    grep -q 'certificate root = H"' <<<"$requirement" ||
      {
        echo "The self-signed designated requirement in $source_name does not pin the certificate." >&2
        return 1
      }
  fi

  if [[ "$signing_mode" == "developer-id" ]]; then
    xcrun stapler validate "$app_path"
  fi

  smoke_launch "$executable" "$architecture" "$source_name"
  verified_requirement="$requirement"
}

artifact_names=(
  "Fluxmail-${version}-arm64.dmg"
  "Fluxmail-${version}-x64.dmg"
  "Fluxmail-darwin-arm64-${version}.zip"
  "Fluxmail-darwin-x64-${version}.zip"
  "RELEASES-darwin-arm64.json"
  "RELEASES-darwin-x64.json"
)
artifact_paths=()

for artifact_name in "${artifact_names[@]}"; do
  artifact_paths+=("$(find_artifact "$artifact_name")")
done

for artifact_path in "${artifact_paths[@]}"; do
  if [[ ! -s "$artifact_path" ]]; then
    echo "Release artifact is empty: $artifact_path" >&2
    exit 1
  fi
done

hdiutil verify "${artifact_paths[0]}"
hdiutil verify "${artifact_paths[1]}"
unzip -tq "${artifact_paths[2]}"
unzip -tq "${artifact_paths[3]}"

verification_root="$(mktemp -d "${TMPDIR:-/tmp}/fluxmail-artifact-verification.XXXXXX")"
current_mount=""

detach_current_mount() {
  if [[ -n "$current_mount" && -d "$current_mount" ]]; then
    if ! hdiutil detach "$current_mount" >/dev/null 2>&1; then
      sleep 1
      hdiutil detach "$current_mount" >/dev/null 2>&1 ||
        hdiutil detach -force "$current_mount" >/dev/null
    fi
  fi
  current_mount=""
}

cleanup() {
  detach_current_mount || true
  rm -rf "$verification_root"
}
trap cleanup EXIT

expected_requirement=""

for architecture in arm64 x64; do
  if [[ "$architecture" == "x64" && "$(uname -m)" == "arm64" ]]; then
    if ! arch -x86_64 uname -m >/dev/null 2>&1; then
      echo "Rosetta is required to smoke-test the x64 artifact." >&2
      exit 1
    fi
  fi

  if [[ "$architecture" == "arm64" ]]; then
    dmg_path="${artifact_paths[0]}"
    zip_path="${artifact_paths[2]}"
  else
    dmg_path="${artifact_paths[1]}"
    zip_path="${artifact_paths[3]}"
  fi

  current_mount="$verification_root/mount-$architecture"
  mkdir -p "$current_mount"
  hdiutil attach -readonly -nobrowse -mountpoint "$current_mount" "$dmg_path" >/dev/null

  verify_app_bundle "$current_mount/Fluxmail.app" "$architecture" "${architecture}-dmg"
  if [[ "$signing_mode" != "ad-hoc" ]]; then
    if [[ -z "$expected_requirement" ]]; then
      expected_requirement="$verified_requirement"
    elif [[ "$expected_requirement" != "$verified_requirement" ]]; then
      echo "The designated requirement in the ${architecture} DMG differs from the other artifacts." >&2
      exit 1
    fi
  fi

  detach_current_mount

  zip_root="$verification_root/zip-$architecture"
  mkdir -p "$zip_root"
  ditto -x -k "$zip_path" "$zip_root"

  verify_app_bundle "$zip_root/Fluxmail.app" "$architecture" "${architecture}-zip"
  if [[ "$signing_mode" != "ad-hoc" && "$expected_requirement" != "$verified_requirement" ]]; then
    echo "The designated requirement in the ${architecture} ZIP differs from the other artifacts." >&2
    exit 1
  fi
done

github_metadata=""
if [[ -n "$github_tag" ]]; then
  github_metadata="$(gh release view "$github_tag" --json tagName,isDraft,isPrerelease,assets)"

  [[ "$(jq -r '.tagName' <<<"$github_metadata")" == "$github_tag" ]]
  [[ "$(jq -r '.isDraft' <<<"$github_metadata")" == "false" ]]
  [[ "$(jq -r '.isPrerelease' <<<"$github_metadata")" == "false" ]]
  [[ "$(jq '.assets | length' <<<"$github_metadata")" == "6" ]]
fi

for artifact_index in "${!artifact_names[@]}"; do
  artifact_name="${artifact_names[$artifact_index]}"
  artifact_path="${artifact_paths[$artifact_index]}"
  digest="sha256:$(shasum -a 256 "$artifact_path" | awk '{print $1}')"
  byte_size="$(stat -f '%z' "$artifact_path")"

  if [[ -n "$github_metadata" ]]; then
    github_digest="$(jq -r --arg name "$artifact_name" '.assets[] | select(.name == $name) | .digest' <<<"$github_metadata")"
    github_size="$(jq -r --arg name "$artifact_name" '.assets[] | select(.name == $name) | .size' <<<"$github_metadata")"
    github_state="$(jq -r --arg name "$artifact_name" '.assets[] | select(.name == $name) | .state' <<<"$github_metadata")"

    if [[ "$github_digest" != "$digest" || "$github_size" != "$byte_size" || "$github_state" != "uploaded" ]]; then
      echo "GitHub metadata does not match $artifact_name." >&2
      exit 1
    fi
  fi

  printf '%s  %s  %s bytes\n' "$digest" "$artifact_name" "$byte_size"
done

for architecture in arm64 x64; do
  manifest_path="$(find_artifact "RELEASES-darwin-${architecture}.json")"
  manifest_url="https://github.com/fluxmailai/fluxmail-desktop/releases/download/v${version}/Fluxmail-darwin-${architecture}-${version}.zip"
  if ! jq -e --arg version "$version" --arg url "$manifest_url" \
    '.currentRelease == $version and .releases[0].version == $version and .releases[0].updateTo.url == $url' \
    "$manifest_path" >/dev/null; then
    echo "Update manifest does not match Fluxmail ${version}: $manifest_path" >&2
    exit 1
  fi
done

echo "Release artifact verification passed for Fluxmail ${version} (${signing_mode})."
