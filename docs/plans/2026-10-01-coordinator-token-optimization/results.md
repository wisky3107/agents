# Pilot results (PLAN §7)

One row per pilot slice. Tokens are context tokens (cache read + cache write + fresh input) from
`tools/token-report` (`--project <slug> --since <slice start>`), per role. Baseline = the same
project's last comparable slice before the plan.

## cc-lego-stack

**Baseline**: S01 (L, fleet). Producer: codex gpt-6-luna-high. Coordinator: codex. Source: token-report from 2026-09-24, slice attribution.

| Role | Sessions | Turns | Context tokens |
|---|---|---|---|
| producer (LLM) | 1 | 1025 | 145.9M |
| fleet-orch | 1 | 191 | 24.8M |
| fleet-worker (claude + codex) | 15 | 1072 | 225.0M |

Project totals 2026-09-24 → 2026-10-02: producer 167.9M (27%), fleet-orch 196.7M (31%), fleet-worker 225.0M (36%).

| Pilot | Slice | Size / lane | Setup | Producer tokens | Fleet-orch tokens | Runner stops (blocked / human / LLM) | Notes |
|---|---|---|---|---|---|---|---|
| 1 | S08 | L / fleet | `producer_mode: runner`, no judge, guard `shadow`, M1 roles + M3 cheatsheets live (master f5fc21e; runner restarted onto 02c1541, e154671) | 0 (no LLM producer) + runner's verifier 1.2M (13 turns) | 82.9M (616 turns) | 7 / 7 / 0 | merged 2026-10-02 14:47Z (main b8dc783, commit cc223e7), verified; 3 review rounds, 2 fix rounds, 3 gates; 5 h 53 m wall |

| 2 | S02 | M / single | runner sau M6/M6b + lựa chọn director_gate GIVEN; `manual_required: defer`; no judge | 0 (no LLM producer) | — (single lane: writer + 2 reviewers, 3 sessions, 238 turns, 39.5M) | 2 / 2 / 0 trong slice (+5 director_gate trước khi chọn) | merged 2026-10-02 19:52Z (`403f1d1`, bookkeeping `2ef8040`); 1 fix round; 5 manual deferred; kẹt 1 h 30 ở bước commit |

| 3 | S03–S07 | 5 × M / single | runner sau pilot 2 (commit single lane, autopilot); `S03-S07 GIVEN`, judge sonnet, `autopilot: retry_once`, `manual_required: defer`; session theo dõi tự trả lời | 0 (judge + Step 3: 0.2M) | — (lane: 15 sessions, 928 turns, 149.4M) | 3 / 1 director + 2 session theo dõi / 0 judge | merged 2026-10-03 02:52Z; 5 slice, 6 fix round; 23 việc manual hoãn; Step 3 chờ director ký |

| 4 | S09 | L / fleet | runner (M6–M6b, autopilot `retry_once`, judge sonnet, `manual_required: defer`), codex coordinator, session theo dõi tự trả lời; evidence-only `worktree rm --force` | 0.1M (judge) | 122.0M (878 turns) | 3 / 1 director + 2 session theo dõi / 0 judge | merged 2026-10-03 18:01Z (`14d813a`, merge `8fcc149`, bookkeeping `b80d3fa`); 3 review rounds, 2 fix rounds, 1 gate; 18 manual hoãn; 4 h 47 |

### Pilot 1 — kết quả

token-report `--since 2026-10-02T08:54:00Z --project cc-lego-stack`, đến 14:49Z.

| Role | S01 baseline | S08 pilot 1 | Δ context |
|---|---|---|---|
| producer (LLM) | 1 session, 1025 turns, 145.9M | 0 | −100% |
| runner LLM handoff (verifier main) | — | 1 session, 13 turns, 1.2M | |
| fleet-orch | 1 session, 191 turns, 24.8M | 1 session, 616 turns, 82.9M | +234% |
| điều phối cộng lại (producer + runner + fleet-orch) | 170.7M | 84.1M | −51% |
| fleet-worker | 15 sessions, 1072 turns, 225.0M | 13 sessions, 611 turns, 104.9M | −53% |

- **Producer: đạt mục tiêu** (gate −60%, stretch −70%). Runner không gọi judge, và slice này không cần handoff Step 0–1 hay Step 3. LLM duy nhất phía producer là verifier sau merge. Không tính vào đây:
  - 7 câu hỏi director phải trả lời;
  - session theo dõi pilot (chạy trong `~/.agents`, ngoài project).
- **Fleet coordinator: chưa đạt** (mục tiêu −40%), nếu so riêng fleet-orch.
  - Context mỗi turn gần như không đổi: 134k so với khoảng 130k ở S01. Phần tăng đến từ số turn (gấp 3,2).
  - S01 có số turn của producer lớn (1025) bên cạnh 191 turn của coordinator, nên so riêng fleet-orch dễ sai. Gộp cả khâu điều phối thì giảm 51%.
  - Turn của coordinator: judgement 70%, chờ 17%, mechanical 10%. Phần script thay được tối đa là 28%.
  - Context của turn đầu (trung vị) chỉ 17k nhờ M1 (coordinator chạy không có editor MCP).
  - Cần một slice so sánh được hơn trước khi kết luận về mục tiêu −40%.
- **Runner dừng 7 lần, cả 7 đều do người trả lời, judge trả lời 0 lần.**
  - Chỉ 3 lần là quyết định thật: q1 (cách tạo material, C‍ursor), q4 và q5 (gate).
  - 4 lần còn lại là do runner:
    - q2: status "implementing" (đã sửa);
    - q3: báo nhầm coordinator mất;
    - q6: gate trùng;
    - q7: runner chỉ đọc `review.md`.
  - Tổng thời gian chờ người khoảng 3 h 23 m (q1 83 m, q5 49 m, q7 30 m, q3 23 m, q2 17 m). Trong lúc chờ q2, q3 và q5, fleet vẫn chạy tiếp.

### Pilot 1 — sự cố (ghi trong lúc chạy)

