# M4 — producer runner: báo cáo (M4a + M4b)

Ngày: 2026-10-02 · Branch `feat/coordinator-token-opt` · Sub-plan: [m4-plan.md](m4-plan.md) · Review độc lập: §4.
M4c (merge journal) và M4d (judge, Step 0–1/3, "Runner mode" trong SKILL) chưa làm: runner hiện dừng ở bước `merge`.

## 1. Thay đổi

| File | Nội dung |
|---|---|
| `skills/game-producer/scripts/producer-runner.mjs` | CLI: `start` / `resume [--dry-run] [--once]`, `status`, `pause`, `stop`, `stop-after <Sxx>`, `clear`, `answer --id --choice [--text]`. Vòng lặp: áp dụng câu trả lời → chọn slice → preflight → chạy lane → hỏi người khi cần phán đoán. Khi có câu hỏi, runner chờ câu trả lời bằng cách đọc file (không gọi model); `--once` thì in câu hỏi rồi thoát. `--dry-run` và `status` không ghi gì |
| `scripts/lib/project.mjs` | Đọc AGENT_NOTES (yaml + dòng policy), MILESTONES, front-matter của slice bằng lib của game-brief. Chọn slice: git là nguồn sự thật (`feat(Sxx)` / `fix(Sxx)` / merge nhánh `Sxx-…`), yaml `release:` chỉ là cache. Preflight gồm: policy, agent bị khóa trong dòng policy khác yaml (`agent_conflict`), `max_parallel`, size của slice, `contract_depth`, director gate (chỉ quyết định viết rõ), slice study (chỉ pin `reviewed` có sha256), brief-progress (chỉ trước lần dispatch đầu, đọc file chứ không ghi). Ghi `current_slice` / `slices.<Sxx>` bằng cách thay đúng byte của giá trị, giữ comment và căn lề |
| `scripts/lib/state.mjs` | Lock `.cursor/producer.lock`: tiến trình đã chết thì chiếm lại bằng `rename` nguyên tử, nên hai runner cùng lúc chỉ một bên thắng. Còn có control file, `producer-runner.json` (câu hỏi với options cố định; `reviewer_override` cho cả run), `T-<Sxx>/producer-state.json` / `producer-log.md`, archive state cũ khi slice được chọn lại từ đầu |
| `scripts/lib/orca.mjs` | Mọi lệnh gọi ra ngoài: `orca`, `bootstrap.mjs agent-session --json`, `orca-wait lane`, `curl`, `orca-memory` (tùy chọn, chạy với `cwd` là project). Parse được JSON nhiều dòng như orca/bootstrap thật in ra |
| `scripts/lib/lanes.mjs` | Điền prompt từ `reference/fleet-slice-prompt.md` và `single-slice-prompt.md`; nếu template thêm placeholder lạ thì báo lỗi, không gửi prompt thiếu. Máy trạng thái **single**: writer → reviewer mới → fix round (≤ 2) → `accept` (APPROVED theo Step 2d) → "approved — commit" → chờ `committed` + sha. Máy trạng thái **fleet**: coordinator → gate chuyển cho người, quyết định gửi dạng text → stall: một nudge rồi hỏi → `accept` → commit. Luật nudge/hung theo `idle_streak`; INFRA_BLOCKED; status HANDOFF lạ hoặc thiếu thì hỏi |
| `skills/cocos-orca-fleet/scripts/orca-wait.mjs` | `coord`: lỗi `ok:false` có mã timeout cũng tính là checkpoint (tài liệu Orca không nói rõ dạng nào) |
| `skills/game-producer/tests/` | `harness.mjs` (project git tạm, `orca` và bootstrap giả in JSON nhiều dòng, `orca-wait` thật), `runner-m4a` (6), `runner-m4b` (11), `runner-kill` (4: SIGKILL thật). Tổng 21 test |

