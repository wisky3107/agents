# S0 — Baseline scorecard

Ngày: 2026-10-02 · Tool: `~/.agents/tools/workflow-scorecard` · Báo cáo đầy đủ: `s0-baseline-report.md`.
Phạm vi: cc-block-out, cc-lego-stack (pilot), cc-meowdoku, cc-monopoly-go. OmniRoute 2026-09-25 → 2026-10-02.

S0 đã xong và không sửa skill hay template nào. Job hằng ngày đã cài: launchd `com.agents.workflow-scorecard`, chạy 09:17, lần chạy thử exit 0.

## Kết luận theo hạng mục

| # | Hạng mục | Baseline đọc được | Tín hiệu |
|---|---|---|---|
| 1 | Điều phối (Orca) | Stalled + failed thật: block-out 13/168 (8%), meowdoku 4/44, monopoly 11/172, lego-stack 0/36. Lỗi chính ở block-out là 8 lần `agent_prompt_stalled` | Orca ghi `failed` cho 4 kết cục khác nhau (review từ chối, stalled, bị thay thế, blocked chờ người). Con số "19%" ở §4.1 của PLAN là sai vì gộp chung |
| 2 | Gateway | Lỗi: claude 547/32.936, codex 306/13.185, agy 32/864 (~4%, chủ yếu `forbidden`). p95 thời gian ≤30s. Cache read: claude 96%, codex 93% | Lỗi codex chủ yếu là `quota_exhausted` (247). Claude có 444 lỗi HTTP 400 chưa rõ nguyên nhân, đáng điều tra. Chỉ nối được ~40% call claude về session; codex/agy/deepseek không nối được (body không mang session id) |
| 3 | Agent theo vai trò | Qua review không cần fix: block-out 6/19, meowdoku 3/7, monopoly 2/6, lego-stack S01 0/1 (7 fix rounds, 2 review INFRA_BLOCKED). Ở monopoly, fleet-orch tốn 413M context so với 552M của worker | Mỗi project khóa một reviewer khác nhau (claude opus, claude sonnet, codex sol-low, claude opus medium), nên thí nghiệm S3 đã có sẵn các nhánh. Chi phí coordinator cao, khớp với plan token-opt |
| 4 | Engine/MCP | Có 4 sự cố engine ở block-out, rút từ lessons | Chưa đo được thời gian gate hay số lần thử lại: cần `infra-log` (S1) |
| 5 | Đầu vào & hợp đồng | Budget block-out: median ×2,34, max ×4,30 trên 8 slice. `contract:Fable change_budget counting note` lặp ở 6 slice liên tiếp (S13–S18). EXPECT block-out: chỉ 4/38 dòng có tag. Gần như không dòng EXPECT nào dẫn số đo của video-probe | Tín hiệu mạnh nhất trong dữ liệu: lỗi calibrate đã được ghi lại nhưng vẫn lặp 6 lần. Hiện không thể đánh giá giá trị của video-probe vì hợp đồng không ghi nguồn số đo |
| 6 | Art | Monopoly: VERDICT qua lần đầu 27/33 (7 FAIL), CONCEPT 11/11. Lego-stack: 5/5 | Chưa có backend, credits hay phút/asset: cần `art-gates.json` (S1) |
| 7 | Ship | Không có dữ liệu | Cần `ship-log` (S1) |
| 8 | Học/memory | 57/57 recipe vẫn `candidate`. 49 bản ghi học ở 3 project, chỉ 2 `recipe_reuse`. Hook memory: 10 lần gọi, 0 lần inject | Phễu tắc ở bước curator; dữ liệu tái dùng quá mỏng để kết luận |
| 9 | TypeSafe | Không project nào bật | — |

## Chất lượng dữ liệu (lý do cần S1)

- **`fix_rounds` của 65 slice:**
  - 12 slice lấy từ `stats.json`.
  - 21 slice lấy từ dòng notes trong AGENT_NOTES.
  - 32 slice không có số.
- **`review.md` thường bị ghi đè qua từng vòng.** Verdict "vòng đầu" chỉ tin được khi có `fix_rounds`.
- **`lessons.jsonl` mỗi project một kiểu:**
  - Ở monopoly, 9/18 dòng cost có `cause` là câu tóm tắt ("0 fix rounds, approved round 1…"), nên không quy được về hệ thống nào.
  - Ở block-out, dòng học dùng `kind`, còn dòng cost dùng `event`.
- **Body của OmniRoute chỉ giữ ~3 ngày.** Từ nay snapshot hằng ngày giữ lại phần nối session. Phần đã mất trước 2026-09-30 không lấy lại được.

## Đề xuất cho bước tiếp

1. **S1 theo đúng §4.0 của PLAN**, ưu tiên ba việc:
   - `origin_slice` và `system` trong lessons.
   - Block `metrics` trong `stats.json` (luôn ghi `fix_rounds`).
   - Tag nguồn số đo trên dòng EXPECT.
2. **Làm ngay, không cần chờ S1:**
   - Sửa hướng dẫn calibrate `change_budget` (lỗi lặp 6 slice).
   - Xem lại 444 lỗi HTTP 400 của claude qua OmniRoute.
3. **Quyết định mở #5 (nối codex):** dùng API key riêng cho codex hoặc header session, vì hiện codex không nối được về project.
