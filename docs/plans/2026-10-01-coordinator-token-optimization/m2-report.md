# M2 — `orca-wait` và coordinator guard: báo cáo

Ngày: 2026-10-02 · Branch `feat/coordinator-token-opt` (+ template `cc-game-template`, cùng tên nhánh) · Self-review: có · Review độc lập: xem §6.

## 1. Thay đổi

| File | Nội dung |
|---|---|
| `skills/cocos-orca-fleet/scripts/orca-wait.mjs` | `coord`: bọc `check --wait`, nuốt keepalive, in một dòng JSON (body cắt 2 dòng; Delivery đầy đủ ghi ra file `full`). `lane`: chờ terminal idle theo từng chunk 60s, mỗi chunk đọc lại `coordinator_handle` từ `run-show` (takeover), kiểm gate đang chờ và HANDOFF; trả `event`, `idle_streak` (lưu ở `--state`), `unread_to_run`. Mặc định `--max-ms 540000`. Mỗi lần gọi báo nếu cheatsheet cũ hoặc guard không chạy |
| `hooks/coordinator-guard.mjs` | Guard core: `classify()` thuần, không phụ thuộc provider; state theo session ở `$TMPDIR/coordinator-guard/`; log `~/.agents/logs/coordinator-guard.jsonl`; adapter CLI cho claude/codex (exit 2 + stderr) và cursor (JSON) |
| `hooks/adapters/opencode-plugin.js` | Adapter OpenCode chạy trong process (`tool.execute.before`, chặn bằng throw) |
| `skills/new-cocos-game/scripts/bootstrap.mjs` | `agent-session --role coordinator|producer` cài hook vào checkout theo CLI (idempotent, giữ hook khác, thêm vào exclude của git); codex có thêm `--dangerously-bypass-hook-trust`; OpenCode được làm nóng (`opencode debug config`) để plugin chạy ngay từ lần khởi động đầu; `RSYNC_EXCLUDES` thêm các file hook |
| Skills | `cocos-orca-fleet`: Coordinator loop dùng `orca-wait coord`; Step 0.4 dùng `bootstrap.mjs wait-mcp` thay vòng retry; bảng hỗ trợ guard theo provider, rủi ro trust của Codex. `game-producer`: §Waiting dùng `orca-wait lane`; luật nudge/hung theo `idle_streak`; 2d.3 dùng `wait-mcp`. `fleet-slice-prompt`: vòng chờ dùng `orca-wait coord` |
| Template | `.gitignore`: các file hook theo checkout |
| Tests | `hooks/tests/coordinator-guard.test.mjs` (11 test, lấy case thật từ transcript Claude và Codex), `skills/cocos-orca-fleet/tests/orca-wait.test.mjs` (5, `orca` giả), `agent-launch.test.mjs` (+1: cài hook), `hooks/tests/adapters-live.mjs` (chạy thật từng CLI) |

**Luật của guard** (chỉ khi có `CC_ROLE`; `CC_GUARD_MODE` = `shadow` mặc định · `block` · `off`):

| Luật | Áp cho | Chặn khi |
|---|---|---|
| `global-mcp-config` | mọi role | ghi vào config MCP global (redirect, `sed -i`, `cp`/`mv`, `tee`, `codex|claude mcp add`…, Edit/Write của Claude) |
| `producer-lane-run` | producer | `run-use`, `gate-resolve`, `task-create/update`, `worker-*` (trừ list/show/read), `dispatch`, `send`, `reply`, `--from` |
| `check-polling` | producer, coordinator | `check` trần thứ hai trước lần chờ kế tiếp (một lần là giao thức wake-up) |
| `read-unbounded` / `read-without-wait` | như trên | `terminal read` không có `--limit ≤ 40`/`--screen`/pipe; đọc lại cùng handle mà không có wait/send ở giữa (lần đọc đầu được phép) |
| `long-sleep` / `sleep-loop` | như trên | `sleep` > 30s; vòng `until/while/for … do … sleep … done` |
| `detached-wait` / `wait-over-cap` | như trên | lệnh chờ bị `nohup`/`setsid`/`&`/`disown` hoặc stdout ghi ra file; `--timeout-ms` > 570000 |
| `help-repeat` | như trên | `orca … --help` lần thứ hai cho cùng subcommand (lần đầu chỉ cảnh báo) |

Mọi luật chỉ dựa vào chuỗi lệnh (hook không thấy wake-up hay kết quả).

