# Fleet coordinator bằng script (runner tự điều phối fleet lane)

Yêu cầu: director (2026-10-16). So sánh cách Claude agent giao tiếp với fleet Orca. Bước 1 = đưa phần
**máy móc** của coordinator LLM vào runner, phải chạy được với mọi provider.

Ký hiệu đường dẫn:
- **L** = `skills/game-producer/scripts/lib/lanes.mjs`
- **S** = `skills/cocos-orca-fleet/SKILL.md`
- **WP** = `skills/cocos-orca-fleet/reference/worker-prompts.md`
- **WPA** = `skills/cocos-asset-gen/reference/worker-prompts-art.md`
- **R** = `docs/plans/2026-10-01-coordinator-token-optimization/results.md`

## 0. Bối cảnh và số liệu

**Hiện tại**
- Slice size L → runner spawn một coordinator LLM (`fleet.orchestrator_agent`, mặc định `cursor --model auto`,
  nhiều pilot dùng claude sonnet) bằng prompt `reference/fleet-slice-prompt.md`.
- Coordinator làm các việc sau:
  - tạo worktree, viết pointer PLAN, `run-create`;
  - viết spec từng role, `task-create`, launch worker theo recipe A/B/C;
  - chờ `orca-wait coord`, mở và resolve gate;
  - chép `fix_routing` thành fix Task, xử lý INFRA_BLOCKED;
  - viết HANDOFF / stats / final-report, rồi commit.
- Runner chỉ đứng ngoài: chờ terminal coordinator, relay gate dạng text, nudge, F18 đọc màn hình worker
  (nhưng phải *nhắn* coordinator `worker-stop`), accept, merge.

**Token (đo thật)**
- fleet-orch theo slice:
  - cat-dash S01–S07: 17–27M, 84–126 lượt, so với workers 77–278M (R:1710–1802);
  - monster-truck S01–S18: 6–28M (R:1549–1897).
- Coordinator chiếm khoảng **10–25 %** token của một slice fleet. Phần lớn token nằm ở workers.
- Share lượt replaceable (wait + mechanical) ở các pilot gần đây là **59–74 %** (R:848, R:1538, R:1710–1802).
- Lượt đầu của coordinator khoảng 72k context. Mỗi lượt sau khoảng 130–190k (R:174, R:81).
- Kỳ vọng thật: **−15…25M mỗi slice fleet**, khoảng −10…20 % token của slice. Ví dụ v1.1 của car-service có
  15 slice fleet → khoảng 300M.
- Plan này **không** giải quyết khoảng cách 85M so với 27M giữa fleet và single. Phần đó là token worker (bước 2).

**Lợi ích lớn hơn token là độ tin cậy.** Đối chiếu R và failure-signatures, trong 22 sự cố đã ghi,
khoảng 12 sự cố do coordinator LLM:
- gate trùng (pilot 1 q6; cat-dash F8 một quyết định thành 3 gate);
- coordinator tự commit trước Step 2d;
- ghi `committed` với HEAD cũ;
- đóng nhầm terminal integrator (giết Creator);
- hết lượt sau lỗi OmniRoute mà không quay lại wait (q20–q23);
- resume sau Orca restart mà không có wait loop;
- đổi reviewer sang Cursor khi Cursor off;
- HANDOFF sai đường dẫn hoặc sai status;
- AskUserQuestion / panel codex;
- quyết định sai (cat-dash S21 "decision K").

Một state machine có test sẽ loại cả nhóm này, và không phụ thuộc provider.

**Tốc độ (đo ở M0, `m0-report.md`).** Từ lúc deps xong đến lúc dispatch: trung vị **16 s**, p90 86 s, nhưng
đuôi tới 54 phút (4/6 khoảng > 5 phút nằm ở integrate → review). Tổng khoảng 11 phút/Run. Script không nhanh hơn
ở trung vị; phần cứu được nằm ở đuôi. Phân loại các đuôi này trước M5.

## 1. Mục tiêu và tiêu chí thành công

