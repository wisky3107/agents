# Runner phase 2 — hai lane song song

Yêu cầu: director (2026-10-15, qua pilot 24) — chạy tối đa 2 slice cùng lúc khi hai slice runnable kế tiếp là
một cặp `parallel_ok` trong MILESTONES. Máy 16 GB M1 Pro chịu được 3 editor Creator. Làm sau việc rút ngắn
smoke (đã xong: run-args `--settle` + `// DELAY:`).

## Hiện trạng (khảo sát 2026-10-15)

Runner nối tiếp ở 4 chỗ: chọn slice (`nextSlice` project.mjs:320, nhiều slice in_progress = stuck), vòng lặp
chặn (`runSlice` R:840 chờ tới khi slice hỏi hoặc xong; `waitForAnswer` R:762 chặn mọi lane), merge journal,
res-guard (`runnerInfo` chỉ đọc một `runner.slice`; `maxEditors: 2`). Không code nào đọc `parallel_ok`.
Single lane giả định main checkout ở nhiều chỗ trong lanes.mjs (handoff/evidence, PORT/`slicePort` lấy port
mới nhất của slice bất kỳ, `ensureEditor` chỉ main, `staticGate --root root`, `commitsSince` đọc HEAD main).
Có sẵn để dùng lại: `orca worktree create --base-branch` + setup hook (rsync `library/`, pin cổng Funplay riêng,
mở Creator), đường merge của fleet (`doMerge` → copy evidence → `worktree_rm` → verify → record),
`sliceStatuses` đã coi worktree `Sxx-…` là in_progress, check-slice nhận `--root/--base/--port`.

## Hai quy tắc chống nguy hiểm

1. **Đặt chỗ:** lane chạy ở main chỉ khi không lane nào khác đang sống; ngược lại vào worktree riêng.
2. **Merge:** worktree lane chỉ merge khi không lane nào đang sống ở main; hàng đợi FIFO, mỗi lần một.
   → không bao giờ merge dưới chân writer đang làm ở main (không đóng Creator của nó, không dời base của nó).

## Các mốc (mỗi mốc merge riêng, có test; max_parallel=1 giữ nguyên hành vi)

| Mốc | Nội dung | Rủi ro |
|---|---|---|
| M0 | Trừu tượng hoá checkout của lane (`laneCtx`: checkout, evidence, handoff, worktree; null ⇒ main). Thay mọi chỗ dùng `root` trong lanes/merge; ctx dựng một chỗ (R:830 và R:413). `slicePort` chỉ lấy port của chính checkout. Refactor thuần, bộ test hiện có giữ nguyên. | thấp |
| M1 | Single lane trong worktree, vẫn nối tiếp, opt-in: phase `spawn-worktree` (tạo với `--base-branch base_sha`, khôi phục qua `sliceWorktrees`), editor + `wait-mcp` của worktree, writer/reviewer/check-slice trên worktree, merge theo đường fleet (key theo `s.worktree`). Harness: `worktree create`, commit theo cwd. | trung bình |
| M2 | Hàng đợi merge + gộp file dùng chung trong `doMerge`: whitelist (MILESTONES `shared_append:`), markdown `merge-file --union`, JSON hợp khoá (trùng khoá khác giá trị → hỏi), số FOLLOWUPS trùng → hỏi (hoặc cấp dải số cho lane worktree), từ chối nhánh sửa AGENT_NOTES.md; token `main_git` cho mọi thao tác git trên main. | trung bình |
| M3 | Câu hỏi mang `lane` + `checkout`; menu/thông báo/pilot-wait hiện chúng; `runner.lanes[]` cạnh `slice`; pilot-wait báo `lane_started`/`lane_done`. | thấp |
| M4 | res-guard theo `runner.lanes`: giữ editor worktree đang dùng, giữ main khi lane main sống (bỏ luật 241 lúc đó); `maxEditors: 3`; `admit` theo checkout của lane. | trung bình |
| M5 | Bộ lập lịch (công tắc thật): `preflight` nhận `max_parallel=2`; `nextLanes()` = lane sống + tối đa 1 lane mới khi là cặp `parallel_ok`, cả hai single lane, không chung nhóm `exclusive` (api, figma…); bước từng lane theo hạn riêng (waitMs ~60–90 s khi có 2 lane); câu hỏi chỉ đỗ slice của nó; `stop-after` không mở lane mới. | cao |

Sau M5: thử trên dự án không chạy pilot, rồi bật cho capytal (cặp đầu tiên khả dĩ: S30 + S21; S21 có
`needs_director_ok`, director_gate của S21 chỉ đỗ S21).

## Rủi ro chính

