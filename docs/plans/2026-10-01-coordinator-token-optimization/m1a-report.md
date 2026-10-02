# M1a — vệ sinh config MCP: báo cáo

Ngày: 2026-10-02 · Self-review: có · Review độc lập: 1 vòng, đã sửa (§4).
Hai repo, cùng tên nhánh `feat/coordinator-token-opt`:
- `~/.agents` (worktree `~/.agents-wt/coordinator-token-opt`);
- template `cc-game-template` (worktree `~/Works/games/template-wt/cc-game-template-token-opt`).

## 1. Thay đổi

**`skills/new-cocos-game/scripts/bootstrap.mjs`**
- `mcp-config` ghi thêm `<checkout>/opencode.json`: thay cả entry `mcp.funplay_cocos` (cc4: `mcp.cocos-cli`), giữ nguyên mọi key khác.
  - Không ghi đè file JSONC hay file git đang track, chỉ cảnh báo.
  - Tự thêm vào `.git/info/exclude` khi chưa được ignore; nếu project nằm trong thư mục con của repo thì pattern tính theo prefix.
  - `opencode.json` vào `RSYNC_EXCLUDES`.
- Lệnh mới `mcp-audit [--fix [--fix-port-matches]] [--home <dir>]`: quét `~/.claude.json` (chỉ `mcpServers` top-level), `~/.cursor/mcp.json`, `opencode.json`/`opencode.jsonc` (theo `XDG_CONFIG_HOME`), `~/.codex/config.toml` (kể cả entry inline dưới `[mcp_servers]`).
  - **Khớp tên** (`funplay_cocos`, `cocos-*-<hex6>`): `--fix` xoá.
  - **Khớp port** (127.0.0.1/localhost/0.0.0.0/[::1] trên 8765–8799 hoặc 9527–9559): chỉ báo, trừ khi có `--fix-port-matches` (wrangler mặc định dùng 8787).
  - Đọc các field `url`/`serverUrl`/`httpUrl`.
  - **Chỉ báo, không sửa:** file JSONC, `projects.*.mcpServers` của claude, file không parse được.
  - `--fix`: backup `<file>.bak-mcp-audit-<ts>`, ghi atomic, giữ quyền file, ghi xuyên qua symlink. TOML xoá theo block, comment ngay trên table kế tiếp được giữ lại. `~/.claude.json` chỉ được thay khi file không đổi trong lúc đang sửa (thử lại tối đa 5 lần).
  - `ok` chỉ đúng khi không còn finding, file lỗi hay lỗi ghi. Exit 2 nếu chưa `ok`. `--home` thiếu giá trị thì báo lỗi, không rơi về home thật.
- `create` và `mcp-config` tự chạy audit ở chế độ chỉ báo (stderr, stdout giữ nguyên).
- `skills/new-cocos-game/tests/mcp-audit.test.mjs`: 5 test.

**Template `cc-game-template`**
- `.gitignore`: `/opencode.json`.
- `.cursor/rules/00-guardrails.mdc`: luật 8, cấm sửa config MCP global và cấm dùng Funplay "Configure client".
- `.cursor/skills/cocos-orca-worktree/SKILL.md`: luật tương tự; liệt kê `opencode.json` trong các file theo checkout.
- `.cursor/skills/vibe-game-director/reference/cocos-mcp-playbook.md`: thêm `opencode.json`; không dùng nút Configure client hay helper `configureClient`.
- `scripts/open-editor.sh`: thiếu `opencode.json` thì chạy lại `mcp-config` (checkout cũ cũng có file này).

## 2. Nghiệm thu

| Tiêu chí (PLAN M1a) | Kết quả |
|---|---|
| `mcp-audit` trên máy hiện tại trả 0 entry | ✅ `ok: true`, exit 0; 1 entry project-scoped trong `~/.claude.json` được báo, không sửa |
| Chép backup cũ vào thư mục tạm: phát hiện đúng entry đã xoá, `--fix` cho ra bản tương đương bản dọn tay | ✅ 11 entry; codex **giống hệt từng byte**, cursor/opencode bằng nhau về JSON; quyền 600 giữ nguyên |
| Agent OpenCode trong checkout mới thấy đúng Funplay của checkout | ✅ `opencode mcp list` trong checkout tạm có `funplay_cocos` của checkout (cùng server global) |
| Unit test cho luật deny ghi vào config global | ⏳ thuộc guard M2 (chưa có guard core) |
| Audit tự chạy ở `producer-runner start` | ⏳ thuộc M4 (runner chưa có) |

