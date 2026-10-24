# 1.0.7 面板第一次点击消失

## 证据与边界

- 当前健康检查版本为 1.0.6；最近的用户点击记录多次只有 mouse_down_1，没有切换请求。
- 外部点击检测使用 Cursor.Position 与 PointToScreen 的屏幕像素原点，却把 ActualWidth/ActualHeight 的 WPF 逻辑尺寸直接加上，缩放屏幕上边缘点击会被误认为外部点击。
- 未改动之前的日志没有记录面板关闭原因，因此不能仅凭旧日志断言每一次消失都来自缩放问题。新版补充 panel_closed_outside 诊断。

## 修改

通过 PointFromScreen 将鼠标坐标转换到目标窗口的逻辑坐标后再判断边界，适配缩放与负坐标屏幕。同时面板或圆圈 IsMouseOver、菜单打开、切换确认期间不触发外部点击关闭。双击依然由 WPF ClickCount 决定，不恢复切换按钮。

## 验证

- Windows PowerShell 回归覆盖 100%、125%、150%、200% 的面板右下边缘内外点击，含负屏幕坐标。
- 浮窗自检通过真实不可见窗口的 PointToScreen/PointFromScreen 往返，面板边缘点击保留面板；第一次调用点击处理器不关闭，第二次调用到达切换入口。
- 测试不会真实切换账号、关闭 Codex、发送诊断或通知。自检时当前窗口 DPI=100%，其余比例使用坐标转换替身；不是多显示器上的真实人工点击验收。
- 实际账号切换仍需用户安装后验证；如失败，读取 mouse_down_1/2、panel_closed_outside 与 confirmation_result 的连续记录。