- **09:05Z: fleet báo `infra_blocked`. Runner hỏi `q1` (lane_blocked) và chờ 83 phút mà không ai biết.**
  - Nguyên nhân 1, có từ trước pilot: fleet SKILL cố định task art-manifest chạy bằng `cursor --model auto`, mà `cursor-agent` trên máy chưa đăng nhập (đã ghi ở M1).
  - Nguyên nhân 2: director chưa quyết cách xử lý `brick_material` (.mtl tạo qua AssetDB/Funplay).
  - 10:28Z director trả lời qua `answer` ("send this answer to the lane"): integrator tạo `.mtl`; bỏ art-manifest nếu không còn dòng art nào; nếu vẫn cần thì chạy bằng claude sonnet. Runner chuyển câu trả lời cho coordinator, và coordinator chạy tiếp ngay (tạo task implement).
  - Sửa: runner gửi thông báo desktop và rung chuông khi bắt đầu chờ một câu hỏi (commit bfcbf47, merge 02c1541). Runner của pilot 1 vẫn chạy code cũ cho tới khi được khởi động lại.
  - Đề xuất cho fleet SKILL: art-manifest dùng `writer_agent` khi Cursor không dùng được, hoặc kiểm tra đăng nhập Cursor trước khi dispatch.
- **10:35Z: một lần chạy test game-producer trên master có 1 test fail; 4 lần chạy lại đều 51/51.** Có lẽ một test kill với cửa sổ thời gian 1,5 s bị chậm vì máy đang chạy fleet. Chưa xác định được test nào.
- **10:52Z: fleet ghi HANDOFF `status: "implementing"`, ngoài bộ status đã quy định.** Runner hỏi `q2` (`unknown_status`), đúng nguyên tắc không đoán, nhưng câu hỏi fleet không có lựa chọn nào hợp. Fleet không bị chặn: nó vẫn implement trong lúc runner chờ.
  - Sửa: status chỉ tên bước (`implementing`, `reviewing`…) được coi là `working`; mọi câu hỏi `unknown_status` có thêm "treat as working, keep waiting" (commit a23c12e, merge e154671).
  - 11:09Z: runner được khởi động lại với code mới. `q2` được bổ sung lựa chọn đó rồi trả lời; runner mới áp dụng câu trả lời và chờ tiếp.
- **Cùng commit đó: Cursor không đăng nhập được không còn làm slice dừng.**
  - Runner dò một lần (`agent-ready.mjs`; `cursor-agent status` báo sai), rồi hỏi một câu `cursor_off` cho cả run trước mọi spawn chạy Cursor.
  - Fleet SKILL: art-manifest chuyển sang claude sonnet khi Cursor không dùng được.
  - Còn lại: `worker-prompts-art.md` và `worker-prompts.md` vẫn ghi Cursor cho art-manifest. Session khác đang sửa dở hai file này trên master, nên để sửa sau.
- **12:20Z: `q3` coordinator_missing là báo động nhầm.**
  - Coordinator `term_933390d6…` vẫn sống: còn trong `terminal list`, có output, và vẫn là `coordinator_handle` của Run.
  - `orca-wait` nhận một lỗi tạm thời của `terminal wait` mà text khớp "missing", nên báo `terminal-missing`.
  - Runner làm đúng luật: không spawn lại coordinator, chỉ hỏi người.
  - Vì runner kẹt ở `q3`, nó không đưa được gate đang chờ (`gate_c71089f4f384`, mở rộng phạm vi test F3) lên cho director.
  - 12:43Z director trả lời "taken over, continue". Runner đưa gate lên thành `q4` ngay lập tức.
  - Đề xuất sửa: trước khi hỏi `coordinator_missing`, kiểm lại bằng `orca terminal list` / `run-show` hoặc thử lại một lần.
- **12:44Z: `q4` fleet_gate, director chọn "yes"**, chỉ cho phép đúng 2 file test của gate. Runner gửi quyết định cho coordinator dưới dạng text, đúng một lần. Coordinator tự resolve gate; runner không gọi `gate-resolve`. HANDOFF xác nhận lúc 12:44:43Z. Fix round 1 đang chạy.
- **13:24Z → 14:14Z: hai gate cho cùng một quyết định (F2-residual, draw calls), hỏi thành hai câu `q5` và `q6`.**
  - 13:24Z runner đưa `gate_f1bd12b0342d` (review round 2) lên thành `q5`. Trong lúc `q5` chờ, coordinator chạy round 3 và mở thêm `gate_93bf04a886e8` cho cùng vấn đề, thay vì cập nhật gate cũ.
  - Runner chỉ hỏi một câu mỗi lần, nên `q6` chỉ hiện ra sau khi `q5` được gửi (14:13:23Z), dù director đã ghi trong `q5` rằng quyết định áp dụng cho cả hai gate. Coordinator resolve cả hai gate từ câu trả lời của `q5`; `q6` được trả lời cùng lựa chọn chỉ để runner thôi chờ.
  - Director chọn `baseline_plus_layers`: tổng draw call ≤ baseline UI của S01 (22) + số layer + 10.
  - Đề xuất sửa: khi có nhiều gate đang chờ, gộp vào một câu hỏi; trước khi hỏi một gate, kiểm lại xem nó còn pending không.
- **14:17Z: `q7` approval_evidence. Runner đọc nhầm file review cũ, nhưng dừng là đúng.**
  - Fleet ghi mỗi round review ra một file riêng (`review-r2.md`, `review-r3.md`). Runner chỉ đọc `review.md`, tức file của round 1, kết thúc bằng CHANGES_REQUESTED.
  - Round 3 cũng kết thúc bằng CHANGES_REQUESTED vì còn chờ gate F2. Chữ APPROVED chỉ có trong HANDOFF và `final-report.md`, do coordinator ghi sau khi gate được resolve.
  - Ở gốc evidence không có `runtime-state.json`. Fleet còn tự báo 2 việc `manual_required`: đo fps và thời gian mở trên máy thật, và director xem GP-22.
  - Director bỏ qua bước đo trên máy thật và đã xem GP-22.
  - Coordinator đổi tên `review.md` của round 1 thành `review-r1.md`, viết `review.md` cuối (dòng cuối APPROVED, ghi rõ không có review mới) và `runtime-state.json` (có `director_checks`, không có `manual_required`). Sau đó q7 được trả lời "evidence fixed, check again".
  - Đề xuất sửa: runner đọc file review mới nhất của fleet. Prompt fleet cho runner mode ghi rõ phải có `runtime-state.json` và dòng verdict cuối cùng.