| # | Tiêu chí | Đo bằng |
|---|---|---|
| 1 | fleet-orch = **0 token** ở chế độ script (judge tính riêng dưới `producer`) | `token_report.py --project <slug> --since …` |
| 2 | Token cả slice fleet giảm ≥ 10 % so với trung vị 5 slice fleet gần nhất cùng project | như trên |
| 3 | p90 khoảng trễ deps xong → dispatch ≤ 30 s (baseline M0: p90 86 s), và không khoảng nào > 5 phút mà không có câu hỏi hay recovery giải thích | `/tmp/fsc-m0/bin/gaps.py` (chuyển vào `tools/` ở M5), log của driver |
| 4 | 0 lần double-dispatch / double-task trong mọi test kill/resume | test harness |
| 5 | Không thêm câu hỏi cho director so với chế độ agent ở cùng loại slice; mỗi câu hỏi có `kind` rõ | `producer-state` questions |
| 6 | Chế độ `agent` giữ nguyên hành vi: toàn bộ test runner hiện có (220+) xanh, gồm `runner-m4b.test.mjs:219` | `node --test skills/game-producer/tests/*.test.mjs` |
| 7 | Chạy được với mọi tổ hợp provider của worker (claude / codex / cursor / agy / opencode) | pilot M5 + test |

## 2. Bất biến (không được phá)

- Lock theo role (writer, reviewer, scanner, art, mesh_agent…), recipe A/B/C, editor lock, MCP riêng từng
  checkout, nguyên tắc **một feature worktree, một integrator**: giữ nguyên. Driver chỉ thay người bấm nút.
- Reviewer luôn chạy trên terminal mới và không nhận memory pack của writer.
- `fix_routing` được **chép nguyên văn**, không suy luận lại scope (S:636–646).
- Mọi quyết định của director đi qua câu hỏi của runner (judge → autopilot → pilot → director). Không có
  đường hỏi nào nằm ngoài runner.
- Ghi intent trước khi hành động. Sau kill, đối chiếu với Orca (`task-list`, `dispatch-show`, `worker-list`)
  và không bao giờ tạo hay dispatch lần hai (giống `spawnOnce` / `registeredSpawn`, L:612–647).
- Fleet chạy standalone (director gọi skill `cocos-orca-fleet` trực tiếp) và PLAN branch C (plan worker)
  vẫn dùng coordinator LLM.
- `max_parallel=2` vẫn không ghép slice L (`pairProblem`, `project.mjs:373`).

## 3. Thiết kế

### D1. Runner là coordinator của Run

- Orca cho mọi lệnh orchestration nhận `--from <handle>`: `run-create`, `task-create`, `worker-start`, `check`,
  `reply`, `gate-*`. Run là "namespace and home inbox", không tự schedule. Vậy một process không phải agent
  vẫn có thể giữ Run.
- Handle coordinator = terminal của runner (`launchRunner`, `orca.mjs:125`).
- **Đã kiểm chứng ở M0:** một `node` script trong terminal Orca thường đã làm được `run-create` (Orca tự lấy
  handle từ `ORCA_TERMINAL_HANDLE`), `worker-start` claude + codex, `check --wait`, `reply`, `--ack`,
  `worker-release`. Không có byte nào bị inject vào terminal coordinator. Không cần terminal mailbox.
- `payload` của message là chuỗi JSON (`taskId`, `dispatchId`, `outcome`).
- `worker-release` có thể trả `retained` (`user_takeover`, gặp với codex sau `ask`). Đây là kết quả hợp lệ; chỉ
  đóng terminal khi có bằng chứng agent đã idle. Nguyên nhân còn mở (m0-report §a.3).

### D2. DAG tạo dần, không tạo hết từ đầu

- `task-create` chỉ khi deps của task đã xong.
- Spec của art-concept / art-mesh / art-anim vì vậy được điền **sau** khi art-manifest có `manifest.json`
  (`expect_dims`, `forward`, `tri_budget`, `complexity`, `animated`).
