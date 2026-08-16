# Orca × Hermes Workflow Handoff

> Tài liệu chuyển giao và nền tảng để xây skill/rule cho workflow Orca điều phối Hermes Agent. Nội dung tổng hợp từ session thử nghiệm ngày 2026-08-10, bao gồm thiết kế mong muốn, hành vi thực tế, failure modes và rule đề xuất.

## 1. Mục tiêu kiến trúc

Mô hình được thử nghiệm:

```text
Orca coordinator
├── Hermes backend-dev
├── Hermes web-dev
├── Hermes unity-dev
└── Hermes reviewer
```

Nguyên tắc cốt lõi:

- Orca Orchestration là **control plane duy nhất**: Run, Task DAG, Dispatch, inbox và lifecycle.
- Hermes profile là **execution role**, không phải scheduler thứ hai.
- Không dùng đồng thời Orca Task DAG và Hermes Kanban nếu chưa thiết kế ownership, state mapping và recovery rõ ràng.
- Hermes hiện chưa phải known Orca agent/provider native; integration dùng terminal tùy chỉnh và `dispatch --inject`.
- Reviewer là worker độc lập với task review riêng; review process hoàn tất không đồng nghĩa code được approve.

## 2. Thành phần Orca

### Run

- Namespace của một workflow và home inbox của coordinator.
- Run không tự schedule hoặc đặt worker.

```bash
orca orchestration run-create \
  --objective "Mục tiêu cụ thể" \
  --json
```

### Task và DAG

- Task là đơn vị công việc.
- `--deps` tạo dependency DAG; chỉ task có dependency hoàn tất mới trở thành ready.
- Task spec cần có scope, acceptance criteria, repo/worktree, verification, stop conditions và human gates.

```bash
orca orchestration task-create \
  --task-title "Slice 2: Orca explorer" \
  --spec "..." \
  --deps '["<foundation_task_id>"]' \
  --json
```

### Dispatch

- Dispatch là một attempt cụ thể gắn Task vào đúng terminal.
- Hermes dùng low-level composition:

```bash
orca terminal create \
  --worktree <selector> \
  --title "Hermes web-dev" \
  --command "hermes --tui -p web-dev" \
  --json

orca orchestration dispatch \
  --task <task_id> \
  --to <terminal_handle> \
  --inject \
  --json
```

- `worker-start --agent hermes` và `automations --provider hermes` không nên được giả định hỗ trợ khi Hermes chưa là provider native.

### Coordinator loop

```text
task-list --ready
→ dispatch workers
→ check --wait
→ heartbeat/status: ghi nhận
→ ask: reply
→ escalation: recovery/human gate
→ worker_done: xác minh payload và artifact
→ release hoặc reuse terminal
→ tạo fix/re-review nếu cần
```

```bash
orca orchestration check \
  --wait \
  --types "worker_done,ask,escalation,heartbeat" \
  --json
```

Delivery được replay cho đến khi coordinator `--ack <delivery_id>`. Phải xử lý toàn bộ message trước khi acknowledge.

## 3. Lifecycle worker bắt buộc

Preamble do `dispatch --inject` cung cấp command chính xác cho Dispatch. Worker phải dùng đúng:

- `from_handle`
- dispatch capability
- `taskId`
- `dispatchId`

### Heartbeat

- Gửi định kỳ khi đang làm việc dài.
- Heartbeat chứng minh liveness, không chứng minh completion.

```bash
orca orchestration send \
  --type heartbeat \
  --subject "alive" \
  --task-id <task_id> \
  --dispatch-id <dispatch_id> \
  --phase implementing
```

### Ask/reply

- Worker không được mở local user prompt mà coordinator không thấy.
- Dùng `orca orchestration ask`; timeout không xóa question, cần resume cùng message ID.

```bash
orca orchestration ask \
  --question "Cần giữ backward compatibility không?" \
  --options "yes,no" \
  --timeout-ms 600000

orca orchestration reply \
  --id <message_id> \
  --body "yes" \
  --json
```

