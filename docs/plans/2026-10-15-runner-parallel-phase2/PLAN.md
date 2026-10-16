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

