# M5 — template và các project đang có: báo cáo

Ngày: 2026-10-02 · Branch `feat/coordinator-token-opt` (cả `~/.agents` lẫn repo template `cc-game-template`) · Review độc lập: §4.

## 1. Thay đổi

| Repo / file | Nội dung |
|---|---|
| template `AGENT_NOTES.md` (`release:`) | `producer_mode: llm` (mặc định; đổi sang `runner` để bật runner) và `judge_agent: claude --model sonnet` (chỉ dùng ở runner mode; để trống thì mọi câu hỏi tới director). Đã kiểm: yaml parse được bằng lib của game-brief, runner đọc ra judge `sonnet` |
| template `.gitignore` | `/.cursor/producer*`: phủ lock, control, runner file, prompt handoff và file `.tmp` / `.dead` sót lại khi crash. Các file hook (M2) và `opencode.json` (M1a) đã có từ trước. `git check-ignore` xác nhận; template không track file nào khớp pattern, và `.cursor/skills/game-producer` không bị ảnh hưởng |
| `skills/new-cocos-game/scripts/bootstrap.mjs` | `RSYNC_EXCLUDES` thêm `/.cursor/producer*`. Hook và MCP pin đã có từ M1/M2 |
| `skills/new-cocos-game/tests/rsync-excludes.test.mjs` | Test mới chạy `rsync` thật với đúng danh sách exclude: 13 file per-checkout / per-run bị bỏ lại; 7 file cùng tên ở chỗ khác vẫn được chép (pattern có anchor, kể cả ca âm của glob). new-cocos-game: 21/21 |
| `skills/game-producer/scripts/lib/state.mjs` | `ensureExcluded` ghi `/<prefix>.cursor/producer*` vào `.git/info/exclude` (có prefix khi project không nằm ở gốc repo). Chạy ở lần ghi control file hoặc runner file đầu tiên của mỗi tiến trình, nên `stop`, `stop-after`, `answer`… trên project cũ cũng không để lại file untracked. Dry-run và `status` vẫn không ghi gì (đã kiểm lại trên lego-stack và tiki-smash) |

**Mục 3 của PLAN M5** (runner chạy được khi thiếu các key) đã có từ M4:
- thiếu `producer_mode` → coi là `llm`: runner chỉ chỉ dẫn Step 3, không spawn LLM;
- thiếu `judge_agent` → không có judge;
- từ lần ghi đầu tiên của runner (bất kỳ lệnh nào), các file của runner tự được thêm vào `.git/info/exclude` của checkout. Hook M2 cũng tự exclude khi spawn.

Vì vậy project cũ không bắt buộc phải sửa `.gitignore`.

## 2. Không sửa

- **`AGENT_NOTES.md` của project đang có:** bật runner cho project nào là việc director tự thêm `producer_mode: runner` (và `judge_agent` nếu muốn).
- **`cc4-game-template` và `cc-playable-template`:** cả hai đang có thay đổi chưa commit của việc khác (26 file trên `main`, và 19 file trên branch `chore/lowercase-assets-and-skills-sync`), nên không đụng tới. Cả hai đã dùng symlink cho `game-producer`. Khi rảnh, cần đồng bộ tay, và không chỉ M5:
  - `cc4-game-template/.gitignore` thiếu `/opencode.json` và 4 dòng hook (M1a/M2);
  - `cc-playable-template/.gitignore` chưa có dòng MCP nào;
  - `release:` của cả hai thiếu `budget_auto_bump_pct` và `fleet_lite_when_no_assets`, ngoài 2 key mới.

## 3. Project cũ cần sync tay (sau khi merge)

**Skill dùng symlink:** `game-producer` và `cocos-orca-fleet` là symlink tới `~/.agents` trong 7 project producer: lego-stack, block-out, block-out-color-sort-puzzle, tiki-smash, monopoly-go, meowdoku, flick-shot. Các project này tự nhận M2–M4 khi merge. `new-cocos-game` không có trong `.cursor/skills` của project nào.