### Escalation

- Dùng khi cần coordinator can thiệp trước khi tiếp tục.
- Không release worker chỉ vì escalation, timeout, idle, heartbeat hoặc question.

### Worker done

- Gửi **chính xác một lần**.
- Body nên là executive summary ngắn: đã làm gì, tìm thấy gì, còn lại gì.
- `worker_done` hợp lệ tự động complete Task/Dispatch; không gọi tiếp `task-update --status completed`.

```bash
orca orchestration send \
  --type worker_done \
  --subject "Slice completed" \
  --body "Ba câu tóm tắt..." \
  --task-id <task_id> \
  --dispatch-id <dispatch_id> \
  --outcome succeeded \
  --files-modified "src/a.ts,tests/a.test.ts" \
  --report-path "reports/slice.md"
```

Sau `worker_done`, worker phải dừng task và idle. Coordinator release terminal hoặc transfer đúng terminal sang task kế tiếp.

## 4. Hermes profiles trong môi trường thử nghiệm

| Profile | Model quan sát | Vai trò |
|---|---|---|
| `default` | `gpt-hermes` | General-purpose |
| `backend-dev` | `gpt-hermes` | API, DB, auth, queues, services |
| `cocos-dev` | `gpt-hermes` | Cocos Creator + TypeScript |
| `game-dev` | `gpt-hermes` | Router Unity/Cocos; không implement product code |
| `life-vn` | `gpt-hermes` | Hướng dẫn đời sống Việt Nam |
| `orchestrator` | `gpt-hermes` | Hermes Kanban fleet manager |
| `research-ai` | `gpt-hermes` | Nghiên cứu AI có nguồn |
| `reviewer` | `gpt-code-fast` | Review độc lập |
| `unity-dev` | `gpt-hermes` | Unity C# và asset safety |
| `web-dev` | `gpt-hermes` | Web UI/accessibility/performance |

Lệnh kiểm tra:

```bash
hermes profile list
hermes profile show web-dev
hermes --tui -p web-dev
```

Model/reasoning cần được coordinator chọn chủ động; Orca không tự tối ưu semantic của Hermes profile khi chỉ thấy một custom terminal.

Gợi ý:

```text
Foundation/UI      → web-dev, gpt-hermes, medium
Orca knowledge     → backend-dev, gpt-hermes, medium
State simulator    → backend-dev, gpt-hermes, high
Unity consultation → unity-dev, gpt-hermes, medium
Slice review       → reviewer, gpt-code-fast, medium+
Final review       → reviewer, model mạnh, high
```

`--reasoning` chỉ override reasoning effort, không mặc định đổi model:

```bash
hermes --tui -p backend-dev --reasoning high
```

## 5. Planning nằm ở đâu

### Global planning

Orca coordinator chịu trách nhiệm:

- Chuẩn hóa brief.
- Inspect repository.
- Thiết kế slices và DAG.
- Chọn profile/model/reasoning/worktree.
- Dispatch, monitor và recovery.
- Tạo review/fix/re-review gates.
- Tích hợp và quyết định human gate.

### Local planning

Hermes worker chỉ planning trong phạm vi Task:

- Đọc spec.
- Inspect worktree được giao.
- Tạo todo nội bộ.
- Implement và verify.
- Báo lifecycle.

Hermes `orchestrator` profile không cần tham gia khi Orca là global coordinator. Nếu dùng Hermes `orchestrator`, Hermes Kanban nên là control plane chính thay vì lồng scheduler tùy tiện.

## 6. Khi nào phải tách worktree

Quy tắc nhanh:

```text
Parallel + writer + shared code surface → tách worktree
Parallel + read-only                    → không bắt buộc
Sequential writer                      → thường không cần
Assets/migrations/generated files      → gần như luôn tách
Independent reviewer                   → session/worktree độc lập
```

Nên tách khi:

