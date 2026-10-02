# Plan giảm token cho producer / fleet coordinator

Trạng thái: **DRAFT — chờ director duyệt, chưa triển khai** (2026-10-02: director đã duyệt 3 điểm ở §9 mục 12–14)
Ngày: 2026-10-01 · Revision: 4 (R2: §3a ma trận provider; R3: M1a vệ sinh config MCP global; R4: đối chiếu với workflow thực tế 2026-10-02, xem §0.1 và §11)
Repo đích: `~/.agents` (`wisky3107/agents`); phần nhỏ ở template `~/Works/games/template/cc-game-template`.
Ngoài phạm vi: **tách nhỏ SKILL.md** (director đã loại khỏi plan này).

---

## 0. Bối cảnh và số liệu nền (baseline)

Đo trên OmniRoute `~/.omniroute/storage.sqlite` (bảng `call_logs`), body ở `~/.omniroute/call_logs/<date>/*.json`,
và transcript Claude Code `~/.claude/projects/**/*.jsonl`, giai đoạn 2026-09-24 → 2026-10-01.
Script dùng để đo nằm ở `baseline-scripts/` (bản thô, viết nhanh; M0 sẽ biến thành tool chuẩn).

- Output chỉ khoảng 0,6% tổng token; cache-read khoảng 96% input. **Chi phí ≈ số lượt × kích thước context.**
- Context trung bình mỗi lượt khoảng 125–130k token. **Lượt đầu tiên đã khoảng 72k** (system, tool schema, skill list, AGENTS và rules).
  Trong tool schema khoảng 187KB, Funplay chiếm khoảng 29% (105 tool), tức khoảng 54KB ≈ 14–17k token.

| Vai trò | Sessions | Lượt | Token context | Output |
|---|---|---|---|---|
| interactive | 97 | 11.9k | 1.53B (34%) | 9.5M |
| fleet-worker | 183 | 10.0k | 1.28B (28.5%) | 7.2M |
| **producer** | 35 | 7.5k | **0.98B (22%)** | 4.8M |
| subagent | 84 | 3.1k | 0.35B (8%) | 0.3M |
| fleet-orchestrator | 5 | 1.3k | 0.18B (4%) | 0.7M |
| slice writer/reviewer | 7 | 0.9k | 0.17B (4%) | 0.1M |

> **M0 (2026-10-02):** bảng trên dùng classifier cũ, gán producer cho mọi session nhắc tới `game-producer`, nên gộp nhầm fleet orchestrator và phiên interactive vào producer. Với classifier v2 trên cùng cửa sổ (Claude + Codex): **producer 0,50B (10%)**, **fleet-orch 0,80B (16%)**. Cột output của bảng trên đếm thiếu (lấy entry stream đầu tiên). Chi tiết, trần tiết kiệm và đề xuất chỉnh target: [m0-report.md](m0-report.md); snapshot: `baseline.json`.

Hành vi phí token đã quan sát được (các skill hiện tại đã cấm phần lớn, nhưng agent không tuân theo):

| Hành vi | producer | fleet-orch | worker |
|---|---|---|---|
| `orca terminal read` (polling) | 349 | 40 | — |
| `orchestration check` không có `--wait` | 268 | 37 | 36 |
| `orca … --help` | 298 | 46 | 354 |
| Đọc lại SKILL.md (Read hoặc cat) | ~340 | 43 | 24 |
| Lượt chỉ có text ("still running…") | ~1.100 | 193 | 359 |

Ngoài ra, mỗi fleet coordinator đọc `orca skills get orchestration --full` ở Precondition 1 của `cocos-orca-fleet`
(42,5KB ≈ 11k token, nằm lại trong context cho mọi lượt sau). Bản không `--full` chỉ 13KB.

Lock hiện tại của các project (ảnh hưởng tới cách enforce, xem §3):

- `cc-block-out`, `cc-monopoly-go`: orchestrator là `claude --model sonnet`.
- `cc-lego-stack`: orchestrator là **`codex --model gpt-6-luna-high --effort high`**, reviewer `codex` (gpt-6.1-sol). Producer cũng chạy bằng orchestrator_agent, tức là codex.
- Template mặc định: orchestrator là `cursor --model auto` (producer cũng vậy).

**Hook của Claude Code không phủ được Codex hay Cursor.**

### 0.1 Quan sát workflow thực tế (2026-10-02)

Rút từ cc-lego-stack S01 (`producer-log.md`, `HANDOFF.json`), `orca terminal list` và quét HANDOFF của mọi project. Mỗi điểm dưới đây đã đổi một phần của plan:

1. **Coordinator đổi handle sau takeover.** Run `run_7eb50027b6db` của S01 qua 3 thế hệ coordinator (`term_d0885e4e…` → `term_50b7ce1d…` → `term_ade023a4…`). Handle lưu lúc spawn không còn đúng. → M2.1, M4.1.
2. **HANDOFF có status ngoài enum.** Đếm được `approved_targeted` ×2, thiếu `status` ×1, `ready_for_independent_review` trong chuỗi `previous`. → M4.1 (chuẩn hóa).
3. **Số vòng review vượt "max 2".** S01 tới `review-round-7`; director cho thêm vòng có giới hạn. → M4.2 (kênh trả lời của human).
4. **Orca từ chối `worktree rm`** vì contracts/AGENTS/settings được copy vào worktree còn dirty; S01 merge xong nhưng worktree vẫn giữ. → M4.3.
5. **Agent CLI đổi title terminal** ("⠴ Take over S01 run | cc-lego-stack", "Resume existing game fleet"). Mọi cách nhận diện dựa vào title `fleet-*`/`slice-*`/`producer-*` đều hỏng. → M0, §5.
6. **Gate của slice kế có thể chờ amendment của brief**: S08 chờ "playable → full targeted game-brief amendment". → M4.1 (preflight).
7. **`~/.agents` đang được sửa live trong lúc fleet chạy**: hai commit tối 10-01 (`4022f80`, `c4a0b4a`, đụng `cocos-orca-fleet`) và có thay đổi chưa commit ở `cocos-orca-fleet/reference/worker-prompts.md`, `cocos-asset-gen`. Vì symlink trỏ vào working tree, mọi thay đổi đó có hiệu lực ngay. → §5.
8. Config MCP global sau khi dọn tay (M1a) **vẫn sạch** ngày 2026-10-02: không còn entry cocos/funplay trong codex, cursor, opencode và `mcpServers` top-level của claude.

## 1. Mục tiêu và tiêu chí thành công

Mục tiêu: giảm token của lớp điều phối mà **không** làm yếu gate chất lượng (review độc lập, editor lock, harvest evidence, merge sequence).

Đo bằng tool M0, so trước và sau trên các slice cùng size:

1. Token context của producer mỗi slice giảm ≥ 70%, **tính cả token của judge và các LLM producer được runner gọi** (mỗi lần gọi là context mới, không có cache). Đây là chỉ số chính. Tỷ trọng producer trong tổng token tuần < 5% chỉ là chỉ số phụ, vì nó phụ thuộc mẫu số.
2. Lượt của fleet orchestrator mỗi slice giảm ≥ 40%.
3. Lượt đầu của coordinator giảm đúng bằng phần schema MCP bị bỏ (M0 in breakdown theo server). Nếu chỉ bỏ Funplay thì ước khoảng 72k → 55–58k.
4. Coordinator: `--help`, `terminal read` polling và `check` không `--wait` ≈ 0, trừ allowlist. Worker: `--help` ≤ 5 mỗi slice (worker không có hook, chỉ có cheatsheet).
5. Không regression:
   - 0 lần mất evidence;
   - 0 lần dispatch trùng;
   - 0 lần chờ hoặc nudge nhầm handle;
   - không có stall > 30 phút mà không ai phát hiện;
   - kill rồi resume ở mọi bước đều qua (§6).

## 2. Bất biến (không được phá)

Các luật dưới đây rút ra từ sự cố đã xảy ra và được giữ nguyên. Mọi thay đổi phải chứng minh vẫn tuân thủ:

- Coordinator không bao giờ giữ editor lock. Chỉ integrator động vào Editor và Funplay.
- Không respawn fleet coordinator; thay coordinator cần `run-use` takeover, và đó là quyết định của human (`game-producer/SKILL.md` §Waiting).
- Producer không bao giờ đụng vào Run của lane: không `run-use`, `gate-resolve`, `task-create`/`task-update`, `worker-*`, `dispatch`, `send`/`reply`, `--from <coordinator>` (S08).
- Harvest evidence **trước** `worktree rm` (meowdoku mất T-S06 và T-S08).
- Đóng **cả hai** Creator trước merge, verify Funplay parity trên main sau merge (`game-producer/SKILL.md` Step 2d.3).
- Chờ là **chờ foreground**, `--timeout-ms` dưới giới hạn thời gian lệnh shell của CLI đang chạy (Claude Bash: 600000 ms). Không `nohup`/`&`/`disown`/`setsid`/`> file` (S08 stall khoảng 3 giờ).
- Thông điệp đánh thức của Orca ("You have N orchestration message(s)…") → `check --ack <id>` hoặc `check` không tham số, rồi mới `check --wait`. Giao thức này phải còn chạy được.
- Chỉ ack một Delivery **sau khi** đã xử lý xong.
- Spawn lane đúng một lần cho mỗi evidence dir (S07 có writer thứ hai).
- Không đổi hành vi của producer hoặc fleet đang chạy: mọi thay đổi đều nằm sau flag hoặc mode, mặc định giữ hành vi cũ.

