param([int]$Port = 17841,[switch]$SelfTest)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms
Add-Type 'using System; using System.Runtime.InteropServices; public static class CompanionMouse { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags); [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr hwnd, int index); [DllImport("user32.dll", EntryPoint="SetWindowLongW")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
$script:Port=$Port; $script:AppVersion='1.0.40'; $script:Status=$null; $script:Detail=$null; $script:DetailClosedAt=[DateTime]::MinValue; $script:SwitchableCardsBuilt=0; $script:SwitchGestureCardsBuilt=0; $script:SwitchButtonCardsBuilt=0; $script:SwitchButtonInvocations=0; $script:LoginExpiredCardsBuilt=0; $script:SwitchInProgress=$false; $script:WarmupInProgress=$false; $script:UpdateInfo=$null; $script:Updating=$false; $script:UpdateCardsBuilt=0; $script:UpdateButtonInvocations=0
$mutexName=if($SelfTest){'Global\CodexCompanionQuotaWidget_v5_selftest'}else{'Global\CodexCompanionQuotaWidget_v5'}
$script:Mutex=New-Object System.Threading.Mutex($false,$mutexName); if(-not $script:Mutex.WaitOne(0,$false)){exit}
$Transparent=[Windows.Media.Brushes]::Transparent
$Disc=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(31,39,54))
$CardBrush=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(42,52,70))
$Track=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(63,30,40))
$Muted=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(176,188,205))
$Green=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(57,218,137))
$Yellow=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(246,190,65))
$Red=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(255,105,105))
$White=[Windows.Media.Brushes]::White
$PlusBadgeBg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(48,58,92))
$PlusBadgeFg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(196,207,255))
$UpdateBadgeBg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(47,107,222))
$UpdateBadgeFg=[Windows.Media.Brushes]::White
$FreeBadgeBg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(41,75,71))
$FreeBadgeFg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(169,243,221))
$ProBadgeBg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(77,57,24))
$ProBadgeFg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(255,211,112))
function Trace-WidgetSwitch($stage,$accountName,$detail=''){
 if($SelfTest){return}
 try{
  $payload=@{stage=$stage;account=[string]$accountName;detail=[string]$detail}|ConvertTo-Json -Compress
  Invoke-RestMethod "http://127.0.0.1:$script:Port/api/widget/switch-trace" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 3|Out-Null
 }catch{}
}
function Get-Status{
 if($SelfTest){
  $reset=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()+7200
  return [pscustomobject]@{accounts=@(
   [pscustomobject]@{id='test-active';name='测试当前账号';is_active=$true;plan_type='plus';usage=[pscustomobject]@{primary_used_percent=20;primary_resets_at=$reset}},
   [pscustomobject]@{id='test-other';name='测试备用账号';is_active=$false;plan_type='free';usage=[pscustomobject]@{primary_used_percent=10;primary_resets_at=$reset}},
   [pscustomobject]@{id='test-expired';name='测试失效账号';is_active=$false;plan_type='pro';usage=[pscustomobject]@{error='登录已失效，请重新登录'}}
  );tasks=[pscustomobject]@{};taskActivity=[pscustomobject]@{rows=@()}}
 }
 try{Invoke-RestMethod "http://127.0.0.1:$script:Port/api/status" -TimeoutSec 8}catch{$null}
}
function Get-ApiErrorMessage($record){
 try{
  $raw=[string]$record.ErrorDetails.Message
  if(-not[string]::IsNullOrWhiteSpace($raw)){
   $parsed=$raw|ConvertFrom-Json
   if(-not[string]::IsNullOrWhiteSpace([string]$parsed.error)){return [string]$parsed.error}
  }
 }catch{}
 $message=[string]$record.Exception.Message
 if([string]::IsNullOrWhiteSpace($message)){return '操作没有完成，请重试。'}
 return $message
}
function Get-RunningTasks($status){
 $rows=@()
 if($null-ne$status.tasks){$rows+=@($status.tasks.psobject.Properties|ForEach-Object{$_.Value}|Where-Object{$_.status -in @('starting','running','waiting_confirmation','retry_waiting')})}
 if($null-ne$status.taskActivity -and $null-ne$status.taskActivity.rows){$rows+=@($status.taskActivity.rows|Where-Object{$_.source -in @('desktop','takeover','companion')})}
 $seen=@{};return @($rows|Where-Object{$id=[string]$_.id;if($seen.ContainsKey($id)){return $false};$seen[$id]=$true;return $true})
}
function Get-Remaining($a,$prefix){if($null -eq $a -or $null -eq $a.usage){return $null};$used=$a.usage.($prefix+'_used_percent');if($null -eq $used){return $null};[Math]::Max(0,[Math]::Min(100,[int](100-[double]$used)))}
function Test-LoginExpired($a){
 if($null-eq$a-or$null-eq$a.usage){return $false}
 $message=[string]$a.usage.error
 return (-not[string]::IsNullOrWhiteSpace($message))-and($message-match'登录.*失效|重新登录|invalid refresh token|refresh token|token.{0,30}(expired|revoked)|token_expired|token_revoked|unauthorized|401')
}
function Get-FriendlyUsageError($message){
 $text=[string]$message
 if([string]::IsNullOrWhiteSpace($text)){return ''}
 if($text-match'登录.*失效|重新登录|invalid refresh token|refresh token|token.{0,30}(expired|revoked)|token_expired|token_revoked|unauthorized|401'){return '登录已失效，请在网页重新登录这个账号。'}
 if($text-match'网络|fetch failed|ECONNREFUSED|超时|timeout'){return '暂时无法读取额度，请检查网络或稍后刷新。'}
 return '额度读取失败，请打开网页查看后台详情。'
}
function Get-Countdown($a,$prefix){try{$seconds=[int64]$a.usage.($prefix+'_resets_at')-[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();if($seconds-le 0){return '已重置'};$d=[Math]::Floor($seconds/86400);$h=[Math]::Floor(($seconds%86400)/3600);$m=[Math]::Floor(($seconds%3600)/60);if($d-gt 0){return "${d}天${h}小时"};if($h-gt 0){return "${h}小时${m}分"};return "${m}分"}catch{'--'}}
function Get-Expiry($a){try{$raw=$a.reset_credits_expires_at;if(-not $raw){return '--'};$seconds=[DateTimeOffset]::Parse([string]$raw).ToUnixTimeSeconds()-[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();if($seconds-le 0){return '已到期'};('{0}天{1}小时'-f [Math]::Floor($seconds/86400),[Math]::Floor(($seconds%86400)/3600))}catch{'--'}}
function Get-Color($r){if($r-le 15){$Red}elseif($r-le 35){$Yellow}else{$Green}}
function New-Text($text,$size,$color,[switch]$bold){$t=New-Object Windows.Controls.TextBlock;$t.Text=[string]$text;$t.FontFamily='Microsoft YaHei UI';$t.FontSize=$size;$t.Foreground=$color;if($bold){$t.FontWeight='Bold'};$t}
function New-PlanBadge($plan){
 $isPro=([string]$plan).ToLowerInvariant()-eq'pro'
 $isFree=([string]$plan).ToLowerInvariant()-eq'free'
 $badgeText=if($isPro){'Pro'}elseif($isFree){'Free'}else{'Plus'}
 $badgeBackground=if($isPro){$ProBadgeBg}elseif($isFree){$FreeBadgeBg}else{$PlusBadgeBg}
 $badgeForeground=if($isPro){$ProBadgeFg}elseif($isFree){$FreeBadgeFg}else{$PlusBadgeFg}
 $badge=New-Object Windows.Controls.Border
 $badge.Width=44;$badge.Height=20;$badge.CornerRadius=10;$badge.Margin='0,0,8,0'
 $badge.Background=$badgeBackground
 $label=New-Text $badgeText 12 $badgeForeground -bold
 $label.FontFamily='Segoe UI'
 $label.HorizontalAlignment='Center';$label.VerticalAlignment='Center'
 $badge.Child=$label
 return $badge
}
function New-QuotaIcon($kind){
 $canvas=New-Object Windows.Controls.Canvas
 $canvas.Width=14;$canvas.Height=14;$canvas.Margin='0,0,5,0';$canvas.VerticalAlignment='Center'
 if($kind-eq'5h'){
  $face=New-Object Windows.Shapes.Ellipse;$face.Width=12;$face.Height=12;$face.Stroke=$Muted;$face.StrokeThickness=1.4
  [Windows.Controls.Canvas]::SetLeft($face,1);[Windows.Controls.Canvas]::SetTop($face,1);$canvas.Children.Add($face)|Out-Null
  $hour=New-Object Windows.Shapes.Line;$hour.X1=7;$hour.Y1=7;$hour.X2=7;$hour.Y2=3.5;$hour.Stroke=$Muted;$hour.StrokeThickness=1.4;$hour.StrokeStartLineCap='Round';$hour.StrokeEndLineCap='Round';$canvas.Children.Add($hour)|Out-Null
  $minute=New-Object Windows.Shapes.Line;$minute.X1=7;$minute.Y1=7;$minute.X2=10;$minute.Y2=8.5;$minute.Stroke=$Muted;$minute.StrokeThickness=1.4;$minute.StrokeStartLineCap='Round';$minute.StrokeEndLineCap='Round';$canvas.Children.Add($minute)|Out-Null
 }elseif($kind-eq'7d'){
  $body=New-Object Windows.Controls.Border;$body.Width=12;$body.Height=11;$body.BorderBrush=$Muted;$body.BorderThickness=1.2;$body.CornerRadius=1
  [Windows.Controls.Canvas]::SetLeft($body,1);[Windows.Controls.Canvas]::SetTop($body,2);$canvas.Children.Add($body)|Out-Null
  $bar=New-Object Windows.Shapes.Line;$bar.X1=2;$bar.Y1=5;$bar.X2=12;$bar.Y2=5;$bar.Stroke=$Muted;$bar.StrokeThickness=1.2;$canvas.Children.Add($bar)|Out-Null
  foreach($x in @(4,10)){$pin=New-Object Windows.Shapes.Line;$pin.X1=$x;$pin.Y1=1;$pin.X2=$x;$pin.Y2=4;$pin.Stroke=$Muted;$pin.StrokeThickness=1.4;$pin.StrokeStartLineCap='Round';$pin.StrokeEndLineCap='Round';$canvas.Children.Add($pin)|Out-Null}
 }else{
  $symbol=New-Text '↻' 14 $Muted -bold;$symbol.FontFamily='Segoe UI Symbol';$symbol.Margin='-1,-4,0,0';$canvas.Children.Add($symbol)|Out-Null
 }
 return $canvas
}
function Get-SortReset($a){
 $values=@()
 foreach($field in @('primary_resets_at','secondary_resets_at')){
  $value=$a.usage.$field
  if($null-ne$value-and[int64]$value-gt 0){$values+=[int64]$value}
 }
 if($values.Count-eq 0){return [int64]::MaxValue}
 return ($values|Measure-Object -Minimum).Minimum
}
function New-Quota($tag,$remaining,$countdown,$width){
 $box=New-Object Windows.Controls.StackPanel
 $box.Width=$width
 $box.Margin='0,4,0,0'
 $line=New-Object Windows.Controls.StackPanel;$line.Orientation='Horizontal'
 $line.Children.Add((New-QuotaIcon $tag))|Out-Null
 $line.Children.Add((New-Text "$remaining%  ·  $countdown" 10 $Muted))|Out-Null
 $box.Children.Add($line)|Out-Null
 $bar=New-Object Windows.Controls.Grid
 $bar.Width=$width
 $bar.Height=6
 $bar.Margin='0,3,0,0'
 $base=New-Object Windows.Controls.Border
 $base.Background=$Track
 $base.CornerRadius='3'
 $bar.Children.Add($base)|Out-Null
 $fill=New-Object Windows.Controls.Border
 $fill.HorizontalAlignment='Left'
 $fill.Width=[Math]::Max(0,$width*$remaining/100)
 $fill.Background=Get-Color $remaining
 $fill.CornerRadius='3'
 $bar.Children.Add($fill)|Out-Null
 $box.Children.Add($bar)|Out-Null
 return $box
}
$script:MenuOpen=$false
$Window=New-Object Windows.Window;$Window.Width=72;$Window.Height=72;$Window.WindowStyle='None';$Window.ResizeMode='NoResize';$Window.AllowsTransparency=$true;$Window.Background=$Transparent;$Window.Topmost=$true;$Window.ShowInTaskbar=$false;$Window.UseLayoutRounding=$true;$Window.SnapsToDevicePixels=$true
function Ensure-WidgetTopmost{
 if($script:MenuOpen -or $script:SwitchInProgress){return}
 foreach($floatingWindow in @($Window,$script:Detail)){
  if($null-eq$floatingWindow-or-not$floatingWindow.IsVisible){continue}
  $handle=(New-Object Windows.Interop.WindowInteropHelper($floatingWindow)).Handle
  if($handle-ne[IntPtr]::Zero){
   # Reassert native Z-order without activation, movement or resizing (0x13).
   # WPF Topmost can stay true even after native windows reorder the window.
   [CompanionMouse]::SetWindowPos($handle,[IntPtr]::new(-1),0,0,0,0,0x13)|Out-Null
  }
 }
}
$Window.Add_Deactivated({Ensure-WidgetTopmost})
$Root=New-Object Windows.Controls.Grid;$Window.Content=$Root
$Back=New-Object Windows.Shapes.Ellipse;$Back.Margin=5;$Back.Fill=$Disc;$Back.Stroke=$Muted;$Back.StrokeThickness=6;$Root.Children.Add($Back)|Out-Null
$Arc=New-Object Windows.Shapes.Path;$Arc.Stroke=$Green;$Arc.StrokeThickness=6;$Arc.StrokeStartLineCap='Round';$Arc.StrokeEndLineCap='Round';$Root.Children.Add($Arc)|Out-Null
$Number=New-Text '--' 22 $Green -bold;$Number.HorizontalAlignment='Center';$Number.VerticalAlignment='Center';$Root.Children.Add($Number)|Out-Null
# 有新版本时，圆环右上角出现一个蓝色 ↑ 小圆标：点一下就是“更新并重启”，
# 不需要开网页、不需要找菜单。没新版本时它完全不存在，不占地方。
$script:UpdateBadge=New-Object Windows.Controls.Border
$script:UpdateBadge.Width=21;$script:UpdateBadge.Height=21;$script:UpdateBadge.CornerRadius=11
$script:UpdateBadge.Background=$UpdateBadgeBg;$script:UpdateBadge.BorderBrush=$Disc;$script:UpdateBadge.BorderThickness=2
$script:UpdateBadge.HorizontalAlignment='Right';$script:UpdateBadge.VerticalAlignment='Top'
$script:UpdateBadge.Cursor=[Windows.Input.Cursors]::Hand;$script:UpdateBadge.Visibility='Collapsed'
$updateArrow=New-Text '↑' 13 $UpdateBadgeFg -bold;$updateArrow.FontFamily='Segoe UI Symbol'
$updateArrow.HorizontalAlignment='Center';$updateArrow.VerticalAlignment='Center';$updateArrow.Margin='0,-2,0,0'
$script:UpdateBadge.Child=$updateArrow
$updateBadgeHandler={param($sender,$eventArgs)$eventArgs.Handled=$true;Update-Companion}
$script:UpdateBadge.Add_PreviewMouseLeftButtonDown($updateBadgeHandler)
if($SelfTest){$script:TestUpdateHandler=$updateBadgeHandler}
$Root.Children.Add($script:UpdateBadge)|Out-Null
function Set-Arc($r){if($r-le 0){$Arc.Data=$null;return};$c=36;$radius=28;$start=-90;$end=$start+(3.599*[Math]::Min(99.9,$r));$a1=$start*[Math]::PI/180;$a2=$end*[Math]::PI/180;$p1=New-Object Windows.Point -ArgumentList ($c+$radius*[Math]::Cos($a1)),($c+$radius*[Math]::Sin($a1));$p2=New-Object Windows.Point -ArgumentList ($c+$radius*[Math]::Cos($a2)),($c+$radius*[Math]::Sin($a2));$g=New-Object Windows.Media.StreamGeometry;$ctx=$g.Open();$ctx.BeginFigure($p1,$false,$false);$ctx.ArcTo($p2,(New-Object Windows.Size -ArgumentList $radius,$radius),0,(($end-$start)-gt 180),[Windows.Media.SweepDirection]::Clockwise,$true,$false);$ctx.Close();$g.Freeze();$Arc.Data=$g}
function Update-UpdateBadge($status){
 $script:UpdateInfo=if($null-ne$status-and$null-ne$status.update){$status.update}else{$null}
 if($null-ne$status-and$status.PSObject.Properties['version']-and$status.version){$script:AppVersion=[string]$status.version}
 # 更新重启期间后台会短暂断开；等它带着新版本回来（或不再报新版本）就解除“更新中”。
 if($script:Updating -and ($null-eq$script:UpdateInfo -or -not[bool]$script:UpdateInfo.available)){$script:Updating=$false}
 $visible=(-not$script:Updating)-and($null-ne$script:UpdateInfo)-and[bool]$script:UpdateInfo.available
 if($null-ne$script:UpdateBadge){
  $script:UpdateBadge.Visibility=if($visible){'Visible'}else{'Collapsed'}
  if($visible){
   $script:UpdateBadge.ToolTip=if($script:UpdateInfo.canApply){"有新版本 v$($script:UpdateInfo.latest)（当前 v$script:AppVersion）· 点一下更新并重启"}else{"有新版本 v$($script:UpdateInfo.latest)· 点一下打开下载页"}
  }
 }
 if($null-ne$script:VersionItem){$script:VersionItem.Header="Codex Companion v$script:AppVersion"}
}
function Update-Widget{$script:Status=Get-Status;Update-UpdateBadge $script:Status;$runningCount=@(Get-RunningTasks $script:Status).Count;$tip="Codex Companion`n运行中对话：$runningCount（含自动接管）";if($null-ne$script:UpdateInfo-and$script:UpdateInfo.available){$tip+="`n有新版本 v$($script:UpdateInfo.latest)，点右上角 ↑ 更新"};$Window.ToolTip=$tip;$a=$script:Status.accounts|Where-Object{$_.is_active}|Select-Object -First 1;if(Test-LoginExpired $a){$Number.Text='!';$Number.Foreground=$Red;$Arc.Data=$null;return};$r=Get-Remaining $a 'primary';if($null-eq$r){$r=Get-Remaining $a 'secondary'};if($null-eq$r){$Number.Text='--';$Arc.Data=$null;return};$color=Get-Color $r;$Number.Text=[string]$r;$Number.Foreground=$color;$Arc.Stroke=$color;Set-Arc $r}
function Close-Detail([switch]$Force){if($script:SwitchInProgress -and -not$Force){return};if($null-ne$script:Detail){$d=$script:Detail;$script:Detail=$null;$script:DetailClosedAt=[DateTime]::UtcNow;try{$d.Close()}catch{}}}
function Test-ScreenPointInsideWindow($floatingWindow,$cursor){
 if($null-eq$floatingWindow -or -not$floatingWindow.IsVisible){return $false}
 try{
  # Cursor.Position is in screen pixels; convert to this window's WPF units.
  # Adding ActualWidth (DIPs) to PointToScreen (pixels) fails at non-100% DPI.
  $local=$floatingWindow.PointFromScreen([Windows.Point]::new([double]$cursor.X,[double]$cursor.Y))
  return $local.X-ge 0 -and $local.X-le$floatingWindow.ActualWidth -and $local.Y-ge 0 -and $local.Y-le$floatingWindow.ActualHeight
 }catch{return $false}
}
function Handle-OutsidePointerDown($cursor){
 if($null-eq$script:Detail -or $script:SwitchInProgress -or $script:MenuOpen){return}
 if($Window.IsMouseOver -or $script:Detail.IsMouseOver){return}
 $insideMain=Test-ScreenPointInsideWindow $Window $cursor
 $insideDetail=Test-ScreenPointInsideWindow $script:Detail $cursor
 if(-not$insideMain -and -not$insideDetail){
  Trace-WidgetSwitch 'panel_closed_outside' '' ("widget=$script:AppVersion pid=$PID")
  Close-Detail
 }
}
function Get-WidgetMonitorWorkArea{
 try{
  $center=$Window.PointToScreen([Windows.Point]::new(([double]$Window.ActualWidth/2.0),([double]$Window.ActualHeight/2.0)))
  $screen=[System.Windows.Forms.Screen]::FromPoint((New-Object Drawing.Point([int]$center.X,[int]$center.Y)))
  $source=[Windows.PresentationSource]::FromVisual($Window)
  if($null-ne$source-and$null-ne$source.CompositionTarget){
   $toDip=$source.CompositionTarget.TransformFromDevice
   $topLeft=$toDip.Transform((New-Object Windows.Point($screen.WorkingArea.Left,$screen.WorkingArea.Top)))
   $bottomRight=$toDip.Transform((New-Object Windows.Point($screen.WorkingArea.Right,$screen.WorkingArea.Bottom)))
   return [pscustomobject]@{Left=$topLeft.X;Top=$topLeft.Y;Right=$bottomRight.X;Bottom=$bottomRight.Y}
  }
 }catch{}
 $fallback=[Windows.SystemParameters]::WorkArea
 return [pscustomobject]@{Left=$fallback.Left;Top=$fallback.Top;Right=$fallback.Right;Bottom=$fallback.Bottom}
}
function Close-WidgetNotice{
 if($null-ne$script:NoticeTimer){$script:NoticeTimer.Stop();$script:NoticeTimer=$null}
 if($null-ne$script:NoticeWindow){$script:NoticeWindow.Close();$script:NoticeWindow=$null}
}
function Hide-FromTaskSwitcher($w){try{if($null-eq$w){return};$h=(New-Object Windows.Interop.WindowInteropHelper($w)).Handle;if($h-eq[IntPtr]::Zero){return};$ex=[CompanionMouse]::GetWindowLong($h,-20);[CompanionMouse]::SetWindowLong($h,-20,($ex -bor 0x80))|Out-Null}catch{}}
function Show-WidgetNotice([string]$message,[double]$seconds=5){
 Close-WidgetNotice
 $toast=New-Object Windows.Window
 $toast.WindowStyle='None';$toast.ResizeMode='NoResize';$toast.AllowsTransparency=$true
 $toast.Background=$Transparent;$toast.ShowInTaskbar=$false;$toast.ShowActivated=$false
 $toast.Topmost=$true;$toast.Width=360;$toast.SizeToContent='Height'
 $border=New-Object Windows.Controls.Border
 $border.Background=$Disc;$border.BorderBrush=$Green;$border.BorderThickness=1;$border.CornerRadius=12;$border.Padding=16
 $stack=New-Object Windows.Controls.StackPanel
 $title=New-Object Windows.Controls.TextBlock
 $title.Text='Codex Companion · 账号切换成功';$title.Foreground=$Green;$title.FontWeight='SemiBold';$title.FontSize=14
 $body=New-Object Windows.Controls.TextBlock
 $body.Text=$message;$body.Foreground=$White;$body.FontSize=13;$body.TextWrapping='Wrap';$body.Margin='0,8,0,0'
 $stack.Children.Add($title)|Out-Null;$stack.Children.Add($body)|Out-Null
 $border.Child=$stack;$toast.Content=$border
 $script:NoticeWindow=$toast
 if($SelfTest){$toast.Opacity=0}
 $toast.Show();$toast.UpdateLayout();Hide-FromTaskSwitcher $toast
 $area=Get-WidgetMonitorWorkArea
 $toast.Left=[Math]::Max($area.Left,$area.Right-$toast.ActualWidth-16)
 $toast.Top=[Math]::Max($area.Top,$area.Bottom-$toast.ActualHeight-16)
 $script:NoticeTimer=New-Object Windows.Threading.DispatcherTimer
 $script:NoticeTimer.Interval=[TimeSpan]::FromSeconds([Math]::Max(0.1,$seconds))
 $script:NoticeTimer.Add_Tick({Close-WidgetNotice});$script:NoticeTimer.Start()
}
function Update-Companion([switch]$Confirmed){
 if($script:Updating){return}
 $info=$script:UpdateInfo
 if($null-eq$info-or-not$info.available){[Windows.MessageBox]::Show('当前已经是最新版本。','Codex Companion','OK','Information')|Out-Null;return}
 if($SelfTest){$script:UpdateButtonInvocations++;return}
 if(-not$info.canApply){
  [Windows.MessageBox]::Show("这次更新需要下载完整安装包。`n`n点确定打开下载页；装好后账号和设置都还在。",'Codex Companion','OK','Information')|Out-Null
  Start-Process 'https://github.com/Match-cj/codex-companion/releases/latest'
  return
 }
 $running=@(Get-RunningTasks $script:Status).Count
 $choice=[Windows.MessageBoxResult]::OK
 if(-not$Confirmed){
  $question=if($running-gt 0){"现在有 $running 个对话在运行，更新会重启软件并中断它们。`n`n确定现在更新到 v$($info.latest) 吗？"}else{"现在更新到 v$($info.latest) 吗？`n`n只下载一个很小的补丁，浮窗大约 10 秒后自动回来；账号和设置都不受影响。"}
  $choice=[Windows.MessageBox]::Show($question,'更新 Codex Companion',[Windows.MessageBoxButton]::OKCancel,[Windows.MessageBoxImage]::Question)
 }
 if($choice-ne[Windows.MessageBoxResult]::OK){return}
 $script:Updating=$true
 if($null-ne$script:UpdateBadge){$script:UpdateBadge.Visibility='Collapsed'}
 try{
  Close-Detail -Force
  Show-WidgetNotice "正在更新到 v$($info.latest)，浮窗大约 10 秒后自动回来…" 25
  Invoke-RestMethod "http://127.0.0.1:$script:Port/api/update/apply" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 180|Out-Null
 }catch{
  $script:Updating=$false
  [Windows.MessageBox]::Show("更新没有完成：`n$(Get-ApiErrorMessage $_)`n`n当前版本仍可正常使用，可以稍后再试。",'Codex Companion','OK','Error')|Out-Null
 }
}
function Switch-WidgetAccount($accountId,$accountName){
 if($SelfTest){$script:SwitchButtonInvocations++;return}
 Trace-WidgetSwitch 'gesture_received' $accountName ("widget=$script:AppVersion pid=$PID")
 if($script:SwitchInProgress){Trace-WidgetSwitch 'ignored_busy' $accountName;return}
 $script:SwitchInProgress=$true
 try{
  $ErrorActionPreference='Stop'
  $state=Invoke-RestMethod "http://127.0.0.1:$script:Port/api/codex/status" -TimeoutSec 8
  $desktopText=if($state.running){'检测到 ChatGPT/Codex 正在运行；确认后会先将它关闭，切换成功再自动重新打开。'}else{'确认后会切换账号，并自动打开 ChatGPT/Codex。'}
  Trace-WidgetSwitch 'confirmation_shown' $accountName
  $owner=if($null-ne$script:Detail -and $script:Detail.IsVisible){$script:Detail}else{$Window}
  $choice=[Windows.MessageBox]::Show($owner,"确定切换到【${accountName}】吗？`n`n$desktopText`n`n请点击确定继续，点击取消不会切换。",'确认切换账号',[Windows.MessageBoxButton]::OKCancel,[Windows.MessageBoxImage]::Warning)
  Trace-WidgetSwitch 'confirmation_result' $accountName ("result=$choice value=$([int]$choice) type=$($choice.GetType().FullName) widget=$script:AppVersion pid=$PID")
  if($choice -ne [Windows.MessageBoxResult]::OK){Trace-WidgetSwitch 'confirmation_cancelled' $accountName ([string]$choice);return}
  Trace-WidgetSwitch 'request_started' $accountName
  [Windows.Input.Mouse]::OverrideCursor=[Windows.Input.Cursors]::Wait
  $payload=@{id=$accountId;closeCodex=$true;source='widget'}|ConvertTo-Json -Compress
  $result=Invoke-RestMethod "http://127.0.0.1:$script:Port/api/accounts/switch" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 90
  Trace-WidgetSwitch 'request_response' $accountName ([string]$result.message)
  if($result.ok -ne $true){throw '后台没有确认账号切换成功。'}
  if([string]$result.activeAccountId -ne [string]$accountId){throw "切换后校验失败：当前账号没有改变。请打开网页查看详细状态。"}
  Trace-WidgetSwitch 'validation_success' $accountName
  Close-Detail -Force
  Update-Widget
  Show-WidgetNotice ([string]$result.message)
 }catch{
  Trace-WidgetSwitch 'failed' $accountName (Get-ApiErrorMessage $_)
  [Windows.MessageBox]::Show("账号切换失败：`n$(Get-ApiErrorMessage $_)",'Codex Companion','OK','Error')|Out-Null
 }finally{$script:SwitchInProgress=$false;[Windows.Input.Mouse]::OverrideCursor=$null;Ensure-WidgetTopmost}
}
function Warmup-WidgetAccount($accountId,$accountName){
 if($script:WarmupInProgress){return}
 $choice=[Windows.MessageBox]::Show("确定预热【${accountName}】吗？`n`n这会发送一次极小请求，让 5 小时额度窗口从现在开始计时，并消耗极少量额度。",'确认预热额度','YesNo','Information')
 if($choice-ne[Windows.MessageBoxResult]::Yes){return}
 try{
  $script:WarmupInProgress=$true
  [Windows.Input.Mouse]::OverrideCursor=[Windows.Input.Cursors]::Wait
  $payload=@{id=$accountId;confirm=$true}|ConvertTo-Json -Compress
  $result=Invoke-RestMethod "http://127.0.0.1:$script:Port/api/accounts/warmup" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 120
  Update-Widget
  [Windows.MessageBox]::Show([string]$result.message,'Codex Companion','OK','Information')|Out-Null
 }catch{
  [Windows.MessageBox]::Show("额度预热失败：`n$(Get-ApiErrorMessage $_)",'Codex Companion','OK','Error')|Out-Null
 }finally{$script:WarmupInProgress=$false;[Windows.Input.Mouse]::OverrideCursor=$null}
}
function Show-Detail{
 if($null-ne$script:Detail){Close-Detail;return};if(([DateTime]::UtcNow-$script:DetailClosedAt).TotalMilliseconds-lt 250){return};$script:Status=Get-Status;$accounts=@($script:Status.accounts|Sort-Object{Get-SortReset $_})
 $d=New-Object Windows.Window;$script:Detail=$d;$d.Width=430;$d.WindowStyle='None';$d.ResizeMode='NoResize';$d.AllowsTransparency=$true;$d.Background=$Transparent;$d.Topmost=$true;$d.ShowInTaskbar=$false;$d.ShowActivated=$true;$d.UseLayoutRounding=$true;$d.SnapsToDevicePixels=$true
 $outer=New-Object Windows.Controls.Border;$outer.Background=$Disc;$outer.CornerRadius=12;$outer.Padding=9;$stack=New-Object Windows.Controls.StackPanel;$outer.Child=$stack;$d.Content=$outer
 $runningCount=@(Get-RunningTasks $script:Status).Count
 $runningColor=if($runningCount-gt 0){$Green}else{$Muted};$runningText=New-Text "运行中对话：$runningCount（含自动接管）" 11 $runningColor -bold;$runningText.Margin='2,0,0,7';$stack.Children.Add($runningText)|Out-Null
 if($null-ne$script:UpdateInfo-and[bool]$script:UpdateInfo.available){
  $updateCard=New-Object Windows.Controls.Border;$updateCard.Background=$CardBrush;$updateCard.CornerRadius=7;$updateCard.Padding='10,7';$updateCard.Margin='0,0,0,7'
  $updateCard.BorderBrush=$UpdateBadgeBg;$updateCard.BorderThickness=1;$updateCard.Cursor=[Windows.Input.Cursors]::Hand;$updateCard.ToolTip='点这里更新并重启'
  $updateText=New-Text ("↑ 有新版本 v$($script:UpdateInfo.latest)（当前 v$script:AppVersion）· 点这里更新") 12 $UpdateBadgeFg -bold
  $updateText.TextWrapping='Wrap'
  $updateCard.Child=$updateText
  $updateCard.Add_PreviewMouseLeftButtonDown({param($sender,$eventArgs)$eventArgs.Handled=$true;Update-Companion})
  $stack.Children.Add($updateCard)|Out-Null;$script:UpdateCardsBuilt++
 }
 foreach($a in $accounts){
  $card=New-Object Windows.Controls.Border;$card.Background=$CardBrush;$card.CornerRadius=7;$card.Padding='10,7';$card.Margin='0,0,0,7'
  $content=New-Object Windows.Controls.StackPanel;$card.Child=$content
  $head=New-Object Windows.Controls.StackPanel;$head.Orientation='Horizontal'
  $badge=New-PlanBadge $a.plan_type;$head.Children.Add($badge)|Out-Null
  $shownName=if([string]::IsNullOrWhiteSpace([string]$a.display_name)){[string]$a.name}else{[string]$a.display_name}
  $nc=if($a.is_active){$Green}else{$White};$prefix=if($a.is_active){'● '}else{''};$name=New-Text ($prefix+$shownName) 12 $nc -bold;if(-not[string]::IsNullOrWhiteSpace([string]$a.alias)){$name.ToolTip=[string]$a.name};$head.Children.Add($name)|Out-Null;$content.Children.Add($head)|Out-Null
  $loginExpired=Test-LoginExpired $a
  if($loginExpired){$warning=New-Text '登录已失效 · 请在网页重新登录' 11 $Red -bold;$warning.Margin='0,5,0,2';$content.Children.Add($warning)|Out-Null;$script:LoginExpiredCardsBuilt++}
  elseif(-not[string]::IsNullOrWhiteSpace([string]$a.usage.error)){$warning=New-Text (Get-FriendlyUsageError $a.usage.error) 11 $Red -bold;$warning.Margin='0,5,0,2';$content.Children.Add($warning)|Out-Null}
  $five=if($loginExpired){$null}else{Get-Remaining $a 'primary'};$week=if($loginExpired){$null}else{Get-Remaining $a 'secondary'}
  $quotaGrid=New-Object Windows.Controls.Grid;$quotaGrid.Width=390;$quotaGrid.Margin='0,2,0,0'
  $col1=New-Object Windows.Controls.ColumnDefinition;$col1.Width=195
  $col2=New-Object Windows.Controls.ColumnDefinition;$col2.Width=195
  $quotaGrid.ColumnDefinitions.Add($col1);$quotaGrid.ColumnDefinitions.Add($col2)
  if($null-ne$five-and$null-ne$week){
   $fiveBox=New-Quota '5h' $five (Get-Countdown $a 'primary') 188
   $weekBox=New-Quota '7d' $week (Get-Countdown $a 'secondary') 188
   [Windows.Controls.Grid]::SetColumn($fiveBox,0);[Windows.Controls.Grid]::SetColumn($weekBox,1)
   $quotaGrid.Children.Add($fiveBox)|Out-Null;$quotaGrid.Children.Add($weekBox)|Out-Null
  }elseif($null-ne$five){
   $fiveBox=New-Quota '5h' $five (Get-Countdown $a 'primary') 390
   [Windows.Controls.Grid]::SetColumnSpan($fiveBox,2);$quotaGrid.Children.Add($fiveBox)|Out-Null
  }elseif($null-ne$week){
   $weekBox=New-Quota '7d' $week (Get-Countdown $a 'secondary') 390
   [Windows.Controls.Grid]::SetColumnSpan($weekBox,2);$quotaGrid.Children.Add($weekBox)|Out-Null
  }
  if($null-ne$five-or$null-ne$week){$content.Children.Add($quotaGrid)|Out-Null}
  $count=if($null-ne$a.reset_count){$a.reset_count}else{'--'}
  $reset=New-Object Windows.Controls.StackPanel;$reset.Orientation='Horizontal';$reset.Margin='0,5,0,0'
  $reset.Children.Add((New-QuotaIcon 'reset'))|Out-Null
  $reset.Children.Add((New-Text "$count  ·  到期 $(Get-Expiry $a)" 10 $Muted))|Out-Null
  if(-not$loginExpired){$content.Children.Add($reset)|Out-Null}
  $cardMenu=New-Object Windows.Controls.ContextMenu
  $warmItem=New-Object Windows.Controls.MenuItem;$warmItem.Header='预热 5 小时额度';$warmItem.Tag=@{Id=[string]$a.id;Name=[string]$shownName}
  if($loginExpired){$warmItem.IsEnabled=$false;$warmItem.Header='登录已失效，请先在网页重新登录'}
  $warmItem.Add_Click({param($sender,$eventArgs) Warmup-WidgetAccount ([string]$sender.Tag.Id) ([string]$sender.Tag.Name)})
  $cardMenu.Items.Add($warmItem)|Out-Null;$cardMenu.Add_Opened({$script:MenuOpen=$true});$cardMenu.Add_Closed({$script:MenuOpen=$false});$card.ContextMenu=$cardMenu
  if((-not$a.is_active)-and(-not$loginExpired)){
    $card.Cursor=[Windows.Input.Cursors]::Hand;$card.ToolTip="双击切换到 $shownName"
    $card.Tag=@{Id=[string]$a.id;Name=[string]$shownName}
   $switchHandler={param($sender,$eventArgs)
    Trace-WidgetSwitch ("mouse_down_"+[string]$eventArgs.ClickCount) ([string]$sender.Tag.Name)
    if($eventArgs.ClickCount-lt 2){return}
    $eventArgs.Handled=$true
    Switch-WidgetAccount ([string]$sender.Tag.Id) ([string]$sender.Tag.Name)
   }
   $card.Add_PreviewMouseLeftButtonDown($switchHandler)
   if($SelfTest){$script:TestSwitchCard=$card;$script:TestSwitchHandler=$switchHandler}
   $script:SwitchableCardsBuilt++
   $script:SwitchGestureCardsBuilt++
  }
  $stack.Children.Add($card)|Out-Null
 }
 $d.Add_Closed({$script:Detail=$null;$script:DetailClosedAt=[DateTime]::UtcNow})
 $stack.Measure([Windows.Size]::new(402,[double]::PositiveInfinity))
 $total=$stack.DesiredSize.Height+18
 $d.Height=[Math]::Max(80,$total)
 $work=Get-WidgetMonitorWorkArea;$left=$Window.Left+(($Window.ActualWidth-$d.Width)/2);$left=[Math]::Max($work.Left+4,[Math]::Min($left,$work.Right-$d.Width-4));$below=$Window.Top+$Window.ActualHeight+6;$top=if(($below+$d.Height)-le$work.Bottom){$below}else{$Window.Top-$d.Height-6};$d.Left=$left;$d.Top=[Math]::Max($work.Top+4,[Math]::Min($top,$work.Bottom-$d.Height-4));if($SelfTest){$d.Opacity=0};$d.Show();Hide-FromTaskSwitcher $d
}
$Window.Add_Closed({Close-WidgetNotice})
if($SelfTest){
 $Error.Clear()
 $Window.Opacity=0;$Window.Show();$Window.UpdateLayout();Hide-FromTaskSwitcher $Window
 $testHandle=(New-Object Windows.Interop.WindowInteropHelper($Window)).Handle
 [CompanionMouse]::SetWindowPos($testHandle,[IntPtr]::new(-2),0,0,0,0,0x13)|Out-Null
 $foregroundBefore=[CompanionMouse]::GetForegroundWindow()
 Ensure-WidgetTopmost
 $topmostRestored=([CompanionMouse]::GetWindowLong($testHandle,-20)-band 8)-ne 0
 $noFocusSteal=$foregroundBefore-eq[CompanionMouse]::GetForegroundWindow()
 Update-Widget
 $badgeHiddenWithoutUpdate=($script:UpdateBadge.Visibility-eq'Collapsed')
 Update-UpdateBadge ([pscustomobject]@{version=$script:AppVersion;update=[pscustomobject]@{available=$true;latest='99.0.0';canApply=$true;mode='auto'}})
 $badgeShownWithUpdate=($script:UpdateBadge.Visibility-eq'Visible')
 if($null-ne$script:TestUpdateHandler){& $script:TestUpdateHandler $script:UpdateBadge ([pscustomobject]@{Handled=$false})}
 $badgeClickInvocations=$script:UpdateButtonInvocations
 Show-Detail
 $stackForTest=$script:Detail.Content.Child
 $scaledBoundsPass=$true
 foreach($scale in @(1.0,1.25,1.5,2.0)){
  $fakeWindow=[pscustomobject]@{IsVisible=$true;ActualWidth=430.0;ActualHeight=279.0;Scale=$scale;Left=-1900.0;Top=120.0}
  $fakeWindow|Add-Member -MemberType ScriptMethod -Name PointFromScreen -Value {param($point) [Windows.Point]::new(($point.X-$this.Left)/$this.Scale,($point.Y-$this.Top)/$this.Scale)}
  $insideScaled=[Windows.Point]::new($fakeWindow.Left+429*$scale,$fakeWindow.Top+278*$scale)
  $outsideScaled=[Windows.Point]::new($fakeWindow.Left+431*$scale,$fakeWindow.Top+280*$scale)
  if(-not(Test-ScreenPointInsideWindow $fakeWindow $insideScaled) -or (Test-ScreenPointInsideWindow $fakeWindow $outsideScaled)){$scaledBoundsPass=$false}
 }
 if(-not$scaledBoundsPass){throw 'Scaled screen-coordinate regression'}
 $script:Detail.UpdateLayout()
 $insidePoint=$script:Detail.PointToScreen([Windows.Point]::new($script:Detail.ActualWidth-2,$script:Detail.ActualHeight-2))
 Handle-OutsidePointerDown $insidePoint
 $insideClickKeepsPanel=$null-ne$script:Detail
 if(-not$insideClickKeepsPanel){throw 'Panel disappeared after an inside edge click'}
 $singleClickKeepsPanel=$false;$doubleClickInvokesSwitch=$false
 if($null-ne$script:TestSwitchHandler){
  & $script:TestSwitchHandler $script:TestSwitchCard ([pscustomobject]@{ClickCount=1;Handled=$false})
  $singleClickKeepsPanel=$null-ne$script:Detail -and $script:SwitchButtonInvocations-eq 0
  & $script:TestSwitchHandler $script:TestSwitchCard ([pscustomobject]@{ClickCount=2;Handled=$false})
  $doubleClickInvokesSwitch=$script:SwitchButtonInvocations-eq 1
 }
 [pscustomobject]@{ScaledBoundsPass=$scaledBoundsPass;InsideEdgeClickKeepsPanel=$insideClickKeepsPanel;SingleClickKeepsPanel=$singleClickKeepsPanel;DoubleClickInvokesSwitch=$doubleClickInvokesSwitch;DpiScale=[Windows.PresentationSource]::FromVisual($script:Detail).CompositionTarget.TransformToDevice.M11}|ConvertTo-Json -Compress
[pscustomobject]@{AccountsFromApi=@($script:Status.accounts).Count;CardsBuilt=@($stackForTest.Children).Count;LoginExpiredCards=$script:LoginExpiredCardsBuilt;SwitchableCards=$script:SwitchableCardsBuilt;SwitchGestureCards=$script:SwitchGestureCardsBuilt;SwitchButtonCards=$script:SwitchButtonCardsBuilt;SwitchButtonInvocations=$script:SwitchButtonInvocations;UpdateBadgeHidden=$badgeHiddenWithoutUpdate;UpdateBadgeShown=$badgeShownWithUpdate;UpdateBadgeClicks=$badgeClickInvocations;UpdateCards=$script:UpdateCardsBuilt;PanelHeight=[Math]::Round($script:Detail.Height,1);TopmostRestored=$topmostRestored;NoFocusSteal=$noFocusSteal;RuntimeErrors=$Error.Count;Errors=@($Error|ForEach-Object{$_.InvocationInfo.PositionMessage+' :: '+$_.Exception.Message})}|ConvertTo-Json -Compress -Depth 3
Close-Detail
$Window.Close()
try{$script:Mutex.ReleaseMutex()}catch{}
if($Error.Count -gt 0 -or -not$insideClickKeepsPanel -or -not$singleClickKeepsPanel -or -not$doubleClickInvokesSwitch -or -not$topmostRestored -or -not$noFocusSteal -or -not$badgeHiddenWithoutUpdate -or -not$badgeShownWithUpdate -or $badgeClickInvocations -ne 1 -or $script:UpdateCardsBuilt -ne 1){throw 'Widget self-test failed'}
 exit
}
$TopmostTimer=New-Object Windows.Threading.DispatcherTimer
$TopmostTimer.Interval=[TimeSpan]::FromSeconds(2)
$TopmostTimer.Add_Tick({Ensure-WidgetTopmost})
$TopmostTimer.Start()
$Window.Add_Closed({$TopmostTimer.Stop()})
$Window.Add_ContentRendered({Ensure-WidgetTopmost})
$Window.Add_MouseLeftButtonDown({$hadDetail=$null-ne$script:Detail;if($hadDetail){Close-Detail};$start=[System.Windows.Forms.Cursor]::Position;try{$Window.DragMove()}catch{};$end=[System.Windows.Forms.Cursor]::Position;$distance=[Math]::Abs($end.X-$start.X)+[Math]::Abs($end.Y-$start.Y);if($distance-le 3-and-not$hadDetail){Show-Detail}})
$Menu=New-Object Windows.Controls.ContextMenu;$Menu.Placement='Right';$Menu.PlacementTarget=$Window;$Menu.HorizontalOffset=8;$Refresh=New-Object Windows.Controls.MenuItem;$Refresh.Header='立即刷新额度';$Refresh.Add_Click({Update-Widget});$Menu.Items.Add($Refresh)|Out-Null;$CheckUpdate=New-Object Windows.Controls.MenuItem;$CheckUpdate.Header='检查更新…';$CheckUpdate.Add_Click({try{$st=Invoke-RestMethod "http://127.0.0.1:$script:Port/api/update/status?force=1" -TimeoutSec 15;if($st.available){$script:UpdateInfo=$st;Update-UpdateBadge ([pscustomobject]@{version=$script:AppVersion;update=$st});$choice=[Windows.MessageBox]::Show("发现新版本 v$($st.latest)（当前 v$($st.current)）。`n`n现在更新并重启吗？",'检查更新','OKCancel','Question');if($choice-eq[Windows.MessageBoxResult]::OK){Update-Companion -Confirmed}}else{[Windows.MessageBox]::Show("已经是最新版本（v$script:AppVersion）。",'检查更新','OK','Information')|Out-Null}}catch{[Windows.MessageBox]::Show("检查更新失败：`n$(Get-ApiErrorMessage $_)",'Codex Companion','OK','Error')|Out-Null}});$Menu.Items.Add($CheckUpdate)|Out-Null;$WarmCurrent=New-Object Windows.Controls.MenuItem;$WarmCurrent.Header='预热当前账号';$WarmCurrent.Add_Click({$script:Status=Get-Status;$active=@($script:Status.accounts|Where-Object{$_.is_active})|Select-Object -First 1;if($null-ne$active){$shown=if([string]::IsNullOrWhiteSpace([string]$active.display_name)){[string]$active.name}else{[string]$active.display_name};Warmup-WidgetAccount ([string]$active.id) $shown}else{[Windows.MessageBox]::Show('没有找到当前账号。','Codex Companion','OK','Warning')|Out-Null}});$Menu.Items.Add($WarmCurrent)|Out-Null;$Open=New-Object Windows.Controls.MenuItem;$Open.Header='打开完整页面';$Open.Add_Click({Start-Process "http://127.0.0.1:$script:Port/"});$Menu.Items.Add($Open)|Out-Null;$Version=New-Object Windows.Controls.MenuItem;$Version.Header="Codex Companion v$script:AppVersion";$Version.IsEnabled=$false;$script:VersionItem=$Version;$Menu.Items.Add((New-Object Windows.Controls.Separator))|Out-Null;$Menu.Items.Add($Version)|Out-Null;$Exit=New-Object Windows.Controls.MenuItem;$Exit.Header='退出浮窗';$Exit.Add_Click({$Window.Close()});$Menu.Items.Add($Exit)|Out-Null;$Menu.Add_Opened({$script:MenuOpen=$true});$Menu.Add_Closed({$script:MenuOpen=$false});$Window.ContextMenu=$Menu
$script:RetryItem=$null;$script:RetryToggleBusy=$false
function Update-RetryMenuItem{
 if($null-eq$script:RetryItem){return}
 $script:RetryToggleBusy=$true
 try{
  $on=$false
  $st=Get-Status
  if($null-ne$st-and$null-ne$st.desktopRetry){$on=[bool]$st.desktopRetry.enabled}
  $script:RetryItem.IsChecked=$on
  $script:RetryItem.Header="桌面端自动重试：$(if($on){'已开启'}else{'已关闭'})"
  if($null-ne$st-and$st.PSObject.Properties['version']-and$st.version){$script:AppVersion=[string]$st.version;$Version.Header="Codex Companion v$script:AppVersion"}
 }catch{}
 $script:RetryToggleBusy=$false
}
$script:RetryItem=New-Object Windows.Controls.MenuItem;$script:RetryItem.IsCheckable=$true;$script:RetryItem.Header='桌面端自动重试';$script:RetryItem.Add_Click({if($script:RetryToggleBusy){return};$script:RetryToggleBusy=$true;$want=[bool]$script:RetryItem.IsChecked;$body=if($want){'{"desktopRetryAutoClick":true}'}else{'{"desktopRetryAutoClick":false}'};try{Invoke-RestMethod "http://127.0.0.1:$script:Port/api/config" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10|Out-Null;Update-Widget}catch{[Windows.MessageBox]::Show("切换失败：`n$(Get-ApiErrorMessage $_)",'Codex Companion','OK','Error')|Out-Null}finally{$script:RetryToggleBusy=$false}});if($Menu.Items.Count-ge 2){$Menu.Items.Insert(2,$script:RetryItem)|Out-Null}else{$Menu.Items.Add($script:RetryItem)|Out-Null};$Menu.Add_Opened({Update-RetryMenuItem});Update-RetryMenuItem
$StopMenu=New-Object Windows.Controls.MenuItem;$StopMenu.Header='中止运行中的对话';$StopMenu.Add_SubmenuOpened({$StopMenu.Items.Clear();$status=Get-Status;$running=@(Get-RunningTasks $status);if($running.Count-eq 0){$empty=New-Object Windows.Controls.MenuItem;$empty.Header='当前没有后台运行中的对话';$empty.IsEnabled=$false;$StopMenu.Items.Add($empty)|Out-Null}else{foreach($task in $running){$item=New-Object Windows.Controls.MenuItem;$item.Header="中止：$([string]$task.prompt)";$item.Tag=[string]$task.id;$item.Add_Click({param($sender,$eventArgs)try{Invoke-RestMethod "http://127.0.0.1:$script:Port/api/task/$([uri]::EscapeDataString([string]$sender.Tag))/stop" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 15|Out-Null;[Windows.MessageBox]::Show('已请求中止这个对话。','Codex Companion','OK','Information')|Out-Null}catch{[Windows.MessageBox]::Show("中止失败：`n$(Get-ApiErrorMessage $_)",'Codex Companion','OK','Error')|Out-Null}});$StopMenu.Items.Add($item)|Out-Null}}});$Menu.Items.Add($StopMenu)|Out-Null
$Shutdown=New-Object Windows.Controls.MenuItem;$Shutdown.Header='退出 Companion（后台与浮窗）';$Shutdown.Add_Click({$choice=[Windows.MessageBox]::Show('确定退出 Companion 后台和浮窗吗？正在运行的后台任务可能中断。','退出 Companion','YesNo','Warning');if($choice-ne[Windows.MessageBoxResult]::Yes){return};try{Invoke-RestMethod "http://127.0.0.1:$script:Port/api/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5|Out-Null}catch{};$Window.Close()});$Menu.Items.Add($Shutdown)|Out-Null
$OutsideTimer=New-Object Windows.Threading.DispatcherTimer;$OutsideTimer.Interval=[TimeSpan]::FromMilliseconds(60);$script:MouseWasDown=$false;$OutsideTimer.Add_Tick({$isDown=(([CompanionMouse]::GetAsyncKeyState(1)-band 0x8000)-ne 0);if($isDown-and-not$script:MouseWasDown){Handle-OutsidePointerDown ([System.Windows.Forms.Cursor]::Position)};$script:MouseWasDown=$isDown});$OutsideTimer.Start()
$Timer=New-Object Windows.Threading.DispatcherTimer;$Timer.Interval=[TimeSpan]::FromSeconds(60);$Timer.Add_Tick({Update-Widget});$Timer.Start();$Warm=New-Object Windows.Threading.DispatcherTimer;$Warm.Interval=[TimeSpan]::FromMilliseconds(800);$script:WarmCount=0;$Warm.Add_Tick({$script:WarmCount++;Update-Widget;if(@($script:Status.accounts).Count-gt 0-or$script:WarmCount-ge 25){$Warm.Stop()}});$Warm.Start();$Window.Add_Closed({Close-Detail;$Timer.Stop();$Warm.Stop();$OutsideTimer.Stop();try{$script:Mutex.ReleaseMutex()}catch{};[Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown('Normal')});Update-Widget;$Window.Show();Hide-FromTaskSwitcher $Window;[Windows.Threading.Dispatcher]::Run()