- M5: các lời gọi chặn lâu (`staticGate` tới 600 s, judge, `wait-mcp` 240 s, harvest 300 s) làm lane kia
  không được quan sát trong lúc đó — cần tách thành bước hoặc chấp nhận độ trễ có giới hạn.
- Verify sau merge chạy trên main khi main đã đi tiếp; preview 3.8 không pin được cổng → kiểm `projectPath`.
- RAM: 2 Creator (~2–3 GB/cái) + 4–6 agent + 2 tsc + 2 trình duyệt smoke trên 16 GB.
- Tài nguyên dùng chung một phiên (API test server, tab Figma, profile ChatGPT): khai báo `exclusive`.
- Kill/restart với hai lane phải khôi phục cả hai, không spawn lần hai.

## Trạng thái

- **M0 xong (2026-10-15):** `laneCheckout(root, id)` (lanes.mjs) = `lane_checkout` trong producer-state, else main;
  `ctx.checkout` đặt một lần ở `runSlice` / `applyAnswer`. Theo checkout: commitText, promptValues
  (PROJECT, EVIDENCE_DIR, PORT, BASE), sliceBase (git -C checkout), reviewVerdict, judge evidence, spawnOnce
  (admit, spawn registry, spawnLane), treeSignature, fixRound, staticGate (--root/cwd), singleStep handoff/evidence,
  infraBlocked, laneHandoff, commitMarks/commitsSince. Ở lại main: mọi state của runner. treeSignature bỏ qua
  AGENT_NOTES.md. Không ai ghi `lane_checkout` nên hành vi không đổi (194/194 test, thêm
  runner-lane-checkout.test.mjs).
- **Ghi chú cho M1:** cập nhật `ctx.checkout` ngay khi phase `spawn-worktree` ghi `lane_checkout` (ctx đang sống
  trong vòng `runSlice`); memory pack `planPack` ghi vào EVIDENCE_DIR của lane mà copyEvidence bỏ qua
  `/evidence/memory/plan/` → giữ pack ở main hoặc cho phép copy; `ensureEditor` / `closeMain` (editors.mjs) vẫn chỉ
  biết main; `slicePort` chưa kiểm `projectPath` (test giả lập dùng `/p`) — thêm khi lane đầu tiên vào worktree;
  merge.mjs single-lane path (`commit_not_on_main`) chưa biết worktree.
- **M1 xong (2026-10-15):** công tắc `release.lane_worktree` / token `lane_worktree=true` (mặc định tắt). Phase
  `spawn-worktree` (lanes.mjs `spawnWorktree`): `io.createWorktree` (`orca worktree create --base-branch <sliceBase>
  --setup run --no-parent`), tìm đường dẫn qua `sliceWorktrees`, ghi `lane_checkout` + `handoff_base`, `waitMcp(wt)`;
  worktree có sẵn (kill sau create) được nhận lại; tạo hỏng → `worktree_failed` (retry / run this slice in main →
  `lane_in_main`). `ensureEditor` theo checkout; `waitMcp` tách ra editors.mjs. `laneCheckout` rơi về main khi
  worktree đã xoá. `previewPort` bỏ report có `projectPath` là một checkout khác đang tồn tại. Memory plan pack luôn
  ở main. merge.mjs: single lane có `lane_checkout` đi đường fleet (journal `wt` = lane_checkout; `commit_not_on_main`
  chỉ cho single ở main). Harness: `worktree create`, `step.wt`. 198/198 test (+4 runner-lane-worktree.test.mjs).
- **Chưa kiểm trên máy thật:** hook setup thật (rsync library/, Creator thứ hai, cổng Funplay), preview của worktree,
  `check-slice --root wt` với node_modules symlink. Nên chạy thử một slice thật với `lane_worktree=true` trước M5.
