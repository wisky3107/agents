# Workflow scorecard — baseline

Tạo lúc 2026-10-02T03:56:15Z. Dự án: cc-block-out, cc-lego-stack, cc-meowdoku, cc-monopoly-go.
OmniRoute: 2026-09-25 → 2026-10-02 (8 ngày đã snapshot).
Số nhỏ = tín hiệu định hướng, không phải tỷ lệ chuẩn. Quy hệ thống cho dữ liệu cũ là heuristic (cột `rule` trong bảng `events`).

## 1. Điều phối (Orca)

| project | runs | task đã xong | completed | review từ chối | blocked | stalled | bị thay thế | failed khác | stalled + failed |
|---|---|---|---|---|---|---|---|---|---|
| cc-block-out | 18 | 168 | 131 | 13 | 3 | 8 | 8 | 5 | 13/168 (8%) |
| cc-lego-stack | 1 | 36 | 29 | 2 | 3 | 0 | 2 | 0 | 0/36 (0%) |
| cc-meowdoku | 5 | 44 | 34 | 6 | 0 | 0 | 0 | 4 | 4/44 (9%) |
| cc-monopoly-go | 12 | 172 | 149 | 12 | 0 | 1 | 0 | 10 | 11/172 (6%) |

_Orca ghi mọi kết cục này là `failed`. "Review từ chối" thuộc §3; "bị thay thế" là hệ quả của task trước, không tính là lỗi riêng; "blocked" thường chờ người (vd. reload gate)._

Sự cố điều phối trong lessons.jsonl:

| project | sự cố | số slice dính |
|---|---|---|
| cc-block-out | 6 | 5 |
| cc-monopoly-go | 3 | 3 |

## 2. Gateway (OmniRoute)

| provider | calls | lỗi | p50 thời gian | p95 thời gian | p95 TTFT | cache read |
|---|---|---|---|---|---|---|
| claude | 32936 | 547/32936 (2%) | ≤8s | ≤30s | ≤15s (n=2738) | 96% |
| codex | 13185 | 306/13185 (2%) | ≤4s | ≤30s | ≤15s (n=5070) | 93% |
| deepseek | 1529 | 2/1529 (0%) | ≤0.25s | ≤0.5s | — (n=0) | — |
| agy | 864 | 32/864 (4%) | ≤0.25s | ≤2s | — (n=0) | — |
| gpt-plan | 2 | 2/2 (100%) | >600s | >600s | — (n=0) | — |

Lỗi hay gặp nhất:

| provider | lỗi | số lần |
|---|---|---|
| claude | HTTP 400 | 444 |
| codex | quota_exhausted | 247 |
| claude | HTTP 499 | 54 |
| codex | unknown | 29 |
| claude | server_error | 27 |
| agy | forbidden | 26 |
| claude | unknown | 13 |
| codex | server_error | 12 |

Lỗi gateway theo project (chỉ claude, những ngày còn request body):

| project | calls | lỗi |
|---|---|---|
| cc-block-out | 860 | 6/860 (1%) |
| cc-lego-stack | 316 | 5/316 (2%) |
| cc-monopoly-go | 390 | 9/390 (2%) |

Nối call gateway về session/project:

provider | session-days | calls joined to a session | of all calls those days | session-days mapped to a project
---|---|---|---|---
claude | 70 | 2334 | 40% | 43
no session id in bodies for: agy, codex, deepseek, gpt-plan (only claude bodies carry metadata.user_id)

Slice bị chặn bởi provider (lessons):

| project | slice | nguyên nhân |
|---|---|---|
| cc-block-out | S16 | openCode deepseek-v4.1-flash provider intermittently returns Bad Request |

## 3. Agent theo vai trò

| project | slice có số liệu | qua review không cần fix | median vòng review | review INFRA_BLOCKED | fix rounds / slice có số | reviewer_agent (AGENT_NOTES) |
|---|---|---|---|---|---|---|
| cc-block-out | 19 | 6/19 (32%) | 2 | 0 | 20 / 19 slice | claude --model opus |
| cc-lego-stack | 1 | 0/1 (0%) | 8 | 2 | 7 / 1 slice | claude --model opus --effort medium |
| cc-meowdoku | 7 | 3/7 (43%) | 2 | 0 | 6 / 7 slice | codex --model gpt-5.6-sol-low |
| cc-monopoly-go | 6 | 2/6 (33%) | 2.5 | 0 | 13 / 6 slice | claude --model sonnet |

Chủ của finding trong bảng fix_routing:

