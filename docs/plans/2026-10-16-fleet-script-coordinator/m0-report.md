# M0 — spike + baseline (2026-10-16)

Script spike và đo: `/tmp/fsc-m0/` (`spike.mjs`, `spike.log`, `bin/gaps.py`). Orca 1.4.218.

## (a) Script giữ Run được không → **ĐƯỢC**

**Cách chạy:** `node spike.mjs` chạy trong một terminal Orca thường, không phải agent
(`orca terminal create --command "node …"`).

**Kết quả từng bước:**

| Bước | Kết quả |
|---|---|
| `run-create` | trả ngay `coordinator_handle` = handle terminal của chính script. Không cần `--from`, vì Orca lấy handle từ `ORCA_TERMINAL_HANDLE`. |
| `worker-start --spec … --worktree current --agent claude --model sonnet` | 2,9 s, `turnStart: observed` |
| `worker-start … --agent codex` | 7,7 s, `turnStart: observed` |
| `worker_done` của claude | về sau khoảng 5 s |
| `check --wait --types worker_done,escalation,question` | nhận `question` của codex. `reply --id <msg> --body banana` → `question.status: answered`. Codex nhận câu trả lời và gửi `worker_done` "B got banana" sau 9 s. |
| Toàn bộ vòng (2 worker, 1 câu hỏi) | 27 s |
| `check --ack <delivery>` | trả `acknowledged` |
| Inject vào terminal coordinator | **0 byte** gõ vào terminal script trong toàn bộ run, kể cả 60 s chờ cuối. Orca không inject vào pane coordinator. Message chỉ nằm trong inbox của Run. |

**Phát hiện cho M3/M4:**
1. Trường `payload` của message là **chuỗi JSON** (`{"taskId","dispatchId","outcome"}`), phải `JSON.parse`.
   Không có `dispatchId` ở cấp trên. Spike đọc sai chỗ này nên không release được ở bước đầu.
2. `worker-release` worker claude → `released`, `closed_agent_terminal`, transcript được archive.
3. `worker-release` worker codex → **`retained`, reason `user_takeover`**, terminal không đóng.
   - Theo recovery reference, terminal reused / pre-existing / coordinator / active / user-taken-over đều bị
     retain, và "never substitute `terminal close`".
   - Driver phải coi `retained` là kết quả hợp lệ, ghi lại, và chỉ đóng terminal sau khi có bằng chứng
     agent đã idle.
   - **Mở:** tìm vì sao Orca coi terminal codex là user-taken-over; nghi do luồng `ask` / chờ của codex.
     Lặp lại spike với codex không `ask` để tách nguyên nhân. Coordinator LLM hiện tại hẳn cũng gặp chuyện này
     (S:579–582 đã tách "release vs terminal close").
4. Spike đóng tay terminal codex và terminal spike sau khi worker đã xong (`ptyKilled: true`). Run
   `run_97509a69f728` còn trong `run-list` (Orca không có lệnh xóa Run; vô hại).

→ D1 xác nhận: **runner (terminal của runner) làm coordinator của Run**. Không cần terminal mailbox.

## (b) Baseline tốc độ của coordinator LLM

**Dữ liệu:** 15 Run fleet gần nhất (cat-dash S01–S07, S14–S21; monster-truck S14–S20; 2026-10-10…12).

**Cách đo:** với mỗi Task có deps, lấy `dispatched_at` (dispatch hiện tại) trừ `completed_at` muộn nhất của deps,
tức thời gian từ lúc đủ điều kiện đến lúc coordinator dispatch.

| Đo | Giá trị |
|---|---|
| dep xong → dispatch (101 khoảng) | **trung vị 16 s**, p75 30 s, p90 86 s, max 3239 s; tổng 2,67 h trên 15 Run (khoảng 11 phút/Run) |
| `run-create` → dispatch đầu tiên | trung vị 123 s (10–219 s) |
| Đuôi > 5 phút (6 khoảng) | 4/6 là **integrate → review**: 393 s, 3239 s, 1099 s, 898 s. 2/6 là scan → implement / art-manifest (678 s, 668 s, cat-dash S05). |

**Kết luận:**
- Ở trung vị, coordinator LLM **không chậm** (16 s). Script nhanh hơn ở trung vị không đáng kể.
- Thời gian mất nằm ở **đuôi**, chủ yếu trước review. Chưa rõ đó là coordinator chờ preview / gate / director
  hay coordinator kẹt. Phải phân loại từ `results.md` và `producer-log` của các slice đó trước pilot M5, để biết
  script cứu được bao nhiêu.
- Sửa tiêu chí §1.3 của PLAN:
  - p90 dep → dispatch ≤ 30 s;
  - không khoảng nào > 5 phút mà không có câu hỏi hay recovery giải thích.

## (c) `/commit-guard` (template `.claude/skills/commit-guard/SKILL.md`, 132 dòng)

**9 gate.**
- Máy móc được:
  - SCOPE: `check-change-budget.sh`, `BUDGET_MAX_LINES` theo `max_lines` / `budget_bump`;
  - ASSETS: `.meta` theo cặp, `verify-scripts`, `verify-refs`, `build-all-indices`;
  - STATIC: `tsc --noEmit`, lint, grep debug log / TODO / secret.
- Cần phán đoán: ARCHITECTURE (có dependency đi ngược lớp không), DOCS (`/create-docs` khi mechanic đổi),
  MESSAGE (mô tả hành vi người chơi thấy).
- Một phần đã nằm trong `check-slice.mjs` (tsc / ES5 / scope / evidence), mà runner đã chạy làm `staticGate` cho single lane.

→ **Đổi D8:** runner **không** tự commit.
- Driver chạy `check-slice` trước.
- Xanh → dispatch một Task `commit` lên **terminal integrator** (dùng lại, như implement → integrate). Spec:
  `/commit-guard`, quy tắc stage evidence (JSON/MD, không PNG), message `feat(Sxx): …`, báo sha trong
  `worker_done`.
- Giữ được phần phán đoán của commit-guard ở một agent sẵn có (một lượt, không boot), và vẫn chạy được với
  mọi provider: commit-guard có cả bản `.claude/` lẫn `.cursor/`.