- **M2 xong (2026-10-15, phần gộp file dùng chung):** merge.mjs `resolveShared` — khi mọi file conflict đều thuộc danh sách
  dùng chung (`FOLLOWUPS.md`, `PLAYTEST.md`, `scripts/smoke/known-red.json`, `docs/cleanup/*.md` + MILESTONES
  `shared_append:`), markdown gộp `git merge-file --union`, JSON gộp theo khoá so với base (`unionJson`); hai bên cùng
  thêm một số dòng (`clashingRows`, ví dụ cùng #93) hoặc cùng sửa một khoá → không đoán, `merge_conflict` kèm lý do.
  Conflict ở file khác (kể cả AGENT_NOTES.md) vẫn hủy merge và hỏi như cũ. Harness: `step.mainCommit`,
  `commit.add`. 203/203 test (+4 merge-shared.test.mjs, +1 end-to-end trong runner-lane-worktree.test.mjs).
- **Dời sang M5:** token `main_git` (tuần tự hoá thao tác git trên main giữa hai lane) — chỉ cần khi hai lane cùng sống.
- **M3 xong (2026-10-15):** `laneTag(root, id)` (lanes.mjs) → `{ lane: main|worktree, checkout }`; mọi câu hỏi có slice
  mang hai trường đó (stopFor, kể cả khi câu hỏi cũ được cập nhật); menu, hộp thoại và thông báo ghi
  ` · worktree <tên>`; `producer-runner.json` có `lanes: [{slice, since}]` cạnh `slice`; `status` liệt kê lane
  (lane, checkout, phase); `pilot-wait` in `lane`/`checkout` cho câu hỏi được giao; `--once` giữ `slice_changed` khi
  chỉ một lane, báo `lane_started` / `lane_done` khi có hai. 205/205 test (+2 runner-lane-questions.test.mjs).
- **M1 chạy thật (capytal S24, 2026-10-16):** worktree tạo trong 4 s, Creator thứ hai + MCP ~20 s, preview của worktree
  dùng được cho mọi lần smoke và check-slice (base thật, tsc 0 lỗi mới, smoke dùng lại report), merge → evidence (không
  PNG) → worktree_rm → reopen → verify trên main đều chạy. Một lỗi: verifier spawn vào worktree đã xoá (ctx.checkout
  cũ) → sửa ở 726f614. RAM với 2 editor: tổng footprint tối đa 6,7 GB, swap tối đa 6,7 GB, availPct thấp nhất 34%;
  res-guard đóng main lúc lane chạy trong worktree (đúng cho một lane).
- **M4 xong (2026-10-16, b18f949):** res-guard `runnerInfo` đọc `runner.lanes` + `lane_checkout`; giữ editor của worktree
  mà một lane còn sống đang dùng (kể cả giữa hai agent); "primary waits" không đóng main khi một lane khác đang làm ở
  main (rơi về luật idle). `~/.agents/run/res-guard/config.json` `maxEditors: 3` (director duyệt; backup
  config.json.bak-20261016). 14/14 test res-guard.

## M5 chi tiết (2026-10-16)

Hiện trạng: vòng `start` (producer-runner.mjs) nối tiếp tuyệt đối — câu hỏi chưa trả lời đầu tiên của cả project chặn mọi
thứ (`waitForAnswer`), `runSlice` lặp tới khi slice hỏi hoặc xong, mỗi `wait()` là một orca-wait tới 540 s; `nextSlice`
coi hai slice in_progress là stuck; `preflight` chặn `max_parallel` ≠ 1.

Chia nhỏ, mỗi bước merge riêng, `max_parallel=1` giữ nguyên hành vi (log và runner-file như cũ):

| Bước | Nội dung |
|---|---|
| M5a | Harness: hàng đợi theo terminal (`queue.json` = mảng như cũ, hoặc `{handle: [...]}`; dừng khi mọi hàng đợi rỗng). `stepLane(ctx)`: đúng một vòng của thân `runSlice` (control, outbox, một bước phase) → `{progress}` / `PAUSE` / `{ask}` / `{phase}`; `runSlice` = lặp `stepLane` (không đổi hành vi). |
| M5b | Chọn lane: `nextLanes(project, statuses, live)` — lane đang sống + tối đa một lane mới khi `max_parallel=2` (policy token / release) VÀ: là slice runnable đầu tiên theo thứ tự, nằm trong `parallel_ok` cùng lane đang sống, cả hai single lane, không chung nhóm `exclusive` (MILESTONES `exclusive: {api: [...], figma: [...]}` hoặc front matter `exclusive: [api]`). Lane mới luôn vào worktree khi đã có lane sống (quy tắc đặt chỗ). `preflight` nhận `max_parallel=2`. Khởi động lại với hai lane in_progress hợp lệ → tiếp tục cả hai thay vì stuck. |
| M5c | Vòng lặp nhiều lane: map `ctx` theo slice; xoay vòng các lane chưa đỗ, mỗi lane một `stepLane`, `waitMs` 75 s khi có hai lane (timeout chỉ là checkpoint). Câu hỏi có slice chỉ đỗ slice đó; câu hỏi không slice (stuck, needs_policy, cursor_off) đỗ tất cả. Judge / autopilot / giao pilot chạy cho MỌI câu hỏi mở, không chỉ câu đầu; `waitForAnswer` chỉ khi mọi lane đều đỗ. `runner.slice` = lane ở main, else lane sớm nhất; `runner.lanes` cập nhật mỗi lượt. `stop-after` không mở lane mới, để lane sống chạy xong. |
| M5d | Merge: lane worktree vào phase `merge` chỉ khi không còn lane nào sống ở main (đứng ở `merge_wait`, log một lần); hai lane worktree merge lần lượt (`merge_owner` trong runner-file, FIFO theo thời điểm tới `merge`). Lane main tới `commit` khi lane worktree đang merge → chờ (token `main_git` thu gọn về `merge_owner`). |
| M5e | Thử: harness kịch bản hai lane (cặp chạy S01 main + S02 worktree; không phải cặp → nối tiếp, log như cũ; nhóm exclusive → nối tiếp; câu hỏi lane A trong lúc lane B tới merge; B chờ A commit rồi mới merge; A xong trước → C vào worktree; kill + restart với hai lane → tiếp tục cả hai, không spawn lần hai). Rồi một dự án ít rủi ro / capytal với một cặp có director theo dõi. |

- **M5a xong (0a17e9f)**, **M5b xong (1058b75)** như bảng trên.
- **M5c + M5d xong (2026-10-16):** `startLanes` (producer-runner.mjs) khi `maxParallel = 2`; vòng một lane giữ nguyên.
  Mỗi lượt: judge / autopilot / giao pilot cho mọi câu hỏi mở, báo director ngay (`asked` + thông báo + hộp thoại, một lần
  mỗi câu, lại một lần khi pilot `--auto` trả về); câu hỏi có slice đỗ slice đó, câu không slice đỗ tất cả.
  Lane = `runner.lanes` còn phase ∪ `nextLanes().live`; lane mới (luôn kèm `pairProblem` với lane đang sống) không mở khi
  một lane đang `merge`/`committing` hoặc khi có `stop-after`; chọn xong lane đầu thì nhìn lại ngay để lane cặp vào trước
  lượt chờ dài. Lane bên cạnh: `force_worktree` trong producer-state. Lượt của một lane = các bước tới hết MỘT orca-wait
  (`ctx.waited` đặt trong `wait()`), `waitMs` = min(WAIT_MS, `PRODUCER_RUNNER_LANES_WAIT_MS` 75 s) khi hai lane.
  Quy tắc đặt chỗ lúc chạy: lane ở main (`lane_in_main`, hoặc main mà không có / sắp có worktree) chỉ chạy khi lane
  sớm hơn không ở main — lane bị trả về main (`worktree_failed` → main) chờ, kiểm cả giữa các bước trong lượt.
  M5d: lane worktree ở phase `merge` chờ khi còn lane sống ở main, hoặc khi `merge_owner` là lane khác (FIFO, xoá khi
  xong); lý do chờ ghi `lane_wait` (log một lần, `status` hiện `waits`). "Lane main tới commit khi lane worktree đang
  merge" không xảy ra: worktree chỉ merge khi không còn lane ở main và không lane mới nào mở trong lúc merge.
  `waitForAnswer` / `--once` trả về chỉ khi không lane nào bước được. Cache release mất lane của runner → ghi lại
  in_progress (như một lane). Xong một lane còn lại một → `current_slice` theo lane còn lại.
  220/220 test (+6 runner-m5c.test.mjs: cặp main + worktree với merge chờ main; không phải cặp → nối tiếp ở main;
  câu hỏi chỉ đỗ lane của nó; kill + restart tiếp tục cả hai không spawn lại; lane trả về main chờ lane main;
  hai lane worktree merge FIFO). Harness: bước `sleepMs` dài hơn một lượt = một lượt bận (orca-wait gọi fake nhiều lần).
- **Đặt chỗ theo cặp (2026-10-16, sau pilot 24 S40/S41):** lane được chọn một mình mà có slice ghép cặp khởi động
  được ngay trong cùng lượt (`pairPartner`: nextLanes khi coi lane này in_progress, không đỗ câu hỏi, không vướng
  preflight) cũng vào worktree — main trống, không merge nào phải chờ main. Lane thật sự chạy một mình vẫn ở main
  (không tốn worktree + verify). Lane đã chạy ở main từ chế độ một lane (lane_in_main) giữ main; M5d vẫn áp dụng.
- **Còn lại (M5e):** chạy thật với một cặp có director theo dõi; pilot 24 không còn cặp độc lập (S22 phụ thuộc mọi slice).
- Lỗi nhỏ thấy khi làm M5c: `cancel` gửi `current_slice: ''` cho `writeRelease` (khoá đúng là `currentSlice`) nên
  không xoá `current_slice` — vô hại (lần chọn sau ghi đè).

Rủi ro đã biết, chấp nhận ở bản đầu: một bước chặn lâu của lane này (staticGate ≤ 600 s, wait-mcp ≤ 240 s, harvest ≤ 300 s,
judge ~1 phút) làm lane kia trễ phản ứng đúng chừng đó — không mất việc, chỉ chậm. RAM: 2 editor đo được footprint
~6,7 GB + swap ~6,7 GB; 3 editor (khi main mở lại để verify) sẽ swap nặng — res-guard `admit` giữ spawn tối đa 30 phút.