- Cách này giải luôn hai mâu thuẫn hiện có:
  - spec cần handle của peer trước khi peer tồn tại;
  - placeholder theo từng row cần manifest chưa có ở bước 0.8.
- Peer-bridge `send --type status` bỏ khỏi spec, vì driver khởi động task phụ thuộc ngay khi nhận
  `worker_done`. Nếu muốn giữ, đây là một dòng tùy chọn của spec.

### D3. Không dùng Orca gate trong chế độ script

- Worker `orca orchestration ask` → driver tạo câu hỏi runner `worker_question` (judge-able khi có trích dẫn
  contracts, như `fleet_gate`) → `orca orchestration reply --id <msg>`.
- Hết 2 fix round → dùng lại kind `changes_after_rounds` của single lane.
- Loại bỏ cả nhóm lỗi gate trùng, gate race, relay gate (L:1334–1366 chỉ còn cho chế độ agent).

### D4. Các điểm phán đoán: hoặc đổi thành hợp đồng, hoặc thành câu hỏi

| Điểm | Hiện tại (coordinator) | Chế độ script |
|---|---|---|
| Câu hỏi của worker về scope / hành vi | đoán, hoặc mở gate | `worker_question` → judge / director → `reply` |
| `CHANGES_REQUESTED` chỉ vì infra preview | đọc findings | owner `infra` trong `## fix_routing`; `review-check.mjs` báo `infra_only` → integrator recovery, không tính fix round (M2) |
| Finding chỉ về budget khi `advisory` | tự phân biệt | slice-to-plan cấm reviewer ghi budget thành finding khi advisory; chế độ gate dùng luật pct từ dòng `budget_bump` (máy móc) |
| Finding cần director quyết | coordinator mở gate | owner `director` → câu hỏi `worker_question` |
| Thiếu `fix_routing` hoặc `owner: unclear` | ask | câu hỏi `fix_routing_missing` |
| Concept `proportions: WARN` | chọn giữ size hay `height_for_concept` | luật: giữ size manifest, ghi lý do vào mesh spec; WARN lần 2 trên cùng stem → câu hỏi |
| Recovery ngoài `projection.nextAction` | coordinator tự xử | chạy `nextAction` argv nếu có; nếu không → câu hỏi `worker_recovery` kèm receipt |
| Văn xuôi `final-report.md` | coordinator viết | template từ evidence: output-contract YAML của integrator, review cuối, `stats.json`, fix rounds |
| Blast radius khi đổi tên | coordinator grep | worker kèm kết quả `git grep -w` trong `ask` (spec đã yêu cầu); driver kiểm có khối grep, thiếu thì trả lời yêu cầu bổ sung |
| PLAN thiếu field | ask | câu hỏi `plan_invalid` liệt kê các row hỏng (validator M1) |

### D5. Một nguồn template cho spec

- Driver đọc **thẳng** các khối spec trong WP / WPA bằng `cocos-orca-fleet/scripts/spec-templates.mjs` (M1),
  không tách ra file riêng. Coordinator LLM (standalone) và driver dùng cùng file, nên không có hai bản lệch nhau.
  - Key của role = heading cắt tới ` (`. Fence sau dòng `**Animated addendum**` là addendum. Fence đầu của
    `implement` là boot prompt, không tính vào spec.
  - art-2d = khối chung + khối backend (+ ui-kit route).
- `<UPPER>` là placeholder coordinator điền. `ALIASES` gom các placeholder chữ thường cùng nghĩa (`<feature>`,
  `<role>`, `<row forward>`, `<row expect_dims>`, `<tri_budget>`, `<project-slug>`, dòng fix_routing).
  `<ISO>`, `<A>` để worker điền.