- Hai worker có khả năng sửa cùng file/module.
- Nhiều implementation slice chạy song song.
- Task cần dependency/config/build state khác nhau.
- Có migration, formatter, codegen hoặc generated files phạm vi rộng.
- Unity/Cocos có scene, prefab, `.meta`, GUID hoặc asset serialization.
- Cần commit/cherry-pick/rollback độc lập.
- Reviewer cần snapshot ổn định trong khi author tiếp tục làm việc.

Không cần tách khi:

- Chỉ có một writer.
- Các writer chạy tuần tự.
- Research/review read-only.
- File ownership thực sự tách biệt và đã enforce.
- Task bắt buộc dùng shared runtime state không thể nhân bản.

Topology khuyến nghị:

```text
current/master
└── foundation
    ├── wt/orca-explorer
    ├── wt/hermes-profiles
    ├── wt/workflow-simulator
    └── wt/unity-case-study
         ↓ reviewed commits
       wt/integration
         ↓ final reviewer
       human gate
```

Các slice phụ thuộc foundation nên dùng child lineage. Work độc lập mới dùng top-level/no-parent. Worktree lineage của Orca và Git base branch là hai quyết định riêng.

## 7. Reviewer đúng cách

- Reviewer là Task riêng, có dependency vào implementation task/commit.
- Không dùng cùng author session.
- Mặc định không sửa production code.
- Đọc full diff, requirement gốc, test/build evidence, secrets/PII và operational risk.
- Finding phải có severity và `file:line` evidence.
- Verdict nằm trong report/message: `APPROVED` hoặc `CHANGES_REQUESTED`.
- `worker_done succeeded` của reviewer chỉ nghĩa là review process hoàn tất.
- `CHANGES_REQUESTED` tạo fix Task; sau fix phải tạo re-review Task.

```text
implementation → review-1 → fix-task → review-2 → approved
```

Không tạo report “APPROVED” thay reviewer rồi gọi đó là independent review.

## 8. Workflow session đã thực sự xảy ra

Run thử nghiệm: `run_89331bd01442`.

### Thành công thật

- Coordinator tạo Run và Task/Dispatch.
- Hermes `web-dev` hoàn thành foundation qua supervised protocol.
- Worker gửi heartbeat, `ask`, nhận `reply`, sửa đúng repo và gửi `worker_done` hợp lệ.
- Typecheck, lint, test, build và browser inspection được chạy.
- Coordinator tạo local foundation commit `f4dfcb5`.

### Không thành công đúng thiết kế

- Một số Task ban đầu được tạo thiếu deps, sau đó tạo lại; Run có duplicate/orphan tasks.
- Các worker song song chạy chung checkout dù cùng chạm shared UI files.
- Hermes TUI footer/profile cwd trỏ tới `~/Works/web`, `~/Works/BE`, `~/Works/games`, khiến worker inspect sai repo.
- Injected prompt dài bị một số worker hiểu là bị truncate.
- Hermes provider nhiều lần trả `HTTP 503: Structurally heavy chat request capacity is busy`.
- Retry terminal có lúc dùng startup query không hợp lệ và thoát về shell.
- Một số worker nhầm Orca Dispatch với Hermes Kanban.
- `backend-dev`, `unity-dev` và independent reviewer không hoàn tất artifact qua valid `worker_done`.
- Coordinator dùng manual `task-update --status completed` và tự tích hợp phần còn lại.
- Các report review cuối được coordinator tạo, không phải independent Hermes reviewer verdict thật.

Kết luận chính xác:

```text
Run + Dispatch                  ✅
Foundation worker_done         ✅
Heartbeat + ask/reply          ✅
Parallel dispatch              ✅
Parallel worker implementation ❌ phần lớn không hoàn tất
Independent review             ❌ không hoàn tất thật
Coordinator recovery           ✅
Final build/test               ✅
End-to-end fleet success       ❌
```

## 9. Root causes và cách phòng tránh