| project | owner | finding |
|---|---|---|
| cc-block-out | art | 1 |
| cc-block-out | code | 5 |
| cc-block-out | followup | 1 |
| cc-block-out | scene | 4 |
| cc-block-out | unclear | 1 |
| cc-lego-stack | code | 5 |
| cc-lego-stack | mesh | 2 |
| cc-lego-stack | scene | 1 |

Task Orca theo vai trò:

| project | role | completed | review từ chối | stalled/failed | tổng |
|---|---|---|---|---|---|
| cc-block-out | review | 17 | 8 | 6 | 38 |
| cc-block-out | plan | 31 | 3 | 2 | 36 |
| cc-block-out | fix | 29 | 0 | 2 | 32 |
| cc-block-out | integrate | 12 | 0 | 2 | 18 |
| cc-block-out | implement | 13 | 0 | 0 | 15 |
| cc-block-out | art | 12 | 0 | 0 | 13 |
| cc-block-out | other | 8 | 2 | 1 | 12 |
| cc-block-out | scan | 9 | 0 | 0 | 9 |
| cc-lego-stack | review | 8 | 2 | 0 | 13 |
| cc-lego-stack | fix | 5 | 0 | 0 | 8 |
| cc-lego-stack | other | 6 | 0 | 0 | 6 |
| cc-lego-stack | integrate | 1 | 0 | 0 | 3 |
| cc-meowdoku | plan | 10 | 1 | 0 | 15 |
| cc-meowdoku | review | 4 | 5 | 2 | 11 |
| cc-meowdoku | fix | 10 | 0 | 1 | 11 |
| cc-meowdoku | other | 2 | 0 | 1 | 3 |
| cc-meowdoku | integrate | 3 | 0 | 0 | 3 |
| cc-meowdoku | implement | 3 | 0 | 0 | 3 |
| cc-meowdoku | scan | 2 | 0 | 0 | 2 |
| cc-monopoly-go | fix | 45 | 0 | 3 | 48 |
| cc-monopoly-go | art | 32 | 0 | 6 | 38 |
| cc-monopoly-go | review | 15 | 12 | 0 | 29 |
| cc-monopoly-go | mesh | 12 | 0 | 0 | 12 |
| cc-monopoly-go | integrate | 10 | 0 | 0 | 11 |
| cc-monopoly-go | concept | 11 | 0 | 0 | 11 |
| cc-monopoly-go | implement | 9 | 0 | 0 | 9 |
| cc-monopoly-go | scan | 8 | 0 | 0 | 8 |
| cc-monopoly-go | plan | 4 | 0 | 1 | 5 |
| cc-monopoly-go | other | 3 | 0 | 1 | 4 |

Token theo vai trò (token-report; Cursor không đo được):

| project | role | sessions | turns | context tokens (M) |
|---|---|---|---|---|
| cc-block-out | fleet-worker | 66 | 4992 | 704.3 |
| cc-block-out | fleet-orch | 12 | 2022 | 274.3 |
| cc-lego-stack | fleet-worker | 15 | 1072 | 225.0 |
| cc-lego-stack | producer | 1 | 1025 | 145.9 |
| cc-lego-stack | fleet-orch | 1 | 191 | 24.8 |
| cc-meowdoku | fleet-worker | 11 | 666 | 66.7 |
| cc-meowdoku | slice-agent | 6 | 543 | 61.6 |
| cc-monopoly-go | fleet-worker | 109 | 4806 | 552.4 |
| cc-monopoly-go | fleet-orch | 11 | 3148 | 413.0 |
| cc-monopoly-go | slice-agent | 9 | 1478 | 181.1 |

Ứng viên lỗi lọt (sự cố ở slice này nhắc tới slice khác; cần `origin_slice` ở S1 để chắc chắn):

