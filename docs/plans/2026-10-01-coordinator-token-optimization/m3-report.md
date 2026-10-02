# M3 — cheatsheet `orca` thay `--help` và guide full: báo cáo

Ngày: 2026-10-02 · Branch `feat/coordinator-token-opt` · Self-review: có · Review độc lập: xem §5.

## 1. Thay đổi

| File | Nội dung |
|---|---|
| `skills/cocos-orca-fleet/scripts/gen-orca-cheatsheet.mjs` | Sinh cheatsheet từ `orca agent-context --json` (schema của 239 lệnh): signature, các dòng giải thích trong usage, notes (bỏ note chỉ dành cho Windows/PowerShell), 1 ví dụ. Header ghi version Orca. `--check` thoát 1 kèm một dòng hướng dẫn khi version lệch hoặc thiếu file. `--coverage` liệt kê lệnh `orca …` mà skill pipeline nhắc tới nhưng chưa có trong cheatsheet |
| `skills/cocos-orca-fleet/reference/orca/` | 4 file sinh tự động: `cheatsheet.md` (coordinator, 23,2KB, gồm cả `worker-retain/stop/abandon`), `cheatsheet-producer.md` (7,6KB), `cheatsheet-worker.md` (4,1KB), `cheatsheet-browser.md` (6,6KB). Bỏ note chỉ dành cho Windows; file coordinator/producer bỏ thêm note về host từ xa/SSH; file worker bỏ note về group address |
| `skills/cocos-orca-fleet/tests/gen-orca-cheatsheet.test.mjs` | 3 test với `orca` giả trong PATH: nội dung, stamp và `--check`, không có orca / orca thiếu agent-context / flag sai |
| `cocos-orca-fleet/SKILL.md` | Precondition 1: chạy `--check` rồi đọc cheatsheet thay vì `orca skills get orchestration --full`. Mục mới **Orca protocol floor** (sau Coordinator loop): các luật của guide bản ngắn mà skill chưa có — `worker-start` lỗi thì không launch lại; kiểm `worker_done` theo Dispatch; `worker-list --include-remote` sau 3 lần chờ rỗng; chỉ stop/abandon/retry/release khi có bằng chứng; sau mỗi settlement làm đúng một việc; kết thúc khi `worker-list --terminal-state reclaimable` rỗng; bảng action gate → `--reference` |
| `store-game-clone/reference/fleet-orchestrator-prompt.md`, `new-cocos-game/SKILL.md` (prompt fleet) | Bỏ yêu cầu đọc guide full; trỏ tới cheatsheet |
| `game-producer/SKILL.md` (Resources) | Một dòng trỏ tới `cheatsheet-producer.md` |
| `cocos-orca-fleet/reference/worker-prompts.md` (header chung) | Một dòng trỏ tới `cheatsheet-worker.md` / `cheatsheet-browser.md`. Header này cấm worker mở `reference/*.md` không được nêu tên, nên phải nêu tên file |
| `game-producer/reference/single-slice-prompt.md` (reviewer bước 2) | Một dòng trỏ tới `cheatsheet-browser.md` |

**Khác với plan:**
- **Nguồn dữ liệu:** dùng `agent-context --json` thay vì parse `--help`. Cùng thông tin, nhưng không phụ thuộc định dạng text.
- **Chia theo vai trò:** một file cho mỗi vai trò. Một file chung sẽ nặng 25KB, nghĩa là worker phải đọc 25KB trong khi chỉ cần khoảng 4KB, có thể còn đắt hơn vài lần `--help`.
- **Chỗ đặt:** đặt trong `cocos-orca-fleet` chứ không trong `orca-cli`, vì `orca-cli` nằm trong `~/.agents/.skill-lock.json` (do skills CLI quản lý).
- **Thêm nhóm browser:** M0 cho thấy reviewer gọi `--help` nhiều nhất cho lệnh browser (`screenshot` 65 lần, `eval` 36, `tab` 27…).
- **Lệnh chỉ dùng khi recovery** (`request-show`, `worker-stop/abandon/retain`) không đưa vào; khi recovery, coordinator đọc guide `--full`.

## 2. Ước lượng tác động (chưa đo, chờ pilot)

