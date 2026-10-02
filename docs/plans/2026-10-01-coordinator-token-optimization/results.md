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
| 1 | S08 | L / fleet | `producer_mode: runner`, no judge, guard `shadow`, M1 roles + M3 cheatsheets live (master f5fc21e) | | | | started 2026-10-02 |

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