Lệnh được đọc bằng một bộ tách lệnh shell nhỏ:
- chỉ tách ở cấp ngoài cùng; text trong dấu ngoặc, nội dung heredoc và comment là dữ liệu;
- thân `$( … )` và backtick được đọc như lệnh riêng;
- dòng nối bằng `\` được ghép lại;
- bỏ các từ khoá đứng đầu (`do`, `then`, `if`, `nohup`…).

Mọi lần quét đều tuyến tính.

Ngoài ra:
- `run_in_background` của Claude tính là detach;
- Codex và Claude chỉ được phân loại với tool `Bash` (và các tool ghi file của Claude);
- state theo session hết hạn sau 12 giờ;
- log xoay vòng khi vượt 5MB.

## 2. Replay trên lệnh thật (09-24 → 10-01, Claude + Codex, 6.870 lệnh)

| Role | Cho qua | Chỉ cảnh báo (`--help` lần đầu) | Sẽ bị chặn |
|---|---|---|---|
| fleet coordinator | 3.967 | 158 | **452 (9,9%)**: help-repeat 120, read-without-wait 106, wait-over-cap 88, check-polling 62, read-unbounded 35, sleep-loop 21, detached-wait 14, long-sleep 6 |
| producer | 1.954 | 41 | **298 (13,0%)**: read-without-wait 97, sleep-loop 75, read-unbounded 62, help-repeat 23, producer-lane-run 15, wait-over-cap 14, long-sleep 8, detached-wait 3, check-polling 1 |

(Số sau review vòng 1, với bộ tách lệnh hiểu dấu ngoặc. `check-polling` tăng vì giờ thấy được cả `R=$(orca orchestration check …)`.)

Ba vòng xem mẫu đã loại các chặn nhầm tìm được:
- chuỗi `orca` trong prompt hoặc message;
- heredoc;
- redirect của lệnh khác trên cùng dòng;
- read có pipe;
- chữ "while" trong văn bản;
- lần đọc đầu tiên một terminal;
- prefix dạng `VAR=$(…)`.

Các mẫu còn lại đều là đúng loại hành vi plan muốn chặn: vòng theo dõi HANDOFF, chờ 600000–1800000 ms, chờ rồi ghi stdout ra file, producer tự `gate-resolve`/`run-use`/`task-create`. Đây là **đánh giá trên dữ liệu cũ**. Tiêu chí "0 chặn nhầm ở shadow" vẫn phải đo trên slice pilot.

## 3. Kiểm trên CLI thật (`node hooks/tests/adapters-live.mjs`, 2026-10-02)

| CLI | Kết quả |
|---|---|
| Claude Code 2.1.287 | pass: lệnh bị chặn, model nhận lý do, log có entry |
| Codex 0.160.0 | pass. Payload PreToolUse cùng dạng Claude (`tool_input.command`) |
| OpenCode 1.18.33 | pass, sau hai phát hiện: (a) lần khởi động đầu tiên trong một checkout, OpenCode cài `.opencode/node_modules` và có thể bỏ qua plugin của project, nên bootstrap làm nóng bằng `opencode debug config`; (b) khi gọi `opencode run` thẳng từ node, hook không ổn định, còn chạy qua shell (như Orca) thì ổn định |
| Cursor Agent | skip: `cursor-agent status` báo "Logged in" nhưng `-p` vẫn đòi xác thực. Adapter chỉ được test offline (I/O JSON) |

Phát hiện phụ:
- Claude Code tự chặn lệnh `sleep 45; …` trước cả hook. Test live vì vậy dùng một lệnh tự kiểm (`CC_GUARD_SELFTEST=1`) không có tác dụng phụ.
- `orca-wait lane` đã chạy chỉ-đọc trên Run thật của cc-lego-stack (handle sau takeover, HANDOFF `approved_targeted`).

## 4. Nghiệm thu

| Tiêu chí (PLAN M2) | Trạng thái |
|---|---|
| Unit test cho `classify` phủ mọi allowlist và vi phạm, case thật từ transcript (cả Codex) | ✅ 11 test |
| Test adapter qua với claude, codex, opencode; cursor trong terminal Orca đã đăng nhập | ✅ claude/codex/opencode; ⏳ cursor (chờ đăng nhập `-p`) |
| `orca-wait lane --run` theo đúng handle mới sau takeover | ✅ unit test; chạy chỉ-đọc trên Run thật |
| Coordinator chạy bằng ≥ 2 provider hoàn thành một slice, guard log có entry của cả hai | ⏳ pilot |
| ≥ 1 slice ở `shadow` với 0 cảnh báo nhầm, rồi mới bật `block` | ⏳ pilot |
| Sau 1 slice ở `block`: lượt coordinator −40% so với baseline, không stall | ⏳ pilot |

## 5. Rủi ro và giới hạn

- **Giới hạn chờ là chung** (570000 ms, theo Claude). Codex có thể cho phép lâu hơn; `CC_GUARD_MAX_WAIT_MS` để chỉnh.
- **Codex `exec` trả quyền về cho model sau `yield_time_ms`**, rồi model gọi tool `wait` để đọc tiếp. Một lần `orca-wait` dài vẫn có thể thành nhiều lượt với Codex. Chưa xử lý; cần đo ở pilot với coordinator Codex.
- **Luật global-config** chỉ phủ session có `CC_ROLE` trong checkout có file hook (producer, coordinator, single lane trong main checkout). Worker fleet trong worktree không được phủ (M1a §4).
- **Codex và `--dangerously-bypass-hook-trust`:** bỏ qua bước trust cho mọi hook của project. Chấp nhận vì checkout và hook đều thuộc repo của director (PLAN §9.8).
- **Hook chạy với mọi lệnh Bash** của mọi session Claude trong main checkout (thoát ngay nếu không có `CC_ROLE`; tốn khoảng 40–60 ms khởi động node).
- **OpenCode tạo `.opencode/node_modules`, `package.json`, `bun.lock`** trong checkout, kèm `.opencode/.gitignore` của nó.

## 6. Review độc lập

Vòng 1: CHANGES_REQUESTED. Không có lỗi crash hay khoá session trong chế độ `shadow` mặc định.

| Phát hiện | Mức | Xử lý |
|---|---|---|
| `idle_streak` không reset khi handle đổi: lane resume hoặc coordinator mới bị coi là treo ngay | major | Handle mới bắt đầu từ 1; có test |
| Tự kiểm guard báo "inactive" sai sau lần chờ dài (nhìn lùi 120s từ lúc kết thúc) | major | Nhìn lùi từ lúc bắt đầu; chỉ đọc 64KB cuối của log; có test |
| Text trong dấu ngoặc bị phân tích như lệnh (prompt có `orca … read`, `check`, `--help`, `run-use`) | major | Bộ tách lệnh hiểu dấu ngoặc và `$( … )`; có test cho từng mẫu |
| Luật `sleep` quét cả text thô (`echo "…sleep 45"`, `rg "sleep 45"`, commit message) | major | Chỉ tính `sleep` là lệnh; vòng lặp nhận bằng cách đi qua các lệnh (`for/while/until … done`) |
| `run_in_background` của Claude không được đọc (đúng kiểu lỗi S08) | major | Tính là `detached-wait` |
| `dispatch-show` / `dispatch-list` bị chặn với producer | major | Khớp lệnh chính xác (`(?![-\w])`) |
| Codex không lọc theo tool: patch chứa "sleep 45" bị phân loại | major | Chỉ phân loại tool `Bash` (và Edit/Write của Claude) |
| Regex vòng lặp chạy 10,9s với input 9KB (OpenCode chạy trong process sẽ treo) | major | Quét tuyến tính, giới hạn 200k ký tự; 9KB còn 3ms, 480KB còn 55ms |
| Đọc bằng `--cursor` bị chặn; recipe B không có `--limit`/`--screen` | minor | `--cursor` tính là có giới hạn; recipe B dùng `--screen` |
| Đọc lại worker sau `check --wait` bị chặn | minor | Một lần chờ coordinator trả về cho phép một lần đọc |
| State không hết hạn; thiếu session id thì dùng chung file; ghi không atomic | minor | TTL 12h; fallback theo `ppid`; ghi tmp + rename |
| Log không xoay vòng | minor | Xoay vòng ở 5MB |
| Bỏ sót `do orca …`, `$(orca …)`, `sleep 1m`, `&> file`, dòng nối `\`; chặn nhầm `cp ~/.codex/config.toml /tmp/x`, `grep install …` | minor | Sửa cả hai chiều; config global chỉ tính khi là *đích* ghi |
| `orca-wait` không giới hạn `--max-ms`; mọi lỗi orca đều thành `terminal-missing` | minor | Giới hạn 570000; tách `terminal-missing` và `orca-error`; SKILL nói cách xử lý từng event |
| Cài hook lỗi làm hỏng spawn; làm nóng OpenCode có thể chặn 120s mỗi lần spawn | minor | try/catch; làm nóng một lần cho mỗi checkout (marker), timeout 60s |
| `RSYNC_EXCLUDES` thiếu `.claude/settings.local.json`; `coord` cắt body `worker_done` | minor | Thêm; SKILL bảo đọc `full` cả với `worker_done` thất bại |

Không sửa: `--terminal "$H"` được khoá theo chữ `$H` (hai terminal cùng đi qua `$H` bị coi là một). Chấp nhận và ghi vào giới hạn.

Không chạy vòng review thứ hai. Phần sửa được phủ bằng test (guard 13, `orca-wait` 7, launcher 15) và chạy lại adapter thật cho Claude, Codex, OpenCode (đều pass).