- `fill()` báo lỗi khi còn placeholder. `clean()` bỏ đúng bộ ký tự mà `clean_spec.py` bỏ.
- Đã sửa các mâu thuẫn:
  - đường dẫn: chốt theo thực tế các Run gần đây, `EVIDENCE_ROOT = .cursor/evidence/tasks/T-<Sxx>/evidence`,
    spec ở `<EVIDENCE_ROOT>/specs/<role>.md` (S:434 đúng; sửa WP:3, WPA:3 và dòng "Evidence root" của shared header);
  - art-mesh / art-anim chạy `mesh_agent` (sơ đồ, bảng owns và bảng role của S sửa theo S:181);
  - S "PLAN format the coordinator writes" → "validates (branch C: the plan worker writes it)".
- Peer handle trong spec scan: giá trị `none` = bỏ qua. Driver tạo task dần nên truyền `none`.

### D6. Lõi DAG thuần, IO tách riêng

- `lib/fleet-dag.mjs`: `next(state, events) → actions[]`, không IO.
  - actions: `create_task`, `start_worker`, `reuse_terminal`, `release`, `close_terminal`, `reply`, `ask`,
    `write_handoff`, `done`.
  - Test dạng bảng: lite, full fan-out 2 stem, animated stem, import stem, fix round code+scene, rig fail mở lại
    concept → mesh → anim, INFRA_BLOCKED, budget_bump.
- `lib/fleet-driver.mjs`: thực thi actions qua `io.*`, mỗi action theo thứ tự intent → act → record, có reconcile.
- Wrapper mới trong `orca.mjs`: `run-create`, `task-create`, `task-list`, `worker-start`, `dispatch-show`,
  `check --wait --ack`, `reply`, `worker-list`, `worker-stop`, `worker-release`, `terminal create/wait`.
- Dùng lại `rescueDrafts` (lost Enter) của `orca-wait.mjs` bằng cách export hàm, không chép code.

### D7. Bật theo cờ, không đổi mặc định cho tới khi pilot đạt

- `AGENT_NOTES.md` `fleet.coordinator: agent | script`. Mặc định `agent`. Prompt của director được override.
- Preflight chuyển về `agent`, kèm một dòng log (không im lặng), khi gặp một trong các trường hợp:
  - slice cần plan worker (branch C);
  - rip port mà slice không nêu đủ report / read path cho `rip_study`;
  - lock có agent mà driver chưa có recipe.
- Chế độ `script` dùng phase riêng:
  `setup → fleet-run → accept (dùng lại) → commit (runner tự làm) → merge (dùng lại)`.
- `fleetStep` (L:1285–1481) giữ nguyên cho chế độ `agent`.

### D8. Runner tự viết HANDOFF / stats; commit là một Task trên terminal integrator

- HANDOFF.json vẫn ghi ở `fleetHandoff()` (L:508), với `role: "fleet-driver"`. Merge, judge, scorecard vẫn đọc
  được như cũ.
- `stats.json` lấy từ log launch của chính driver: `agents` = launch spec thật đã chạy, kể cả reviewer bị đổi;
  `fix_rounds` và `review_rounds` chính xác. `workflow-scorecard` không cần đổi.
- Commit (đổi sau M0 §c: `/commit-guard` có 3 gate cần phán đoán: architecture, docs, message):
  - driver chạy `check-slice` trước;
  - xanh → dispatch Task `commit` lên **terminal integrator** (dùng lại terminal, không boot). Spec:
    `/commit-guard`, stage evidence JSON/MD (không PNG), message `feat(Sxx): <title slice>`, báo sha trong
    `worker_done`;
  - driver kiểm sha (dùng lại `staleFleetSha` / `committedTo`), rồi vào merge journal hiện có;
  - bỏ handshake `approved — commit` của chế độ agent.

### D10. Phần "work order" riêng của từng role (phát hiện khi làm M1)

Coordinator hiện **không chỉ điền template**. Ví dụ `cc-cat-dash` T-S06: `implement.body` có 17 dòng, 15 dòng
khác template WP. Coordinator (sonnet) tự viết thứ tự công việc, con số cụ thể (gravity −150, jumpItem 40), file
video cần frame-step, feel row nào thuộc writer, ghi chú cho integrator. Đây là "planner hat" mà S:18–26 nói
coordinator không nên đội, nhưng nó đang mang giá trị thật cho worker.

