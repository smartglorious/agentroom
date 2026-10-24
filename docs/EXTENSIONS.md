# Điểm mở rộng (plugins) — v0.12

AgentRoom có vài điểm mở rộng để thêm tính năng mà không sửa lõi. Một plugin là một module TypeScript được **gộp vào bản build** (không tải lúc chạy), nên nó chạy với cùng quyền như extension và phải được người build tin cậy.

## Plugin làm được gì

```ts
import type { AgentRoomPlugin } from "../core/plugins";

export const plugin: AgentRoomPlugin = {
  id: "demo",                       // a-z, 0-9, '-' (tối đa 32); cũng là khóa phần cấu hình ext.demo
  activate(host) {
    const level = (host.config.ext.demo as { level?: number } | undefined)?.level;
    const offGuard = host.registerGuard((c) =>
      c.paths.some((p) => p.includes("/frozen/")) ? { action: "ask", reason: "vùng đang đóng băng" } : undefined);
    const offPanel = host.registerPanel({
      id: "main",
      title: () => "Demo",
      sections: () => [{ title: "Trạng thái", rows: [{ text: `level ${level}`, tag: "ok" }] }],
    });
    return () => { offGuard(); offPanel(); };   // dọn dẹp khi tắt
  },
};
```

| Điểm | Mô tả |
|---|---|
| **Guard** `registerGuard(fn)` | Chạy trước mỗi lần worker dùng tool. Trả `{action: "ask"\|"deny", reason}` hoặc `undefined`. Nhận `workerId`, `tool`, `input`, `paths` (đường dẫn tuyệt đối đã suy ra), `cwd`, `host`. |
| **Panel** `registerPanel(def)` | Thêm một tab chỉ-xem vào chat: các mục có tiêu đề, mỗi mục là các dòng chữ (`text`, `tag?`, `level?`). Chỉ là văn bản thuần. Gọi `host.panelsChanged()` khi nội dung đổi. |
| **Cấu hình** `host.config.ext` | Phần `ext:` của `workers.yaml`, mỗi plugin một khóa (`ext: { demo: {…} }`). Lõi không kiểm tra nội dung. |
| **Vòng đời** | `activate(host)` gọi khi phòng chạy (cả VS Code lẫn daemon); hàm trả về được gọi khi dừng. Lỗi ở plugin được ghi log và **không làm hỏng phòng**. |

## Quy tắc an toàn (không đổi được)

- Guard **chỉ làm chặt hơn**: biến "được phép" thành "hỏi người dùng" hoặc "chặn", không bao giờ ngược lại. Plugin không thể nới quyền của worker (Auto/Full vẫn hỏi khi guard hỏi; việc chính sách đã chặn thì vẫn bị chặn).
- Guard ném lỗi thì tính là **hỏi** (không phải cho qua).
- Nhiều guard: `deny` thắng `ask`.
- Tin hệ thống do guard gây ra không chứa `@` (thay bằng `(at)`); mọi quyết định guard được ghi vào `audit.jsonl`.

## Cách gộp một plugin vào bản build

Mã nguồn công khai không có plugin nào (`src/plugins/none.ts` xuất mảng rỗng). Khi build, `esbuild.mjs` giải `agentroom:plugins` thành `src/plugins/private.ts` **nếu file đó tồn tại**, ngược lại dùng `none.ts`:

```ts
// src/plugins/private.ts  (không có trong repo này)
import { plugin as demo } from "./demo";
export const plugins = [demo];
```

TypeScript dùng cùng thứ tự (`paths` trong `tsconfig.json`). Không file nào được theo dõi bị sửa, nên nhánh có plugin vẫn merge sạch với nhánh gốc.

## Đã kiểm chứng / chưa

- Đã (test tự động, `test/plugins.test.ts`): guard ask/deny ở Manual/Auto/Full, không nới quyền, guard ném lỗi, `deny` thắng `ask`, vòng đời và lỗi kích hoạt, panel (cả render trong Chromium thật, kể cả chống chèn HTML), `ext:` trong cấu hình, hoán đổi `agentroom:plugins` khi có `private.ts`.
- Chưa: panel trong VS Code thật; plugin chạy trong daemon trên máy thật.
