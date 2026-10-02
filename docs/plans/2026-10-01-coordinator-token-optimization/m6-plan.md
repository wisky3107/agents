# M6 — sau pilot 1: trả lời dễ hơn, hoãn manual, sửa các lần dừng nhầm

Ngày: 2026-10-02 · Branch `feat/coordinator-token-opt` · Director chọn cả ba nhóm (A, B, C).

Pilot 1 (S08) dừng 7 lần, nhưng chỉ 3 lần là quyết định thật. Ngoài ra, director thấy việc
trả lời bằng `answer --id --choice` là khó.

## A. Ba cách trả lời, cùng một đường ghi

Cả ba cách đều đi qua `lib/answer.mjs`, nên giữ được các đảm bảo cũ:
- `st.answer` từ chối câu đã có trả lời;
- runner áp dụng mỗi câu trả lời đúng một lần.

`lib/answer.mjs` gồm:
- `textNeed(q, choice)`: ghi chú là `required`, `optional` (gate: ghi chú được chuyển cho coordinator) hay không cần;
- `parseReply(q, line)`: nhận `2` hoặc `2 ghi chú`;
- `menu(q)`: in câu hỏi kèm lựa chọn đánh số;
- `submit(root, id, choice, text, by)`: kiểm tra rồi ghi câu trả lời.

1. **Terminal của runner.** Khi chờ một câu hỏi, runner in menu ra stderr (stdout vẫn là các dòng JSON).
   - Gõ số rồi Enter; chọn lựa chọn bắt buộc có ghi chú thì runner hỏi thêm ghi chú.
   - Chỉ bật khi stdin là TTY, hoặc khi đặt `PRODUCER_RUNNER_TTY=1` (cho test).
   - Dòng nào tới trong 500 ms đầu sau khi menu hiện thì bị bỏ, để chữ gõ sẵn từ trước không thành câu trả lời cho câu hỏi mới.
   - Vì vậy `waitForAnswer` chuyển sang async (`setTimeout` thay cho `Atomics.wait`), để sự kiện stdin chạy được.
2. **Hộp thoại macOS.** `scripts/answer-dialog.mjs --project --id`, được `notify()` spawn tách rời, một lần cho mỗi câu hỏi.
   - Dùng `choose from list`; gate và các lựa chọn cần ghi chú có thêm `display dialog` để nhập ghi chú.
   - Nếu câu hỏi được trả lời bằng cách khác thì helper tắt osascript rồi thoát.
   - Chạy khi `PRODUCER_RUNNER_DIALOG` khác `0` và có một trong hai: darwin không có `NOTIFY_CMD`, hoặc `PRODUCER_RUNNER_OSASCRIPT` (fake trong test).
   - Harness đặt `PRODUCER_RUNNER_DIALOG=0`.
3. **`answer` có menu.** Chạy không có `--choice` trên một TTY thì hiện menu: chọn câu hỏi (nếu có nhiều), rồi chọn lựa chọn.

## B. `release.manual_required: defer`

Mặc định là `ask`; token `manual_required=` trên dòng policy cũng được đọc.
- Step 2d: nếu `manual_required` là vấn đề *duy nhất* (review APPROVED, có `runtime-state.json`, đủ file evidence), runner không hỏi:
  - ghi `<evidence>/manual-deferred.json` (`items` lấy từ trường `manual_required` của runtime-state và HANDOFF);
  - commit và merge như thường;
  - dòng Notes ghi `manual_deferred=<n>`.
- `status` liệt kê các việc đã hoãn. Prompt Step 3 trình danh sách cho director trước khi build/deploy.
- Thứ tự câu hỏi khi có nhiều vấn đề giữ nguyên như cũ.

## C. Các lần dừng nhầm của pilot 1

1. **q7: file review.** Verdict được đọc từ file review mới nhất (`review.md` hoặc `review-r<N>.md`, xét theo mtime). Áp dụng ở accept, review phase của single lane, judge và budget_bump.
2. **q3: báo nhầm coordinator mất.** Khi orca-wait báo `terminal-missing`, runner kiểm lại bằng `orca terminal show`:
   - còn sống: log lại rồi chờ tiếp; nếu orca-wait vẫn báo như vậy 5 lần liên tiếp thì mới hỏi;
   - không trả lời được: đi đường `orca_error`.
3. **q6: gate trùng.**
   - Câu hỏi gate liệt kê mọi gate đang chờ. Tin chuyển cho coordinator nhắc tên các gate còn lại và bảo coordinator áp dụng quyết định cho gate nào hỏi cùng một việc.
   - Sau khi chuyển một quyết định, runner chờ `GATE_SETTLE` lần nghỉ rồi mới hỏi gate khác.
4. **Worktree giữ lại vì "dirty".** Nếu thay đổi chỉ nằm trong `.c‍ursor/evidence/tasks/T-<Sxx>/` và bước evidence đã chép sang main, runner chạy `orca worktree rm --force`. Fleet luôn ghi lại `HANDOFF.json` (là file tracked) sau khi commit, nên trước đây mọi worktree fleet đều bị giữ lại.
5. **Commit ngoài runner.** Câu commit của fleet là `approved — commit (producer: Step 2d passed)`, dùng chung cho runner và producer LLM (SKILL Step 2d.1). Prompt fleet:
   - chỉ commit khi nhận đúng dòng đó;
   - không mời director gõ lệnh commit;
   - trước `offer_commit` phải có `review.md` là verdict cuối (kết thúc APPROVED; quyết định gate được ghi vào đó) và `runtime-state.json`.

   Coordinator cũ vẫn commit được, vì câu mới vẫn bắt đầu bằng `approved — commit`.

## Sau review vòng 1 (CHANGES_REQUESTED: 2 major, 8 minor)

- **Câu commit:** đổi thành câu chung cho cả hai chế độ. Câu cũ nhắc đến runner, nên producer LLM gửi `approved — commit` trần thì coordinator không commit.
- **`rm --force`:** chỉ chạy khi mọi file đổi là file mà bước chép mang theo (không PNG, không file của runner). Trước *mọi* lần xoá worktree, evidence được chép lại sang main.
- **Khoá file runner:** mọi lần đọc rồi ghi `producer-runner.json` đi qua khoá `mkdir` (`.c‍ursor/producer-runner.json.lock`). Câu trả lời được kiểm lại khi đang giữ khoá.
- **`verdict_override`:** `review.md` cuối biến CHANGES_REQUESTED của round cuối thành APPROVED thì phải nêu một gate mà runner đã chuyển quyết định.
- **Thứ tự round review:** round xếp theo số N, mtime chỉ dùng để so `review.md` với round cuối.
- **Terminal đã đóng:** `orphaned` hoặc `connected: false` được coi là đã mất.
- **Hộp thoại:** tách khỏi `NOTIFY`; mở lại sau restart nếu helper đã chết; đóng khi runner stop.
- **Thông báo:** gửi trước rồi mới đánh dấu `notified`, nên runner bị kill giữa chừng sẽ báo trùng chứ không bỏ sót.

## D. Tài liệu và test

- **Tài liệu:**
  - SKILL Runner mode: cách trả lời, `manual_required: defer`;
  - Step 2d;
  - fleet SKILL bước 6;
  - prompt Step 3.
- **Test:** `tests/runner-m6.test.mjs`, kèm sửa các test cũ thay đổi theo (câu commit của fleet, coordinator_missing cần `dead`).
- **Kiểm thật**, không ghi gì vào project:
  - dry-run trên lego-stack;
  - kiểm cú pháp `osacompile` cho AppleScript.