Test: 19/19 (`node --test skills/new-cocos-game/tests/*.test.mjs`).

## 3. Không làm / follow-up

- **Nút "Configure client" của extension Funplay vẫn ghi vào config global.** Plan cho phép để sau. Cách chặn: patch `extensions/funplay-cocos-mcp-plugin/lib/client-config.js` của template (ẩn nút hoặc ghi vào config theo checkout). Hiện chỉ có luật trong rule/skill, và `mcp-audit` phát hiện được nếu nút bị dùng.
- **Đặt `clientConfigEntries: {}`: bỏ.** Reviewer chỉ ra `mcp-config` vốn đã không giữ field này (không nằm trong danh sách kế thừa), còn extension chỉ dùng nó để gỡ entry cũ của chính nó, nên dòng đó không có tác dụng.
- **Template `cc-playable-template` và `cc4-game-template` chưa sửa text.** Nhánh của playable đang có 7 commit chưa push của người khác. Project tạo từ hai template này vẫn được `bootstrap.mjs` tự thêm `opencode.json` vào `info/exclude`.
- **Project đang có** (block-out, lego-stack, monopoly…) không tự nhận luật mới trong `.cursor/rules` và skill bản copy; phải sync tay sau khi merge (§9 mục 12).

## 4. Review độc lập

Vòng 1: CHANGES_REQUESTED. Ba điểm chặn (1–3) và hai điểm nên làm cùng lượt (4–5).

| Phát hiện | Mức | Xử lý |
|---|---|---|
| `--fix` làm mất quyền 0600 của file chứa credential; symlink bị thay bằng file thường | major | Ghi qua `realpath`, giữ `mode` |
| Xoá block TOML cuốn theo comment của table kế tiếp; gom dòng trắng toàn file | major | Comment ngay trên table kế tiếp được giữ; bỏ bước gom toàn file |
| File không parse được bị bỏ qua mà vẫn `ok`; không quét `opencode.jsonc` | major | Báo `unparsed`, `ok: false`; quét `.jsonc` (chỉ báo) và `XDG_CONFIG_HOME` |
| Race khi ghi `~/.claude.json` | minor | Kiểm mtime/size trước khi thay, thử lại; vẫn còn một khe nhỏ, nên đóng session trước khi `--fix` |
| Port-only match bị xoá (ví dụ wrangler 8787) | minor | Chỉ báo, trừ khi `--fix-port-matches` |
| Thiếu `serverUrl`/`httpUrl`, `[::1]`/`0.0.0.0`, entry inline của codex | minor | Thêm. Server local của OpenCode có URL nằm trong `command`/`environment` vẫn chưa nhận |
| Exit luôn 0; `--home` rỗng rơi về home thật; key thiếu làm `--fix` dừng giữa chừng | minor | Exit 2; `--home` rỗng báo lỗi; lỗi theo từng file được gom vào `errors` |
| `writeOpencodeJson` ghi đè JSONC, sửa file git đang track, tạo entry lai local+remote, sai pattern khi project ở thư mục con | minor | Sửa cả bốn, có test |
| `clientConfigEntries: {}` không có tác dụng | minor | Bỏ; ghi follow-up (§3) |
| Template: bảng file theo checkout thiếu `opencode.json`; `open-editor.sh` không kiểm `opencode.json`; comment sai trong `bootstrap.mjs` | minor | Sửa |
| Audit ở `producer-runner start` chưa có | minor | Chuyển sang M4 |

Không chạy vòng review thứ hai. Phần sửa được phủ bằng test mới và hai lần chạy nghiệm thu lại (§2).