## 3. Đặt thay đổi ở đâu

`game-producer`, `cocos-orca-fleet`, `cocos-asset-gen` trong template và trong mọi project là **symlink** về `~/.agents/skills/…` (trỏ vào **working tree** của `~/.agents`), và `~/.cursor/skills/new-cocos-game` cũng là symlink nên `scripts/setup-orca-worktree.sh` của mọi project gọi đúng `bootstrap.mjs` trong `~/.agents`. Sửa ở `~/.agents` thì mọi project nhận ngay.

Các thứ **được copy** vào từng project (sửa template chỉ áp cho project mới): `scripts/`, `AGENT_NOTES.md`, `AGENTS.md`, `.cursor/rules/*`, và các skill không symlink như `cocos-orca-worktree`, `vibe-game-director`. Chưa project nào có `.cursor/.skills-manifest.json`, nên `update-skills` không dùng được; project cũ phải sync tay (ghi vào FOLLOWUPS của từng project).

| Thành phần | Vị trí |
|---|---|
| Tool đo token (M0) | `~/.agents/tools/token-report/` |
| Registry spawn (M1) | `~/.agents/logs/spawns.jsonl`, do `bootstrap.mjs agent-session` ghi |
| Cờ `--role` cho launcher (M1) | `~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs`: `resolveAgentLaunchCommand` (~575–619), `createAgentSession` (~1255), `cmdAgentCmd` (~1663) |
| Lệnh spawn producer/coordinator (M1) | `game-producer/SKILL.md` §Step 2c; `game-producer/reference/fleet-slice-prompt.md`, `single-slice-prompt.md`, `producer-prompt.md`; `new-cocos-game/SKILL.md` (~347, spawn `fleet-<slug>`); `store-game-clone/SKILL.md` (~370) và `store-game-clone/reference/fleet-orchestrator-prompt.md` |
| Lệnh spawn worker recipe B (M1, chỉ để gắn role) | `cocos-orca-fleet/SKILL.md` (~429, ~450), `cocos-orca-fleet/reference/worker-prompts.md` (~156) |
| `opencode.json` theo checkout, `mcp-audit`, `clientConfigEntries: {}` (M1a) | `bootstrap.mjs` (`mcp-config`, lệnh mới `mcp-audit`); luật trong template `.cursor/skills/cocos-orca-worktree`, `.cursor/skills/vibe-game-director`, `.cursor/rules/00-guardrails.mdc` |
| Bảng tra cứu orca (M3) | `~/.agents/skills/orca-cli/reference/cheatsheet.md` cùng script sinh `scripts/gen-cheatsheet.mjs`; chỗ đọc guide full: `cocos-orca-fleet/SKILL.md` Precondition 1, `store-game-clone/reference/fleet-orchestrator-prompt.md`, `new-cocos-game/SKILL.md` (~443) |
| Helper chờ (M2) | `~/.agents/skills/cocos-orca-fleet/scripts/orca-wait.mjs` |
| Guard core cùng adapter (M2) | `~/.agents/hooks/coordinator-guard.mjs` cùng `~/.agents/hooks/adapters/` |
| Cài hook | Cấp checkout, do `bootstrap.mjs agent-session --role …` ghi lúc spawn; gate bằng `CC_ROLE`; **không** sửa config global (§M2.6) |
| Producer runner (M4) | `~/.agents/skills/game-producer/scripts/producer-runner.mjs` cùng `lib/` |
| Prompt cho judge (M4) | `~/.agents/skills/game-producer/reference/judge-*.md` |
| Mode trong template (M5) | Template `AGENT_NOTES.md` (`release.producer_mode`), `.gitignore`; `bootstrap.mjs` `RSYNC_EXCLUDES` (~144–160) |

## 3a. Ma trận provider (đã kiểm chứng 2026-10-01)

Yêu cầu của director: orchestrator và producer phải chạy được với **mọi** agent (claude, codex, cursor, opencode, antigravity…). Vì vậy enforcement được chia hai lớp:

- **Lớp 1, không phụ thuộc provider (bắt buộc):**
  - `producer-runner` là script, nên vòng lặp của producer không còn tốn token ở bất kỳ provider nào.
  - `orca-wait` là cách chờ duy nhất được ghi trong prompt.
  - Lớp này một mình đã phải đạt phần lớn mục tiêu.
- **Lớp 2, hook theo từng CLI (best-effort):**
  - Cùng một guard core (`coordinator-guard.mjs`, chỉ phân loại lệnh), thêm adapter mỏng cho từng CLI.
  - Thiếu adapter cho CLI nào thì CLI đó chỉ có lớp 1. Workflow vẫn chạy, chỉ yếu hơn về enforcement.

Kết quả test (thư mục `/tmp/hooktest`, hook từ chối mọi lệnh có `HOOKTEST_BLOCK`, chạy headless):

| CLI (bản) | Hook chặn shell | Cách deny | Lý do có về model? | Kiểm chứng | Lưu ý |
|---|---|---|---|---|---|
| Claude Code 2.1.286 | `PreToolUse` matcher `Bash` | exit 2 cùng stderr | ✅ | **Live** | Config project `.claude/settings.json` hoặc global |
| Codex 0.159.3 | `PreToolUse` trong `hooks.json` | exit 2 cùng stderr | ✅ "Command blocked by PreToolUse hook: …" | **Live** | **Hook chưa trust bị bỏ qua im lặng**. Trust lưu bằng hash theo đường dẫn trong `~/.codex/config.toml` `[hooks.state]`, nên mỗi worktree mới là chưa trust. Chạy được khi thêm `--dangerously-bypass-hook-trust` |
| OpenCode 1.18.33 | Plugin `tool.execute.before` (`.opencode/plugins/*.js` hoặc `~/.config/opencode/plugins/`) | `throw new Error(msg)` | ✅ | **Live** | Plugin chạy trong process, đọc `process.env.CC_ROLE` |
| Cursor Agent CLI 2026.09.26 | `beforeShellExecution` trong `hooks.json` | stdout `{"permission":"deny","user_message","agent_message"}` | Có trong code (`agent_message`) | **Đọc code bundle**; chưa test live vì shell test chưa đăng nhập `cursor-agent` | Executor phải test live trong terminal Orca đã đăng nhập |
| Antigravity `agy` 1.2.14 | Có `PreToolUse` (shim Orca trả `{"decision":"ask"}`) | Có thể là `{"decision":"deny"}` | ? | **Chưa xác minh**, chưa tìm thấy file config | Coi như chỉ có lớp 1 cho đến khi xác minh |
| Gemini CLI 0.58 | `BeforeTool` | — | — | Không dùng được: tài khoản báo `IneligibleTierError` | Bỏ khỏi phạm vi |

**Tắt MCP theo từng lần launch (cho M1):**