### Sai working directory

**Hiện tượng:** Orca terminal thuộc đúng worktree nhưng Hermes profile restore cwd cũ.

**Rule:** Task preamble phải yêu cầu worker chạy và báo lại:

```bash
cd <absolute_worktree_path>
pwd
git status --short --branch
```

Không tin TUI footer hoặc profile default cwd. Tất cả write/test command phải dùng worktree path được dispatch.

### Prompt/context quá nặng

**Hiện tượng:** HTTP 503 “Structurally heavy chat request capacity is busy”.

**Rule:**

- Task spec ngắn, executable, tránh lặp toàn bộ guide.
- Lifecycle nằm trong injected preamble; Task chỉ chứa requirement riêng.
- Không nạp skill không liên quan.
- Chia research/content/implementation thành bounded tasks.
- Chọn reasoning theo độ khó, không mặc định high cho mọi worker.
- Retry với fresh session và bounded context thay vì nhồi thêm follow-up dài.

### Prompt bị truncate/không recover được

**Rule:** Worker phải biết đọc active Dispatch context qua Orca CLI/inbox; không được chuyển sang Hermes Kanban để tìm Task.

### Shared checkout race

**Hiện tượng:** Worker và coordinator cùng sửa `src/app.tsx`/styles, tạo import race và artifact bị loại bỏ.

**Rule:** Nếu parallel writer chạm shared surface, bắt buộc worktree riêng và commit handoff.

### Retry/ownership sai

**Rule:**

- Không close terminal tùy tiện khi Dispatch còn active.
- Dùng supervised `worker-stop`/`worker-abandon`/recovery receipt nếu có.
- Chỉ manual `task-update` trong recovery có evidence; ghi rõ đó là override.
- Retry phải tạo attempt mới liên kết attempt cũ và giữ đúng placement.

### Review giả

**Rule:** Không cho coordinator tự viết verdict và mô tả như independent reviewer. Nếu reviewer fail, final status phải ghi `review unavailable/blocked`, hoặc dispatch reviewer mới.

## 10. Workflow chuẩn đề xuất

### Phase A — Plan và một lần phê duyệt

1. Inspect repo và AGENTS.md.
2. Chia tối thiểu 5 slices.
3. Vẽ DAG và xác định parallel writers.
4. Gán profile/model/reasoning/worktree.
5. Định nghĩa review groups, fix loop và human gates.
6. Xin user duyệt plan một lần.

Sau approval, coordinator tự động thực thi trong scope đã duyệt. Chỉ hỏi lại nếu có decision mới không thể discover/default an toàn.

### Phase B — Foundation

1. Tạo Run.
2. Tạo foundation Task.
3. Dispatch `web-dev` trong current hoặc foundation worktree.
4. Chờ valid `worker_done`.
5. Verify và tạo foundation commit.

### Phase C — Parallel slices

1. Tạo child worktree từ foundation commit cho từng writer.
2. Tạo Hermes terminal trong đúng worktree.
3. Dispatch Task với absolute path và file ownership.
4. Monitor heartbeat/ask/escalation.
5. Yêu cầu worker commit local hoặc cung cấp exact diff/artifact.

### Phase D — Review

1. Reviewer chạy session/worktree độc lập.
2. Review exact commit/diff.
3. APPROVED → candidate for integration.
4. CHANGES_REQUESTED → fix task trong author worktree → re-review.

### Phase E — Integration

1. Tạo integration worktree.
2. Cherry-pick approved commits theo dependency order.
3. Integration worker chỉ xử lý conflict/cross-navigation, không viết lại specialist content tùy tiện.
4. Chạy targeted → broad verification.

### Phase F — Final review và handoff

1. Final reviewer độc lập review integration commit.
2. Chạy build/test/lint/accessibility checks.
3. Coordinator báo trung thực task nào worker hoàn tất, task nào recovery/manual override.
4. Push/PR/deploy/merge chỉ sau human gate nếu brief yêu cầu.