Spec chỉ từ template sẽ mỏng hơn. Ba hướng:

| Hướng | Cách làm | Provider | Rủi ro |
|---|---|---|---|
| **a. Chỉ template + slice** | Worker tự đọc slice, EXPECT, discovery (slice-to-plan: "the slice file IS the PLAN") | mọi provider | writer phải tự suy ra thứ tự / con số; có thể thêm review round |
| **b. Một lượt LLM headless mỗi spec** | `claude -p` / `codex exec` / `cursor-agent -p` viết phần work order, driver ghép vào template | provider headless (không có agy) | thêm token (nhỏ hơn một coordinator chạy 100 lượt); lại có một điểm LLM |
| **c. Scan viết work order** | Mở rộng hợp đồng output của `scan` (đã là một worker có sẵn): thêm mục `## work order` theo role (implement / integrate / art / review) trong `discovery.md`; spec của role trỏ tới mục đó | mọi provider | không có cho `lite` (không scan) → lite dùng hướng a |

**Director chốt (2026-10-16): c**, và a cho lite. Pilot M5 đo review rounds và fix rounds so với baseline; nếu
tăng rõ thì thử b. Hợp đồng output của scan (mục `## work order`) làm ở M1, cùng với template.

### D9. Worker kẹt và INFRA_BLOCKED do runner tự làm

- F18: driver tự `worker-stop --dispatch` rồi dispatch lại với `--retry-of`, thay vì nhắn coordinator
  (L:1863–1864). Vẫn kẹt sau thêm một cửa sổ → `worker_stuck`.
- INFRA_BLOCKED: dùng lại logic `infraBlocked` của single lane (L:1076–1107): curl, retry frozen-tab một lần
  với `--channel auto`, đổi reviewer `cursor --model auto` khi Cursor on, ngược lại recovery integrator.

## 4. Milestones

Mỗi mốc merge riêng và có test. Chế độ `agent` không đổi hành vi.

