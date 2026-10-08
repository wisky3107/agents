# {{GAME}} — Dựng từng view từ Figma (Orca browser)

## Figma của game

| | |
| --- | --- |
| File | **{{FILE}}** |
| URL | <{{URL}}> |
| File key | `{{FILE_KEY}}` |
| Frame gốc | `{{ROOT}}` |
| Design resolution | {{RES}} |
| Map view → node | [`tools/figma/views.json`](tools/figma/views.json) |

Tên layer trong file dùng kiểu `name-name` và trùng với tên file asset. Hãy dùng đúng tên này cho node trong Cocos. Nếu file đã được đổi tên, bản backup tên cũ nằm ở `assets/reference/figma-names-backup.json`.

## Cách hoạt động

Trang Figma web có sẵn **Plugin API** (biến toàn cục `figma`). Orca browser chạy được JS trong trang qua `orca eval`. Vì vậy công cụ **không cần Figma token hay plugin**, chỉ dùng phiên đăng nhập Figma trong tab Orca. Nó đọc được cây layer, toạ độ, màu, font, text, và export PNG/JPG của bất kỳ node nào, kể cả bitmap gốc.

**Điều kiện:** Orca đang chạy (`orca status --json`), và đã đăng nhập Figma trong Orca browser bằng tài khoản có quyền xem file. Lệnh nào cũng tự tìm tab theo file key. Không có tab thì nó tự mở tab mới và chờ tới khi `figma` sẵn sàng.

## CLI: `tools/figma/figma.mjs`

Chạy từ thư mục game (`reference/<slug>/` trong project, hoặc `orca-global/games/<slug>/`):

```bash
node tools/figma/figma.mjs views                                  # danh sách view key → node id
node tools/figma/figma.mjs tree <view> 3                          # cây layer, sâu 3 cấp
node tools/figma/figma.mjs layout <view> --out /tmp/<view>.json   # layout JSON của 1 view
node tools/figma/figma.mjs layout-all                             # ghi lại data/layout/<view>.json cho mọi view
node tools/figma/figma.mjs shot <view> /tmp/<view>.jpg --scale 0.5           # mockup để so sánh
node tools/figma/figma.mjs export <nodeId> /tmp/<name>.png                   # export 1 node @1x
node tools/figma/figma.mjs export <nodeId> /tmp/<name>.png --hide-text       # bỏ chữ (nút, pill)
node tools/figma/figma.mjs export <nodeId> /tmp/<name>.png --unclip          # không bị khung màn cắt
node tools/figma/figma.mjs export <nodeId> /tmp/<name>.png --raw             # bitmap gốc theo imageHash
```

Tham số view: dùng **view key** trong `views.json` hoặc **node id** (`1:1650`; trên URL Figma viết là `node-id=1-1650`). Cách lấy node id của một layer: chọn layer trong Figma → Copy link → lấy phần `node-id=` rồi đổi `-` thành `:`.

`--hide-text` và `--unclip` chỉ đổi tạm trạng thái node lúc export, export xong sẽ khôi phục. Công cụ **không** sửa nội dung thiết kế.

### Views

{{VIEWS}}

## Layout JSON (`data/layout/<view>.json`)

| Trường | Ý nghĩa |
| --- | --- |
| `name`, `id`, `type`, `visible` | Tên layer (dùng làm tên node Cocos), node id, loại Figma |
| `size` | Kích thước khung, dùng cho `UITransform.contentSize` |
| `cc` | **Vị trí Cocos** = tâm node so với tâm parent (anchor 0.5, trục y hướng lên). Dùng thẳng cho `node.position` khi giữ đúng cây cha-con như Figma |
| `ccScreen` | Tâm node so với tâm màn. Dùng khi đặt node làm con trực tiếp của Canvas |
| `figma` | Góc trái-trên so với màn, theo hệ toạ độ Figma (y hướng xuống) |
| `spriteSize`, `spriteCcScreen` | Kích thước và tâm theo **render bounds** (gồm shadow/glow), khớp ảnh PNG đã export. **Đặt Sprite theo 2 trường này** |
| `asset` | File asset tương ứng trong `assets/` (map theo node id/tên từ `assets/manifest.json`) |
| `fills`, `strokes`, `effects`, `radius`, `opacity`, `rotation` | Màu solid/gradient, viền, shadow, bo góc |
| `text` | `characters`, `font`, `size`, `align`, `valign`, `lineHeight`, `letterSpacing` |
| `texts`, `component` | Text bên trong instance của thư viện (label của nút, badge, …) |
| `autoLayout` | Auto-layout Figma (hướng, spacing, padding), dùng để chọn `Layout` trong Cocos |

Công thức: `cc.x = (box.x + w/2) − (parent.x + parentW/2)`, `cc.y = (parent.y + parentH/2) − (box.y + h/2)`.

## Quy trình dựng 1 view

1. **Mockup:** `assets/reference/screens/<view>.jpg`, hoặc chạy `shot`. Đọc mô tả luồng, nút và logic của màn trong `GAME_BRIEF.md`, và note gốc trong `FIGMA_NOTES.md`.
2. **Cấu trúc:** `tree <view> 3`. Mỗi khối lớn (`part-*` trong views) thành một prefab.
3. **Layout:** `data/layout/<view>.json`.
4. **Dựng node** ở design resolution {{RES}}. Giữ đúng tên layer và thứ tự (con đầu tiên vẽ dưới cùng):

   | Loại Figma | Node Cocos |
   | --- | --- |
   | FRAME / GROUP không có `asset` | Node rỗng + `UITransform(size)`, `position = cc` |
   | Node có `asset` | `Sprite` (`sizeMode = CUSTOM`, size = `spriteSize`), đặt theo `spriteCcScreen` hoặc tính lại so với parent. Asset 9-slice (xem ASSET_MANIFEST) thì đặt border và `type = SLICED` |
   | TEXT | `Label`: font theo `text.font` (file trong `assets/fonts/`), `fontSize`, `color = fills[0].color`, align; `overflow = SHRINK` cho text động |
   | INSTANCE nút | `Button` + Sprite nền (ảnh đã bỏ chữ) + Label từ `texts[0]` |

5. **Widget:** header neo trên, hàng nút và dock neo dưới, background neo giữa, overlay popup Widget 4 cạnh.
6. **Bind data:** text số liệu trên mockup (số dư, %, tên) là placeholder. Lấy từ config hoặc API, không hard-code.
7. **So với mockup:** chụp preview cùng resolution, chồng lên ảnh `shot` với độ mờ 50%, sửa sai lệch lớn hơn 2–3 px.
8. **Thiếu asset:** `export <nodeId> assets/<dir>/<name>.png [--hide-text] [--unclip]`, đặt tên theo layer, rồi thêm vào `ASSET_MANIFEST.md`.

## Lưu ý

- `browserPageId` đổi khi tab đóng/mở lại. CLI tự tìm lại theo URL, đừng lưu cứng.
- "Figma tab not ready": tab đang ở màn login, hoặc file chưa load xong. Đăng nhập trong Orca browser rồi chạy lại.
- Export mặc định bị khung màn cắt (clip). Background và props sát mép phải dùng `--unclip`.
- Layer bên trong component của thư viện ngoài không đổi tên. Text của chúng nằm trong `texts` của layout.
- **Không sửa thiết kế trong Figma.** Cần đổi UI thì ghi vào `GAME_BRIEF.md` hoặc hỏi designer.

<!-- game-specific -->
