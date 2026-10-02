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