## 11. Candidate skill/rule requirements

Skill hoặc AGENTS rule nên enforce các invariant sau:

1. **Single control plane:** Orca hoặc Hermes Kanban, không cả hai mặc định.
2. **Run required:** supervised request phải tạo/bind Run trước Task.
3. **No bare terminal handoff:** phải `task-create` rồi `dispatch --inject`.
4. **Absolute worktree assertion:** worker phải `cd`, `pwd`, `git status` trước read/write.
5. **Worktree isolation:** parallel writers trên shared surface bắt buộc tách worktree.
6. **One writer per worktree:** không có competing writers.
7. **Lifecycle compliance:** heartbeat, ask/reply, escalation và exactly-once worker_done.
8. **Dispatch identity:** taskId + dispatchId + capability phải đúng.
9. **Delivery discipline:** process trước, ack sau.
10. **Reviewer independence:** khác session; mặc định read-only; verdict artifact riêng.
11. **No fake approval:** coordinator không tự gắn nhãn independent review.
12. **Bounded context:** task spec ngắn, không lặp guide, skill load tối thiểu.
13. **Recovery transparency:** manual override phải được ghi rõ trong result và final handoff.
14. **Human gates:** merge, push, deploy, production mutation, destructive migration, credentials và billing.
15. **Truthful final report:** phân biệt valid worker_done, failed attempt, manual completion và unreviewed output.

## 12. Preflight checklist

```text
[ ] Orca status ready
[ ] Correct Run bound
[ ] No duplicate/orphan Task from previous attempts
[ ] DAG dependencies verified with task-list --ready
[ ] Each writer has explicit worktree and file ownership
[ ] Hermes profile/model/reasoning justified
[ ] Absolute worktree path embedded in Task
[ ] Worker terminal is Hermes TUI, not shell after failed startup
[ ] Dispatch preamble injected successfully
[ ] Reviewer tasks depend on exact implementation artifacts
[ ] Integration and final-review stages exist
[ ] Human gates documented
```

## 13. Completion audit checklist

```text
[ ] Every completed implementation has valid worker_done or is labeled manual override
[ ] taskId/dispatchId match active attempt
[ ] Files modified and report paths exist
[ ] Verification commands actually ran
[ ] Reviewer verdict came from independent reviewer
[ ] CHANGES_REQUESTED findings were fixed and re-reviewed
[ ] Worker terminal released/reused correctly
[ ] Delivery acknowledged only after processing
[ ] No worker wrote outside assigned worktree
[ ] Final answer describes failures and recovery honestly
```

## 14. Suggested skill structure

```text
orca-hermes-fleet/
├── SKILL.md
├── references/
│   ├── topology.md
│   ├── lifecycle.md
│   ├── worktree-policy.md
│   ├── reviewer-policy.md
│   └── recovery.md
└── scripts/
    ├── preflight.sh
    ├── verify-dispatch.sh
    └── completion-audit.sh
```

`SKILL.md` nên giữ workflow ngắn và bắt buộc load version-matched Orca guide bằng:

```bash
orca skills get orchestration --full
```

Không hardcode toàn bộ Orca command surface vào skill vì CLI có thể thay đổi theo version. References tập trung vào invariant, quyết định topology và failure recovery đã học được.

## 15. Handoff cho agent tiếp theo

Agent tiếp nhận nên bắt đầu bằng:

1. Đọc file này.
2. Đọc AGENTS.md áp dụng cho repo.
3. Chạy `orca skills get orchestration --full`.
4. Kiểm tra `orca status --json`, Run hiện tại, Task list và terminal list.
5. Không tin status “completed” nếu thiếu valid `worker_done` hoặc artifact reviewer độc lập.
6. Nếu tiếp tục workflow cũ, audit duplicate tasks và manual overrides trước khi dispatch thêm.
7. Nếu tạo workflow mới, áp dụng worktree isolation ngay từ DAG design.