**An toàn khi bị kill (PLAN §6):**
- **Spawn:** ghi ý định trước. Nếu runner chết khi bootstrap đang chạy:
  - registry đã có dòng → gắn lại handle;
  - registry chưa có dòng → hỏi người (`spawn_unconfirmed`), không spawn lần hai một cách mù quáng (sự cố S07).
- **Gửi tin:** đi qua outbox. Ý định được ghi cùng lúc với việc đổi phase, rồi mới gửi, rồi đánh dấu đã gửi. Bị kill thì tin vẫn tới ít nhất một lần.
- **Câu trả lời của người:** được đánh dấu đã áp dụng *trước* khi làm. Bị kill giữa chừng thì runner hỏi lại, không làm hai lần.

## 2. Khác với sub-plan

- **Runner chờ câu trả lời ngay trong tiến trình** (đọc file mỗi 5 s), không thoát ra. M4d cần đúng hành vi "câu hỏi chờ + kill + answer". `--once` dành cho LLM producer hoặc test.
- **INFRA_BLOCKED khi port vẫn trả 200:** chuyển thẳng sang `cursor --model auto` và giữ cho cả run.
  - Không spawn lại reviewer cũ, vì SKILL coi đó là anti-pattern.
  - Bước "sửa launch một lần" trong SKILL không áp dụng: runner luôn launch bằng lệnh hiện hành của bootstrap.
  - Nếu policy có `no_cursor=true`, hỏi người.
- **Thêm preflight `agent_conflict`:** dòng policy có thể khóa agent khác với yaml. Runner spawn theo yaml, nên khi hai bên lệch thì phải hỏi. Ví dụ thật: lego-stack có policy `reviewer=codex:gpt-6.1-sol`, còn yaml ghi `claude --model opus`.
- **Port preview cho writer:** nếu chưa có `preview-startup.json`, prompt ghi "(port of previewUrl in …/preview-startup.json)". Writer tự khởi preview và ghi file đó; reviewer nhận port từ file.
- **Thêm bước `accept` cho cả hai lane:** fleet `offer_commit` không còn đi thẳng tới commit.

## 3. Dry-run trên project thật (chỉ đọc; không file nào đổi, kể cả với `status`)

| Project | Runner sẽ làm |
|---|---|
| cc-lego-stack | S08 (fleet). Hỏi `agent_conflict`: reviewer bị khóa khác nhau. Director gate S08 đã qua (`S08 gate gate_9b5d… approved as written`) |
| cc-block-out | Dừng: S21 đang chạy nhưng không có trong `MILESTONES.slices` |
| cc-tiki-smash | Dừng: S03 và S05 cùng đang chạy |
| cc-monopoly-go, cc-meowdoku, cc-bus-fever-party, cc-flick-shot | Done |
| cc4-playground | AGENT_NOTES không có `release:` (không phải project của producer) |

Cả bốn trường hợp dừng hoặc hỏi đều là dữ liệu hợp đồng lệch thật, đúng nguyên tắc "không đoán".

## 4. Review độc lập

- **Vòng 1:** CHANGES_REQUESTED, gồm 1 blocker, 9 major, 9 minor. Đã sửa hết:
  - **Blocker:** runner không parse được JSON nhiều dòng của bootstrap và orca thật. Fake cũ in JSON một dòng nên test không phát hiện; fake giờ in JSON nhiều dòng giống bản thật.
  - **Major:**
    - dry-run/status ghi `docs/brief-watch.json`;
    - gate brief chạy trước mọi slice;
    - director gate coi mọi lần nhắc tới slice là quyết định;
    - vòng lặp nóng khi state `blocked` mà yaml ghi `in_progress`;
    - nhánh orca-error không bao giờ chạy tới;
    - commit dù `manual_required` hoặc thiếu evidence;
    - khe hở spawn lần hai và bỏ qua `promptSent`;
    - sai giá trị `<RIP_STUDY>`;
    - status `approved` / `changes_requested` trong yaml bị dispatch lại từ đầu.
  - **Minor:**
    - fallback INFRA chỉ giữ trong một slice;
    - `stop-after` bỏ qua tham số;
    - HANDOFF thiếu `status`;
    - các cặp gửi-rồi-ghi không an toàn khi kill;
    - gửi tới handle coordinator đã cũ;
    - nhận diện cc4 sai;
    - hook orca-memory chạy sai `cwd`;
    - hai runner cùng chiếm một lock đã chết;
    - nhánh `blocked` che mất terminal đã chết.
