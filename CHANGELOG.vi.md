# Nhật ký thay đổi

Những gì thay đổi qua từng bản phát hành của protunel, viết cho người dùng.
Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/), số
phiên bản theo [Semantic Versioning](https://semver.org/lang/vi/). Bản tiếng
Anh: [CHANGELOG.md](CHANGELOG.md). Các bản trước 0.10.0 xem ở
[trang release trên GitHub](https://github.com/vrykolakas166/protunel/releases).

## [Unreleased]

### Cải thiện
- **Ctrl+T** ở cửa sổ chính mở terminal và ẩn cửa sổ chính, chỉ một bước.
- Nhấp chuột phải vào máy chủ ở thanh bên của terminal, hoặc vào khung shell, rồi chọn **Sửa máy chủ…** để sửa ngay, không cần quay lại cửa sổ chính. Đổi thông tin kết nối của máy chủ đang dùng sẽ kết nối lại các shell của nó.
- Thanh máy chủ bên trái của terminal **đổi được độ rộng**: kéo cạnh phải (nhấp đúp để về độ rộng mặc định).

## [0.10.0] - 2026-11-24

### Điểm nổi bật

#### Tệp của máy chủ bạn đang mở
- **Bảng tệp cho từng shell**: biểu tượng thư mục trên đầu khung (hoặc **Ctrl+Shift+O**) mở tệp của máy chủ đó qua SFTP, dùng chung kết nối của shell. Bảng mở ngay thư mục hiện tại của shell khi prompt hoặc shell cho biết.
- Bảng nổi, vẫn gõ shell bình thường khi đang mở: kéo đi đâu cũng được hoặc để nó **bám vào góc** khung, đổi kích thước từ mọi cạnh, **phóng to** bằng nhấp đúp lên tiêu đề. Mỗi shell một bảng, tiêu đề luôn ghi `user@host`.
- Duyệt, tạo, đổi tên, xóa (đếm trước những gì sẽ mất; xóa nhiều thì phải gõ tên để xác nhận), sao chép, cắt và dán, thuộc tính, lọc.
- **Sửa tệp văn bản** tới 2 MB ngay tại chỗ (Ctrl+S; nếu ai đó đã sửa tệp trong lúc đó, bạn sẽ được hỏi trước), xem phần cuối của log lớn, xem trước ảnh.
- **Tải lên** bằng cách thả tệp hoặc thư mục vào bảng, **tải về** thư mục Downloads, hoặc **Tải về thư mục…** (mũi tên cạnh nút Tải về), nhớ nơi bạn lưu lần trước. Không ghi đè gì mà không hỏi; việc truyền tệp vẫn chạy khi đóng bảng.

#### Sao chép giữa các máy chủ
- **Kéo hàng** từ bảng này sang bảng khác, hoặc thả vào một thư mục. Cùng máy chủ thì thả là di chuyển (giữ **Ctrl** để sao chép); sang máy chủ khác thì luôn là sao chép. **Sao chép** ở một bảng rồi **Dán** ở bảng khác cũng được.
- Khi máy chủ A đăng nhập được vào máy chủ B bằng khóa, tệp đi **thẳng từ A sang B** (rsync, hoặc scp với một tệp), có kiểm tra theo khóa máy chủ đã tin cậy của B trong protunel. Nếu không, tệp đi qua máy này, và bảng đề nghị gõ sẵn `ssh-copy-id` vào shell của A (bạn tự nhấn Enter) để lần sau sao chép trực tiếp.

#### Kéo tệp ra Windows
- Trên Windows, kéo hàng ra khỏi cửa sổ thả vào Explorer, Desktop hoặc ứng dụng nào nhận tệp. Tải về bắt đầu khi thả, hiện trong hộp tiến trình của Explorer và hàng đợi của bảng, không giới hạn kích thước, hủy được từ cả hai phía mà không để lại tệp dở.

#### Nhóm
- Xếp máy chủ vào **nhóm**: danh sách tunnel và danh sách máy chủ của terminal hiện chúng thành từng mục. Đổi tên hoặc bỏ nhóm từ menu của mục; mở cả nhóm trong một tab chia đều. **Ctrl+nhấp** vào tiêu đề nhóm để thu gọn hoặc mở rộng tất cả các nhóm.
- **Nhập từ WinSCP** (Cài đặt › Sao lưu): chọn `WinSCP.ini`, xem trước, nhập. Thư mục thành nhóm, mật khẩu đã lưu đi thẳng vào kho mật khẩu của hệ thống, jump host được khớp hoặc tạo một lần. Khóa máy chủ không được nhập: bạn vẫn xác nhận từng máy chủ ở lần kết nối đầu như mọi khi.

### Cải tiến
- Đóng khung, tab hoặc cửa sổ terminal khi bảng tệp còn thay đổi chưa lưu giờ sẽ hỏi trước.
- Hướng dẫn nhanh giới thiệu thêm nhóm, nhập từ WinSCP và bảng tệp.
- Chữ tiếng Việt giờ dùng đúng phông của ứng dụng cho mọi chữ cái (trước đây chữ có dấu bị lấy phông hệ thống giữa chừng).
- Hộp chọn tệp, lỗi "không phải tệp cấu hình protunel" khi nhập và thông báo kết nối lại hiện theo ngôn ngữ của ứng dụng.
- Cài đặt, danh sách máy chủ đã tin cậy và các tệp khác của ứng dụng được ghi nguyên vẹn một lần, nên ứng dụng bị tắt ngang lúc đang lưu không còn làm hỏng tệp.

### Sửa lỗi
- Nhập cấu hình có jump host được nhập thành bản sao khiến các máy chủ đi qua nó vẫn trỏ về jump host gốc.
- Kết nối cùng một tunnel từ hai nơi cùng lúc (router, khay hệ thống, terminal) có thể khởi động nó hai lần.
- Lưu cài đặt từ cửa sổ chính và cửa sổ terminal gần như cùng lúc có thể làm mất một trong hai thay đổi.
- Một chế độ "Đơn giản / Đầy đủ" không hợp lệ trong tệp cài đặt hoặc cấu hình được nhập giờ bị bỏ qua thay vì làm hỏng lựa chọn chế độ.
- Cập nhật thư viện SSH theo một cảnh báo bảo mật (RUSTSEC-2026-0492).
