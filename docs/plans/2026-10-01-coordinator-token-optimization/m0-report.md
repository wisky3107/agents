# M0 — tool đo token: báo cáo

Ngày: 2026-10-02 · Branch `feat/coordinator-token-opt` (worktree `~/.agents-wt/coordinator-token-opt`)
Self-review: có. Review độc lập: 1 vòng, đã sửa theo review (xem §6).

## 1. Phạm vi, file, test (PLAN con, ghi sau khi làm)

| Mục | Nội dung |
|---|---|
| File mới | `tools/token-report/token_report.py`, `test_token_report.py`, `README.md` |
| Snapshot | `docs/plans/2026-10-01-coordinator-token-optimization/baseline.json`: không có danh sách session, đoạn prompt, đường dẫn hay tên API key |
| Ngôn ngữ | Python 3 stdlib (cần `sqlite3` cho OmniRoute; plan cho phép `.mjs` hoặc `.py`) |
| Nguồn | Transcript Claude (kể cả subagents), session Codex, OmniRoute `call_logs` (đối chiếu tổng) và body (đo schema) |
| Test | 23 unit test (`python3 -m unittest test_token_report.py`): classifier, bộ đếm hành vi, phân loại lượt, parser Claude/Codex, cửa sổ thời gian, dedupe giữa các file, join registry/guard log |
| Không đổi | Không đụng skill, template hay project nào |

Lệnh tái tạo:

```bash
python3 tools/token-report/token_report.py --since 2026-09-24 --until 2026-10-01T12:41:00Z --omniroute --schema
```

`--until 2026-10-01T12:41:00Z` là lúc chạy baseline (`/tmp/omni/roles.json` lúc 19:41 giờ máy).

## 2. Nghiệm thu: tái tạo §0

Classifier cũ (`role2.py`, giữ trong tool dưới tên `baseline`; dedupe theo từng file như §0):

| Role | Sessions (§0 / M0) | Lượt Δ | Context Δ | Output Δ |
|---|---|---|---|---|
| interactive | 97 / 97 | −0,2% | +0,3% | 0% |
| fleet-worker | 183 / 183 | +0,2% | +0,1% | 0% |
| producer | 35 / 35 | +0,1% | +0,2% | +1% |
| subagent | 84 / 84 | +0,2% | +0,4% | **+776%** |
| fleet-orch | 5 / 5 | −3,2% | +1,6% | −5% |
| slice-agent | 7 / 7 | −0,6% | −2,0% | **+614%** |

- **Bảng role đạt nghiệm thu:** sessions khớp tuyệt đối; lượt và context nằm trong ±5% (phần lệch là do §0 làm tròn).
- **Cột output của §0 đếm thiếu, chỉ ở các transcript loại subagent.** Ở đó một message có nhiều entry, entry đầu chỉ mang output một phần (ví dụ 5 token, entry cuối 638). `role2.py` lấy entry đầu; tool lấy giá trị lớn nhất. Ở session chính, entry đầu đã là số cuối. Output chỉ khoảng 0,6% tổng nên không ảnh hưởng chi phí.
- **Bảng hành vi của §0 không tái tạo được trong ±5%.** Ví dụ producer `terminal read` 391 so với 349, `--help` 331 so với 298, worker `--help` cao hơn khoảng 11%. §0 đếm bằng grep tay, không còn script; các bộ đếm của tool là định nghĩa chính thức từ nay.
- §0 được sinh trước khi `role2.py` có nhánh `orca-spawned(boot)`; tool gộp nhánh đó vào `interactive` để tái tạo đúng.

## 3. Phát hiện chính

Các bảng dưới dùng classifier v2 và dedupe `message.id` **giữa mọi file**: resume, fork và bản copy subagent lặp lại 41,3M context, tức 0,9% tổng. Cửa sổ 09-24 → 10-01 12:41Z.

### 3.1 Bucket "producer" ở §0 bị phình gần 2 lần

Classifier cũ gán role producer cho mọi session có chữ `game-producer` trong 20k ký tự đầu. Prompt của fleet orchestrator có trích `.cursor/skills/game-producer/reference/slice-to-plan.md`, và nhiều phiên interactive có bàn về producer, nên đều bị tính là producer.

Classifier v2:
- lấy prompt nhiệm vụ đầu tiên **ở đầu file**, không phụ thuộc cửa sổ thời gian;
- bỏ boot preamble, `/model` và wrapper paste;
- marker xuất hiện sớm nhất thắng;
- phiên handoff "Continue work from the prior Orca session" kế thừa role của transcript gốc.

| Role | Claude (§0 → v2) | Codex (v2, mới) | Tổng v2 | Tỷ trọng v2 |
|---|---|---|---|---|
| producer | 0,98B → **0,40B** | 0,10B | **0,50B** | 10% |
| fleet-orch | 0,18B → **0,62B** | 0,18B | **0,80B** | 16% |
| fleet-worker | 1,28B → 1,28B | 0,03B | 1,31B | 26% |
| interactive | 1,53B → 1,38B | 0,13B | 1,51B | 31% |
| subagent | 0,35B → 0,49B | — | 0,49B | 10% |
| slice-agent | 0,17B → 0,18B | — | 0,18B | 4% |
| helper (analyst, brief author, recovery) | — → 0,11B | 0,03B | 0,14B | 3% |
| **Tổng** | 4,46B | 0,47B | 4,93B | |