| Mốc | Nội dung | Có ích cho chế độ agent? | Rủi ro |
|---|---|---|---|
| **M0** Spike + baseline ✅ (`m0-report.md`) | (a) Script trong một terminal Orca giữ Run qua `--from`: `run-create`, `task-create`, `worker-start` một worker cursor + một claude trên task đồ chơi, nhận `worker_done` qua `check --wait`, `reply` một `ask`, `worker-release`, `terminal close`. Ghi lại Orca có cần pane coordinator là agent không, có inject text vào terminal coordinator không (nếu có thì dùng terminal mailbox ở D1). (b) Baseline khoảng trễ `worker_done → worker-start` từ 5 Run fleet gần nhất (cat-dash, monster-truck). (c) Đọc `/commit-guard`. Kết quả ghi vào `m0-report.md`. **Kill:** Orca không cho script giữ Run và mailbox cũng không được → dừng plan, báo director. | — | trung bình |
| **M1** Template + validator ✅ | Tách `reference/specs/*.md` (D5). `plan-check.mjs`: viết pointer PLAN từ slice (`slice-to-plan.md`) và validate theo S:408–432. Phần "observation-phrased" giữ là cảnh báo, không chặn. Sửa 3 mâu thuẫn tài liệu. Coordinator LLM gọi `plan-check.mjs` thay vì tự kiểm. | **có**: bớt lượt và lỗi PLAN | thấp |
| **M2** Hợp đồng reviewer ✅ | Cột owner của `## fix_routing` là một từ cố định: code / scene / asset / concept / mesh / anim / infra / director / unclear / followup, có thể kèm `(lý do)`. `review-check.mjs` kiểm dòng verdict, ids, owner, scope nằm trong slice paths; gom nhóm theo owner, báo `infra_only`. Reviewer tự chạy trước `worker_done`. Coordinator LLM dùng `fix_groups`. Trên 127 review thật: 108 đạt hợp đồng mới. | **có**: coordinator chép bảng thay vì đọc văn xuôi | thấp |
| **M3** Lõi DAG + IO ✅ | `game-producer/scripts/lib/fleet-dag.mjs` (thuần, 9 test kịch bản) + `fleet-driver.mjs` (intent → act → record, reconcile sau kill, 7 test với io giả) + wrapper trong `orca.mjs`; card `commit` trong WP; owner concept/mesh/anim phải ghi `(stem)`. Đã kiểm wrapper với Orca thật (spike 2). Harness end-to-end của runner (fake orca thêm lệnh) chuyển sang M4. | — | trung bình |
| **M4** Nối vào runner ✅ (nhánh `feat/fleet-script-m4`) | `fleet.coordinator: script` → `fleet_mode` ghim theo slice (slice có rip study vẫn chạy agent). `scriptStep` trong lanes.mjs: setup (worktree, pointer PLAN qua plan-check, `run-create`) → `fleet` (driver tick, câu hỏi driver = câu hỏi runner với ref `drv:`) → accept (FLEET_EVIDENCE do driver viết: stats.json, final-report.md) → commit (Task `commit` trên terminal implement) → committedTo → merge của fleet. `run-use` khi runner đổi terminal. INFRA: tự curl và đổi reviewer như single lane, không được thì hỏi `fleet_infra`. Judge được trả lời `worker_question` (phải trích contracts). Scanner rẻ (cursor) → Sonnet vì phải viết work order. Harness: fake orca thêm run-create/task-create/task-list/dispatch-show/worker-start/check/reply/worker-release/worker-stop + `fleet-queue.json`. 8 test runner (lite trọn tới merge+verify, full có art-2d, fix round, câu hỏi worker, worker-start lỗi, restart không trùng, run-use, chế độ agent giữ nguyên). Runner 244/244. Chưa có: `status`/pilot-wait hiện DAG; check-slice trước commit (commit-guard của Task commit thay). | — | **cao** |
| **M5** Pilot | 2 slice L trên một project director chọn: (1) một slice `lite`, (2) một slice có art 3D. `workflow-pilot` watch như thường. So với 5 slice fleet gần nhất: tiêu chí §1, wall time, câu hỏi, sự cố. Ghi vào `results.md`. **Gate:** đạt §1.1, 1.3–1.6, không có sự cố mới do driver → M6. Ngược lại sửa rồi pilot lại, tối đa 2 vòng, sau đó báo director. | — | trung bình |
| **M6** Rollout | Mặc định `fleet.coordinator: script` trong 4 template + các project đang chạy (director duyệt từng project). S / WP: ghi coordinator LLM chỉ còn cho standalone và branch C. Cập nhật `failure-signatures.md`, `docs/workflow-map/`, memory. | — | thấp |

**Thứ tự và xung đột với phase 2:**
- M0–M2 không đụng `lanes.mjs`, làm được ngay.
- M3 chỉ thêm file mới và wrapper.
- M4 đụng `laneFor` / `freshLane`, `stepLane` (thêm nhánh) và `applyAnswer` (case mới). Phase 2 cũng sửa
  `stepLane`, `wait()` (`ctx.waited`) và đầu `applyAnswer`, nên làm M4 **sau khi trial M5e của phase 2 có kết
  quả**, rebase lên đó.
- Không đụng `startLanes` (`producer-runner.mjs:802–1038`) hay `fleetStep`.
- Test `runner-m4b.test.mjs:219` (runner không gọi `task-create|dispatch|gate-resolve`) vẫn đúng cho chế độ
  `agent`. Thêm assertion ngược cho chế độ `script`: không có `gate-create`.

### Phát hiện ở M3 (spike 2, 2026-10-16, Orca 1.4.218)

- `task-create` → `result.task.id`; `task-list` trả `task_title`, nên reconcile sau kill dùng title
  `T-<Sxx>:<task>#<attempt>`.
- Dùng lại terminal: chờ `terminal wait --for tui-idle` rồi `worker-start --task --terminal --worktree`. A → A2
  trên cùng terminal mất khoảng 4 s.