- **14:43Z: slice được commit ngoài runner.**
  - Trong lúc runner còn dừng ở q7, có người gõ `approved — commit` thẳng vào terminal của coordinator: outbox của runner không có lệnh này. `final-report.md` của fleet cũng mời director gõ đúng câu đó.
  - Coordinator commit `cc223e7` trước khi Step 2d của runner qua.
  - Không có hậu quả: sau khi q7 được trả lời, runner gửi lệnh commit, coordinator ghi lại HANDOFF `committed` với cùng sha (không commit lần hai), rồi runner merge.
  - Rủi ro: gõ vào terminal của coordinator là bỏ qua được Step 2d.
  - Đề xuất sửa: ở runner mode, prompt fleet chỉ cho commit khi runner yêu cầu, và `final-report.md` chỉ người đọc tới câu hỏi của runner.
- **14:47Z → 14:49Z: merge, verify, record đều xong (`phase done`).**
  - Merge `b8dc783` vào `main`, không conflict. Verifier chạy claude sonnet và mất 77 s.
  - Worktree S08 được giữ lại vì còn file evidence sửa chưa commit.
  - Trên `main` còn lại:
    - `AGENT_NOTES.md` chưa commit: dòng ghi chú của runner, `S08: merged`, cùng hai dòng sửa trước pilot (`producer_mode`, reviewer);
    - các file evidence tracked bị rsync ghi đè;
    - 2 file untracked do Editor tạo khi mở lại: `assets/.meta`, `assets/scenes/game.scene.index.json.meta`.
  - Chưa rõ SKILL muốn runner commit các file này hay để director commit.
  - Runner chuyển ngay sang S02 và dừng ở `q8` (director_gate: S02 `needs_director_ok`, dòng policy chưa ghi quyết định).

### Pilot 2 — S02 (M, single lane), 2026-10-02

- **17:29Z: director chọn "S02 GIVEN — record it" trong hộp thoại (q12).** Runner ghi quyết định lên dòng policy và chọn S02 ngay.
  - Trước đó, q8–q11 lặp lại: director chọn "decided, retry" mà chưa ghi quyết định lên dòng policy. Lỗi này đã sửa bằng lựa chọn GIVEN (merge `a6c403f`).
- **Lane chạy đúng.** Writer chạy 28 phút. Review 1 trả CHANGES_REQUESTED, runner gửi fix round 1, rồi review 2 trả APPROVED. `manual_required: defer` hoãn 5 việc manual mà không hỏi.
- **18:22Z: writer commit `403f1d1` nhưng không ghi HANDOFF `committed` + sha, rồi thoát.**
  - Prompt của writer ghi "Do not commit". Quy trình commit chỉ nằm trong phần hướng dẫn cho producer, nên lệnh `approved — commit` không nói writer phải làm gì.
  - Runner hỏi `commit_stalled` (q13). Director chọn "resend commit" sau 81 phút. Sau đó runner chờ im lặng: fingerprint của tình huống trùng với q13 đã được trả lời.
  - 19:52Z, session producer ghi HANDOFF thay writer, theo lệnh của director. Runner chạy tiếp: harvest, record, rồi bookkeeping commit `2ef8040` (`AGENT_NOTES.md`). Sau đó runner hỏi director_gate cho S03.
- **Đã sửa (commit `f579d10`):**
  - lệnh commit cho single lane nói rõ phải ghi gì vào HANDOFF;
  - đúng một commit mới trên main kể từ lúc gửi lệnh thì runner nhận luôn, nhiều hơn thì director chọn;
  - đã gửi lại lệnh commit mà vẫn kẹt thì runner hỏi lại;
  - thêm `autopilot: retry_once`;
  - việc manual hiển thị dạng "item — reason".
- **Token:** lego-stack chưa có slice single lane nào chạy theo cách cũ để so sánh. Producer tốn 0 token. Lane: 3 session, 238 turn, 39,5M context.
- **2026-10-03: director yêu cầu chạy S03–S07 liên tục, không dừng.** Đã làm 3 việc:
  - ghi `S03-S07 GIVEN` lên dòng policy;
  - bật `judge_agent: claude --model sonnet`;
  - bật `autopilot: retry_once` sau khi merge.

### Pilot 3 — S03–S07 liên tục (2026-10-02 19:53Z → 2026-10-03 02:52Z)

Director yêu cầu chạy hết các slice mà không bị chặn. Đã làm:
- ghi `S03-S07 GIVEN` lên dòng policy;
- bật `judge_agent: claude --model sonnet` và `autopilot: retry_once`;
- cho session theo dõi kiểm tra mỗi 30 phút và tự trả lời câu hỏi của runner theo luật an toàn (không bao giờ chọn stop / mark blocked / skip).

| Slice | Commit | Thời gian (UTC) | Fix round | Câu hỏi | Manual hoãn | Lane (sessions / turns / context) |
|---|---|---|---|---|---|---|
| S03 | `d76a55b` | 19:53 → 20:28 | 0 | q14 director_gate (trước khi chạy; session theo dõi trả lời sau khi có GIVEN) | 3 | 2 / 147 / 25.1M |
| S04 | `f4e66f2` | 20:28 → 00:04 | 1 | q15 verdict_override — báo động nhầm, chờ director 2 h 45 | 4 | 3 / 202 / 31.6M |
| S05 | `6c3e521` | 00:04 → 00:29 | 1 | — | 0 | 3 / 131 / 17.6M |
| S06 | `b5edc04` | 00:29 → 01:13 | 1 | — | 7 | 3 / 173 / 30.6M |
| S07 | `24d01e6` | 01:13 → 02:52 | 2 | q16 verdict_mismatch — race; judge chuyển cho director, session theo dõi trả lời sau 23 phút | 5 | 4 / 275 / 44.5M |