| project | slice phát hiện | slice được nhắc | nguyên nhân |
|---|---|---|---|
| cc-block-out | S09 | S08 | S08 committed 6 door PNGs without .meta; each checkout mints different UUIDs (main vs S09  |
| cc-block-out | S14 | S01, S13 | PLAN invariant 'S01-S13 specs pass unchanged' is impossible for a cross-slice parity test  |
| cc-block-out | S16 | S04 | producer PLAN path list missed the entity that owns the S04 curtain marker |
| cc-monopoly-go | S14B-S16A | S14B, S14C, S15A, S16A | asset gap carried across 4 slices (S14b found, S14c/S15a carried, S16a fixed) |
| cc-monopoly-go | S14A-S16B | S14A | every runtime slice from S14a: timing/fps rows manual_required; host screenshots unusable |
| cc-monopoly-go | S12-S17 | S12, S13, S17 | retro data gap: 0 learning-candidates.json, stats.json missing in S12/S13/S17 and schema-i |

## 4. Engine, MCP và preview

| project | sự cố engine/MCP/preview | số slice dính |
|---|---|---|
| cc-block-out | 4 | 4 |

_Chưa có thời gian MCP gate và số lần thử lại: cần `infra-log.jsonl` (S1)._

## 5. Đầu vào, bằng chứng và hợp đồng

| project | dòng EXPECT | GIVEN | ASSUMPTION | nhắc tới số đo/probe |
|---|---|---|---|---|
| cc-block-out | 38 | 1 | 3 | 0 |
| cc-lego-stack | 57 | 43 | 51 | 1 |
| cc-meowdoku | 31 | 0 | 22 | 1 |
| cc-monopoly-go | 48 | 29 | 47 | 0 |

| project | slice có budget_bump | median ratio | max ratio | sự cố do hợp đồng | director gate |
|---|---|---|---|---|---|
| cc-block-out | 8 | ×2.34 | ×4.30 | 5 | 2 |
| cc-lego-stack | 1 | ×1.15 | ×1.15 | 0 | 0 |

## 6. Art

| project | gate | file check | PASS ngay lần đầu | số FAIL |
|---|---|---|---|---|
| cc-block-out | VERDICT | 17 | 17/17 (100%) | 0 |
| cc-lego-stack | CONCEPT | 2 | 2/2 (100%) | 0 |
| cc-lego-stack | VERDICT | 3 | 3/3 (100%) | 0 |
| cc-monopoly-go | CONCEPT | 11 | 11/11 (100%) | 0 |
| cc-monopoly-go | VERDICT | 33 | 27/33 (82%) | 7 |

Sự cố art trong lessons:

| project | sự cố | số slice dính |
|---|---|---|
| cc-block-out | 2 | 2 |
| cc-monopoly-go | 1 | 1 |

_Chưa có credits, phút/asset và backend: cần `art-gates.json` (S1)._

## 7. Ship

_không có dữ liệu_

_Chưa có tỷ lệ build/deploy pass và lead time: cần `ship-log.jsonl` (S1)._

## 8. Học và memory

Lỗi lặp (cùng `fix_target` ở ≥2 slice):

| project | fix_target | số lần | slice |
|---|---|---|---|
| cc-block-out | contract:Fable change_budget counting note | 6 | S13, S14, S15, S16, S17, S18 |
| cc-block-out | skill:cocos-orca-fleet | 2 | S13, S18 |
| cc-block-out | skill:game-producer | 2 | S08, S09 |

Bài học thu được:

| project | bản ghi học | failure_fix | successful_pattern | recipe_reuse |
|---|---|---|---|---|
| cc-block-out | 30 | 22 | 8 | — |
| cc-lego-stack | 5 | 2 | 1 | 2 |
| cc-monopoly-go | 14 | 8 | 6 | 0 |

Playbook: 57 recipe — candidate: 57.

Hook orca-memory:

| project | mode | lần gọi | đã inject | ms trung bình | pack tokens trung bình |
|---|---|---|---|---|---|
| cc-block-out | shadow | 10 | 0 | 94 | 1537 |

## 9. TypeSafe

Bật ở: không project nào — không đo.

## Phụ lục: từng slice

| project | slice | vòng review | verdict đầu | verdict cuối | fix rounds | nguồn | merged | e2e phút | budget × |
|---|---|---|---|---|---|---|---|---|---|
| cc-block-out | S01 | 2 | CHANGES_REQUESTED | APPROVED | 1 | AGENT_NOTES | 1 | — | — |
| cc-block-out | S02 | 0 | — | — | 1 | AGENT_NOTES | 1 | — | — |
| cc-block-out | S03 | 0 | — | — | 0 | AGENT_NOTES | 1 | — | — |
| cc-block-out | S04 | 0 | — | — | 1 | AGENT_NOTES | 1 | — | — |
| cc-block-out | S05 | 0 | — | — | 1 | AGENT_NOTES | 1 | — | — |
| cc-block-out | S06 | 0 | — | — | 1 | AGENT_NOTES | 1 | — | — |
| cc-block-out | S07 | 0 | — | — | 1 | AGENT_NOTES | 1 | — | — |
| cc-block-out | S08 | 4 | APPROVED | APPROVED | 3 | stats.json | 1 | — | 1.29 |
| cc-block-out | S09 | 3 | CHANGES_REQUESTED | APPROVED | 2 | stats.json | 1 | — | 2.05 |
| cc-block-out | S10 | 0 | — | — | — | — | 1 | 698 | — |
| cc-block-out | S11 | 0 | — | — | — | — | 1 | 177 | — |
| cc-block-out | S12 | 1 | APPROVED | APPROVED | 2 | stats.json | 1 | 300 | — |
| cc-block-out | S13 | 1 | APPROVED | APPROVED | 2 | stats.json | 1 | 1012 | 4.298 |
| cc-block-out | S14 | 1 | APPROVED | APPROVED | 0 | stats.json | 1 | 279 | 1.476 |
| cc-block-out | S15 | 1 | APPROVED | APPROVED | 0 | stats.json | 1 | 179 | 2.64 |
| cc-block-out | S16 | 1 | APPROVED | APPROVED | 0 | stats.json | 1 | 248 | 1.68 |
| cc-block-out | S17 | 1 | APPROVED | APPROVED | 2 | stats.json | 1 | 251 | 3.32 |
| cc-block-out | S18 | 1 | APPROVED | APPROVED | 0 | stats.json | 1 | 446 | 3.06 |
| cc-block-out | S19 | 1 | APPROVED | APPROVED | 0 | AGENT_NOTES | 1 | 847 | — |
| cc-block-out | S20 | 2 | CHANGES_REQUESTED | APPROVED | 1 | AGENT_NOTES | 1 | 585 | — |
| cc-block-out | S21 | 3 | CHANGES_REQUESTED | APPROVED | 2 | stats.json | 1 | 522 | — |
| cc-block-out | S22 | 0 | — | — | — | — | 0 | — | — |
| cc-lego-stack | S01 | 8 | CHANGES_REQUESTED | CHANGES_REQUESTED | 7 | AGENT_NOTES | 1 | — | 1.1515384615 |
| cc-meowdoku | S01 | 0 | — | — | 3 | AGENT_NOTES | 1 | — | — |
| cc-meowdoku | S02 | 0 | — | — | — | — | 1 | — | — |
| cc-meowdoku | S03 | 0 | — | — | 1 | AGENT_NOTES | 1 | — | — |
| cc-meowdoku | S04 | 1 | APPROVED | APPROVED | 1 | AGENT_NOTES | 0 | — | — |
| cc-meowdoku | S05 | 1 | APPROVED | APPROVED | 0 | AGENT_NOTES | 0 | — | — |
| cc-meowdoku | S06 | 0 | — | — | 1 | AGENT_NOTES | 1 | — | — |
| cc-meowdoku | S07 | 1 | APPROVED | APPROVED | 0 | AGENT_NOTES | 0 | — | — |
| cc-meowdoku | S08 | 0 | — | — | 0 | AGENT_NOTES | 1 | — | — |
| cc-meowdoku | S09 | 0 | — | — | — | — | 0 | — | — |
| cc-meowdoku | S10 | 0 | — | — | — | — | 0 | — | — |
| cc-meowdoku | S11 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S01 | 0 | — | — | 8 | AGENT_NOTES | 0 | — | — |
| cc-monopoly-go | S02 | 1 | APPROVED | APPROVED | 1 | AGENT_NOTES | 0 | — | — |
| cc-monopoly-go | S03 | 0 | — | APPROVED | 0 | stats.json | 0 | — | — |
| cc-monopoly-go | S04 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S05 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S06 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S07 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S08 | 2 | APPROVED | APPROVED | 0 | stats.json | 1 | — | — |
| cc-monopoly-go | S09 | 0 | — | — | — | — | 1 | — | — |
| cc-monopoly-go | S10 | 3 | CHANGES_REQUESTED | APPROVED | 2 | AGENT_NOTES | 1 | — | — |
| cc-monopoly-go | S11 | 1 | CHANGES_REQUESTED | CHANGES_REQUESTED | 2 | AGENT_NOTES | 1 | — | — |
| cc-monopoly-go | S12 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S13 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S14A | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S14B | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S14C | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S14D | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S15A | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S15B | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S15C | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S16A | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S16B | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S17 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S18 | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S18A | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S18B | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S18C | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S18D | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S18E | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S18F | 0 | — | — | — | — | 0 | — | — |
| cc-monopoly-go | S18G | 0 | — | — | — | — | 0 | — | — |

Phân bổ sự cố theo hệ thống (heuristic):

| project | system | sự cố |
|---|---|---|
| cc-block-out | brief | 12 |
| cc-block-out | orca | 6 |
| cc-block-out | engine | 4 |
| cc-block-out | art | 2 |
| cc-block-out | agent | 2 |
| cc-block-out | other | 1 |
| cc-block-out | gateway | 1 |
| cc-lego-stack | brief | 1 |
| cc-monopoly-go | other | 9 |
| cc-monopoly-go | agent | 5 |
| cc-monopoly-go | orca | 3 |
| cc-monopoly-go | art | 1 |