- Release terminal dùng lại: dispatch **cuối** → `released` (đóng terminal); dispatch gốc → `retained:
  ownership_transferred`. Driver đóng chain bằng release dispatch cuối, không bao giờ `terminal close`.
- Chỉ terminal đang bind mới được thay đổi Run (`consumer_fenced`). Runner restart sang terminal khác phải
  `run-use` (M4).
- Codex có thể kẹt ở menu cập nhật khi khởi động: `worker-start` thất bại với `agent_readiness: Agent startup
  blocked: agent-update-prompt` và dispatch `failed`/`reclaimable` (FS:12). Driver hỏi theo giao thức. Ứng viên M4:
  tự release rồi retry một lần sau khi chọn "Skip until next version".

## 5. Kiểm thử stop / resume (bắt buộc cho M4)

- Kill runner tại từng action: sau intent / trước act, sau act / trước record. Restart → reconcile bằng
  `task-list` + `dispatch-show` + `worker-list` → không task trùng, không dispatch trùng, terminal không mồ côi.
- Orca restart giữa lane: Run còn → `run-use --from <runner>`, tiếp tục. Run mất → câu hỏi `orca_error`.
- `check --wait` trả lại cùng Delivery (chưa ack) sau kill → mỗi message xử lý đúng một lần (`acked` trong state).
- Worker gửi `worker_done` hai lần, hoặc `worker_done` của dispatch cũ → chỉ chấp nhận dispatch đang active
  (protocol floor S:661).

## 6. Rủi ro

| Rủi ro | Giảm |
|---|---|
| Orca coi Run không có pane agent là coordinator chết, hoặc tự takeover | M0. Dùng terminal mailbox. `run-show` theo dõi `coordinator_handle` như hiện tại. |
| Worker hỏi những câu coordinator LLM vẫn tự trả lời → câu hỏi cho director tăng | Judge-able với trích dẫn contracts. Đếm ở M5. Nếu tăng, xem lại spec worker (câu hỏi đó có nên nằm trong slice không) trước khi thêm LLM. |
| Spec từ template kém hơn spec do coordinator viết (D10) | Hướng c (scan viết work order). So review rounds và fix rounds ở M5. Tăng rõ → hướng b. |
| Recipe B/C nhiều bước (boot prompt, `tui-idle`, `--screen`) dễ vỡ khi viết bằng script | Viết theo đúng S:530–567, test từng nhánh. Lost Enter dùng `rescueDrafts` đã chạy thật. |
| Work order (D10) do scanner rẻ viết (`scanner_agent` mặc định `cursor --model auto`); trước đây coordinator sonnet viết | Chế độ script khóa `scanner_agent` tối thiểu Sonnet-class khi slice không lite. So chất lượng spec ở M5. |
| M4 to và đụng runner đang chạy pilot thật | Cờ mặc định `agent`. Runner đang chạy cần restart mới nạp code. Không bật cho project đang pilot nếu director không chọn. |
| Mất "nhìn thấy" coordinator trong terminal | Driver ghi `producer-log.md` mỗi action. `status` hiện DAG (task → trạng thái → handle). |

## 7. Ngoài phạm vi

- Token phía worker (scan / art-manifest headless, subagent cho worker Claude): bước 2, plan riêng.
- Ghép 2 lane fleet song song.
- Fleet standalone và branch C.

## 8. Quyết định của director (2026-10-16)

1. Pilot M5 chạy trên **một dự án mới** tạo riêng cho pilot (không dùng project đang chạy).
2. `final-report.md`: **template của driver** (D4) là đủ.
3. `worker_question` **judge được trả lời** (như `fleet_gate`, cần trích dẫn contracts).
4. M0–M2 **bắt đầu ngay**, song song với trial M5e của phase 2. M4 vẫn chờ M5e.
5. D10 work order: **scan viết** (`discovery.md` `## work order` theo role); lite → worker đọc slice.