- **Vòng 2:** cả 19 finding đã sửa đúng. Còn 1 major mới và 10 minor. Đã sửa hết:
  - **Major:** một tin trong outbox không gửi được (terminal writer đã đóng) làm slice kẹt vĩnh viễn. Giờ tin đó thành câu hỏi `send_failed`; với lane single có lựa chọn để resume lane mang luôn tin đó.
  - **Minor:**
    - fleet: `committed` + sha bị che khi terminal mất;
    - `gateDecides` còn nhận nhầm (`go`, cửa sổ tràn sang slice kế tiếp);
    - khe hở khi bị kill lúc chuyển reviewer sang cursor;
    - verdict có ký hiệu markdown;
    - `manualRequired` sót một số dạng;
    - bộ đếm `bad_handoff` cộng dồn;
    - gắn lại spawn từ registry mà không biết prompt đã gửi chưa (giờ hỏi một lần);
    - `rip_port.enabled: false`;
    - regex timeout của `orca-wait` khớp cả `ETIMEDOUT`;
    - `sendOnce` bỏ qua patch khi tin đã gửi.
  - Reviewer đề nghị khôi phục bước thử lại một lần trên provider cũ trước khi chuyển sang cursor. Tôi giữ việc chuyển thẳng và ghi rõ vào SKILL: runner luôn launch bằng lệnh hiện hành nên không có launch cũ để sửa, và SKILL coi việc spawn lại reviewer cũ là anti-pattern.
- **Vòng 3** (chỉ kiểm các bản sửa của vòng 2): **APPROVED**, kèm 2 minor. Đã sửa cả hai:
  - commit gửi thất bại không còn được đưa vào resume lane (vì prompt resume có dòng "Do not commit");
  - `gateDecides` loại các cách nói tương lai hoặc có điều kiện (`will be approved when reached`, `needs approved plan`).
  
  Thêm một điểm reviewer nêu: khi bỏ một tin chuyển quyết định gate, gate đó được hỏi lại.

## 5. Nghiệm thu M4a + M4b

| Tiêu chí | Kết quả |
|---|---|
| Chọn slice theo DAG + git, preflight, ghi cache giữ comment | ✅ test M4a; dry-run trên 8 project |
| Mỗi lane spawn đúng một lần, kể cả khi bị kill | ✅ `runner-kill` (SIGKILL lúc bootstrap chạy, trước và sau khi tạo terminal) |
| Chờ bằng `orca-wait`, không đọc terminal theo chu kỳ | ✅ `calls.log` của fake chỉ có `terminal wait` / `run-show` / `gate-list` / `inbox` |
| Nudge, hung, stall, fix round, INFRA_BLOCKED, gate, takeover | ✅ `runner-m4b` |
| Không bao giờ `gate-resolve` / `run-use` / `task-*` / `dispatch` trên Run của lane | ✅ test kiểm `calls.log` |
| Token của producer giảm ≥ 60% mỗi slice | ⏳ pilot (§7), sau M4c/M4d |

## 6. Việc cho pilot

- Dạng thật của `check --wait` khi timeout (`orca-wait coord` đã chấp nhận cả hai dạng).
- `idle_streak` với runner (thời gian giữa hai lần chờ là `PRODUCER_RUNNER_IDLE_MS` = 60 s): nudge sau khoảng 1 phút idle, coi là hung sau khoảng 2 phút. Cần xem có nudge quá sớm với agent đang nghĩ lâu không.
- Chế độ advisory: review liệt kê lố budget như một finding là đọc sai và phải bỏ finding đó (Step 2d). Việc này cần phán đoán, nên để judge ở M4d; hiện runner coi là một fix round.
