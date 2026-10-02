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