- **Mỗi slice có thêm một bookkeeping commit** do runner tự tạo (`chore(producer): record <Sxx> merge`): `266f0d3`, `4bed25c`, `4ab8868`, `ea75c89`, `95cf2a2`. Không slice nào kẹt ở bước commit: bản sửa ở pilot 2 có tác dụng.
- **Autopilot: 0 lần.** Judge: 1 lần, và lần đó judge chuyển cho director. Phía producer tốn 0.2M (judge và handoff Step 3).
- **Thời gian:** cả chuỗi mất 7 h. Trừ 2 h 45 ở q15 thì còn khoảng 4 h 15, trung bình khoảng 50 phút cho một slice M.
- **`manual_deferred`** từng liệt kê 24 dòng cho 23 việc: dấu `status: manual_required` thành một dòng riêng, và `{reason, items}` bị tách đôi. Đã sửa: `manualItems` chỉ đọc danh sách trong các trường `manual_required`, còn dấu trần chỉ hiện khi không có gì khác; `status` đọc lại runtime-state của từng slice, nên các slice cũ cũng hiển thị đúng.
- **Step 3** do codex chạy. Nó trình các việc manual, và chưa build hay deploy cho tới khi director ký done/waived.

Sự cố và cách sửa:
- **S04, q15: báo động nhầm của `verdict_override`.** Reviewer giữ lại `review-r1.md` (CHANGES_REQUESTED) cạnh `review.md` APPROVED mới. Luật M6 vốn dành cho verdict do coordinator viết lại, nhưng lại chạy cả ở single lane. Đã sửa: luật này chỉ áp dụng cho fleet (`8db0556`).
- **S07: writer đưa `AGENT_NOTES.md` về bản đã commit trong fix round 1.** Cache release lại ghi `S07: planned`. Nếu runner lập kế hoạch lại lúc đó, nó sẽ mở writer thứ hai.
  - Session theo dõi đã ghi lại cache bằng tay.
  - Đã sửa (`c7d27ce`): slice đang chạy của runner thắng cache bị ghi đè. Yêu cầu fix round cũng dặn writer không khôi phục `AGENT_NOTES.md` hay file của runner.
- **S07, q16: race giữa HANDOFF và `review.md`.** Reviewer ghi HANDOFF `approved` lúc 02:27:39Z; `review.md` 18 giây sau mới kết thúc bằng APPROVED; runner hỏi đúng vào khoảng giữa. Đã sửa: runner nhìn thêm 2 lần trước khi hỏi `verdict_mismatch`.
- **Restart giữa slice:** runner được restart 3 lần (S03 writer, S05 writer, S07 review) để nhận code mới. Lần nào cũng chạy tiếp đúng lane cũ, không spawn thêm.

### Pilot 4 — S09 toon-ui-outline (L, fleet), 2026-10-03 13:14Z → 18:01Z

Slice do director yêu cầu: làm lại UI theo phong cách cartoon và chỉ vẽ viền cho 3 lớp kế tiếp, khử nét khuất. Contract và 7 mock được duyệt trước khi chạy (`ac5ec23`).

| Role | S01 (baseline) | S08 (pilot 1) | S09 (pilot 4) |
|---|---|---|---|
| fleet-orch | 1 session, 191 turns, 24.8M | 1 / 616 / 82.9M | 1 / 878 / 122.0M (trung bình 139k/turn; turn đầu 17k) |
| fleet-worker | 15 / 1072 / 225.0M | 13 / 611 / 104.9M | 16 / 996 / 237.3M |
| producer (LLM) | 145.9M | 0 | 0.1M (judge) |

- **Mục tiêu −40% cho coordinator: vẫn chưa đạt.** S09 tốn hơn S01 392%, hơn S08 47%.
  - Context mỗi turn gần như không đổi qua cả ba slice: khoảng 130k, 134k, 139k. Chi phí đi theo **số turn**, và số turn tăng theo số vòng review và số task fix: S09 có 3 vòng review và 12 task.
  - Turn split của coordinator: judgement 71%, chờ 20%, mechanical 7%. Phần script thay được tối đa là 25%.
  - Kết luận: M1 (turn đầu 17k) và M2/M3 không giảm được chi phí mỗi turn. Muốn đạt −40% phải giảm số turn của coordinator. Hướng đi: gom nhiều task fix thành một dispatch, rút ngắn vòng chờ, hoặc chuyển phần điều phối mechanical sang runner.
- **Runner hoạt động đúng trên fleet:**
  - Hỏi 3 câu:
    - q17: director_gate; director chọn GIVEN qua session theo dõi.
    - q18: gate về lỗi ES5 `Map` có từ S08 trong `LayerMeshBuilder.ts`; session theo dõi chọn sửa trong đường dẫn đã cho phép của slice.
    - q19: `lane_blocked`; preview không chạy rAF; session theo dõi trả lời "dùng recipe stepped-clock của slice, reviewer claude".
  - Một lần orca-wait báo nhầm coordinator mất; runner kiểm lại bằng `terminal show`, không hỏi.
  - Merge chạy trọn: lần đầu dùng thật đường xoá worktree khi chỉ còn evidence (`--force` sau khi chép lại); verify đạt; bookkeeping commit 4 file. Không phải dọn tay.
- **Sự cố hoặc bài học:**
  - Coordinator chuyển review sang `cursor --model auto` dù Cursor đang tắt; luật fleet chỉ cho làm vậy khi `cursor=on`. Session theo dõi phải trả lời để kéo review về claude.
  - 18 việc được hoãn theo `manual_required: defer`, trong đó có trùng lặp và vài dòng **không phải kiểm thủ công** — "A-09-04 outline-only volume (blocked by F1)", "rerun the whole round-2 review…". Một acceptance row chưa kiểm được đã đi qua dưới dạng "manual". Đề xuất: defer chỉ nhận việc cần máy thật hoặc mắt người; dòng nhắc tới acceptance ID ở trạng thái "blocked" thì phải hỏi director.
  - Lỗi ES5 `Map` (crash ở mọi lần chuyển level trên bản web) có từ S08, tức đã có trong preview v1.0.0. S09 đã sửa.