Dịch chuyển lớn nhất so với classifier cũ:
- 11 session (0,40B) từ producer sang fleet-orch;
- 9 session (0,18B) từ producer sang interactive;
- 7 session (0,17B) từ slice-agent sang subagent, và 9 session (0,18B) từ interactive sang slice-agent. Hai chiều này bù nhau nên hàng slice-agent gần như không đổi.

Mẫu kiểm tay của reviewer (23 producer, 30 fleet-orch) không thấy nhầm giữa producer và fleet-orch.

**Hệ quả cho plan:** tổng lớp điều phối gần như không đổi (khoảng 26%), nhưng **fleet coordinator tốn nhiều hơn producer** (0,80B so với 0,50B). M2 và M3 (nhắm coordinator) đáng giá hơn plan nghĩ; M4 (runner thay producer) nhắm vào phần nhỏ hơn.

### 3.2 Trần tiết kiệm (phân loại lượt, heuristic)

| Role | Chờ | Overhead | Máy móc | Phán đoán | Script thay được (strict – mặc định) |
|---|---|---|---|---|---|
| producer | 47% | 3% | 23% | 27% | **56% – 73%** context |
| fleet-orch | 42% | 6% | 13% | 39% | **53% – 61%** context |

- "Mặc định" coi lượt không gọi tool và có dưới 600 ký tự ("still running…") là lượt chờ; "strict" coi chúng là lượt phán đoán. Riêng quy tắc này chiếm khoảng 17 điểm phần trăm ở producer và 8 điểm ở fleet-orch, nên phải báo dưới dạng khoảng.
- Producer: mục tiêu −70% nằm **gần đầu trên** của khoảng 56–73%. Muốn đạt thì judge phải rẻ hơn nhiều so với lượt phán đoán hiện tại (context trung bình 139k mỗi lượt). Judge chạy context mới, nhỏ, nên có thể đạt, nhưng chưa chứng minh.
- Fleet-orch: mục tiêu −40% lượt nằm dưới trần 53–61%, hợp lý.

### 3.3 Hành vi (số lần gọi tool, Claude + Codex, định nghĩa của tool)

| Role | `orca --help` | `terminal read` | `check` không wait/ack | `check --ack` không wait | `check --wait` | guide `--full` | sleep > 30 / vòng sleep | đọc SKILL.md (đọc lại) | lượt chỉ có text |
|---|---|---|---|---|---|---|---|---|---|
| fleet-orch | 365 | 518 | 383 | 278 | 588 | 31 | 123 | 229 (135) | 571 |
| producer | 89 | 360 | 9 | 0 | 5 | 9 | 99 | 203 (125) | 720 |
| fleet-worker | 398 | 0 | 51 | 0 | 1 | 5 | 314 | 35 (13) | 371 |

- Polling của coordinator (`terminal read`, `check` trần) nhiều hơn của producer. Guard M2 nhắm đúng chỗ.
- `check --ack` không wait (278 lần) là giao thức wake-up hợp lệ, guard phải cho qua.
- Fleet worker có 314 lần sleep dài hoặc vòng sleep (chủ yếu chờ Creator/preview). Worker không có hook; `wait-mcp` trong skill (M2.2) là cách giảm.

### 3.4 Lượt đầu và schema MCP

- Lượt đầu (trung vị): Claude producer 80k, fleet-orch 72k, worker 75k. **Codex chỉ khoảng 16–17k.**
- Schema tool trong body OmniRoute: Funplay luôn là **52KB ≈ 13,5–16,9k token** (tính 3,2–4 byte/token) trên mọi request có nó; phần builtin 62–130KB tùy session. Mẫu lấy từ thư mục body đang chạy nên số request mẫu đổi giữa các lần, còn kích thước theo server thì ổn định.
- Target M1 cho coordinator Claude: khoảng 72k → **55–58k**, đúng như ước tính trong plan.
- Lượt đầu của codex nhỏ hơn cả riêng schema Funplay, nên hoặc codex không nạp sẵn schema MCP, hoặc các session codex này không có Funplay. **Bỏ MCP cho coordinator codex (M1) có thể gần như không tiết kiệm được gì**; executor kiểm khi làm M1.

### 3.5 Theo slice (ví dụ)

| Slice | Coordinator | Lane |
|---|---|---|
| cc-monopoly-go S08 (fleet) | 190M Claude + 12M Codex, 4 session | 226M (41 session worker) |
| cc-block-out S21 (fleet) | 24M | 115M |
| cc-lego-stack S01 (`--project cc-lego-stack`, 09-28 → 10-02 03:00Z) | fleet-orch 197M + producer 168M (Codex, có takeover) | 53M Codex + 172M Claude |

