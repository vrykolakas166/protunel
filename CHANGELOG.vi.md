# Nhật ký thay đổi

Những gì thay đổi qua từng bản phát hành của protunel, viết cho người dùng.
Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/), số
phiên bản theo [Semantic Versioning](https://semver.org/lang/vi/). Bản tiếng
Anh: [CHANGELOG.md](CHANGELOG.md). Các bản trước 0.10.0 xem ở
[trang release trên GitHub](https://github.com/vrykolakas166/protunel/releases).

## [Unreleased]

## [0.11.0] - 2026-11-26

### Cải thiện
- Terminal: khi chưa có tab nào, có thể kéo máy chủ từ thanh bên thả vào bất kỳ chỗ nào của vùng trống để mở. Bỏ nút + trên thanh tab (chỉ nhảy tới ô tìm máy chủ); Ctrl+Shift+K vẫn làm việc đó.
- **Tên đã có?** Khi tải lên hoặc sao chép giữa hai máy chủ, mọi tên đã có được liệt kê trong một bảng, mặc định **Bỏ qua**: chọn **Ghi đè** hoặc **Giữ cả hai** (lưu thành “tên (1)”) cho từng tên, hoặc đặt cho tất cả một lần. Dòng bị bỏ qua trong danh sách truyền cũng có nút Ghi đè và Giữ cả hai.
- **Truyền thư mục không dừng vì một tệp lỗi**: dòng truyền cho biết bao nhiêu tệp đã xong và liệt kê các tệp lỗi (có thể sao chép danh sách để đi sửa). Sửa nguyên nhân (kết nối lại shell nếu mất kết nối), rồi bấm **Thử lại** trên dòng đó, kể cả lượt đã hủy: tệp đã xong được giữ nguyên, phần còn lại được gửi lại tới đúng máy chủ cũ, tệp đang dở sẽ chép lại từ đầu. Nút truyền tệp của popup đếm số lượt lỗi cho tới khi bạn xóa chúng.
- Popup tệp có **Quay lại / Tiến tới** (Alt+← / Alt+→, qua các thư mục đã mở từ lúc mở popup) và nút **đánh dấu**: đánh dấu thư mục theo từng máy chủ (lưu cùng host, đi theo khi xuất cấu hình) và quay lại các thư mục gần đây của máy chủ, vẫn còn cả sau khi đã đóng cửa sổ terminal.
- **Ctrl+T** ở cửa sổ chính mở terminal và ẩn cửa sổ chính, chỉ một bước.
- Nhấp chuột phải vào máy chủ ở thanh bên của terminal, hoặc vào khung shell, rồi chọn **Sửa máy chủ…** để sửa ngay, không cần quay lại cửa sổ chính. Đổi thông tin kết nối của máy chủ đang dùng sẽ kết nối lại các shell của nó.
- **Thanh trạng thái** ở dưới cửa sổ chính: lưu lượng của mọi tunnel đang kết nối, và phiên bản hoặc bản cập nhật đang chờ.
- **Đóng xuống khay hệ thống** (Cài đặt › Chung, bật mặc định): tắt đi thì đóng cửa sổ chính là thoát protunel, có hỏi xác nhận trước.
- **Menu khay hệ thống** gọn lại khi có nhiều tunnel: tunnel đang chạy ở trên, rồi 5 tunnel dùng gần nhất, rồi **Tất cả tunnel** với mỗi nhóm một menu con. Thêm Mở terminal, công tắc Router và Ngắt tất cả.
- **Làm lại hướng dẫn**: ngắn hơn, theo đúng thứ tự thiết lập (thêm tunnel, đăng nhập, jump host, nhóm, port forward, rồi Router). Hướng dẫn terminal chỉ việc cần làm trước khi chưa mở shell nào, và mời xem phần khung và tệp khi shell đầu tiên đã mở.
- Chế độ Đơn giản nói rõ cần làm gì khi công tắc đang tắt; trên Linux nhắc ngay từ đầu bước cài đặt trình duyệt một lần.
- Thanh máy chủ bên trái của terminal **đổi được độ rộng**: kéo cạnh phải (nhấp đúp để về độ rộng mặc định).

### Sửa lỗi
- Bảng tệp: xóa, đổi tên, tạo tệp/thư mục và lưu chỉ thực hiện trên máy chủ mà bảng đang hiển thị; tên đang gõ để đổi bị bỏ khi chuyển sang thư mục khác; tệp không phải UTF-8 hợp lệ mở ở chế độ chỉ đọc thay vì bị hỏng khi lưu; tệp đang tải lên, sao chép hoặc lưu được giữ riêng tư cho tới khi xong; danh sách truyền vừa với bảng nhỏ; bổ sung các thông báo lỗi còn thiếu.
- Linux: ứng dụng không còn bị tắt đột ngột khi nhiều tunnel kết nối hoặc ngắt cùng lúc (ví dụ mở nhiều shell một lúc). Các mục bật/tắt trên khay hệ thống giờ hiện dấu ✓ trước tên.
- Danh sách truyền tệp và tiến độ trong popup tệp chỉ hiện các lượt truyền của máy chủ đó, và nút **Xóa mục đã xong** chỉ xóa các lượt đó; trước đây mọi popup đang mở đều hiện (và xóa) tất cả.
- Popup tệp ngừng thao tác trên tệp của máy chủ cũ khi host được sửa để trỏ tới máy chủ khác, và đề nghị tải lại trên máy chủ mới; các lượt truyền đã xếp hàng trước khi sửa không còn chạy trên máy chủ mới.
- Lưu tệp bị từ chối khi tệp đã bị người khác sửa kể cả khi kích thước và thời gian trông như cũ, hai editor trên cùng một tệp không còn ghi đè nhau, và tệp không thể thay an toàn sẽ hỏi trước khi ghi trực tiếp.
- Ghi đè, tải về và hủy an toàn hơn: ghi đè giữ tệp cũ cho đến khi tệp mới chép xong, tải về không chiếm tên vừa xuất hiện trong lúc tải, và hủy tải không để lại gì.
- Các popup cùng máy chủ tự làm mới cho nhau sau khi xóa, đổi tên, tạo mới hay dán; upload xong không còn kéo popup về thư mục vừa rời, và giữ nguyên bộ lọc lẫn vị trí cuộn.
- Tệp thả từ hệ thống chỉ vào danh sách của popup ngay dưới con trỏ, không xuyên qua hộp thoại hay vào thư mục phía sau tệp đang mở.
- Mở popup thứ chín chỉ đóng đúng popup đã được hỏi, tệp mở chậm không còn giành bàn phím của popup khác, và Thử lại trên popup mở lúc chưa kết nối sẽ tìm đúng thư mục home.
- Sao chép giữa hai máy chủ bỏ qua ssh config của máy nguồn, hai lượt sao chép vào cùng một tên không còn trộn lẫn, sao chép đi vòng qua máy này không thể chép một thư mục vào chính nó, và symlink bị bỏ qua được báo thay vì hiện là xong.

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
