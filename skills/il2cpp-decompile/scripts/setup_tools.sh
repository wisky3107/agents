#!/usr/bin/env bash
# Install or verify the IL2CPP decompile toolchain (macOS arm64). Idempotent.
#   setup_tools.sh           install what is missing, then verify
#   setup_tools.sh --check   verify only; exit 1 when something is missing
# Tools dir: $IL2CPP_TOOLS (default /Users/wikz/Works/agent/assets-ripper/tools).
# Prints the env block (JAVA_HOME, GHIDRA_INSTALL_DIR, REA_JADX_MCP_JAR, ...) on success.
set -euo pipefail

TOOLS="${IL2CPP_TOOLS:-/Users/wikz/Works/agent/assets-ripper/tools}"
CHECK=0; [[ "${1:-}" == "--check" ]] && CHECK=1

GHIDRA_VER=12.1.4
GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
CPP2IL_URL=https://github.com/SamboyCoding/Cpp2IL/releases/download/2022.1.0-pre-release.21/Cpp2IL-2022.1.0-pre-release.21-OSX-ARM64
INSPECTOR_URL=https://github.com/LukeFZ/Il2CppInspectorRedux/releases/download/2026.2/Il2CppInspectorRedux.Legacy.CLI-osx-arm64.zip
JADX_URL=https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar
JADX_SHA=6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75

JAVA_HOME_DIR=/opt/homebrew/opt/openjdk@21
GHIDRA_DIR="$TOOLS/ghidra_${GHIDRA_VER}_PUBLIC"
CPP2IL="$TOOLS/cpp2il/Cpp2IL"
INSPECTOR="$TOOLS/il2cppinspector/Il2CppInspectorRedux.Legacy.CLI-osx-arm64/Il2CppInspector"
JADX_JAR="$HOME/.local/share/rea/android/jadx-headless-mcp-0.7.1-all.jar"
REA="$HOME/.local/bin/rea"

missing=()
step() { echo "[setup] $*" >&2; }
# macOS kills unsigned downloaded arm64 binaries (exit 137): clear quarantine and ad-hoc sign.
sign() { chmod +x "$1"; xattr -c "$1" 2>/dev/null || true; codesign --force -s - "$1" 2>/dev/null; }

if [[ ! -x "$JAVA_HOME_DIR/bin/java" ]]; then
  if (( CHECK )); then missing+=("JDK 21 (brew install openjdk@21)"); else step "installing openjdk@21"; brew install openjdk@21 >&2; fi
fi

if [[ ! -x "$REA" ]]; then
  # The global npm prefix (/usr/local) is root-owned here, so REA goes to ~/.local.
  if (( CHECK )); then missing+=("REA ($REA)"); else step "installing rea-agents"; npm install --global --prefix "$HOME/.local" rea-agents >&2; fi
fi

if [[ ! -f "$JADX_JAR" ]] || ! echo "$JADX_SHA  $JADX_JAR" | shasum -a 256 -c - >/dev/null 2>&1; then
  if (( CHECK )); then missing+=("JADX headless jar ($JADX_JAR)"); else
    step "downloading jadx-headless-mcp 0.7.1"; mkdir -p "$(dirname "$JADX_JAR")"
    curl -fsSL -o "$JADX_JAR" "$JADX_URL"
    echo "$JADX_SHA  $JADX_JAR" | shasum -a 256 -c - >&2
  fi
fi

if [[ ! -x "$GHIDRA_DIR/support/analyzeHeadless" ]]; then
  if (( CHECK )); then missing+=("Ghidra $GHIDRA_VER ($GHIDRA_DIR)"); else
    step "downloading Ghidra $GHIDRA_VER"; mkdir -p "$TOOLS"
    curl -fsSL -o "$TOOLS/ghidra.zip" "$GHIDRA_URL"
    unzip -q "$TOOLS/ghidra.zip" -d "$TOOLS" && rm "$TOOLS/ghidra.zip"
  fi
fi
# The release zip ships no mac_arm_64 decompiler; build it from the bundled sources.
if [[ -d "$GHIDRA_DIR" && ! -x "$GHIDRA_DIR/Ghidra/Features/Decompiler/build/os/mac_arm_64/decompile" ]]; then
  if (( CHECK )); then missing+=("Ghidra mac_arm_64 natives (gradlew buildNatives)"); else
    step "building Ghidra native decompiler"
    (cd "$GHIDRA_DIR/support/gradle" && JAVA_HOME="$JAVA_HOME_DIR" PATH="$JAVA_HOME_DIR/bin:$PATH" ./gradlew buildNatives >&2)
  fi
fi

if [[ ! -x "$CPP2IL" ]]; then
  if (( CHECK )); then missing+=("Cpp2IL ($CPP2IL)"); else
    step "downloading Cpp2IL"; mkdir -p "$(dirname "$CPP2IL")"
    curl -fsSL -o "$CPP2IL" "$CPP2IL_URL"; sign "$CPP2IL"
  fi
fi

if [[ ! -x "$INSPECTOR" ]]; then
  if (( CHECK )); then missing+=("Il2CppInspectorRedux ($INSPECTOR)"); else
    step "downloading Il2CppInspectorRedux legacy CLI"; mkdir -p "$TOOLS/il2cppinspector"
    curl -fsSL -o "$TOOLS/il2cppinspector/legacy.zip" "$INSPECTOR_URL"
    unzip -q -o "$TOOLS/il2cppinspector/legacy.zip" -d "$TOOLS/il2cppinspector" && rm "$TOOLS/il2cppinspector/legacy.zip"
    sign "$INSPECTOR"
  fi
fi

if (( ${#missing[@]} )); then
  printf '[setup] missing: %s\n' "${missing[@]}" >&2
  exit 1
fi

# Verify that the signed binaries actually start (137 = killed by Gatekeeper/signing).
"$CPP2IL" --help >/dev/null 2>&1 || { rc=$?; [[ $rc -eq 137 ]] && { echo "[setup] Cpp2IL killed (137): re-sign it" >&2; exit 1; }; }
"$INSPECTOR" --help >/dev/null 2>&1 || { rc=$?; [[ $rc -eq 137 ]] && { echo "[setup] Il2CppInspector killed (137): re-sign it" >&2; exit 1; }; }

cat <<EOF
export JAVA_HOME=$JAVA_HOME_DIR
export GHIDRA_INSTALL_DIR=$GHIDRA_DIR
export REA_JADX_MCP_JAR=$JADX_JAR
export IL2CPP_CPP2IL=$CPP2IL
export IL2CPP_INSPECTOR=$INSPECTOR
export IL2CPP_REA=$REA
EOF