### 3.6 Đối chiếu OmniRoute

- `call_logs` chỉ giữ khoảng 7 ngày (dòng cũ nhất `2026-09-25T03:21Z`), nên chỉ so được trên khoảng thời gian chung đó.
- Trên khoảng chung:
  - Claude: OmniRoute cache read **3,81B**, transcript 3,37B, tức **OmniRoute cao hơn 12,9%**.
  - Codex: 353M so với 348M (+1,6%).
- Có khoảng 12% traffic Claude **không nằm trong transcript**. Có thể là các call phụ của Claude Code (compaction, đặt tiêu đề, tóm tắt…) hoặc client khác dùng chung key; **chưa xác minh**.
- Hệ quả: số tuyệt đối theo role của Claude có thể thấp hơn thực tế khoảng 12%. Tỷ trọng giữa các role bị ảnh hưởng ít hơn, nhưng cũng chưa chứng minh.
- Cursor: không đo được từ các nguồn này.

## 4. Đề xuất cho director (theo §9 mục 14)

1. **Producer:** đổi gate thành **−60% token/slice (tính cả judge)**, giữ −70% là mục tiêu mở rộng. Lý do: trần ước được là 56–73%, phụ thuộc cách tính các lượt "still running…".
2. **Thêm chỉ tiêu token cho fleet coordinator:** −40% token/slice, không chỉ −40% lượt, vì đây là bucket lớn hơn.
3. **Ưu tiên:** giữ thứ tự M1 → M1a → M3 → M2 → M4, nhưng coi M2 + M3 là phần mang lại nhiều nhất; M4 vẫn làm vì producer còn 0,50B mỗi tuần.
4. **M1 với codex:** kiểm trước khi làm phần tắt MCP cho codex (§3.4).
5. **§0 của PLAN:** giữ số cũ để lịch sử khớp, dùng `baseline.json` (v2, dedupe giữa các file) làm baseline chính thức cho các so sánh sau.

## 5. Giới hạn đã biết

- Phân loại theo prompt đầu tiên: một session interactive mà giữa chừng được bảo "xài producer" vẫn tính là interactive. Một phiên "update agent notes … then resume the producer" được tính là producer (5,8M, Codex), có thể tranh luận. Registry spawn (M1) và guard log (M2) sẽ thay dần cách này.
- Join với registry và guard log mới chỉ có unit test; `~/.agents/logs` chưa tồn tại cho tới M1/M2.
- Phân loại lượt là heuristic, dùng để ước trần, không phải số đo chính xác.
- `--omniroute` và `--schema` không lọc theo `--project` (body và `call_logs` không có cwd).
- Repo `wisky3107/agents` là public. `baseline.json` không còn tên API key, nhưng plan và báo cáo có tên project và đường dẫn máy. Push hay không là quyết định của director.

## 6. Review độc lập

Reviewer: subagent mới, không đọc gì từ phiên viết code. Vòng 1: **CHANGES_REQUESTED**, không có lỗi chặn; nghiệm thu M0 vẫn đạt.

| Phát hiện | Mức | Đã xử lý |
|---|---|---|
| Đối chiếu OmniRoute sai cửa sổ (call_logs chỉ giữ ~7 ngày); kết luận "transcript đầy đủ hơn" sai chiều | major | So trên khoảng chung, in rõ khoảng đó; sửa §3.6 |
| Dedupe chỉ trong từng file; 272 message id lặp giữa các file (41,5M) | major | Dedupe toàn cục, file sớm nhất giữ turn; bảng baseline vẫn dedupe theo file để tái tạo §0 |
| Số trong báo cáo cũ không khớp tool; bảng hành vi §0 không tái tạo được | minor | Viết lại báo cáo từ output mới; ghi rõ ở §2 |
| Role lấy từ text đầu tiên **trong cửa sổ** (producer bị cắt thành interactive) | minor | Lấy từ đầu file |
| Classifier sót "Cocos Orca Fleet" (có dấu cách), "orca-fleet worker", "Khởi động lại Producer", "resume the existing run"; "You are not the game-producer" bị nhận nhầm | minor | Sửa regex, thêm test |
| `find_project` ăn cả text prompt; slice `S14a` không nhận | minor | Sửa regex, thêm test |
| Tool `wait`/`sleep` của Codex bị tính là phán đoán; trần nhạy với quy tắc "text ngắn = chờ" | minor | Tính là chờ; báo trần dạng khoảng strict–mặc định |
| Join registry không một-đối-một; `worker` luôn map sang slice-agent | minor | Dòng registry dùng một lần; `worker` map theo cwd |
| So chuỗi thời gian lệch (`12:41:00.500Z`), bỏ qua giờ và múi giờ ở `--since` | minor | Chuẩn hóa `--since`/`--until` sang UTC có mili-giây |
| Repo public: `baseline.json` có tên API key | minor | Chỉ còn nhãn `claude`/`codex`/`other` |

Không chạy vòng review thứ hai. Phần sửa được phủ bằng 6 test mới; output đã chạy lại và số trong báo cáo lấy từ lần chạy đó.