**Skill dùng bản copy**, nên không nhận M2/M3 nếu không sync tay:
- **cc-bus-fever-party:** copy cả `game-producer` lẫn `cocos-orca-fleet`;
- **6 project chỉ có fleet:** copy `cocos-orca-fleet` và không có `game-producer`, gồm cc-arrow-puzzle, cc-block-blast, cc-jelly-busters, cc-nitelore, cc-taxi-pizza, cc4-playground.

Các file template sau là bản copy ở mọi project có chúng (một số project không có `cocos-orca-worktree` hoặc `vibe-game-director`):

| File | Đổi gì (milestone) | Cần cho |
|---|---|---|
| `.cursor/rules/00-guardrails.mdc` | Mục 8: không sửa config MCP global, không bấm "Configure client" (M1a) | Mọi project |
| `.cursor/skills/cocos-orca-worktree/SKILL.md` | MCP chỉ lấy từ `bootstrap.mjs mcp-config`, liệt kê `opencode.json`, nhắc `mcp-audit` (M1a) | Project có skill này (8 project producer đều là bản copy) |
| `.cursor/skills/vibe-game-director/reference/cocos-mcp-playbook.md` | `opencode.json` và cảnh báo "Configure client" (M1a) | Project có skill này |
| `scripts/open-editor.sh` | Thiếu `opencode.json` thì chạy `mcp-config` (M1a) | Project có dùng OpenCode |
| `.gitignore` | Hook (M2) và state của runner (M5) | Không bắt buộc (đã tự exclude) |
| `AGENT_NOTES.md` `release:` | `producer_mode`, `judge_agent` (M5) | Chỉ project muốn bật runner |
| cc-bus-fever-party: `.cursor/skills/game-producer/`, `.cursor/skills/cocos-orca-fleet/` | Toàn bộ M2–M4 (orca-wait, guard, cheatsheet, runner) | Chỉ khi bật runner hoặc guard ở project này; hoặc đổi sang symlink |
| cc-arrow-puzzle, cc-block-blast, cc-jelly-busters, cc-nitelore, cc-taxi-pizza, cc4-playground: `.cursor/skills/cocos-orca-fleet/` | M2/M3 (orca-wait, cheatsheet, protocol floor) | Khi chạy fleet ở các project này; hoặc đổi sang symlink |

## 4. Review độc lập

**APPROVED**, kèm các chỗ sửa đã làm trong cùng commit:
- báo cáo nói sai về `new-cocos-game` và về danh sách bản copy;
- auto-exclude trước đây chỉ chạy khi `start`;
- comment `judge_agent` ghi chưa đúng hành vi;
- file `.tmp` / `.dead` sót lại khi crash chưa được ignore;
- việc sync hai template kia nhiều hơn mô tả cũ;
- test rsync thiếu ca âm cho glob.

## 5. Tiếp theo: pilot (PLAN §7)

**Chưa có milestone nào chạy trên project thật.** Pilot cần director chọn project và slice. Theo §5, project được chọn phải không có producer hay fleet đang chạy. Tình trạng hiện tại (dry-run):

| Project | Runner sẽ làm |
|---|---|
| cc-lego-stack | Hỏi `agent_conflict`: policy khoá reviewer `codex:gpt-6.1-sol`, yaml ghi `claude --model opus`. Producer và coordinator codex còn sống từ trước, cần kiểm lại |
| cc-block-out | Dừng: S21 đang chạy nhưng không có trong MILESTONES |
| cc-tiki-smash | Dừng: S03 và S05 cùng đang chạy |
| cc-monopoly-go, cc-meowdoku, cc-bus-fever-party, cc-flick-shot | Done (không còn slice để chạy) |

Đề xuất thứ tự:
1. Đo baseline mới bằng `tools/token-report` cho project được chọn.
2. Bật M1 (`--role`) + M3 (cheatsheet), không cần cấu hình gì thêm.
3. Bật guard M2 ở chế độ `shadow` cho 1 slice, rồi `block` cho 1 slice.
4. Đặt `producer_mode: runner` cho 1–2 slice S/M, rồi 1 slice L.

Mỗi bước ghi kết quả vào `results.md`.
