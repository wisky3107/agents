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

## M4c chi tiết — merge journal (`lib/merge.mjs`)

Mỗi slice có một `T-<Sxx>/merge-journal.json`, mỗi bước một mục `{done_at, …}`. Khi bị kill, runner chạy lại từ bước chưa xong. Trước khi làm, mỗi bước tự kiểm trạng thái thật, nên làm lại cũng không gây hại.

| Bước | Fleet | Single | Khi không làm được |
|---|---|---|---|
| `harvest` | `orca-memory hook harvest --wt <wt> --task T-<Sxx>` (nếu có launcher, chạy với `cwd` là main) | như fleet, `--wt <main>` | exit ≠ 0 → giữ worktree (`kept: harvest_failed`), không chặn |
| `merge` | `sha` đã là ancestor của HEAD (người hoặc director đã merge, hoặc bị kill sau khi merge) → xong, không đụng Editor. Ngược lại phải có `refs/heads/<branch>` (worktree detached HEAD → hỏi), và main phải đang ở `base_branch` (branch lúc chọn slice; khác thì hỏi). **Mỗi lần thử** đều đóng cả hai Editor rồi probe: 3.8 dùng `close-editor.sh` + `probe.mjs --only funplay` với `cwd` là checkout + `pgrep`; cc4 dùng `close-mcp.sh --kill` + `probe --only cocos-cli`. Rồi `git merge --no-ff --no-edit <branch>` (`LC_ALL=C`). File untracked bị đè → `/tmp/<Sxx>-stash/<slug>-<ts>/`, merge, so sánh, giống thì xoá. Merge hỏng → không để lại `MERGE_HEAD` (`merge --abort`), trả file stash về, hỏi. Sau merge, sha phải là ancestor | — | Editor không xác nhận được đã đóng / conflict / main có thay đổi local / branch khác → hỏi; **không merge** |
| `evidence` | Sau merge, trước `rm`: `rsync -a --exclude '*.png'` (bỏ cả file của runner) wt → main | — | rsync lỗi → hỏi, không `worktree rm` |
| `worktree_rm` | Sha không có trong main → giữ. wt bẩn (`git status --porcelain`) → `kept: dirty`. Harvest lỗi → `kept: harvest_failed`. Ngược lại `orca worktree rm --worktree path:<wt> --run-hooks --json`. Không xoá branch | — | rm lỗi → ghi `kept`, không chặn |
| `reopen` | 3.8: `open-editor.sh <main>` (chạy detached vì script `exec` Creator). cc4: `open-mcp.sh`. Sau đó `bootstrap.mjs wait-mcp --path <main> --timeout-ms 180000 --json` một lần | — | exit 3 → hỏi |
| `verify` | Lane integrator ngắn (spawn `writer_agent`, `--role worker`) với prompt cố định `reference/verify-main-prompt.md`; ghi `T-<Sxx>/evidence/verify-main.json` `{status: verified\|manual_required\|failed}`. cc4 / không có Funplay → `manual_required` ngay | — (reviewer đã verify trên main) | `manual_required` / `failed` → hỏi; **không ghi merged** khi chưa verified |
| `record` | `release.slices.<Sxx>=merged`, `current_slice=""`; viết lại dòng slice trong Notes; ghi `lessons.jsonl` (cost events + `learning-candidates.json`, dedupe theo nội dung và `candidate_id`); đóng terminal của lane | như fleet, nhưng trước đó kiểm sha có trong HEAD của main (không có → hỏi) | — |

`auto_merge=false` (fleet): runner dừng sau commit và hỏi người. Lựa chọn "director đã merge" sẽ kiểm tra lại ancestor rồi mới ghi nhận.

Recipe reuse rows (phần recipe results trong `review.md`) chưa ghi ở M4c, vì định dạng chưa cố định. Phần này để retro hoặc M4d.

## M4d chi tiết — judge, handoff cho LLM, Runner mode