### Pilot 5 — S12 scene-structure (L, fleet), từ 2026-10-06 03:23Z

Đây là slice director yêu cầu ngày 2026-10-06 (S12-D1). Mục tiêu: đưa toàn bộ UI đang dựng bằng code vào `game.scene` và prefab theo `.cursor/rules/35-scene-structure.mdc`, đặt tên `{Kind} - {label}`, và người chơi không thấy gì thay đổi. Hai quyết định đi kèm: D2 giữ ngưỡng so ảnh mặc định, D3 hiệu ứng dùng prefab + NodePool. Contract nằm ở `fb9d4fd`. Rule và scene-tool đã đồng bộ ở `4fdfac6`.

Pilot này chạy lần đầu trên runner với các bản sửa của ngày 2026-10-06:
- `coordq`: chuyển câu hỏi riêng của codex thành popup cho director.
- `director_pending` và `coordinator_screen`.
- art fallback (slice này không có art).
- `run-smoke` mới: thăm dò lại Orca trước khi kết luận Orca chết, và giới hạn 3 lần chập chờn.

Cấu hình lúc khởi chạy:
- runner pid 50354, terminal `term_97ae84f4…`;
- coordinator codex gpt-6-luna-high, terminal `term_0f32c7d6…`;
- writer claude sonnet high, reviewer claude opus medium;
- judge claude sonnet, autopilot retry_once, manual_required defer.

Policy line: `S12 GIVEN`. Kết quả (token-report `--since 2026-10-06T03:23Z`, số turn, vòng review, sự cố) sẽ ghi khi slice merge.

### Pilot 5 — kết quả (S12 merge 2026-10-06 06:58Z)

- **Merge:** `0db6294`, slice commit `f14f528`, bookkeeping `a7bc506`. Tổng thời gian 03:23Z → 06:58Z = 3 giờ 35 phút. Trong đó có 24 phút runner đứng vì lỗi (xem phần sự cố) và các lần chờ director.
- **Review:** 1 vòng, APPROVED, 0 vòng fix, 4 finding (tất cả minor hoặc followup).
- **Kiểm tra tay:** 3 việc hoãn theo `manual_required: defer`: feel trên máy thật, FPS và level start thời gian thực, z-order của FX trên result card.
- **Bằng chứng runtime:** so ảnh 41/41, giải 103/103 level, perf nằm trong ngưỡng A-12-09, smoke V2 đạt 53/53. Smoke V1 đạt 52/53; check fail là `S03-04`, lỗi có từ trước, giống hệt ở baseline.

| Role | S01 (baseline) | S08 (pilot 1) | S09 (pilot 4) | S12 (pilot 5) |
|---|---|---|---|---|
| fleet-orch | 1 session, 191 turns, 24.8M | 1 / 616 / 82.9M | 1 / 878 / 122.0M | 1 / 508 / 65.0M (trung bình 128k/turn; turn đầu 17.9k) |
| fleet-worker | 15 / 1072 / 225.0M | 13 / 611 / 104.9M | 16 / 996 / 237.3M | 2 / 291 / 99.2M (writer+integrator 249 turns 93.5M, reviewer opus 42 turns 5.7M) + verifier 1 / 16 / 1.4M |
| producer (LLM) | 145.9M | 0 | 0.1M (judge) | 0.07M (judge, 2 lần) |

- **Mục tiêu −40% cho coordinator: vẫn chưa đạt so với S01**, vì S12 tốn hơn S01 162%. So với các pilot trước thì đã giảm: −22% so với S08, −47% so với S09.
  - Context mỗi turn vẫn như cũ (khoảng 128k, trong khi S08 134k, S09 139k). Phần giảm đến từ **số turn**: 508 so với 878, vì chỉ 1 vòng review và 0 vòng fix. Planner, scan và art đều bị bỏ qua (`lite`).
  - Kết luận của pilot 4 vẫn đúng: chi phí coordinator đi theo số turn. Theo heuristic, turn split là judgement 73%, chờ 17%, mechanical 8%, nên phần script thay được tối đa khoảng 27%.
- **Câu hỏi runner (4):**
  - q39 `coordinator_missing`: báo động sai. `orca-wait` báo coordinator mất 5 lần trong khi `terminal show` vẫn thấy nó. Director chọn "taken over, continue".
  - q40 `fleet_gate`: khi reimport, Creator ép tên root của prefab theo tên file, nên luật tên node không qua được nếu file tên `SelectRow.prefab`. Judge không tự quyết. Director chọn đổi tên file prefab thành `Panel - Select Row.prefab` và các tên tương tự.
  - q41 `fleet_gate` (commit-guard): smoke V1 52/53 vì `S03-04`. Judge không tự quyết. Session theo dõi kiểm tra baseline thấy fail giống hệt, rồi chọn "authorize commit with documented baseline failure", kèm một dòng FOLLOWUPS.
  - q42 `verify_failed`: lỗi `S03-04` trên main sau khi merge. Director chọn "record merged anyway".
- **Sự cố và bài học:**
  - **Runner đứng 06:02 → 06:26Z:** orca đặt tên worktree `feature-S12-scene-structure`, trong khi `sliceWorktrees` chỉ nhận tên bắt đầu bằng `S12-`. Vì vậy runner không bao giờ đọc HANDOFF `offer_commit`. Đã sửa trên master `28668a9` (review APPROVED, kèm regex dò "Merge branch"), rồi khởi động lại runner ở terminal `term_7c143065…`.
  - **Judge bị "quote không nguyên văn" chặn 2 lần (q40, q41):** câu nó trích từ A-12-09 có chỗ khác dấu câu so với slice. Nên nới việc so khớp câu trích, ví dụ bỏ qua dấu câu và khoảng trắng.
  - **`S03-04` (EXPECT `"n/a-or-true"` so với `true`) gây ra 2 câu hỏi** (q41, q42). Cần sửa check này trước slice tiếp theo, nếu không câu hỏi sẽ lặp lại ở mọi lần chạy V1.
  - **Ghi chú dựng UI theo cụm qua Funplay** (gửi lúc 03:5xZ) nằm trong hàng đợi của codex rồi được nạp đúng lúc. Coordinator chép nó vào `specs/integrate.md`, và integrator dựng scene theo cụm.
  - **Hai giới hạn của Cocos mà rule 35 nên ghi lại:** mỗi script chỉ có một `@ccclass`, nên `UiRefs.ts` phải tách thành nhiều file; và tên root của prefab luôn bằng tên file, nên file prefab cũng phải đặt tên `{Kind} - {label}`.
  - **Diff scene/prefab rất lớn:** 193 file, khoảng 175k dòng. Gần như toàn bộ là JSON serialized, budget không đếm phần này.

