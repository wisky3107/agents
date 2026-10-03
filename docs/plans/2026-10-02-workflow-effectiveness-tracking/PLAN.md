# Plan đo hiệu quả các hệ thống trong workflow Cocos (workflow scorecard)

Trạng thái: **S0 xong (2026-10-02), S1–S2 xong (2026-10-03), S3 đã có khung đo**: xem `s0-baseline.md` và §10. S3 chờ dữ liệu (≥5 slice/nhánh, đổi cấu hình trong cùng project).
Ngày: 2026-10-02 · Revision: 2 (các quyết định mở #1–#4 đã chốt theo đề xuất; sửa số liệu Orca ở §4.1)
Phạm vi review: KPI cho từng hạng mục hệ thống, hợp đồng dữ liệu tối thiểu, lộ trình, quyết định mở.

## 1. Vấn đề

Workflow đã sinh nhiều dữ liệu, nhưng dữ liệu nằm rời rạc. Chưa nơi nào trả lời được câu hỏi "hệ thống X có đáng giữ, đáng đổi hay không".

| Nguồn đang có | Giới hạn |
|---|---|
| OmniRoute `~/.omniroute/storage.sqlite` (`call_logs`: token, cache, duration, ttft, status, provider) | Chỉ giữ khoảng 7 ngày. Chưa nối được request với slice/role |
| Orca task state (`task-list --run --json`: status, created_at, completed_at, result) | Phải đọc từng Run. `run-list` phân trang. Không ai tổng hợp |
| `stats.json` từng slice | Trường tự do, mỗi slice một kiểu (vd. `"reviewer": "task_… (opencode deepseek-v4.1-flash)"`) |
| `lessons.jsonl` của producer | Có `fix_target` (quy trách nhiệm) nhưng `cost` là chữ. cc-block-out: 58 dòng, trong đó 10 dòng `other`; 28 dòng dùng `event`, 30 dòng dùng `kind` |
| `review.md`, `2d-check.md`, `concept-check.md`, `qa.json` | Kết quả gate là dòng markdown, không có số vòng/chi phí |
| token-report (plan token-opt M0) | Chỉ đo token, theo role |
| orca-memory pilot report + dashboard | Chỉ đo memory, chỉ cc-block-out |

Hệ quả đã thấy:

- S13–S17 của cc-block-out lặp `budget_bump` 4 lần với cùng `fix_target: contract:Fable change_budget counting note`. Chỉ phát hiện khi chạy pilot report M08.
- Reviewer mặc định khác nhau giữa SKILL (`claude opus`), template (`cursor auto`) và thực tế cc-block-out (opencode deepseek), nhưng không có số để so.
- 57 recipe trong playbook, chưa recipe nào được promote. Không ai đo phễu này.
- 7 ngày gần nhất: OmniRoute ghi 48.639 call, 893 lỗi (~1,8%). Riêng agy là 32/867 (~3,7%). Không ai biết các lỗi này có làm chậm slice nào không.

## 2. Nguyên tắc

1. **Đơn vị phân tích là slice**, không phải lượt gọi hay agent. Slice là đơn vị giá trị đi tới người chơi.
2. **Đọc dữ liệu có sẵn trước.** Chỉ thêm instrumentation khi KPI không suy ra được từ nguồn hiện có.
3. **Mỗi sự cố quy về đúng một hệ thống**, dựa trên `fix_target` đã có, ánh xạ sang enum `system` (§4.0).
4. **N nhỏ thì chỉ là tín hiệu định hướng.** Không tính phần trăm tổng hợp, giống quy tắc của pilot M08. Chỉ so hai cấu hình khi mỗi bên có ≥5 slice.
5. **Mỗi KPI phải có ngưỡng và hành động.** KPI nào không dẫn tới quyết định thì bỏ.
6. **Scorecard chỉ đọc, không thành gate.** Không chặn delivery, không thêm cap mới. Kích thước build chỉ theo dõi xu hướng (giữ nguyên quyết định ở `0d79aa4`).

## 3. Kiến trúc tối thiểu

```
nguồn có sẵn                     collector              ledger                    đầu ra
───────────────────────────      ─────────────          ──────────────────        ─────────────────────
OmniRoute call_logs  ──daily──▶  llm                    scorecard.sqlite          slice row (lúc merge)
Orca run/task/worker ──daily──▶  orca             ──▶   slices · tasks     ──▶    weekly scorecard
evidence/T-Sxx/*     ──merge──▶  slice                  events · gates            dashboard
lessons.jsonl        ──merge──▶  events                 llm_daily · builds        retro.md
token-report (M0)    ──daily──▶  tokens (tái dùng)
orca-memory pilot    ──daily──▶  memory (tái dùng)
```

- **Khóa nối:** `project`, `slice`, `task` (T-Sxx), `run_id`, `worktree`, `session_id`, `role`.
- **Tái dùng, không đo lại:**
  - Token theo role lấy từ token-report.
  - Role theo session lấy từ spawn registry `~/.agents/logs/spawns.jsonl` (token-opt M1).
  - Chỉ số memory lấy từ orca-memory pilot report.
- **Nhịp chạy:**
  - **Lúc merge slice:** producer gọi `scorecard slice --project <p> --slice <Sxx>`. Lệnh luôn exit 0 và không bao giờ chặn merge.
  - **Hằng ngày:** snapshot OmniRoute (vì chỉ giữ 7 ngày) và Orca runs. Chỉ lưu số tổng hợp, không chép request body (có prompt).
  - **Hằng tuần:** báo cáo theo hạng mục để đưa vào retro.

## 4. Giải pháp theo hạng mục

Mỗi hạng mục trả lời bốn ý: câu hỏi "hiệu quả" là gì, KPI định nghĩa cụ thể, nguồn dữ liệu, và phần cần bổ sung. Ngưỡng ghi "sau baseline" khi chưa có dữ liệu để đặt số.

### 4.0 Nền chung: hợp đồng dữ liệu tối thiểu

| Thay đổi | Nội dung | Ai ghi |
|---|---|---|
| `stats.json` thêm block `metrics` (schema v1, trường cố định) | `e2e_min`, `fix_rounds`, `review_rounds`, `director_gates`, `recoveries`, `budget_planned`, `budget_actual`, `agents: {role: {provider, model, effort}}`, `smoke: {pass, fail, infra}`, `art_gates: {first_pass, total}` | coordinator ở bước Finish |
| `lessons.jsonl` thêm `system`, `minutes`, `origin_slice` | `system` ∈ `orca \| gateway \| agent:<role> \| engine \| intake \| brief \| art:<backend> \| ship \| memory`. `minutes` là số, đặt cạnh `cost` dạng chữ. `origin_slice` là slice gây lỗi khi khác slice phát hiện | producer |
| Spawn registry (chung với token-opt M1) | `{at, project, slice, role, provider, model, effort, terminal, session}` | `bootstrap.mjs agent-session` |
| `infra-log.jsonl`, `ship-log.jsonl` | một dòng cho mỗi gate hoặc build (§4.4, §4.7) | script template |

Collector suy ra `system` từ prefix của `fix_target` (`skill:cocos-orca-fleet` → `orca`; `contract:*` → `brief`; `template:AGENT_NOTES.md reviewer_agent` → `agent:review`) cho dữ liệu cũ. Trường mới chỉ cần cho dữ liệu từ nay về sau.

### 4.1 Điều phối (Orca)

**Câu hỏi:** Orca có chuyển việc đúng và nhanh không, hay agent bị kẹt và phải cứu tay?

| KPI | Định nghĩa | Nguồn |
|---|---|---|
| Tỷ lệ task lỗi | `(stalled + failed) / task đã xong`, theo Run và theo slice. Orca ghi `failed` cho 4 kết cục khác nhau: review CHANGES_REQUESTED, `agent_prompt_stalled`, task bị thay bằng bản retry, và blocked chờ người. Phải tách chúng ra (Rev 1 ghi "19%" cho cc-lego-stack là sai; tách ra thì là 0/36) | `task-list --run --json` (`result.subject` / `result.reason`) |
| Sự cố điều phối / slice | respawn, `agent_prompt_stalled`, `blockedReason`, worker-stop, chờ bị treo, message bị replay | lessons, `worker-show`, HANDOFF |
| Thời gian chết | khoảng từ lúc một task `completed` tới lúc task kế tiếp trong DAG được dispatch | Orca task + `worker-show` |
| Chi phí điều phối | số turn và token context của producer + coordinator trên mỗi slice | token-report |

- **Cần bổ sung:**
  - Snapshot hằng ngày bằng cách duyệt `run-list --limit --cursor`.
  - Lý do fail đọc từ `result` của task.
  - Event hook của Orca không lưu lại phía mình (spool chỉ là đường dự phòng, hiện trống), nên dựa vào spawn registry và task state.
- **Ngưỡng → hành động:** tỷ lệ fail >15% hoặc >1 sự cố trên một slice → mục retro với `fix_target: skill:cocos-orca-fleet`.

### 4.2 Gateway model (OmniRoute)

**Câu hỏi:** Gateway có ổn định, nhanh và đúng chi phí không? Lỗi provider có làm kẹt slice không?

| KPI | Định nghĩa | Nguồn |
|---|---|---|
| Tỷ lệ lỗi | `status ≥ 400` theo provider/model/ngày. 7 ngày gần nhất: claude 549/33.019, codex 308/13.217, agy 32/867, deepseek 2/1.534 | `call_logs` |
| Độ trễ | p50/p95 `ttft_ms` và `duration` theo model. `ttft_ms` mới có ở 7.683/48.639 dòng | `call_logs` |
| Hiệu quả cache | `tokens_cache_read / (input + cache_read + cache_creation)` | `call_logs` |
| Slice bị chặn bởi provider | số sự kiện `infra_blocked` có cause là provider (vd. S16: `Bad Request: {model: deepseek-v4.1-flash}`) | lessons + `error_summary` |

- **Cần bổ sung:**
  - Snapshot tổng hợp theo ngày vào ledger trước khi OmniRoute xoay vòng log.
  - Xác minh `session_tag` (`conv_<uuid>`) có khớp session id của Claude/Codex không. Nếu khớp thì nối được request → role → slice. Nếu không, mới tính đến API key riêng theo role.
- **Ngưỡng → hành động:** lỗi >3%/ngày trên một provider, hoặc p95 TTFT tăng >50% so với median 7 ngày → đổi combo/fallback trong OmniRoute.
- **Ngoài KPI:** gateway đang listen `*:20128`. Nên bind `127.0.0.1`.

### 4.3 Agent theo vai trò (provider / model)

**Câu hỏi:** Mỗi vai trò có đang dùng provider/model cho chất lượng tốt nhất trên chi phí không?

| Vai trò | KPI chất lượng | KPI chi phí |
|---|---|---|
| implement | tỷ lệ APPROVED ngay vòng review đầu; số fix round có owner=code | token, turn, phút |
| integrate | finding owner=scene; lỗi import sau integrate (vd. S18: PNG thành texture thay vì sprite-frame); số lần stall | như trên |
| review | **lỗi lọt**: lỗi phát hiện ở slice sau, ở build hoặc playtest có `origin_slice` là slice đã APPROVED · tỷ lệ `INFRA_BLOCKED` · tỷ lệ finding bị producer/director bác | như trên |
| producer / coordinator | xem §4.1 | xem §4.1 |

- **Nguồn:** `review.md` (verdict, bảng `fix_routing`), `stats.json`, HANDOFF, lessons, token-report, spawn registry.
- **Cần bổ sung:**
  - `metrics.agents` có cấu trúc (§4.0).
  - `origin_slice` trong lessons, để đo được lỗi lọt.
  - Cursor không đo được token, nên chỉ so bằng turn và phút.
- **Quyết định dựa trên KPI:**
  - Mỗi lần đổi default của một vai trò thì gắn nhãn cấu hình, so sau ≥5 slice mỗi bên.
  - Ứng viên đầu tiên là **reviewer**: `cursor auto` vs `claude opus` vs opencode deepseek.

### 4.4 Engine, MCP và preview

**Câu hỏi:** Editor, MCP và preview có phải là nút thắt không?

| KPI | Định nghĩa | Nguồn |
|---|---|---|
| MCP gate qua lần đầu | `/health.projectName` khớp ngay lần thử đầu (bootstrap và worktree setup) | cần log mới |
| Thời gian tới MCP sẵn sàng | từ lúc setup hook bắt đầu tới khi parity đạt | cần log mới |
| Sự cố editor-lock | lock hết hạn, tranh chấp, phải ép thả | lessons, `editor-log.txt` |
| Lỗi preview / smoke hạ tầng | `preview-startup.json` fail, `run-smoke.mjs` exit 2 (phân biệt với lỗi sản phẩm) | `preview-startup.json`, `smoke*.json` |
| Sự cố đóng editor lúc merge | listener còn sống sau close | `close-editor.sh`, probe |

- **Cần bổ sung:** `probe.mjs`, `setup-orca-worktree.sh` và `bootstrap.mjs create` ghi mỗi gate một dòng vào `infra-log.jsonl` gồm `{step, ok, ms, port, attempt, engine}`. Cần sửa template, nhánh 3.8 và cc4 làm cùng lúc.
- **Ngưỡng → hành động:** sau baseline 2 tuần. Gợi ý: >20% checkout cần thử lại gate → sửa setup hook.

### 4.5 Đầu vào, bằng chứng và hợp đồng

Phạm vi: store crawl, video-probe, SAM 2, AssetRipper, rip-port-analysis, game-brief.

**Câu hỏi:** Bằng chứng và hợp đồng có làm giảm rework ở các slice sau không, và tốn bao nhiêu?

| KPI | Định nghĩa | Nguồn |
|---|---|---|
| Độ phủ bằng chứng | % dòng feel/timing trong EXPECT_GAMEPLAY_VISUAL có số đo từ video-probe, so với `GIVEN`/`ASSUMPTION` · % mục rip-port có bằng chứng, so với UNKNOWN | EXPECT, HOW_TO, `RIP_PORT_MANIFEST.json` |
| Rework do hợp đồng | số fix round, director gate và `budget_bump` có `system: brief` trên mỗi slice | lessons |
| Độ chính xác `change_budget` | median `ratio` của `budget_bump` (S13 ×4,30; S15 ×2,64; S16 ×1,68) | lessons |
| Giá trị của video-probe | tỷ lệ finding feel ở review trên dòng có số đo, so với dòng không có số đo | `review.md` + EXPECT |
| Chi phí | phút của brief author, rip analyst, probe, SAM 2 | spawn registry, timestamps |

- **Cần bổ sung:**
  - Finding trong `review.md` dẫn id dòng EXPECT, để nối được.
  - `prepare.mjs` ghi thời điểm bắt đầu/kết thúc phase vào `brief-progress.json`, nếu chưa có.
- **Ngưỡng → hành động:**
  - Median ratio >1,5 trong 5 slice liên tiếp → sửa cách calibrate trong `slice-schema.md`.
  - ≥2 slice có cùng `fix_target` hợp đồng → amendment hợp đồng ngay, không chờ retro.

### 4.6 Art

**Câu hỏi:** Theo từng backend và loại asset: asset có qua gate ngay lần đầu, có dùng được trong game không, và tốn bao nhiêu?

KPI được tách theo `(art_backend, loại asset 2D/concept/mesh/anim, method)`.

| KPI | Định nghĩa | Nguồn |
|---|---|---|
| Qua gate lần đầu | ART2D, CONCEPT, VERDICT, ANIM đều PASS ngay vòng 1 | `2d-check.md`, `concept-check.md`, `qa.json` |
| Vòng regen | số vòng trung bình cho mỗi asset | như trên |
| Lỗi lọt gate | finding owner=asset ở review · lỗi import sau gate (alpha, kích thước, importer) | `review.md`, lessons |
| Tuân thủ method | dòng `image-gen` làm bằng script (blocker) · method do worker tự đặt (thay đổi đang chưa commit) | ASSET_MANIFEST `method`, `verify.tool` |
| Chi phí | Tripo credits/mesh · phút/asset · tỷ lệ studio rơi về Blender (exit 2) · sự cố backend (ChatGPT login/quota/CAPTCHA, prompt trust của agy) | output `gen3d_studio.py`, lessons |

- **Cần bổ sung:**
  - **Giai đoạn đầu:** collector parse các dòng `ART2D: PASS|FAIL`, `CONCEPT: PASS`, …
  - **Giai đoạn sau:** worker art ghi `art-gates.json` gồm `{asset, type, backend, method, gate, round, result, credits, minutes}`.
  - Harvest bỏ PNG, nên file JSON/MD phải nằm trong commit của slice.
- **Quyết định dựa trên KPI:** so antigravity, gpt-image-gen và cursor cho 2D theo tỷ lệ qua gate lần đầu và phút/asset.

### 4.7 Ship

**Câu hỏi:** Bản build có đúng và lên được không, mất bao lâu từ merge tới URL?

| KPI | Định nghĩa | Nguồn |
|---|---|---|
| Build / deploy pass | tỷ lệ pass và thời gian của `build.sh` / `deploy.sh` | cần log mới |
| Smoke sau deploy | pass/fail khi smoke qua `npx vercel curl` + trình duyệt Orca | smoke JSON |
| Lỗi chỉ có ở bản build | lỗi không tái hiện ở preview (vd. Set/Map spread S07) trên mỗi release | lessons `system: ship` |
| Lead time | từ merge của slice cuối tới khi có preview URL | git + ship-log |
| Kích thước bundle | chỉ theo dõi xu hướng, **không** thành cap | ship-log |

- **Cần bổ sung:** `build.sh` và `deploy.sh` ghi thêm dòng vào `build/ship-log.jsonl` gồm `{sha, step, ok, ms, size_bytes, url}`.

### 4.8 Học và memory

Phạm vi: playbook, lessons, orca-memory, Hindsight. Đây là hạng mục đã có instrumentation tốt nhất (pilot ledger, report, dashboard), nên chỉ cần mở rộng.

| KPI | Định nghĩa | Nguồn |
|---|---|---|
| Tỷ lệ lặp lỗi | cùng cause/`fix_target` xuất hiện lại ở slice sau, tách theo `system`. Hiện đã có exact match; bổ sung `pilot recur` cho lặp ngữ nghĩa | orca-memory pilot |
| Phễu bài học | candidate → curated → recipe `candidate` → `verified`/`default`: tỷ lệ và thời gian mỗi bước. Hiện 0/57 recipe qua `candidate` | playbook `registry.json`, lessons |
| Kết quả tái dùng recipe | tỷ lệ `recipe_reuse` thành công | lessons, `review.md` |
| Chất lượng pack | tỷ lệ verdict useful / redundant / irrelevant / misleading / stale ở shadow · overhead hook (ms, tokens) | `pilot judge`, `hook-log.jsonl` |

- **Cần bổ sung:**
  - Bật `capture-only` cho các project khác ngoài cc-block-out, để có dữ liệu so sánh (hiện là `off`).
  - Nhắc curator khi một candidate xuất hiện ở ≥2 project mà sau 14 ngày chưa được review.
- **Ngưỡng → hành động:** theo gate shadow → assist của plan Hindsight. Scorecard chỉ hiển thị, không tự quyết.

### 4.9 TypeSafe (opt-in)

- **Mặc định:** giữ tắt. Không đầu tư thêm.
- **Nếu muốn đánh giá:** chạy shadow, log gợi ý route bên cạnh quyết định thực tế.
- **KPI khi chạy shadow:** tỷ lệ đồng ý, số ca gợi ý lẽ ra tránh được rework, latency, số lần `fail_open`.

## 5. Đầu ra và nhịp xem

- **Dòng slice:** append lúc merge, gồm mọi trường `metrics` cộng số tổng hợp từ ledger. Producer ghi một dòng tóm tắt vào `producer-log.md`.
- **Scorecard tuần:** một bảng mỗi hạng mục, cờ đỏ/vàng/xanh theo ngưỡng, kèm top 3 `fix_target` lặp nhiều nhất.
- **Dashboard:** mở rộng `~/.orca-memory/reports/dashboard.html`, hoặc một trang riêng (quyết định mở #1).
- **Retro:** `docs/retro.md` đọc từ scorecard, thay vì producer tự tổng hợp lại từ đầu.

## 6. Lộ trình

| Bước | Nội dung | Sửa skill/template? | Tiêu chí xong |
|---|---|---|---|
| **S0** Baseline | Collector đọc nguồn có sẵn; backfill cc-block-out S01–S22, cc-lego-stack, cc-meowdoku, cc-monopoly-go; snapshot hằng ngày OmniRoute + Orca; xác minh khóa `session_tag` | Không | Có báo cáo baseline theo 9 hạng mục; director chọn KPI giữ/bỏ |
| **S1** Hợp đồng dữ liệu | `metrics` trong `stats.json`; `system`/`minutes`/`origin_slice` trong lessons; spawn registry (chung token-opt M1); `infra-log`, `ship-log` | Có. Áp giữa hai slice, vì skill được symlink và có hiệu lực ngay | 3 slice liên tiếp sinh đủ trường, collector không cần đoán |
| **S2** Báo cáo | Scorecard tuần, dashboard, ngưỡng | Không | Một retro dùng scorecard thay cho tổng hợp tay |
| **S3** Thí nghiệm | Reviewer default; `art_backend` cho 2D | Chỉ đổi `AGENT_NOTES` theo nhãn | ≥5 slice mỗi nhánh; quyết định có số đi kèm |

## 7. Quan hệ với các plan khác

- **Coordinator token optimization:**
  - Dùng token-report (M0) và spawn registry (M1).
  - Scorecard không đo token lại.
  - Nếu M1 chưa xong, S0 dùng classifier v2 của token-report.
- **Hindsight / orca-memory:**
  - Đọc pilot ledger/report.
  - Scorecard không thay gate của plan đó.

## 8. Quyết định mở

| # | Câu hỏi | Đề xuất |
|---|---|---|
| 1 | Đặt tool ở đâu? | **Chốt:** `~/.agents/tools/workflow-scorecard`, Python stdlib |
| 2 | Lưu ở đâu? | **Chốt:** `~/.agents/logs/scorecard.sqlite` (`logs/` đã vào `.gitignore`). Chỉ lưu số tổng hợp |
| 3 | Pilot trên project nào? | **Chốt:** cc-block-out + cc-lego-stack; baseline thêm cc-meowdoku, cc-monopoly-go |
| 4 | Ai gọi collector lúc merge? | **Chốt:** producer gọi ở S1 (không chặn). Job hằng ngày là launchd `com.agents.workflow-scorecard` lúc 09:17 (đã cài ở S0) |
| 5 | Nối call gateway về session/project? | **Còn mở.** S0 xác minh: `session_tag` (`conv_…`) không khớp session id. Chỉ body của Claude có `metadata.user_id.session_id` (nối được ~40% call claude, body giữ ~3 ngày). Codex/agy/deepseek không nối được, nên cần API key riêng hoặc header session cho codex |

## 9. Rủi ro

- **Goodhart:** agent tối ưu KPI thay vì tối ưu game. Giữ scorecard chỉ đọc, không đưa KPI vào prompt worker.
- **N nhỏ, nhiều nhiễu:** chỉ đưa tín hiệu định hướng (§2.4).
- **Thêm tải cho agent:** hợp đồng dữ liệu giữ nhỏ; collector suy ra phần lớn số liệu.
- **Riêng tư:** request body của OmniRoute chứa prompt. Chỉ lưu số tổng hợp.
- **Skill có hiệu lực ngay khi sửa:** mọi patch S1 áp giữa hai slice, khi không có fleet đang chạy giữa chừng.

## 10. Nhật ký triển khai

### S1 — 2026-10-03

Làm sau khi token-opt M0–M6b đã merge (producer runner là đường chính). Vì runner đã ghi phần lớn số liệu dưới dạng có cấu trúc, S1 nhỏ hơn §4.0 dự kiến.

| Hạng mục §4.0 | Đã làm | Lệch so với plan |
|---|---|---|
| `system` trong lessons | Runner tự điền (`game-producer/scripts/lib/attribution.mjs`, gọi trong `appendLessons`). LLM producer điền theo schema mới ở SKILL.md. Khóa dedupe bỏ qua `system`, nên dòng ghi trước S1 không bị lặp | — |
| `origin_slice`, `minutes` | Có trong schema SKILL.md, tùy chọn | Runner không điền: dòng của runner luôn thuộc slice của nó, và runner không biết chi phí theo phút. Thời gian chờ đo bằng `runner_stops` thay thế |
| `metrics` trong `stats.json` | Bước Finish của fleet bắt buộc 3 trường `fix_rounds`, `review_rounds`, `agents` | Rút gọn: e2e và fix rounds đã có ở `producer-state.json` / `merge-journal.json` |
| Spawn registry | Dùng `logs/spawns.jsonl` của token-opt M1 | Chỉ ghi spawn qua bootstrap; worker do Orca `worker-start` lấy từ `stats.json` `agents` |
| `infra-log.jsonl` | `probe.mjs` trong cc-game-template và cc-playable-template ghi vào checkout chính | cc4-game-template chưa có (file đang có WIP khác). Project đã tạo trước đó vẫn dùng bản probe cũ |
| `ship-log.jsonl` | `build/scripts/ship-log.sh`, gọi từ `build.sh`/`deploy.sh` của cả ba template | Project đã tạo trước đó chưa có |
| `art-gates.json` | Chưa làm | Collector vẫn đọc dòng `ART2D/CONCEPT/VERDICT/ANIM` (§4.6 giai đoạn đầu) |

Scorecard đọc thêm:
- runner (`producer-state.json`, `merge-journal.json`, các lần dừng trong `producer-log.md`),
- `spawns.jsonl` và `coordinator-guard.jsonl`,
- `ship-log`, `infra-log`, `stats.json` `agents`,
- `system` khi dòng lessons đã ghi sẵn.

Pilot cc-lego-stack S08 (runner): e2e 355 phút, trong đó 202 phút runner dừng chờ, qua 7 lần dừng. Lâu nhất là 83 phút ở lần đầu, do `cursor-agent` chưa đăng nhập nên art-manifest không dispatch được.

Test: scorecard 23, game-producer 81 (gồm 3 test S1).

### S2 — 2026-10-03

- **Ngưỡng:** 13 KPI cho 8 hạng mục, số lấy từ §4. Mỗi KPI có số mẫu tối thiểu; dưới mức đó ghi "chưa đủ dữ liệu". `memory.promotion` chỉ có mức vàng.
- **Đầu ra của job `daily`:**
  - `logs/weekly/scorecard-<YYYY>-W<ww>.md`: cờ KPI, slice xong trong 7 ngày, top 3 `fix_target` lặp, các nhánh cấu hình.
  - `logs/scorecard-dashboard.html`: trang local, light/dark, dùng palette trạng thái có icon và nhãn chữ.
- **Retro:** đọc `scorecard-latest.md` (S1).
- **Chưa làm:** cảnh báo hồi quy TTFT (§4.2). Histogram theo bucket quá thô để so ±50%.
- **Lần chạy đầu (2026-10-03):** ĐỎ 4, VÀNG 7, XANH 15, chưa đủ dữ liệu 4. Bốn mục ĐỎ:
  - runner chờ chiếm 57% e2e (cc-lego-stack S08),
  - lỗi agy 5%,
  - budget cc-block-out median ×2,64,
  - `contract:Fable change_budget counting note` lặp ở 6 slice.

### S3 — 2026-10-03 (khung đo)

- `experiments()` nhóm slice theo reviewer, writer, art backend. Nhãn ghi trong chính slice (`stats.json` `agents`) được ưu tiên hơn khóa AGENT_NOTES.
- Một chiều chỉ "so được" khi mỗi nhánh có ≥5 slice **và** có ít nhất một project đã chạy cả hai cấu hình.
- **Hiện chưa chiều nào so được:**
  - Reviewer: các nhánh có dưới 5 slice.
  - Writer và art backend: mỗi nhánh trùng với một project riêng.
- **Để có phép so đầu tiên:** trong một project pilot, đổi `reviewer_agent` giữa hai cấu hình, mỗi cấu hình ≥5 slice. Fleet ghi `stats.json` `agents` (S1), nên mỗi slice tự mang nhãn của mình.

### Sửa 4 mục ĐỎ — 2026-10-03

| Mục ĐỎ | Nguyên nhân gốc | Đã làm | Trạng thái sau |
|---|---|---|---|
| Runner chờ 57% e2e (cc-lego-stack) | KPI gộp quyết định của director với lần dừng tránh được, và tính cả gate hỏi trước khi chọn slice. Mọi lần dừng tránh được đều đã được phiên token-opt sửa: Cursor chưa đăng nhập, status lạ (a23c12e); báo nhầm coordinator mất, đọc review cũ (79e4539); commit kẹt (f579d10); verdict_override (df9e630); verdict_mismatch (191cc35) | KPI tách `orca.runner_avoidable_wait` / `orca.director_wait_min`, cắt theo khung slice; các fix ghi vào `resolutions.json` | ĐÃ SỬA · chờ xác nhận |
| Lỗi agy 5% | Toàn bộ là health-check `connection-test` của OmniRoute; traffic agy thật không qua gateway. Một tài khoản agy bị "Access denied" | Gateway KPI bỏ health-check; KPI mới `gateway.dead_connections` | Lỗi agy hết. Tài khoản hỏng thành VÀNG: cần đăng nhập lại hoặc gỡ trong OmniRoute (việc của người dùng) |
| Budget cc-block-out median ×2,64 | Bộ đếm `code_only` đếm cả `docs/evidence`, tính mỗi PNG là một file, và đếm output của importer, trái với định nghĩa của chính nó | Sửa `check-change-budget.sh` (3 template + cc-block-out; thêm `budget_exclude` và `--range`). SCOPE.md của cc-block-out liệt kê output importer. `slice-schema.md`: test scenario 200–300 dòng, cảnh báo ratio cũ | ĐỎ → VÀNG: đếm lại S14–S18 ra ×1,58. Phần còn lại là ước lượng, đã sửa trong hướng dẫn cho brief sau |
| `contract:Fable change_budget counting note` lặp 6 slice | Như trên | Như trên + resolution | ĐÃ SỬA · chờ xác nhận |

Cũng sửa:
- parser `fix_routing` (bảng có cột severity),
- tỷ lệ cache (OmniRoute `tokens_in` đã gồm cache read).

Mục ĐỎ mới hiện ra: `agent.first_pass` cc-lego-stack 1/8 slice không cần fix. Gần như mọi finding có owner `code` (writer claude sonnet). Đây là ứng viên cho thí nghiệm S3 về writer.

### S3 — thí nghiệm writer cc-lego-stack, bắt đầu 2026-10-03

- **Hướng:** đổi writer từ thời điểm này trở đi, không chạy lại slice cũ và không bịa thêm slice.
- **Nhánh A — claude sonnet effort high:**
  - S01–S08. Riêng S02–S07 có nhãn lấy từ dòng `spawned writer` trong producer-log của runner.
  - 1/6 slice runner qua review mà không cần fix; finding gần như đều có owner `code`.
- **Nhánh B — claude opus effort high:** áp dụng từ `cc-lego-stack e49982c` (12:18Z), đổi cả hai khóa (`fleet.writer_agent` và dòng policy). Task size L do director gửi ngày 2026-10-03 là slice đầu tiên của nhánh B.
- **Ghi nhận mốc đổi:** `tools/workflow-scorecard/experiments.json`. Slice không có nhãn riêng (vd. S08 fleet) được gán theo khóa lúc slice xong, nên không bị đổi nhãn.
- **Khi nào kết luận được:** khi mỗi nhánh có ≥5 slice trong cc-lego-stack. Trước đó scorecard chỉ hiện tín hiệu định hướng.
- **Theo dõi khi so:** độ khó các slice có thể khác nhau (S09+ là task mới). Nên đọc kèm `fix_routing` owner và e2e, không chỉ dựa vào tỷ lệ first-pass.
