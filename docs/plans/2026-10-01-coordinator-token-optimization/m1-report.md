# M1 — launcher theo role, coordinator không có MCP của editor: báo cáo

Ngày: 2026-10-02 · Branch `feat/coordinator-token-opt` · Self-review: có · Review độc lập: 1 vòng, đã sửa (§4).

## 1. Thay đổi

| File | Nội dung |
|---|---|
| `skills/new-cocos-game/scripts/bootstrap.mjs` | `agent-session` và `agent-cmd` nhận `--role producer\|coordinator\|worker\|judge` và `--slice S<nn>`. Có role thì lệnh launch có prefix `CC_ROLE`/`CC_PROJECT`/`CC_SLICE`. `agent-session` ghi một dòng vào `~/.agents/logs/spawns.jsonl`. Role `coordinator` bỏ MCP của editor (xem bảng dưới). Không có role thì lệnh giữ nguyên |
| `skills/new-cocos-game/tests/agent-launch.test.mjs` | 7 test mới, tổng 14 |
| `game-producer` (SKILL, `producer-prompt`, `fleet-slice-prompt`, `single-slice-prompt`), `new-cocos-game/SKILL.md`, `store-game-clone` (SKILL, `fleet-orchestrator-prompt`), `cocos-orca-fleet` (SKILL recipe B/C, `worker-prompts`) | Mọi chỗ spawn producer/coordinator/lane truyền `--role` (và `--slice` khi có slice). Thêm khuyến nghị: orchestrator dùng model mức Sonnet, không xuống Haiku |
| `.gitignore` | `/logs/` |

| Agent | Coordinator bỏ MCP thế nào |
|---|---|
| claude | `--strict-mcp-config` |
| claude-agent-teams | `--strict-mcp-config`, đánh dấu `stripped-all-unverified` (chưa kiểm wrapper Orca) |
| codex | Server của checkout: `-c …url=<url> -c …enabled=false` (nhắc lại url để không crash khi Codex không nạp config của checkout). Server global nối localhost qua HTTP: `-c …enabled=false`. **Giữ** server stdio global (`node_repl`, `computer-use`) |
| opencode | `OPENCODE_CONFIG_CONTENT` tắt mọi server đã khai báo |
| cursor, antigravity, gemini | Không hỗ trợ; báo trên stderr |

Producer giữ Funplay. Worker chỉ có env.

## 2. Kiểm trên CLI thật (2026-10-02)

| Kiểm | Kết quả |
|---|---|
| Không có `--role`: lệnh của claude, codex, cursor, opencode, antigravity, claude có model/effort | Giống hệt HEAD |
| `claude -p` trong cc-lego-stack, có/không `--strict-mcp-config` | 1 server/135 tool → 0 server/27 tool; context lượt đầu **52,3k → 35,8k** |
| Lệnh codex sinh cho coordinator, chạy `mcp list` trong thư mục không được trust | `funplay_cocos`, `unityMCP` đều `disabled`, không lỗi (bản đầu, chỉ `enabled=false`, làm codex dừng với `invalid transport`) |
| `OPENCODE_CONFIG_CONTENT` | Server `disabled`, phần config còn lại giữ nguyên |
| Prefix env qua `orca terminal create` | Claude, codex: identity đúng, `tui-idle` ok, agent đọc được env. OpenCode: identity đúng, env tới process nhưng shell tool lọc bớt biến. Antigravity: env tới agent. Cursor: chưa kiểm được env (chưa đăng nhập) |

Tất cả terminal thử nghiệm đã đóng.

## 3. Nghiệm thu

| Tiêu chí (PLAN M1) | Trạng thái |
|---|---|
| `agent-cmd --role coordinator --agent "claude --model sonnet"` in lệnh có env và strict MCP | ✅ |
| Một coordinator thật khởi động với lượt đầu giảm đúng phần MCP bị bỏ | Chờ pilot. `claude -p` đã cho thấy −16,5k |
| Một slice fleet thật chạy hết mà coordinator không cần Funplay | Chờ pilot |
| `spawns.jsonl` có đủ dòng cho mọi lane của slice pilot | Chờ pilot (đã có unit test) |

Pilot cần chạy từ code mới: hoặc merge vào `~/.agents` khi không có run nào (§5), hoặc trỏ project pilot vào worktree này.

## 4. Review độc lập

Vòng 1: CHANGES_REQUESTED, không có lỗi chặn.

| Phát hiện | Mức | Xử lý |
|---|---|---|
| Codex coordinator có thể crash: `enabled=false` cho server mà Codex không nạp (config checkout chưa trust) → `invalid transport` | major | Nhắc lại `url` cho server của checkout; server không có url thì bỏ qua; kiểm lại trong thư mục không trust |
| Prefix mới chỉ kiểm với claude/codex, trong khi cursor là orchestrator mặc định | major | Kiểm thêm cursor, opencode, antigravity và chạy đối chứng không prefix (§2). Identity của cursor/agy vốn `None` nên prefix không đổi gì; env của cursor còn chờ đăng nhập |
| Key quoted (`"f.g"`, `"a b"`) bị shell tách khi không quote cả tham số `-c` | minor | Quote từng tham số `-c` |
| TOML scan bỏ sót comment sau header, key nháy đơn, url nháy đơn, `[[array]]`; thiếu `[::1]`, `0.0.0.0`; `opencode.jsonc` lỗi im lặng | minor | Sửa, báo trên stderr khi không parse được, thêm test |
| `claude-agent-teams` ghi `stripped-all` mà chưa kiểm | minor | Đổi thành `stripped-all-unverified` |
| Câu "every lane spawn" trong skill nói quá; mode `single` không có role; thiếu `--slice` ở usage và store-game-clone; `--slice` không có `--role` bị bỏ qua im lặng | minor | Sửa câu chữ, mode `single` → `worker`, thêm `--slice`, `--slice` thiếu `--role` thì báo lỗi |
| Test "byte-identical" chỉ so với chính nó; thiếu test case biên | minor | So với HEAD bằng dry run (§2); thêm test TOML, quoting, teams, registry lỗi |
| `logs/` khớp mọi thư mục tên logs | minor | `/logs/` |

Các chỗ spawn không thuộc pipeline producer (`rip-port-analysis` analyst, `game-brief` author) giữ nguyên không có role; `token-report` nhận chúng là `helper` qua prompt.

## 5. Phát hiện ngoài phạm vi

- **`cursor-agent` trong terminal Orca chưa đăng nhập** (màn hình đăng nhập qua trình duyệt). Template mặc định dùng `cursor --model auto` cho orchestrator, scanner và reviewer, nên project mới sẽ dừng ở bước đăng nhập. Cần `cursor-agent login` một lần.
- Codex 0.160.0 đã thay bản 0.159.3 được ghi trong §3a. Cần chạy lại test hook trust của M2 trên bản mới.