### Pilot 6 — S13 chapter-home (L, fleet), từ 2026-10-06 08:52Z

Slice director yêu cầu ngày 2026-10-06 (S13-D1..D5, contract `03765f8` và `b5ad2d9`): màn Home có thẻ Continue, đếm số mẫu đã ghép theo từng chương, nút Home trên HUD, và save lên schema 2. Đây là màn hình mới đầu tiên được dựng thẳng trong scene sau S12, theo rule 35 và cách dựng theo cụm qua Funplay.

Pilot này chạy lần đầu với:
- bản sửa runner tìm worktree theo token `Sxx` (`28668a9`);
- check `S03-04` đã sửa (`7124dd0`). Ở pilot 5, check này gây ra 2 câu hỏi.

Cấu hình lúc khởi chạy:
- runner pid 75783, terminal `term_f584c2c9…`;
- coordinator codex gpt-6-luna-high, terminal `term_74556afc…`;
- writer claude sonnet high, reviewer claude opus medium;
- judge claude sonnet, autopilot retry_once, manual_required defer.

Policy line: `S13 GIVEN`.

Sự cố ngay lúc khởi chạy (q43 `prompt_not_sent`): codex mở menu cập nhật 0.160.1 khi khởi động và nuốt mất prompt. Session theo dõi chọn "Skip until next version" rồi "close it and spawn again". Runner có thể nhận diện màn hình này để tự bấm Skip.

Kết quả (token-report `--since 2026-10-06T08:52Z`) sẽ ghi khi slice merge.

### Pilot 6 — kết quả (S13 merge 2026-10-06 11:52Z)

- **Merge:**
  - merge commit `5635472`, slice commit `41a4ddc`, bookkeeping `8b587c7`;
  - verify trên main đạt.
- **Thời gian:** 08:52Z → 11:52Z, tức 3 giờ. Trong đó runner dừng 46 phút: từ q53 (11:06Z) tới lúc director cho chạy lại (11:52Z). Review r2 đã APPROVED từ 11:45Z.
- **Review:** 2 vòng (r1 CHANGES_REQUESTED với F1–F5, rồi r2 APPROVED), 1 vòng sửa.
- **Kiểm tra tay:** 5 việc hoãn theo `manual_required: defer`. Đó là feel thời gian thực, 500 ms từ lúc mở game tới Home, 300 ms mở Home, cùng các việc trên máy thật.

| Role | S01 (baseline) | S08 (pilot 1) | S09 (pilot 4) | S12 (pilot 5) | S13 (pilot 6) |
|---|---|---|---|---|---|
| fleet-orch | 1 session, 191 turns, 24.8M | 1 / 616 / 82.9M | 1 / 878 / 122.0M | 1 / 508 / 65.0M | 1 / 542 / 73.7M |
| fleet-worker | 15 / 1072 / 225.0M | 13 / 611 / 104.9M | 16 / 996 / 237.3M | 2 / 291 / 99.2M | 5 / 450 / 113.8M (writer+integrator 214 turns 79.4M; review r1, fix, doc, review r2) + verifier 1 / 35 / 3.4M |
| producer (LLM) | 145.9M | 0 | 0.1M (judge) | 0.07M (judge) | 0.1M (judge, 4 lần) |

- **Mục tiêu −40% cho coordinator vẫn chưa đạt so với S01.** S13 tốn hơn S01 197%, nhưng thấp hơn S09 40% và thấp hơn S08 11%. So với S12 thì tăng 13%, vì có thêm 1 vòng review và 1 vòng sửa (542 so với 508 turns).
  - Context mỗi turn vẫn quanh 136k. Kết luận của pilot 4 và 5 vẫn đúng: chi phí đi theo số turn.
- **Câu hỏi runner:** 11 câu, so với 4 ở S12.
  - q43 `prompt_not_sent`: menu cập nhật codex 0.160.1 nuốt mất prompt. Session theo dõi chọn "Skip until next version" rồi spawn lại.
  - q44 `fleet_gate`: `S04-03` dùng schema 2 làm mẫu "sai phiên bản". Director chọn đổi mẫu sang schema 3.
  - q45 `coordinator_missing`: báo động sai lần hai (lần đầu là S12 q39). Session theo dõi trả lời continue.
  - q46 `fleet_gate`: chỗ bên trái nút sound không đủ 44 px. Director đổi D4 sang đặt bên phải, và chấp nhận skin S09 cùng tick "OK".
  - q47 `fleet_gate`: director cho phép sửa thêm 4 file docs và FOLLOWUPS.
  - q48 `unknown_status`: status dạng câu mô tả "fix-r1 …". Director chọn "treat as offer_commit", là một lựa chọn bẫy vì review vẫn CHANGES_REQUESTED.
  - q49–q52 `approval_evidence`: "check again" kiểm lại ngay trên đúng các file cũ, nên runner hỏi lại khoảng mỗi 4 giây.
  - q53: director chọn stop.