- **Judge** (`lib/judge.mjs`, prompt `reference/judge-prompt.md`):
  - Chạy khi AGENT_NOTES có `judge_agent` (`release:` hoặc `fleet:`). Giai đoạn 1 chỉ cho phép `claude …`; provider khác ghi log "chưa xác minh" và để người trả lời.
  - Lệnh: `claude -p --output-format json --model <m> --allowedTools Read,Grep,Glob` (`cwd` là project, env `CC_ROLE=judge`, `CC_PROJECT`, `CC_SLICE` để token-report đếm). Trả về JSON `{choice, text, reason}`, trong đó `choice` là một option của câu hỏi hoặc `defer`.
  - Judge **không bao giờ** chọn `stop` / `mark blocked` / `skip this slice`: các option đó bị bỏ khỏi danh sách đưa cho judge. `defer`, lỗi, hay JSON sai đều chuyển cho người.
  - Loại câu hỏi được gửi judge:
    - `fleet_gate`: trả lời từ hợp đồng, như director;
    - `lane_blocked`: câu hỏi của lane; option mới "send this answer to the lane" kèm `--text`, người cũng dùng được;
    - `unknown_status`;
    - `verdict_mismatch`.
  - Mọi câu hỏi khác là của người, như chi phí, conflict, Editor, `manual_required`.
  - Câu trả lời của judge được ghi như của người (`by: judge`, `reason`), áp dụng một lần, và ghi vào `producer-log.md`.
- **Step 0–1** (project mới, chưa có dòng policy):
  - Runner spawn LLM producer (`--role producer`) với `reference/producer-step01-prompt.md`: "chỉ Step 0–1: khoá policy, ghi dòng policy, director gate; xong thì khởi động runner rồi dừng".
  - Runner hiện tại thoát.
  - Trong `new-cocos-game` / `store-game-clone`, khi `producer_mode: runner`, dùng luôn prompt này thay cho prompt producer đầy đủ.
- **Step 3** (runner báo done):
  - Runner spawn LLM producer với `reference/producer-step3-prompt.md` ("chỉ Step 3: ship / retro"), ghi handle vào `producer-runner.json`, rồi thoát.
  - Chạy lại runner thì không spawn lần hai.
- **SKILL:** thêm mục "Runner mode", gồm khi nào dùng, lệnh, câu hỏi và `answer`, judge, giới hạn giai đoạn 1, việc LLM producer còn làm. `reference/producer-prompt.md` chọn runner hay LLM theo `release.producer_mode` (mặc định `llm`, M5 thêm key vào template).
- **Test:**
  - judge giả qua `PRODUCER_RUNNER_JUDGE_CMD` (trả lời, `defer`, chọn option cấm, JSON hỏng);
  - runner đang chờ câu trả lời thì bị kill, chạy lại, câu trả lời từ tiến trình khác được áp dụng;
  - spawn Step 0–1 và Step 3 đúng một lần.

## Giới hạn giai đoạn 1 (ghi rõ trong SKILL)

- Chỉ `max_parallel=1`.
- Port slice cần slice study thì dừng `blocked: needs_slice_study`; runner không tự chạy study.
- **`verify_main` sau merge:** runner spawn lane integrator ngắn với prompt cố định. Nếu project không có Funplay hoặc preview (cc4, playable), bước này ghi `manual_required` và báo human, không tự đánh dấu là đã verify.
- **Port preview** cho prompt single lane lấy từ `preview-startup.json` gần nhất của project. Không có thì để lane tự xác định rồi ghi vào `preview-startup.json`; reviewer đọc file đó.
- **AGENT_NOTES lệch template** (dòng policy không ở dạng `- policy:` / `policy:`, thiếu `release:`) thì dừng và báo; runner không sửa Notes ngoài đúng một dòng của slice.

## Đo

Pilot theo PLAN §7: 1–2 slice S/M rồi 1 slice L ở `producer_mode: runner`, đo bằng `tools/token-report` (role `producer` = runner không tốn token + judge + các LLM được gọi).
