# M4 — producer runner: PLAN con

Ngày: 2026-10-02 · Theo PLAN §M4 (R4) và §6 (kill/resume). Gate đã chốt: producer −60% token/slice, tính cả judge.

## Nguyên tắc

- Runner là **script** (node, `skills/game-producer/scripts/producer-runner.mjs` cùng `lib/`). Model chỉ được gọi khi cần phán đoán (judge) hoặc khi runner chuyển cho LLM (Step 0–1 lần đầu, Step 3).
- **Không đoán.** Gặp dữ liệu không đọc được (AGENT_NOTES lệch template, status HANDOFF lạ, MILESTONES thiếu field) thì dừng `blocked` và báo một dòng, không tự diễn giải.
- **Git là nguồn sự thật**, yaml `release:` chỉ là cache (§Resuming của SKILL).
- Mọi thao tác ghi đều **idempotent** và tự kiểm trạng thái trước khi làm; trạng thái lưu ra file, không giữ trong RAM.
- Dùng lại `game-brief/scripts/lib.mjs` (YAML, front-matter, AGENT_NOTES) và `orca-wait.mjs`; không thêm dependency.
- Mặc định **không bật** cho project nào: `release.producer_mode: runner` do director tự thêm (M5).

## Chia bước (mỗi bước: code → test → review độc lập → commit)

| Bước | Nội dung | Test |
|---|---|---|
| **M4a** — khung | CLI `start/resume/status/pause/stop-after/stop/answer`; lock `.cursor/producer.lock` (pid chết thì chiếm lại); control file; đọc project (AGENT_NOTES leading yaml + dòng policy, MILESTONES, slice front-matter) bằng lib game-brief; chọn slice kế theo DAG + git (ancestor `feat(Sxx)`) + `release.slices`; preflight gate (policy, `contract_depth`, `brief-progress`, `needs_director_ok`, `max_parallel=1`, rip study → `blocked: needs_slice_study`); ghi `current_slice` / `slices.<Sxx>` vào yaml bằng sửa theo dòng (giữ comment); `producer-state.json`, `producer-log.md` | Unit + harness project giả (git repo tạm) |
| **M4b** — lane | Điền prompt từ `reference/fleet-slice-prompt.md` / `single-slice-prompt.md`; spawn đúng 1 lần (`agent-session --json --role --slice`, handle ghi trước khi chờ); chờ bằng `orca-wait lane`; chuẩn hóa status HANDOFF; luật nudge/hung (`idle_streak`); stall của fleet (1 nudge, rồi báo human); single lane: spawn reviewer mới, fix round ≤ 2, INFRA_BLOCKED (curl → reviewer `cursor --model auto`); `auto_commit` ("approved — commit" → chờ `committed`) | Harness với `orca`/`bootstrap` giả |
| **M4c** — merge và ghi nhận | Merge journal 7 bước (harvest memory → rsync, đóng 2 editor + probe, merge `--no-ff`/bỏ qua nếu đã là ancestor, `worktree rm` hoặc `kept: dirty`, mở lại main + `wait-mcp`, verify main, record); single lane chỉ harvest + record; dòng Notes của slice; `lessons.jsonl` (cost events, dedupe candidates theo `candidate_id`) | Harness kill/resume ở từng bước (§6) |
| **M4d** — judge và human | `judge_agent` (claude `-p` …, provider khác chỉ khi đã xác minh, chưa thì `ask_human`); prompt `reference/judge-*.md`; schema hành động; câu hỏi cho human với `options` cố định, trả lời bằng `producer-runner answer`; Step 0–1 cho project mới (spawn LLM "chỉ Step 0–1"); Step 3 (LLM "chỉ Step 3"); mục "Runner mode" trong SKILL; `producer-prompt.md` chọn runner hay LLM theo `release.producer_mode` | Harness: judge giả, câu hỏi chờ + kill + answer |

## Giới hạn giai đoạn 1 (ghi rõ trong SKILL)

- Chỉ `max_parallel=1`.
- Port slice cần slice study thì dừng `blocked: needs_slice_study`; runner không tự chạy study.
- **`verify_main` sau merge:** runner spawn lane integrator ngắn với prompt cố định. Nếu project không có Funplay hoặc preview (cc4, playable), bước này ghi `manual_required` và báo human, không tự đánh dấu là đã verify.
- **Port preview** cho prompt single lane lấy từ `preview-startup.json` gần nhất của project. Không có thì để lane tự xác định rồi ghi vào `preview-startup.json`; reviewer đọc file đó.
- **AGENT_NOTES lệch template** (dòng policy không ở dạng `- policy:` / `policy:`, thiếu `release:`) thì dừng và báo; runner không sửa Notes ngoài đúng một dòng của slice.

## Đo

Pilot theo PLAN §7: 1–2 slice S/M rồi 1 slice L ở `producer_mode: runner`, đo bằng `tools/token-report` (role `producer` = runner không tốn token + judge + các LLM được gọi).