- **Sự cố và bản sửa:**
  - Vòng lặp q48–q53 và báo động sai q45 đều đã sửa trên `~/.agents` master `c0671e1` (4 vòng review, APPROVED):
    - `orca-wait` kiểm lại bằng `terminal show` trước khi báo `terminal-missing`.
    - `unknown_status` chỉ đưa ra lựa chọn offer_commit khi review đã APPROVED.
    - `obs` của `approval_evidence` dựa trên file verdict thật và nội dung lỗi; thêm lựa chọn "back to the lane".
    - Handle stale mà HANDOFF không đổi suốt 30 phút thì runner hỏi `fleet_stall`.
    - Runner được khởi động lại bằng code mới (terminal `term_1adf32ae…`). Nó đi thẳng accept → commit → merge → verify, không hỏi thêm câu nào.
  - Bản sửa tìm worktree theo token `Sxx` (`28668a9`) chạy đúng: worktree tên `S13-chapter-home` được nhận ra, không bị kẹt như S12.
  - **Bài học:** hai gate về contract (q44 dùng schema 2 làm mẫu sai phiên bản, q46 chỗ bên trái nút sound không đủ 44 px) đáng ra phải được phát hiện lúc soạn slice. Người soạn slice nên kiểm hình học thật và các smoke check đang có, trước khi chốt một quyết định vị trí hay schema.

### Pilot 7 — S14 settings-panel (L, fleet), từ 2026-10-06 12:54Z — thử nghiệm orca-memory assist

Slice do director yêu cầu để thử orca-memory (contract `08e8f8b`). Director ủy quyền toàn bộ quyết định (S14-D1..D5), và yêu cầu chạy tới khi merge mà không dừng.
- Trước khi chạy đã `orca-memory refresh`: kho có 294 record, thêm 9 bài học từ S12/S13.
- Memory pack của planner: 6 mục, 1.976 token, nằm ở `T-S14/evidence/memory/plan/`, đường dẫn tuyệt đối. Mục đầu là `T-S13-rendered-label-floor-shrink`.
- Đây là slice assist đầu tiên có pack thực sự được giao. Ở S12/S13 pack không tới được agent (đã sửa ở `dcf5dea`).
- Cấu hình:
  - runner pid 90518, terminal `term_115c6069…`;
  - coordinator codex, terminal `term_64c44b31…`;
  - runner đã có các bản sửa `28668a9` và `c0671e1`.
- Policy line: `S14 GIVEN` (ủy quyền).
- Khi merge sẽ ghi:
  - token;
  - từng role có trích dẫn id memory nào hay ghi `memory used: none`;
  - các bài học trong pack có giúp tránh lỗi đã gặp không, ví dụ S14-03/04 có đo cỡ chữ thật lúc hiển thị ngay từ đầu không.

### Pilot 8 — cc-love-train S01→S07 (dự án mới, cả release), nhận lúc 2026-10-06 15:48Z

Ngày 2026-10-06 director nói "pilot dự án cc-love-train tự động làm hết". Đó là ủy quyền delegated: tôi trả lời mọi câu hỏi của runner, cho đến khi S07 merge, không push/deploy/tag. Mục đích: workflow chung, chạy trên một dự án mới tinh (source=media, contract do Fable viết, chưa commit trong main).
- Lúc nhận việc, runner đã chạy S01:
  - runner pid 14047, terminal `term_cc499227…`, khởi động lúc 14:27Z (đã có `dcf5dea`);
  - coordinator `claude --model sonnet`, terminal `term_dff019ee…`, Run `run_df286e4f009f`;
  - reviewer và judge đều là `claude --model opus`.
- Policy line đã có `S01, S02, S04, S05, S06 GIVEN`, autopilot `retry_once`, `manual_required: defer`, `deploy=preview` (Step 3 phải chờ director ký các mục manual trước khi build/deploy).
- Memory: `off`, nên không có pack.
- Phát hiện trước khi tôi vào:
  - **q1 fleet_gate (tsconfig strict)**: dòng acceptance "tsc strict clean" mâu thuẫn với SCOPE ("template common/* stays as shipped"). Có 161 lỗi strict nằm trong kit ui-popup và file template, đều ngoài slice. Judge defer đúng, director chọn A (`@ts-nocheck`). Lỗi nằm ở khâu viết contract: game-brief không chạy tsc strict trên baseline template và kit trước khi đưa dòng này vào.
  - **q2 lane_blocked (infra)**: Creator của worktree chết khi coordinator đóng terminal integrator, vì terminal đó đã khởi động Creator. Bản recovery chạy Creator detached (ppid 1). HANDOFF đã ghi rõ "No human action needed", nhưng judge vẫn defer cho director. Tôi trả lời "answered in the lane, continue" lúc 15:48Z.
  - **stop-after**: lệnh này không chặn được việc giao Step 3. `next.done` được kiểm tra trước `stop-after`, nên sau khi S07 merge, Step 3 vẫn được giao cho LLM producer.

### Pilot 7 — kết quả (S14 merge 2026-10-06 15:33Z)

Mục này ghi sau mục Pilot 8 vì pilot 8 (cc-love-train) bắt đầu trước khi S14 merge.

- **Merge:** `b50fcfe` (slice commit `21c3508`, bookkeeping `201e7e8`). Verify trên main đạt. Thời gian 12:54Z → 15:33Z, tức 2 giờ 39 phút. Runner không dừng lần nào.
- **Review:** 3 vòng, 2 vòng sửa.
  - r1: F1 bảng màu lệch so với mock.
  - r2: F3 chữ navy lệch 36 đơn vị mỗi kênh.
  - r3: APPROVED.
  - Có 6 việc kiểm tay được hoãn: feel thời gian thực, 300 ms mở Settings, fps, độ trễ input, notch trên máy thật, reduced motion của hệ điều hành.

| Role | S01 (baseline) | S08 | S09 | S12 | S13 | S14 (pilot 7) |
|---|---|---|---|---|---|---|
| fleet-orch | 1 session, 191 turns, 24.8M | 1 / 616 / 82.9M | 1 / 878 / 122.0M | 1 / 508 / 65.0M | 1 / 542 / 73.7M | 1 / 456 / 53.4M |
| fleet-worker | 15 / 1072 / 225.0M | 13 / 611 / 104.9M | 16 / 996 / 237.3M | 2 / 291 / 99.2M | 5 / 450 / 113.8M | 6 / 392 / 98.5M (writer+integrator 221 turns 77.8M; review r1–r3 và các vòng sửa) + verifier 1 / 7 / 0.6M |
| producer (LLM) | 145.9M | 0 | 0.1M | 0.07M | 0.1M | < 0.1M (judge 1 lần) |