| Vai trò | Trước (M0, 09-24 → 10-01) | Sau |
|---|---|---|
| Fleet coordinator | Đọc guide `--full` (42,5KB ≈ 11k token, nằm lại trong context mọi lượt sau) 31 lần/tuần; 365 lần `--help` | Đọc `cheatsheet.md` 23,2KB ≈ 5,8k token, một lần; protocol floor (~2,5KB) nằm trong skill; một reference (2,7–9,5KB) khi gặp action gate |
| Producer | 89 lần `--help`, 9 lần đọc guide `--full` | `cheatsheet-producer.md` 7,6KB |
| Worker | 398 lần `--help` | `cheatsheet-worker.md` 4,1KB, `cheatsheet-browser.md` 6,6KB khi dùng browser |

## 3. Nghiệm thu

| Tiêu chí (PLAN M3) | Kết quả |
|---|---|
| Cheatsheet sinh lại được, không cần sửa tay | ✅ `gen-orca-cheatsheet.mjs` sinh lại cả 4 file; `--check` báo mới; `--coverage` không còn lệnh thiếu |
| Sau 1 slice, số `--help` ≤ 5 | ⏳ chờ pilot |
| Coordinator không còn đọc guide full khi version khớp | ⏳ chờ pilot (chỗ yêu cầu đọc đã được gỡ khỏi skill) |
| Cảnh báo "cheatsheet stale" trong `orca-wait` / runner | ⏳ M2/M4 gọi `gen-orca-cheatsheet.mjs --check` |

## 4. Rủi ro cần theo dõi ở pilot

- **Lỗi giao thức sau khi bỏ guide.** Coordinator không còn đọc guide ở đầu phiên. Các luật của guide bản ngắn đã được chép vào "Orca protocol floor" của skill (theo orca 1.4.218); khi Orca đổi bản, phải đối chiếu lại khối này. Pilot cần theo dõi lỗi ack, release, gate; nếu có, đổi lại thành bắt buộc đọc guide bản ngắn (13KB).
- **Project giữ bản copy của skill** (`cc-bus-fever-party` trong số project dùng producer) không nhận thay đổi này.
- **Cheatsheet cũ sau khi update Orca.** Agent phải tự chạy `--check`; M2 sẽ cho `orca-wait` chạy việc này ở lần gọi đầu.
- **Đụng nhau khi merge.** `cocos-orca-fleet/reference/worker-prompts.md` đang có thay đổi chưa commit của một session khác trong `~/.agents`.

## 5. Review độc lập

Vòng 1: CHANGES_REQUESTED, có hai lỗi lớn.

| Phát hiện | Mức | Xử lý |
|---|---|---|
| "Cheatsheet + guide khi cần" chưa an toàn: không có trigger mở guide; các luật chỉ có trong guide bản ngắn (`worker-start` lỗi không launch lại, `worker-list` sau 3 lần chờ rỗng, bằng chứng trước khi stop/release, kiểm `worker_done` theo Dispatch, kết thúc bằng `--terminal-state reclaimable`) mà skill không có | major | Chép thành "Orca protocol floor" trong skill; trỏ tới `--reference <file>` thay vì `--full`; thêm `worker-retain/stop/abandon` vào cheatsheet coordinator |
| Đường dẫn tương đối `reference/orca/cheatsheet.md` hỏng ở project giữ bản copy | major | Đổi thành đường dẫn tuyệt đối `~/.agents/skills/cocos-orca-fleet/reference/orca/…` ở mọi chỗ; ghi số project copy vào PLAN §3 |
| Không có orca → lỗi khó hiểu; orca thiếu agent-context → `--check` bảo regenerate trong khi regenerate cũng lỗi | minor | Báo "orca is not on PATH"; `--check` bảo dùng `--help` |
| Stamp chỉ lấy token đầu của version; ngày trong header gây thay đổi git mỗi lần sinh | minor | Stamp lấy cả chuỗi version, bỏ ngày |
| Flag sai vẫn sinh và ghi đè file; ghi không atomic; import thừa | minor | Flag lạ thì báo usage, exit 2; ghi atomic; bỏ import |
| Worker và reviewer được dặn tự regenerate | minor | Chỉ file coordinator/producer dặn regenerate; worker/browser dùng `--help` cho lệnh thiếu |
| Lọc chữ "PowerShell" làm mất note "Prefer --task-id … over raw --payload" | minor | Chỉ bỏ note mở đầu "On Windows" |
| Note không dùng được cho vai trò (remote/SSH, group address) | minor | Lọc theo vai trò |
| Header worker nêu file nhưng không nêu bước | minor | "Before your first `orca` call read …" |
| `orca worktree current` của template nằm ngoài phạm vi coverage | minor | Để nguyên (template script, không phải lane) |

Không chạy vòng review thứ hai. Phần sửa được phủ bằng test (3/3) và `--check` / `--coverage` trên Orca thật.