| CLI | Cơ chế | Trạng thái |
|---|---|---|
| Claude | `--strict-mcp-config --mcp-config <rỗng>` | Flag có trong 2.1.x; executor test |
| Codex | `-c mcp_servers.<name>.enabled=false` (Codex có trường `enabled` cho mỗi server) | Executor xác minh với **tên server thực của checkout** (`.codex/config.toml` của project, ví dụ `funplay_cocos`) |
| OpenCode | `OPENCODE_CONFIG_CONTENT='{"mcp":{"<name>":{"enabled":false}}}'` (biến môi trường có trong binary) | Executor xác minh |
| Cursor | Chưa có cờ theo lần launch. Có `cursor-agent mcp disable`, nhưng lưu vĩnh viễn và ảnh hưởng worker cùng checkout | Không làm; ghi "không hỗ trợ" |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` là global | Không làm |

**Hai điều executor phải xác minh thêm cho từng CLI (R4):**

| CLI | Giới hạn thời gian một lệnh shell | Orca vẫn nhận `agentIdentity` và `tui-idle` khi lệnh launch có prefix `CC_ROLE=…`? |
|---|---|---|
| Claude | 600000 ms (Bash tool) | Executor test |
| Codex | Executor xác minh (model tự truyền `timeout_ms`; lego chạy được với 540000) | Executor test |
| Cursor | Executor xác minh | Executor test |
| OpenCode | Executor xác minh | Executor test |
| Antigravity | Executor xác minh | Executor test |

`orca terminal create` (Orca 1.4.218) **không có `--env`**; `--command` được gõ vào login shell, nên prefix `CC_ROLE=x claude …` chạy được về mặt shell. Nếu Orca không nhận ra agent khi có prefix, dùng `env CC_ROLE=x claude …` hoặc export trong một wrapper giữ nguyên tên process; chọn cách nào phải ghi lý do.

Phát hiện phụ: config global của codex, cursor và opencode còn khai báo MCP Funplay của project hoặc worktree khác. Đã dọn tay ngày 2026-10-01; cách chặn tận gốc ở **M1a**.

## 4. Milestones

**Thứ tự thực hiện (R4): M0 → M1 → M1a → M3 → M2 → M4 → M5.** M3 lên trước M2 vì rủi ro thấp, có thêm phần thay guide full 42,5KB, và luật `--help` của guard cần đường dẫn cheatsheet. Mỗi milestone có tiêu chí nghiệm thu riêng. Sau M1, M3, M2 và M4 phải chạy pilot rồi đo lại bằng tool M0.

### M0: Tool đo token (baseline có thể lặp lại)

Biến `baseline-scripts/` thành `~/.agents/tools/token-report/token-report.mjs` (hoặc `.py`, tùy executor, miễn chạy được không cần cài thêm gì).

- Nguồn:
  - Transcript Claude: `~/.claude/projects/**/*.jsonl`, kể cả `subagents/`. **Dedupe usage theo `message.id`**: transcript ghi usage lặp cho mỗi content block, nếu không dedupe thì số bị gấp khoảng 2 lần.
  - Session Codex: `~/.codex/sessions/**` (lego chạy producer và coordinator bằng codex). Executor xác định cách dedupe sự kiện token.
  - OmniRoute `call_logs`: đối chiếu tổng; nguồn duy nhất cho breakdown tool schema theo MCP server.
  - Cursor auto đi qua máy chủ Cursor, không có trong các nguồn trên. Báo cáo phải ghi rõ "không đo được" cho session cursor, không được coi là 0.
- Phân loại role, theo thứ tự ưu tiên:
  1. Registry spawn `~/.agents/logs/spawns.jsonl` (M1) join theo `cwd` và thời điểm bắt đầu.
  2. Guard log `~/.agents/logs/coordinator-guard.jsonl` (M2) có `session_id` và `CC_ROLE`.
  3. Marker trong các user message đầu, như `role2.py` đang làm.

  **Không dựa vào env hay title**: transcript không ghi env, không ghi title Orca, và agent CLI tự đổi title (§0.1).
- Gắn với slice: lấy `Sxx` từ registry, cwd của worktree hoặc prompt.
- Đầu ra:
  - Bảng theo role (sessions, lượt, token context, context trung bình, output).
  - Bảng theo slice.
  - Bảng đếm hành vi: `--help`, `terminal read`, `check` có và không có `--wait`, lượt chỉ có text, đọc lại SKILL, đọc `orca skills get orchestration --full`.
  - Breakdown tool schema của lượt đầu theo MCP server (từ OmniRoute) — dùng để đặt target M1.
  - **Phân loại lượt của producer: chờ / máy móc / phán đoán** (heuristic theo tool call: lệnh chờ, đọc terminal, `--help` → chờ; git, rsync, close/open editor, sửa yaml → máy móc; đọc review/slice rồi `ask` hoặc trả lời → phán đoán). Số này là trần thật của M4: nếu phần phán đoán lớn thì −70% không đạt được, phải báo trước khi build M4.
  - Có `--since`, `--until`, `--project`, `--json`.
- Lưu snapshot baseline: `docs/plans/2026-10-01-coordinator-token-optimization/baseline.json`.

**Nghiệm thu:** chạy trên cùng giai đoạn 09-24 → 10-01 phải ra số khớp bảng §0 trong khoảng ±5%, và in được bảng phân loại lượt producer.

### M1: Launcher theo role và coordinator không có Funplay

1. `bootstrap.mjs agent-session` và `agent-cmd` nhận `--role producer|coordinator|worker|judge` và `--slice <Sxx>`. Mặc định không có role, giữ hành vi cũ.
2. Mọi provider: thêm biến môi trường `CC_ROLE=<role>`, `CC_PROJECT=<path>`, `CC_SLICE=<Sxx>` vào lệnh launch.
   - Chèn trong `createAgentSession` (đường `agent-session`) và trong `command` mà `cmdAgentCmd` trả về (đường recipe B: coordinator lấy `command` rồi tự `orca terminal create`).
   - Xác minh theo bảng R4 ở §3a: env tới được process agent và Orca vẫn nhận `agentIdentity`/`tui-idle`.
   - Worker do `orchestration worker-start --agent …` launch là do Orca tự spawn, **không** có `CC_ROLE`. Chấp nhận; M0 phân loại các session này bằng marker.
3. `agent-session` ghi một dòng vào `~/.agents/logs/spawns.jsonl`: `{ts, project, cwd, role, slice, agentSpec, command, title, handle}`.
4. Riêng `--role coordinator`, bỏ MCP theo bảng "Tắt MCP" ở §3a:
   - claude: `--strict-mcp-config`;
   - codex: `-c mcp_servers.<name>.enabled=false` cho từng server Cocos/Funplay đọc được từ `.codex/config.toml` của checkout;
   - opencode: `OPENCODE_CONFIG_CONTENT`;
   - cursor, antigravity: no-op, in một dòng log "MCP stripping unsupported for <agent>".

   **Không** sửa file config của project hay global, vì worker dùng chung. Thêm bảng hỗ trợ này vào `bootstrap.mjs agent-cmd` để `--help` in ra.
5. `--role producer` **giữ Funplay**, vì Step 2d.3 cần verify parity trên main sau merge. Chỉ thêm env.
6. Cập nhật **mọi** chỗ spawn liệt kê ở §3:
   - fleet coordinator: `--role coordinator` (game-producer Step 2c, `fleet-slice-prompt.md`, `new-cocos-game/SKILL.md` ~347 khi mode=fleet, `store-game-clone/SKILL.md` ~370 cùng `fleet-orchestrator-prompt.md`);
   - producer: `--role producer` (`game-producer/reference/producer-prompt.md`);
   - single lane writer và reviewer: `--role worker`;
   - recipe B của fleet: `agent-cmd --role worker`.
7. Không đổi model đang lock. Trong `cocos-orca-fleet/SKILL.md` ghi khuyến nghị: orchestrator dùng Sonnet hoặc tương đương, **không xuống Haiku** cho producer.

**Nghiệm thu:**
- `agent-cmd --role coordinator --agent "claude --model sonnet"` in ra lệnh có env và strict MCP.
- Một coordinator thật khởi động với lượt đầu giảm đúng phần schema MCP bị bỏ theo breakdown của M0 (ước ~72k → 55–58k nếu chỉ có Funplay).
- Một slice fleet thật chạy hết mà không cần Funplay ở coordinator.
- `spawns.jsonl` có đủ dòng cho mọi lane của slice pilot.

### M1a: Vệ sinh config MCP — không để Funplay của một checkout lọt vào config global

**Bối cảnh (2026-10-01).** Config global của các CLI chứa entry Funplay của project hoặc worktree khác. Mọi session đều nạp chúng: tốn token, và tệ hơn là có thể điều khiển **nhầm Editor**. Đã dọn tay, có backup (kiểm lại 2026-10-02: vẫn sạch):

- `~/.codex/config.toml.bak-mcp-cleanup-20261001-214342`: xoá `funplay_cocos` (8771, color-sort), `cocos-s01-core-dra-ab01f0`, `cocos-cc-flick-sho-1bcbe0`.
- `~/.cursor/mcp.json.bak-mcp-cleanup-20261001-214603`: xoá 3 entry `cocos-*`.
- `~/.config/opencode/opencode.json.bak-mcp-cleanup-20261001-214603`: xoá `funplay_cocos` (8778, worktree `cc-lego-stack/S01-polished-playable`) và 4 entry `cocos-*`.
- `~/.claude.json`: chỉ còn entry giới hạn trong worktree `cc-block-out-color-sort-puzzle/S01-core-drag-clear`. Để nguyên, vì không ảnh hưởng project khác và file này Claude Code ghi liên tục.

**Nguồn sinh rác:**

1. **Nút "Configure client" trong panel Funplay.** `extensions/funplay-cocos-mcp-plugin/lib/client-config.js` (`buildTargets`, `configureTarget`) ghi thẳng vào `~/.claude.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json` và VS Code, rồi lưu vết vào `clientConfigEntries` của `funplay-cocos-mcp.config.json`. Ví dụ: cc-flick-shot có entry cho codex, cursor và opencode. Hàm này chỉ chạy khi bấm nút, không chạy lúc khởi động.
2. **Agent tự sửa config global.** Không có skill nào ra lệnh này, nhưng có file backup do agent tạo (`opencode.json.S08-backup-…`, `opencode.json.S11-8778.backup`).
3. **OpenCode không có config theo từng checkout.** `bootstrap.mjs mcp-config` hiện chỉ ghi `.cursor/mcp.json`, `.mcp.json` và `.codex/config.toml`, nên agent OpenCode không thấy Funplay. Đó là lý do agent đi sửa config global.

**Việc cần làm:**

1. **`bootstrap.mjs mcp-config` ghi thêm `opencode.json` ở root checkout**, chỉ merge key của mình:
   ```json
   {"$schema":"https://opencode.ai/config.json","mcp":{"funplay_cocos":{"type":"remote","url":"http://127.0.0.1:<port>/"}}}
   ```
   - Executor xác minh OpenCode 1.18 merge `opencode.json` của project lên config global: chạy `opencode` trong checkout, kiểm tra tool Funplay có xuất hiện.
   - Thêm `/opencode.json` vào phần `.gitignore` "per-checkout port pins" của template và vào `RSYNC_EXCLUDES`; với project cũ thì thêm vào `.git/info/exclude`.
   - Xử lý cc4 (`cocos-cli-mcp.config.json`) theo đúng cách.
   - Đây là phần **thật sự chặn được** worker fleet sửa config global, vì worker trong worktree không có hook (xem mục 4).
2. **Lệnh `bootstrap.mjs mcp-audit [--fix]`** quét config global của claude (`~/.claude.json`, chỉ `mcpServers` top-level), codex, cursor và opencode:
   - Entry bị đánh dấu khi:
     - tên là `funplay_cocos` hoặc khớp `^cocos-.+-[0-9a-f]{6}$`, **hoặc**
     - URL là `127.0.0.1` hay `localhost` với port nằm trong dải Funplay hoặc COCOS CLI mà `bootstrap.mjs` dùng (8765.., 9527–9559).
   - `--fix` thì backup `<file>.bak-mcp-audit-<ts>` rồi xoá đúng các entry đó; không động vào entry khác. Ghi TOML bằng cách xoá theo block, không serialize lại cả file, để không mất comment hay `[hooks.state]`. Ghi JSON với indent 2.
   - Không sửa `projects.<path>.mcpServers` trong `~/.claude.json`, chỉ báo.
   - Chạy tự động, chỉ báo cáo, ở ba chỗ: `bootstrap.mjs create`, `bootstrap.mjs mcp-config`, `producer-runner start`. Có entry thì in cảnh báo và gợi ý `--fix`; **không tự `--fix`** nếu không có cờ.
3. **Vô hiệu hoá lối ghi của Funplay.**
   - `mcp-config` đặt `clientConfigEntries: {}` trong `funplay-cocos-mcp.config.json` của checkout.
   - Thêm luật vào **template** `.cursor/skills/cocos-orca-worktree/SKILL.md` và `.cursor/skills/vibe-game-director` (phần Funplay): "Không dùng Funplay → Configure client; config MCP theo checkout chỉ đến từ `bootstrap.mjs mcp-config`." Hai skill này là bản copy, nên project cũ phải sync tay (ghi FOLLOWUPS).
   - Patch extension để ẩn hoặc chặn nút là tùy chọn: chỉ làm nếu extension là bản template sở hữu (`extensions/funplay-cocos-mcp-plugin` có trong template), và ghi vào FOLLOWUPS thay vì làm ngay.
4. **Luật cho mọi agent** (template `.cursor/rules/00-guardrails.mdc`, một dòng; AGENTS.md của template chỉ 1,1KB và không có mục guardrail): "Không sửa config MCP global của agent CLI (`~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.config/opencode/opencode.json`, `~/.claude.json`). Thiếu hoặc sai Funplay thì chạy `bootstrap.mjs mcp-config --path <checkout>`."
   - Guard core (M2) thêm luật `deny` cho mọi lệnh ghi vào các đường dẫn đó, bật cho **mọi** `CC_ROLE`.
   - **Phạm vi thật của luật hook này:** chỉ các session có `CC_ROLE` **và** chạy trong checkout có file hook, tức producer, coordinator và single lane trong main checkout. Worker fleet trong worktree (không có file hook, và worker do `worker-start --agent` launch không có `CC_ROLE`) **không** được phủ; với họ dựa vào mục 1 và `mcp-audit`. Session interactive của director không bị chặn.

**Nghiệm thu M1a:**
- `mcp-audit` trên máy hiện tại trả 0 entry (đã dọn).
- Chép lại một backup cũ vào thư mục tạm: `mcp-audit` phát hiện đúng các entry đã xoá ở trên, và `--fix` cho ra file tương đương bản đã dọn.
- Agent OpenCode trong một checkout mới thấy đúng Funplay của checkout đó, không cần config global.
- Unit test cho luật deny ghi vào config global.

### M3: Bảng tra cứu `orca` thay cho `--help` và guide full

1. `gen-cheatsheet.mjs` chạy `orca --version` và `--help` của các subcommand mà skill đang dùng: `terminal create|read|wait|send|list|show|close`, `orchestration check|send|reply|ask|inbox|run-*|task-*|worker-*|gate-*|dispatch`, `worktree *`, `eval`, `exec`, `tab`, cùng các mục lệnh của `orca skills get orchestration --full` mà fleet dùng.
   - Sinh `cheatsheet.md` gọn: mỗi lệnh có signature, flag hay dùng và 1 ví dụ; header ghi version Orca.
2. Các skill trỏ tới cheatsheet: `cocos-orca-fleet`, `game-producer`, prompt worker trong `cocos-orca-fleet/reference/worker-prompts.md`. **Chỉ thêm một dòng trỏ**, không chép nội dung.
3. **Thay việc đọc guide full (R4).** `cocos-orca-fleet/SKILL.md` Precondition 1, `store-game-clone/reference/fleet-orchestrator-prompt.md` và `new-cocos-game/SKILL.md` (~443) đang bảo coordinator đọc `orca skills get orchestration --full` (42,5KB). Đổi thành: đọc cheatsheet; chỉ đọc guide (bản không `--full` trước, 13KB) khi cheatsheet không có lệnh cần dùng hoặc version lệch. Guide vẫn là nguồn chuẩn để sinh cheatsheet.
4. Khi `orca --version` khác version trong header thì `orca-wait` hoặc runner in một dòng cảnh báo "cheatsheet stale → chạy gen-cheatsheet".

**Nghiệm thu:** cheatsheet sinh lại được, không cần sửa tay. Sau 1 slice, số `--help` ≤ 5 (baseline khoảng 20 mỗi slice), và coordinator không còn đọc guide full khi version khớp.

### M2: Helper chờ và hook chặn polling

1. **`orca-wait.mjs`** (chạy foreground, tự giới hạn bằng `--max-ms`, mặc định 540000, in **một dòng JSON tóm tắt** ra stdout):
   - `orca-wait coord [--ack <delivery>]`: bọc `orca orchestration check --wait --types worker_done,escalation,question --timeout-ms <max> --json`.
     - In danh sách Delivery đã rút gọn (id, type, from, task, 1–2 dòng body) **kèm đường dẫn file JSON đầy đủ** `$TMPDIR/orca-wait/<run>/<delivery_id>.json`, vì coordinator cần body đầy đủ để trả lời `question` hay `escalation`. Hết giờ thì `{"timeout":true}`.
     - Keepalive ra stderr.
   - `orca-wait lane --handoff <path> --state <file> (--run <id> | --handle <h>)`:
     - Fleet lane dùng `--run`: **mỗi vòng** resolve `coordinator_handle` từ `orchestration run-show --id <run> --json`, vì takeover đổi handle (§0.1).
     - Single lane dùng `--handle`.
     - Chờ `orca terminal wait --for tui-idle` trên handle đó, đồng thời kiểm tra `orchestration inbox --json` (tin `read: 0` gửi tới `run:<run>`): `ask` của fleet là blocking nên terminal không về idle và HANDOFF không đổi; không xem inbox thì runner không bao giờ thấy câu hỏi.
     - In `status/detail/sha` của HANDOFF, `handle` đang dùng, `idle_streak`, `handoff_mtime_changed`, `pending_questions`.
     - Trạng thái chờ lưu ở file `--state`, mặc định `<main>/.cursor/evidence/tasks/T-<Sxx>/producer-state.json`. **Không** ghi vào evidence dir của lane: fleet stage cả `T-<Sxx>/` vào commit slice, và đó là thư mục của lane.
2. Cập nhật `cocos-orca-fleet/SKILL.md` §Coordinator loop và `game-producer/SKILL.md` §Waiting: thay khối lệnh chờ bằng `orca-wait`. Nội dung luật giữ nguyên. **Đồng thời** thay hai chỗ dễ sinh vòng `until … sleep` bằng `bootstrap.mjs wait-mcp --path <checkout> --timeout-ms 180000` (lệnh đã có, gate theo projectName): fleet Step 0.4 ("retry up to ~2 min while Creator boots") và producer Step 2d.3 ("wait for primary Funplay parity"). **Phải xong việc này trước khi bật `block`.**
3. **Hook `coordinator-guard.mjs`** (PreToolUse, matcher `Bash`; luật chờ chỉ hoạt động khi `CC_ROLE ∈ {producer, coordinator}`).

   Giới hạn của PreToolUse: hook **không thấy** thông điệp wake-up (đó là lượt user, không phải tool call) và **không thấy kết quả** lệnh trước (idle hay timeout). Vì vậy mọi luật chỉ dựa vào chuỗi lệnh đã chạy trong session:

   - **Đánh dấu vi phạm:**
     - `orca orchestration check` không có `--wait` và không có `--ack`, khi đã có một `check` như vậy kể từ lần `check --wait` gần nhất (tức cho phép **một** `check` trần hoặc `--peek` giữa hai lần chờ, đủ cho giao thức wake-up);
     - `orca terminal read` khi chưa có `orca terminal wait` hoặc `orca-wait` trên cùng handle kể từ lần read trước, **hoặc** thiếu `--limit` / `--limit` > 40 (`--screen` coi như đã giới hạn). Đọc sau một lần chờ bị timeout là hợp lệ: recipe B của fleet dặn "tui-idle never arrives → `orca terminal read`";
     - lệnh có `sleep N` mà N > 30 đứng một mình, hoặc vòng `until … sleep` / `while … sleep`;
     - `nohup`, `&`, `disown`, `setsid`, hoặc chuyển stdout vào file (`> file`) quanh lệnh chờ;
     - `orca … --help`: mỗi subcommand được `--help` **một lần mỗi session**; từ lần thứ hai thì cảnh báo hoặc chặn kèm đường dẫn cheatsheet (M3).
   - **Chỉ cho `CC_ROLE=producer`** (bất biến §2, sự cố S08): `orchestration run-use|gate-resolve|task-create|task-update|worker-*|dispatch|send|reply` và mọi lệnh có `--from`.
   - **Cho mọi `CC_ROLE`**: ghi vào config MCP global (M1a.4).
   - **Allowlist rõ ràng:** `check --ack …`, `check --peek`, `check --all`, `orchestration inbox|run-list|run-show|gate-list`, `orchestration ask` (producer, director gate), `terminal list|show|send|wait`, `orca-wait`, `bootstrap.mjs wait-mcp`.
   - **Ba chế độ**, chọn bằng `CC_GUARD_MODE` (mặc định `shadow`):
     - `shadow`: cho chạy, chỉ ghi `~/.agents/logs/coordinator-guard.jsonl`.
     - `block`: từ chối, kèm lý do và lệnh thay thế đúng (ví dụ "dùng `orca-wait coord …`").
     - `off`: kill switch.
   - Trạng thái giữa các lượt (lệnh chờ gần nhất, handle đã chờ, số lần `--help` theo subcommand) lưu ở `$TMPDIR/coordinator-guard/<session_id>.json`, lấy `session_id` từ input của hook (adapter map trường tương ứng của từng CLI).
4. **Guard core không phụ thuộc provider.**
   - `coordinator-guard.mjs` có hàm thuần `classify(command, sessionState, role) → {verdict: allow|warn|deny, reason, suggestion}`.
   - Chung cho mọi CLI; mọi unit test viết cho hàm này.
   - Adapter chỉ làm ba việc: đọc input của CLI, gọi `classify`, trả kết quả theo đúng định dạng CLI đó (§3a).
   - Adapter: `adapters/claude.sh`, `codex.sh`, `cursor.sh`, `opencode-plugin.js`, và `antigravity.sh` nếu xác minh được.
5. **Gate bằng biến môi trường cho mọi CLI.**
   - Adapter thoát ngay (allow) nếu `CC_ROLE` rỗng. Luật chờ chỉ áp khi `CC_ROLE ∈ {producer, coordinator}`.
   - Biến được set ở lệnh launch (M1), nên session thường hay worker không bị ảnh hưởng dù hook được cài ở đâu.
6. **Cài adapter ở cấp checkout lúc spawn, không sửa config global.**
   - `~/.codex/hooks.json`, `~/.cursor/hooks.json`, `~/.claude/settings.json` và plugin opencode global đều do Orca ghi; Orca có thể ghi đè (đã thấy file `.bak`).
   - `bootstrap.mjs agent-session --role coordinator|producer` ghi config hook vào checkout trước khi launch, theo cách idempotent và chỉ thêm entry của mình:
     - `.claude/settings.local.json` — template đã có sẵn file này (untracked, chứa `enabledMcpjsonServers`), nên phải **merge**, không ghi đè. Máy này ignore nó qua `~/.config/git/ignore`; máy khác thì không, nên vẫn cần `.gitignore` (M5).
     - `.codex/hooks.json`
     - `.cursor/hooks.json`
     - `.opencode/plugins/coordinator-guard.js`
   - Coordinator được spawn ở main checkout rồi `cd` vào worktree ở Step 0.4. Hook được nạp lúc launch nên vẫn chạy; adapter dùng đường dẫn tuyệt đối. Executor xác nhận điều này cho từng CLI.
   - Các đường dẫn này phải nằm trong `.gitignore` của template và `RSYNC_EXCLUDES` (M5). Với project cũ thì thêm vào `.git/info/exclude`.
7. **Codex trust.** Hook ở cấp project chưa trust bị bỏ qua im lặng, mà mỗi worktree có đường dẫn mới nên luôn chưa trust.
   - Với `--role coordinator|producer` và agent codex, launcher thêm `--dangerously-bypass-hook-trust`.
   - Chấp nhận được vì hook đến từ `~/.agents` (repo của director) và checkout là repo của director.
   - Ghi rủi ro này vào `cocos-orca-fleet/SKILL.md`.
8. **Tự kiểm tra hook có chạy không.** Không được tin là hook đã chạy.
   - Mỗi lần được gọi, adapter ghi một dòng vào `~/.agents/logs/coordinator-guard.jsonl` (`cli`, `session_id`, `CC_ROLE`, `CC_SLICE`, `cwd`, `verdict`, `cmd` rút gọn). Dòng này cũng là khoá join cho M0.
   - `orca-wait` (lần gọi đầu của coordinator) và `producer-runner status` kiểm tra file này đã có entry của session hiện tại trong 5 phút đầu.
   - Không có thì in `guard: inactive (<agent>) → layer-1 only` và ghi vào `producer-log.md`. Không chặn workflow.
9. **Provider chưa có adapter** (antigravity cho đến khi xác minh, CLI mới): chỉ có lớp 1, ghi rõ trong bảng hỗ trợ của `cocos-orca-fleet/SKILL.md`.
10. Thêm bộ test adapter `tests/adapters/` dùng lại cách test ở §3a: thư mục tạm, lệnh `echo HOOKTEST_BLOCK`, chạy headless cho từng CLI có trên máy. Xác nhận chặn được và thông điệp có về model. CLI chưa đăng nhập thì `skip` kèm lý do, không `fail`.

**Nghiệm thu:**
- Unit test cho `classify`: mỗi dòng allowlist và mỗi vi phạm có ít nhất một case. Lấy case thật từ transcript bằng M0, gồm cả lệnh từ session Codex (`~/.codex/sessions/`). Có case riêng cho: read sau wait bị timeout (allow), một `check` trần sau wake-up (allow), vòng retry parity bằng `wait-mcp` (allow).
- Test adapter (§M2.10) qua với claude, codex, opencode. Cursor qua trong một terminal Orca đã đăng nhập.
- Test `orca-wait lane --run` với một Run đã takeover: theo đúng handle mới, không chờ handle cũ.
- Coordinator chạy bằng **ít nhất hai provider khác nhau** (ví dụ claude và codex) đều hoàn thành một slice. Guard log có entry của cả hai.
- Chạy ≥ 1 slice ở `shadow`: số cảnh báo nhầm trên các lệnh hợp lệ là 0 thì mới bật `block`.
- Sau khi bật `block` 1 slice: số lượt coordinator giảm ≥ 40% so với baseline M0 của slice cùng size, và không có stall.

### M4: Producer runner (thay vòng lặp LLM bằng script, LLM chỉ dùng khi cần phán đoán)

Ngôn ngữ: **node (`.mjs`)**, cùng hệ với `bootstrap.mjs`, `brief-progress.mjs`, `validate-rip-port.mjs`. Không thêm dependency ngoài, trừ khi đã có trong `~/.agents`.

Trước khi build: xem bảng phân loại lượt producer của M0. Nếu phần "phán đoán" quá lớn để đạt −70%, báo director và chỉnh mục tiêu trước.

#### 4.1 Phạm vi giai đoạn 1

Runner làm các bước máy móc trong checklist Step 2 của `game-producer/SKILL.md`:

- **Preflight trước lần dispatch đầu** (đọc từ AGENT_NOTES, MILESTONES, slice):
  - có `policy` line (xem 4.2 cho project mới);
  - `brief.contract_depth=playable` thì chỉ `v1_slice` được dispatch và chỉ khi `release.goal=playable`;
  - project dùng `docs/brief-progress.json` thì `brief-progress.mjs` phải báo phase=done và hash contract khớp;
  - slice có `needs_director_ok` mà chưa có quyết định trong `policy` line → `blocked: needs_director_gate`;
  - `validate-rip-port.mjs` cho rip input;
  - giai đoạn 1 chỉ chạy `max_parallel=1`; policy khác thì dừng và báo.
  - Gate không qua → slice giữ `planned`, runner báo một dòng (ví dụ lego S08 đang chờ amendment playable → full).
- 2a: chọn slice kế theo `MILESTONES.md` (`slices`, `dag`) và `release.slices`.
- 2b: cập nhật `current_slice` và `in_progress`.
- 2c: chọn lane theo size (L → fleet hoặc fleet lite; S/M → single), điền prompt từ `reference/fleet-slice-prompt.md` hoặc `single-slice-prompt.md`.
  - Memory: chạy `hook plan` (điền `<CONTEXT_PACK>`) trước khi spawn; với single lane, chạy `hook review` sau khi writer `ready_for_review` để điền pack cho reviewer. Tất cả chỉ khi launcher tồn tại.
  - Spawn qua `bootstrap.mjs agent-session --json --role … --slice <Sxx>` **đúng một lần**. Fleet lane: ghi run id ngay khi Run xuất hiện (`run-list` theo `coordinator_handle`).
- §Waiting: `orca-wait lane` (fleet dùng `--run`), luật nudge (single lane: 2 lần idle với `working` → 1 nudge; 3 lần idle không đổi file → coi là hung, spawn resume lane), luật stall của fleet (1 nudge cho coordinator **đang sống theo `run-show`**, rồi báo human). Câu hỏi đang chờ trong inbox → judge (4.4).
- **Chuẩn hóa status HANDOFF** trước mọi quyết định. Ví dụ: `ready_for_independent_review` → `ready_for_review`; `approved_targeted` → **không** coi là `approved` (đưa judge kèm `manual_required`); thiếu `status` hoặc giá trị lạ → judge. Bảng chuẩn hóa nằm trong code và có test.
- **Fix round của single lane:** `CHANGES_REQUESTED` → gửi các dòng `## fix_routing` cho terminal writer, tối đa 2 vòng, mỗi vòng spawn **reviewer mới**.
- **INFRA_BLOCKED (máy móc, không qua judge):** runner tự `curl 127.0.0.1:<port>`; 200 → chạy lại review bằng `cursor --model auto` và lock lại cho phần còn lại của run; khác 200 → integrator recovery rồi review mới. Trước khi đổi provider, kiểm lệnh launch thật như SKILL §Policy yêu cầu.
- 2d: đọc verdict, `auto_commit` (gửi "approved — commit" vào terminal của lane, chờ `committed`), chuỗi merge (§4.3), cập nhật `release.slices` và viết lại dòng của slice trong Notes.
- **2e (máy móc):** append cost events vào `lessons.jsonl` (`fix_round`, `infra_blocked`, `budget_bump` kèm `from/to/ratio`, `respawn`…) từ HANDOFF, review và `producer-state.json`; gom `learning-candidates.json`, dedupe theo `candidate_id`. Không spawn LLM cho bước này.
- 2f: điều kiện dừng (`goal=playable` và `v1_slice`).

Runner **không tự làm** mà chuyển cho LLM (judge hoặc chế độ thủ công):

- Step 0 và Step 1 lần đầu của project (xem 4.2).
- Slice study cho port slice. Runner chạy `validate-rip-port.mjs`; nếu cần study thì **dừng `blocked: needs_slice_study`** ở giai đoạn 1.
- Câu hỏi và escalation từ fleet, `CHANGES_REQUESTED` sau khi đã hết fix round, status HANDOFF không chuẩn hóa được, merge conflict, `gate:<pct>` budget, `manual_required` → **judge** (§4.4).
- Step 3 (ship, retro) → spawn producer LLM một lần với prompt "chỉ làm Step 3".
- Recovery Funplay sau merge → spawn lane integrator ngắn với prompt "verify primary parity + runtime trên main".

#### 4.2 Trạng thái, lock và lệnh điều khiển

- Nguồn sự thật: git (`feat(Sxx)` có trong HEAD thì là merged), `git worktree list`, `HANDOFF.json`, `run-show` cho handle của coordinator, `release:` trong AGENT_NOTES (chỉ là cache). Dùng lại đúng logic của §Resuming hiện có. Merge do human tự làm (như S01 của lego) được nhận ra nhờ kiểm tra ancestor.
- `.cursor/producer.lock`: `{pid, host, started_at, mode:"runner"|"llm", terminal_handle}`.
  - Khi start: pid còn sống thì từ chối; pid đã chết thì chiếm lại và ghi vào `producer-log.md`.
  - **Producer LLM (chế độ thủ công) cũng phải tôn trọng lock này**: thêm vào `game-producer/SKILL.md` Step 0 một bước "kiểm tra hoặc chiếm lock; runner đang sống thì dừng".
- Bộ đếm nudge, idle, câu hỏi đang chờ và `humanRequest` lưu trong `T-<Sxx>/producer-state.json` của main checkout, không giữ trong RAM.
- **Project mới chưa có `policy` line:** `producer-runner start` spawn producer LLM với prompt "chỉ làm Step 0–1: lock policy, ghi `policy` line, director gate, rồi dừng", chờ nó xong (lock `mode:"llm"` trong lúc đó), rồi tự chạy tiếp.
- CLI: `producer-runner start|resume|status|pause|stop-after <Sxx>|stop|answer`.
  - `pause`, `stop-after` và `stop` ghi vào `.cursor/producer.control`; runner kiểm tra file này giữa các bước.
  - **`answer --id <question_id> --choice <option> [--text …]`**: kênh để human trả lời `ask_human`. Mỗi câu hỏi có danh sách `options` cố định, mỗi option ánh xạ tới một hành động runner biết làm (ví dụ `extra_round` cho thêm một vòng fix và review có giới hạn như S01 của lego, `stop`, `accept_manual_required`, `mark_blocked`). Câu trả lời ghi vào `producer-state.json` và chỉ được áp dụng một lần.
  - `status` in slice hiện tại, lane, handle đang dùng, bước merge, lần chờ cuối và câu hỏi đang chờ.
- Runner chạy trong một terminal Orca riêng, title `producer-runner-<slug>`, foreground. Không dựa vào title để tìm lại nó; dùng `producer.lock`.
- Thông báo cho director: mỗi khi `blocked`, có câu hỏi, xong slice hoặc lỗi, gửi một dòng qua `orca orchestration ask` hoặc message tới terminal của director nếu có, kèm lệnh `producer-runner answer …` mẫu. Thiếu kênh thì in ra và ghi log.

#### 4.3 Merge journal

`T-<Sxx>/merge-journal.json`, mỗi bước ghi `pending → done` (hoặc `kept`) kèm bằng chứng. Mỗi bước **idempotent** và tự kiểm tra trạng thái trước khi làm.

**Fleet lane:**

1. `harvest`: chạy `orca-memory hook harvest --wt <wt> --task T-<Sxx>` **trước** (nếu launcher tồn tại; exit ≠ 0 thì dừng), rồi rsync evidence (loại `*.png`) nếu commit của slice chưa chứa `T-<Sxx>/`. Lỗi thì dừng, **không** sang bước 4.
2. `close_editors`: `<wt>/scripts/close-editor.sh <wt>`, rồi `<main>/scripts/close-editor.sh <main>`. Xác nhận bằng `probe.mjs --only funplay` trên cả hai.
3. `merge`: nếu commit của slice đã là ancestor của HEAD thì bỏ qua. Nếu không thì `git -C <main> merge --no-ff <branch>`.
   - File untracked sẽ bị ghi đè thì xử lý theo luật `/tmp/<Sxx>-stash/` hiện có.
   - Conflict thật thì `blocked` và gọi judge.
4. `worktree_rm`: chỉ khi bước 1 đã `done`. Dùng `orca worktree rm --worktree path:<wt> --run-hooks --json`.
   - **Orca từ chối vì worktree còn dirty** (như S01 của lego: contracts/AGENTS/settings được copy vào) → ghi `kept: dirty <danh sách file>`, **không** force, báo human một lần, và **không** chặn các bước sau hay slice kế.
5. `reopen_main`: `<main>/scripts/open-editor.sh <main>`, rồi `bootstrap.mjs wait-mcp --path <main>`.
6. `verify_main`: spawn lane integrator ngắn (§4.1), chờ HANDOFF của nó. Có kiểm tra `includeModules` khi Feature Cropping đổi.
7. `record`: `release.slices[Sxx]=merged`, `current_slice=""`, viết lại dòng Notes, chạy 2e.

**Single lane** (commit thẳng trên main): chỉ `harvest` (memory hook với `--wt <PROJECT>`), `record`. Không có merge hay `worktree_rm`.

#### 4.4 Judge

- Gọi non-interactive, một lần cho mỗi sự kiện. Model judge lấy từ lock mới `release.judge_agent`, mặc định `claude --model sonnet`.
  - claude: `claude -p --model <m> --strict-mcp-config --mcp-config <rỗng> --output-format json` (executor kiểm tra flag).
  - Provider khác: executor xác minh chế độ non-interactive cho JSON (ví dụ `codex exec`, `cursor-agent --print`, `opencode run`) và thêm vào bảng ở §3a. **Provider chưa xác minh thì không dùng làm judge**: runner chuyển thẳng thành `ask_human`.
- Input được runner dựng, gọn: sự kiện, slice file, đoạn liên quan của `SCOPE.md`, `policy` line, review.md hoặc message gốc, HANDOFF đã chuẩn hóa. **Không** đưa cả SKILL.md, chỉ đưa prompt trong `reference/judge-<event>.md`.
- Output phải là JSON theo schema. Runner validate rồi mới làm theo. Hành động hợp lệ:
  - `reply` (text trả lời fleet, gửi bằng `orca terminal send` tới coordinator, không dùng `orchestration reply`);
  - `nudge` (text);
  - `mark_blocked` (kèm lý do);
  - `ask_human` (câu hỏi kèm `options` lấy từ danh sách ở 4.2);
  - `accept_with_budget_bump`.
  Hành động ngoài danh sách thì runner coi là `ask_human`.
- Judge **không bao giờ** chạy các lệnh bị cấm với Run của lane (`run-use`, `gate-resolve`, `task-*`, `worker-*`, `dispatch`, `send`/`reply`, `--from <coordinator>`). Runner cũng không.
- Chỉ ack message sau khi đã làm theo quyết định của judge.
- Token của judge được M0 tính vào bucket producer (§1.1).

#### 4.5 Tài liệu

- `game-producer/SKILL.md` thêm mục ngắn "Runner mode":
  - khi `producer_mode: runner` thì producer LLM chỉ chạy khi runner gọi (Step 0–1 lần đầu, Step 3), hoặc ở chế độ thủ công;
  - cách `pause`, `answer`, chiếm lock, `resume`;
  - các bước đã chuyển cho runner. Không cần lặp lại luật, chỉ trỏ tới §.
- `producer-prompt.md`: launcher chọn runner hoặc LLM theo `release.producer_mode`.
- **Bảng đối chiếu luật** (§8): mỗi luật "Never…" hoặc có tên sự cố trong `game-producer` và `cocos-orca-fleet` ánh xạ tới dòng code, test, hoặc "giữ cho LLM".

**Nghiệm thu M4:** xem §6 (kill và resume) và §7 (pilot).

### M5: Template và các project đang có

1. Template `AGENT_NOTES.md`, mục `release:`:
   - `producer_mode: llm  # llm | runner — runner: game-producer/scripts/producer-runner.mjs`
   - `judge_agent: claude --model sonnet`
2. Template `.gitignore` **và** `RSYNC_EXCLUDES` của `bootstrap.mjs`: thêm `.cursor/producer.lock`, `.cursor/producer.control`, cùng các file hook sinh lúc spawn: `.claude/settings.local.json`, `.codex/hooks.json`, `.cursor/hooks.json`, `.opencode/plugins/coordinator-guard.js`, `/opencode.json` (M1a). Hiện template không track file nào trong số này (đã kiểm 2026-10-02), nhưng có sẵn `.claude/settings.local.json` untracked; executor kiểm lại lúc làm.
3. Runner và skill phải chạy được khi **thiếu** các key này (project cũ): thiếu thì mặc định `llm` và không bắt buộc `.gitignore`. Nếu ghi lock thì tự thêm vào `.git/info/exclude`.
4. Không sửa `AGENT_NOTES.md` của project đang có. Bật runner cho project nào là việc director tự thêm một dòng.
5. Các thay đổi ở bản copy (`.cursor/rules/00-guardrails.mdc`, `cocos-orca-worktree`, `vibe-game-director`) chỉ vào template. Với project cũ, liệt kê file cần sync tay trong báo cáo của milestone; không tự sửa project đang chạy.

## 5. Rollout và rollback

- **Làm trong một git worktree riêng của `~/.agents`** (ví dụ `~/.agents-wt/coordinator-token-opt`), branch `feat/coordinator-token-opt` tạo từ `master`. **Không** checkout branch khác hay sửa file trong `~/.agents`: symlink trỏ vào working tree của nó, nên mọi thay đổi ở đó (sửa file, commit, merge, checkout) đều có hiệu lực ngay với fleet đang chạy. `docs/` chưa track: chép plan sang worktree, không commit lẫn với việc khác.
- Lưu ý (2026-10-02): `~/.agents` đang được một session khác sửa trực tiếp trên `master` (§0.1 mục 7). Trước khi merge, đối chiếu với director để không đè hay trộn thay đổi chưa commit của session đó.
- Theo AGENTS.md: writer làm trong worktree, reviewer độc lập review diff. Self-review phải ghi rõ là self-review.
- **Không đưa thay đổi vào working tree của `~/.agents` khi đang có producer hoặc fleet chạy.** Kiểm tra bằng cả ba, **không** dựa vào title terminal (agent CLI đổi title, §0.1 mục 5):
  - `orca orchestration run-list --json`: không có Run nào đang active;
  - với mỗi project: `release.current_slice` rỗng và không có `.cursor/producer.lock` của pid còn sống;
  - `orca terminal list --json`: không có terminal nào có `agentIdentity` mà `worktreePath` thuộc `~/Works/games/CocosCreator/*` hoặc `~/orca/workspaces/*` và `lastOutputAt` trong 30 phút gần nhất.
  - Lúc viết (2026-10-02): `cc-block-out` current_slice = S21; `cc-lego-stack` current_slice rỗng (S01 merged, S08 chờ amendment) **nhưng producer và coordinator codex vẫn sống**; `cc-monopoly-go` rỗng.
- Mỗi milestone là một commit hoặc PR riêng, revert được độc lập.
- Kill switch:
  - hook: `CC_GUARD_MODE=off`, hoặc xoá dòng đăng ký;
  - runner: `producer_mode: llm`;
  - M1: không truyền `--role`.

## 6. Kiểm thử stop và resume (bắt buộc cho M4)

Viết harness (`scripts/test/runner-kill.mjs`) dùng repo git giả, mock `orca`/`bootstrap` (bin giả trong `PATH`) và HANDOFF giả lập. Với mỗi điểm dừng: `kill -9` runner, chạy `resume`, kiểm tra kết quả.

| Kill tại / tình huống | Kỳ vọng sau resume |
|---|---|
| Ngay sau khi chọn slice, trước spawn | Spawn đúng 1 lane |
| Sau spawn, trước khi ghi handle | Thấy lane đang sống qua `terminal list`, `spawns.jsonl` và HANDOFF, bám lại, không spawn lần hai |
| Đang chờ lane | Bám lại; bộ đếm idle và nudge giữ nguyên, không nudge lặp |
| Coordinator bị takeover (handle đổi) trong lúc chờ | Resolve handle mới qua `run-show`; không chờ hay nudge handle cũ |
| Fleet đang `ask` (terminal bận, HANDOFF không đổi) | Thấy câu hỏi qua inbox, gọi judge đúng một lần |
| HANDOFF có status lạ (`approved_targeted`, thiếu status) | Không merge; chuyển judge hoặc `ask_human` |
| Đang gọi judge | Message chưa ack; gọi lại judge một lần |
| Đang chờ human `answer` | Câu hỏi vẫn chờ, không gửi thông báo trùng; câu trả lời đến sau được áp dụng đúng một lần |
| Từng bước 1–7 của merge journal | Tiếp từ bước dở; không `worktree rm` nếu harvest chưa `done`; không merge hai lần |
| `worktree rm` bị từ chối vì dirty | Ghi `kept`, slice vẫn `merged`, chuyển sang slice kế |
| Human đã tự merge slice | Nhận ra qua ancestor, bỏ qua bước merge |
| Giữa hai slice | Chọn slice kế đúng |
| Lock của pid đã chết | Chiếm lại, ghi log |
| Hai runner start cùng lúc | Runner thứ hai bị từ chối |
| Producer LLM start khi runner còn sống | LLM dừng ở Step 0 |

## 7. Pilot

1. Chọn project **không có producer đang chạy** (kiểm theo §5), slice S/M trước, sau đó 1 slice L (fleet). Pilot chạy thẳng từ worktree của `~/.agents` (gọi script bằng đường dẫn tuyệt đối), chưa cần merge.
2. Thứ tự: M1 → đo; M3 → đo; M2 ở `shadow` 1 slice → `block` 1 slice → đo; M4 ở `producer_mode: runner` cho 1–2 slice S/M, rồi 1 slice L.
3. Mỗi pilot ghi một dòng vào `docs/plans/2026-10-01-coordinator-token-optimization/results.md`: slice, size, lane, provider, số lượt và token theo role (M0), so với baseline, **số lần runner dừng `blocked` hoặc chuyển LLM/human**, sự cố nếu có. Pilot bằng cursor ghi rõ "token không đo được".
4. **Gate go/no-go trước khi bật runner mặc định cho template:**
   - đạt tiêu chí §1;
   - 0 regression ở §1.5;
   - tỷ lệ fallback của runner đủ thấp để vẫn đạt −70%;
   - director duyệt.

## 8. Rủi ro và cách giảm

| Rủi ro | Giảm thiểu |
|---|---|
| Hook chặn nhầm giao thức wake-up hoặc `--ack` | Allowlist §M2.3 (cho phép một `check` trần giữa hai lần chờ), chạy `shadow` trước, unit test lấy case thật |
| Hook không thấy wake-up hay kết quả lệnh | Luật chỉ dựa vào chuỗi lệnh (§M2.3); không viết luật cần biết kết quả |
| Cấm `terminal read` làm producer không thấy worker kẹt ở prompt TUI | Cho đọc ≤ 40 dòng (`--limit`) sau một lần chờ, kể cả chờ bị timeout |
| Agent viết vòng `until … sleep` cho việc chờ Creator | Skill dùng `bootstrap.mjs wait-mcp` (§M2.2) trước khi bật `block` |
| Mỗi CLI có định dạng hook khác nhau; bản CLI mới có thể đổi định dạng | Guard core chung cùng adapter mỏng (§M2.4); test adapter chạy lại sau mỗi lần nâng cấp CLI; tự kiểm tra hook (§M2.8) |
| Giới hạn thời gian lệnh shell khác nhau giữa các CLI | `orca-wait --max-ms`, giá trị theo bảng R4 ở §3a |
| Codex bỏ qua hook chưa trust một cách im lặng | `--dangerously-bypass-hook-trust` chỉ cho role coordinator/producer; tự kiểm tra bằng guard log |
| CLI chưa có adapter (antigravity, CLI mới) | Lớp 1 (runner cùng `orca-wait`) vẫn chạy; hook chỉ là lớp bổ sung |
| Orca ghi đè hook global | Không sửa config global; cài ở cấp checkout lúc spawn |
| Cheatsheet cũ so với version Orca | Sinh tự động, cảnh báo khi lệch version, `--help` một lần mỗi subcommand |
| Coordinator takeover đổi handle | `orca-wait lane --run` resolve qua `run-show` mỗi vòng; test ở §6 |
| Lane ghi status HANDOFF tự do | Bảng chuẩn hóa trong runner; status lạ → judge; không bao giờ merge trên status lạ |
| Runner gặp tình huống lạ hoặc workflow lệch luật (thêm vòng review, human tự merge, chờ amendment) | Dừng `blocked` rõ ràng, có `answer` để human quyết; chế độ thủ công dùng chung lock và trạng thái; đo tỷ lệ fallback ở pilot |
| Chuyển luật văn xuôi sang code bị sót luật | Bảng đối chiếu (§4.5). Reviewer kiểm bảng này |
| Thay đổi trong working tree `~/.agents` ảnh hưởng run đang chạy | Làm trong worktree riêng; chỉ đưa vào khi không có run (§5) |
| Session khác cũng đang sửa `~/.agents` trên `master` | Đối chiếu với director trước khi merge (§5) |
| Coordinator không có Funplay nhưng skill vẫn bảo nó probe | Coordinator chỉ dùng `probe.mjs` (bash), `wait-mcp` và `preview-startup.json`; rà `cocos-orca-fleet/SKILL.md` xem còn chỗ nào gọi tool `mcp__funplay*` từ coordinator không |
| Judge trả lời sai câu hỏi về scope | Input chỉ gồm contracts; không chắc thì `ask_human`; schema giới hạn hành động |
| Token không đo được cho cursor (mặc định của template) | Báo cáo ghi rõ; pilot đo trên claude và codex |

## 9. Quyết định đã chốt mặc định (director có thể đổi)

1. Runner viết bằng **node**.
2. Producer **giữ Funplay**; chỉ fleet coordinator bỏ.
3. Hook bắt đầu ở **`shadow`**.
4. Judge mặc định **`claude --model sonnet`**, cấu hình qua `release.judge_agent`. Provider chưa xác minh chế độ non-interactive thì không làm judge (chuyển `ask_human`).
5. Runner giai đoạn 1 **không** làm slice study, ship hay retro; các việc này chuyển cho LLM.
6. Không đổi model đang lock của project nào.
7. Orchestrator và producer phải chạy được với mọi provider mà `bootstrap.mjs` hỗ trợ. Hook là lớp bổ sung, không phải điều kiện để chạy được (§3a).
8. Codex coordinator dùng `--dangerously-bypass-hook-trust` (§M2.7).
9. (R4) Runner tự làm Step 2e và INFRA_BLOCKED (máy móc); LLM chỉ cho Step 0–1 lần đầu, phán đoán qua judge, và Step 3.
10. (R4) Thứ tự milestone: M0 → M1 → M1a → M3 → M2 → M4 → M5.
11. (R4) Giai đoạn 1 của runner chỉ hỗ trợ `max_parallel=1`.
12. (R4, director duyệt 2026-10-02) Project cũ sync tay các thay đổi ở bản copy (`cocos-orca-worktree`, `vibe-game-director`, `.cursor/rules`); không dùng `update-skills` vì chưa project nào có manifest.
13. (R4, director duyệt 2026-10-02) Giới hạn thời gian lệnh shell của từng CLI và việc Orca nhận `agentIdentity` khi có prefix `CC_ROLE=…` do executor xác minh (bảng R4 ở §3a) trước khi dùng trong M1/M2.
14. (R4, director duyệt 2026-10-02) Mục tiêu −70% của producer được phép chỉnh sau M0: nếu bảng phân loại lượt producer cho thấy phần phán đoán quá lớn, executor đề xuất target mới và director chốt trước khi build M4.

## 10. Bàn giao cho agent thực thi

- Đọc file này, `game-producer/SKILL.md`, `cocos-orca-fleet/SKILL.md`, `new-cocos-game/scripts/bootstrap.mjs` (`resolveAgentLaunchCommand`, `createAgentSession`, `cmdAgentCmd`, `configureFunplayMcp`, `RSYNC_EXCLUDES`), `game-producer/reference/*.md`, các chỗ spawn liệt kê ở §3, và bản template của `cocos-orca-worktree`, `vibe-game-director`, `.cursor/rules/00-guardrails.mdc`.
- Làm trong worktree riêng của `~/.agents` (§5), không đụng working tree `~/.agents`.
- Bắt đầu bằng M0 và đối chiếu số với §0 trước khi sửa bất cứ thứ gì; gửi bảng phân loại lượt producer cho director trước khi bắt đầu M4.
- Mỗi milestone: viết PLAN con ngắn (file đổi, test, tiêu chí nghiệm thu) → code → review độc lập → commit trên branch. **Không push, không merge `master`**; việc đó do human làm.
- Báo lại theo từng milestone: diff tóm tắt, kết quả test, số đo M0 trước và sau, và danh sách file cần sync tay cho project cũ (nếu có).

## 11. Thay đổi ở revision 4 (tóm tắt)

- Thêm §0.1 (quan sát thực tế 2026-10-02) và chi phí đọc guide full 42,5KB.
- §1: chỉ số chính là −70%/slice tính cả judge; target lượt đầu theo breakdown MCP; tách chỉ tiêu `--help` của coordinator và worker; thêm regression "chờ/nudge nhầm handle".
- §2: thêm bất biến "producer không đụng Run của lane"; giới hạn chờ theo CLI; thêm `setsid`, `> file`.
- §3: sửa tên hàm `bootstrap.mjs`, đường dẫn `producer-prompt.md`, đủ các chỗ spawn, guardrail ở `.cursor/rules/00-guardrails.mdc`, ghi rõ phần nào là bản copy; thêm registry spawn.
- §3a: bảng xác minh giới hạn lệnh shell và `agentIdentity` khi có prefix env; Orca không có `--env`.
- M0: thêm nguồn Codex, phân loại role bằng registry và guard log (không dùng env/title), phân loại lượt producer, breakdown schema MCP.
- M1: `--slice`, `CC_SLICE`, registry spawn, phủ recipe B.
- M1a: phạm vi thật của luật hook; các file copy cần sync tay.
- M3: lên trước M2; thay việc đọc guide full; luật `--help` chuyển vào guard của M2.
- M2: `orca-wait lane --run` theo `run-show`, xem inbox, file Delivery đầy đủ, state ở main, `--max-ms`; chuyển skill sang `wait-mcp`; viết lại luật guard theo chuỗi lệnh; thêm deny cho producer; `--limit` cho `terminal read`.
- M4: preflight gate, chuẩn hóa status, fix round single lane, INFRA_BLOCKED và 2e làm máy móc, memory hooks đúng thứ tự, Step 0–1 cho project mới, lệnh `answer`, `worktree rm` bị từ chối, nhánh single lane trong merge journal, judge theo provider.
- M5: `RSYNC_EXCLUDES`, file template có sẵn, sync tay cho project cũ.
- §5: làm trong worktree riêng; nhận diện run đang chạy không dựa vào title; cảnh báo session khác đang sửa `master`.
- §6: thêm 6 tình huống kill/resume.
- §7–§9: thứ tự pilot mới, đo tỷ lệ fallback, quyết định mặc định mới.