- **Coordinator:** vẫn cao hơn S01 115%, nên mục tiêu −40% so với S01 vẫn chưa đạt. Nhưng đây là slice rẻ nhất kể từ S08: thấp hơn S09 56%, thấp hơn S13 28%, thấp hơn S12 18%, dù có 3 vòng review.
  - Số turn thấp nhất (456), context mỗi turn khoảng 117k. Nguyên nhân là runner không dừng lần nào và không có báo động sai.
  - Kết luận cũ vẫn đúng: chi phí đi theo số turn.
- **Câu hỏi runner:** 2 câu (S13 có 11).
  - q54 `fleet_gate`: phần đổ bóng và viền plate kiểu S09 còn sót. Judge không tự quyết vì câu trích không khớp nguyên văn. Director trả lời qua dialog: chấp nhận như một điểm lệch so với mock theo D1.
  - q55 `approval_evidence`: dòng cuối của review.md là "APPROVED (automated and static gate)…" có kèm chữ. Session theo dõi nhờ coordinator đưa ghi chú lên trên để dòng cuối chỉ còn `APPROVED`. File đổi xong thì chọn "check again"; runner nghiệm thu rồi commit.
- **Sự cố:**
  - Coordinator ghi HANDOFF ở `T-S14/HANDOFF.json` (thư mục gốc của task). Đã nhắc ghi về `evidence/HANDOFF.json` trước khi kịp gây kẹt.
  - q55 (dòng verdict kèm chữ) và judge không trích nguyên văn đều đã thêm vào `skills/workflow-pilot/reference/failure-signatures.md`.
  - Worktree tên `T-S14-settings-panel` được runner nhận ra nhờ `28668a9`.
  - Bản sửa `c0671e1` có hiệu lực: không còn `coordinator_missing` và không còn vòng lặp `approval_evidence`.
- **Thử orca-memory (assist), slice đầu tiên mà pack thực sự tới tay agent:**
  - Pack của planner/writer có 6 mục, 1.976 token, đường dẫn tuyệt đối, đã được đưa vào spec của writer.
  - Writer trích dẫn và làm theo `T-S13-rendered-label-floor-shrink`: S14-03/04 đo cỡ chữ thật lúc hiển thị (`actualFontSize`) ngay từ đầu, có kèm phép thử ép hộp chữ hẹp. Writer cũng dùng `T-S13-fresh-tab-per-run-and-no-leftover-patches` (mở tab mới cho mỗi lần chạy).
  - **Kết quả:** ba vòng review không có finding nào về cỡ chữ hiển thị. Ở S13, chính lỗi này (F2) đã gây ra một vòng sửa. Đánh giá: **useful** cho 2 mục, irrelevant cho 4 mục còn lại (`gap-pose-fixed-point-needs-damping`, monopoly `lesson-L5`, `LC-S07-04`, `hud-nodes-under-safe-area-parent`).
  - **Lỗ hổng:** reviewer không có pack nào ("memory used: none — no MEMORY line in the spec"). Pack `memory/review` chỉ được tạo ở bước merge (15:32Z), sau khi review đã xong. Muốn đo hiệu quả với reviewer thì runner phải tạo review pack trước khi spawn reviewer.
- **Bài học cho người soạn slice:**
  - Mock phải lấy đúng bảng màu của skin thật (S09), không tự đặt màu. Cả F1 lẫn F3 ở S14 và F3 ở S13 đều là lệch màu giữa mock và skin.
  - Dặn reviewer trong prompt rằng dòng cuối chỉ được là từ verdict.
- 15:5xZ: director cho phép thêm "bạn giúp mình deploy luôn, trước khi deploy hãy tạo git private push lên trước". Đã tạo repo private `wisky3107/cc-love-train` (remote `origin`) và push `main` (38434a6). Chỉ deploy preview, không prod, không tag. Push main sau mỗi lần merge và trước khi deploy. Các mục manual để ở trạng thái deferred, không waive.
- 17:31Z **q3 verdict_override**: lần review thứ 4 ghi `review.md` (APPROVED), nhưng runner lấy `review-r3.md` (CHANGES_REQUESTED) làm vòng cuối nên hỏi director. Director chọn "treat as approved" trong popup lúc 17:37Z. Ứng viên sửa: runner xếp các file review theo mtime hoặc theo vòng ghi trong HANDOFF, không theo hậu tố `-rN`.
- 17:41Z S01 commit `e24ea16`, merge `e1a4687` (fix_rounds=2, budget tăng từ 40 lên 79 file, từ 3500 lên 6901 dòng, chỉ ghi nhận).
- 17:50Z **q4 verify_failed**: smoke trên main chạy được 0 check. Slice file (do game-brief viết) đặt tên check là `s01-*.js`, trong khi run-smoke chỉ nạp `*.check.js`. Đã sửa bằng tay: đổi tên 3 check và đổi đường dẫn check trong S02–S07 thành `.check.js` (`e667b50`), rồi trả lời "fixed by hand, verify again". Ứng viên sửa: validate-contracts bắt các đường dẫn `scripts/smoke/checks/` không có đuôi `.check.js`.
- **Contract của dự án mới chưa bao giờ được commit**: lane coi contract ở root là forbidden_changes nên commit của slice không chứa chúng, và game-brief cũng không commit. Đã commit bộ contract, slice và reference vào main (`2aba3f5`), kèm dòng 11 của FOLLOWUPS lấy từ worktree. Ứng viên sửa: game-brief commit bộ contract sau khi gate contract qua.
- 17:4xZ: director hỏi vì sao popup của runner bị cắt chữ và muốn đọc bằng tiếng Việt. Đang làm nhánh `fix/dialog-vi`: `release.question_lang: vi`, dịch mỗi câu hỏi bằng một lần gọi `claude -p`, lựa chọn hiện đủ trong phần câu hỏi, dòng cuối danh sách mở toàn văn. Đang chờ review.
