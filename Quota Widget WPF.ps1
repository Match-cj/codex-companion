param([int]$Port = 17841,[switch]$SelfTest)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms
Add-Type 'using System; using System.Runtime.InteropServices; public static class CompanionMouse { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags); [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr hwnd, int index); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
$script:Port=$Port; $script:AppVersion='0.7.42'; $script:Status=$null; $script:Detail=$null; $script:DetailClosedAt=[DateTime]::MinValue; $script:SwitchableCardsBuilt=0; $script:SwitchGestureCardsBuilt=0; $script:SwitchButtonCardsBuilt=0; $script:SwitchButtonInvocations=0; $script:LoginExpiredCardsBuilt=0; $script:SwitchInProgress=$false; $script:WarmupInProgress=$false
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
$ProBadgeBg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(77,57,24))
$ProBadgeFg=New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromRgb(255,211,112))
function Get-Status{try{Invoke-RestMethod "http://127.0.0.1:$script:Port/api/status" -TimeoutSec 8}catch{$null}}
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
function Get-Remaining($a,$prefix){if($null -eq $a -or $null -eq $a.usage){return $null};$used=$a.usage.($prefix+'_used_percent');if($null -eq $used){return $null};[Math]::Max(0,[Math]::Min(100,[int](100-[double]$used)))}
function Test-LoginExpired($a){
 if($null-eq$a-or$null-eq$a.usage){return $false}
 $message=[string]$a.usage.error
 return (-not[string]::IsNullOrWhiteSpace($message))-and($message-match'登录.*失效|重新登录|invalid refresh token|refresh token|token.{0,30}expired|token_expired')
}
function Get-Countdown($a,$prefix){try{$seconds=[int64]$a.usage.($prefix+'_resets_at')-[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();if($seconds-le 0){return '已重置'};$d=[Math]::Floor($seconds/86400);$h=[Math]::Floor(($seconds%86400)/3600);$m=[Math]::Floor(($seconds%3600)/60);if($d-gt 0){return "${d}天${h}小时"};if($h-gt 0){return "${h}小时${m}分"};return "${m}分"}catch{'--'}}
function Get-Expiry($a){try{$raw=$a.reset_credits_expires_at;if(-not $raw){return '--'};$seconds=[DateTimeOffset]::Parse([string]$raw).ToUnixTimeSeconds()-[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();if($seconds-le 0){return '已到期'};('{0}天{1}小时'-f [Math]::Floor($seconds/86400),[Math]::Floor(($seconds%86400)/3600))}catch{'--'}}
function Get-Color($r){if($r-le 15){$Red}elseif($r-le 35){$Yellow}else{$Green}}
function New-Text($text,$size,$color,[switch]$bold){$t=New-Object Windows.Controls.TextBlock;$t.Text=[string]$text;$t.FontFamily='Microsoft YaHei UI';$t.FontSize=$size;$t.Foreground=$color;if($bold){$t.FontWeight='Bold'};$t}
function New-PlanBadge($plan){
 $isPro=([string]$plan).ToLowerInvariant()-eq'pro'
 $badgeText=if($isPro){'Pro'}else{'Plus'}
 $badgeBackground=if($isPro){$ProBadgeBg}else{$PlusBadgeBg}
 $badgeForeground=if($isPro){$ProBadgeFg}else{$PlusBadgeFg}
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
$Window=New-Object Windows.Window;$Window.Width=72;$Window.Height=72;$Window.WindowStyle='None';$Window.ResizeMode='NoResize';$Window.AllowsTransparency=$true;$Window.Background=$Transparent;$Window.Topmost=$true;$Window.ShowInTaskbar=$false;$Window.UseLayoutRounding=$true;$Window.SnapsToDevicePixels=$true
function Ensure-WidgetTopmost{
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
function Set-Arc($r){if($r-le 0){$Arc.Data=$null;return};$c=36;$radius=28;$start=-90;$end=$start+(3.599*[Math]::Min(99.9,$r));$a1=$start*[Math]::PI/180;$a2=$end*[Math]::PI/180;$p1=New-Object Windows.Point -ArgumentList ($c+$radius*[Math]::Cos($a1)),($c+$radius*[Math]::Sin($a1));$p2=New-Object Windows.Point -ArgumentList ($c+$radius*[Math]::Cos($a2)),($c+$radius*[Math]::Sin($a2));$g=New-Object Windows.Media.StreamGeometry;$ctx=$g.Open();$ctx.BeginFigure($p1,$false,$false);$ctx.ArcTo($p2,(New-Object Windows.Size -ArgumentList $radius,$radius),0,(($end-$start)-gt 180),[Windows.Media.SweepDirection]::Clockwise,$true,$false);$ctx.Close();$g.Freeze();$Arc.Data=$g}
function Update-Widget{$script:Status=Get-Status;$a=$script:Status.accounts|Where-Object{$_.is_active}|Select-Object -First 1;if(Test-LoginExpired $a){$Number.Text='!';$Number.Foreground=$Red;$Arc.Data=$null;return};$r=Get-Remaining $a 'primary';if($null-eq$r){$r=Get-Remaining $a 'secondary'};if($null-eq$r){$Number.Text='--';$Arc.Data=$null;return};$color=Get-Color $r;$Number.Text=[string]$r;$Number.Foreground=$color;$Arc.Stroke=$color;Set-Arc $r}
function Close-Detail{if($null-ne$script:Detail){$d=$script:Detail;$script:Detail=$null;$script:DetailClosedAt=[DateTime]::UtcNow;try{$d.Close()}catch{}}}
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
function Switch-WidgetAccount($accountId,$accountName){
 if($SelfTest){$script:SwitchButtonInvocations++;return}
 if($script:SwitchInProgress){return}
 try{
  $ErrorActionPreference='Stop'
  $state=Invoke-RestMethod "http://127.0.0.1:$script:Port/api/codex/status" -TimeoutSec 8
  $desktopText=if($state.running){'检测到 ChatGPT/Codex 正在运行；确认后会先将它关闭，切换成功再自动重新打开。'}else{'确认后会切换账号，并自动打开 ChatGPT/Codex。'}
  $choice=[Windows.MessageBox]::Show("确定切换到【${accountName}】吗？`n`n$desktopText`n`n正在运行的桌面端任务可能中断。",'确认切换账号','YesNo','Warning')
  if($choice-ne[Windows.MessageBoxResult]::Yes){return}
  $script:SwitchInProgress=$true
  [Windows.Input.Mouse]::OverrideCursor=[Windows.Input.Cursors]::Wait
  $payload=@{id=$accountId;closeCodex=$true;source='widget'}|ConvertTo-Json -Compress
  $result=Invoke-RestMethod "http://127.0.0.1:$script:Port/api/accounts/switch" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 90
  if($result.ok -ne $true){throw '后台没有确认账号切换成功。'}
  if([string]$result.activeAccountId -ne [string]$accountId){throw "切换后校验失败：当前账号没有改变。请打开网页查看详细状态。"}
  Close-Detail
  Update-Widget
  [Windows.MessageBox]::Show([string]$result.message,'Codex Companion','OK','Information')|Out-Null
 }catch{
  [Windows.MessageBox]::Show("账号切换失败：`n$(Get-ApiErrorMessage $_)",'Codex Companion','OK','Error')|Out-Null
 }finally{$script:SwitchInProgress=$false;[Windows.Input.Mouse]::OverrideCursor=$null}
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
 foreach($a in $accounts){
  $card=New-Object Windows.Controls.Border;$card.Background=$CardBrush;$card.CornerRadius=7;$card.Padding='10,7';$card.Margin='0,0,0,7'
  $content=New-Object Windows.Controls.StackPanel;$card.Child=$content
  $head=New-Object Windows.Controls.StackPanel;$head.Orientation='Horizontal'
  $badge=New-PlanBadge $a.plan_type;$head.Children.Add($badge)|Out-Null
  $shownName=if([string]::IsNullOrWhiteSpace([string]$a.display_name)){[string]$a.name}else{[string]$a.display_name}
  $nc=if($a.is_active){$Green}else{$White};$prefix=if($a.is_active){'● '}else{''};$name=New-Text ($prefix+$shownName) 12 $nc -bold;if(-not[string]::IsNullOrWhiteSpace([string]$a.alias)){$name.ToolTip=[string]$a.name};$head.Children.Add($name)|Out-Null;$content.Children.Add($head)|Out-Null
  $loginExpired=Test-LoginExpired $a
  if($loginExpired){$warning=New-Text '登录已失效 · 请在网页重新登录' 11 $Red -bold;$warning.Margin='0,5,0,2';$content.Children.Add($warning)|Out-Null;$script:LoginExpiredCardsBuilt++}
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
  $cardMenu.Items.Add($warmItem)|Out-Null;$card.ContextMenu=$cardMenu
  if((-not$a.is_active)-and(-not$loginExpired)){
    $card.Cursor=[Windows.Input.Cursors]::Hand;$card.ToolTip="双击切换到 $shownName"
    $card.Tag=@{Id=[string]$a.id;Name=[string]$shownName;LastClick=[DateTime]::MinValue}
   $switchHandler={
    param($sender,$eventArgs)
    $source=$eventArgs.OriginalSource
    while($null-ne$source-and$source-ne$sender){
     if($source -is [Windows.Controls.Button]){return}
     $source=[Windows.Media.VisualTreeHelper]::GetParent($source)
    }
    $now=[DateTime]::UtcNow
    $elapsed=($now-$sender.Tag.LastClick).TotalMilliseconds
    $sender.Tag.LastClick=$now
    if($eventArgs.ClickCount-ge 2-or($elapsed-ge 0-and$elapsed-le[System.Windows.Forms.SystemInformation]::DoubleClickTime)){
     $eventArgs.Handled=$true
     $sender.Tag.LastClick=[DateTime]::MinValue
     Switch-WidgetAccount ([string]$sender.Tag.Id) ([string]$sender.Tag.Name)
    }
   }
   $card.Add_PreviewMouseLeftButtonDown($switchHandler)
   $switchButton=New-Object Windows.Controls.Button
   $switchButton.Content='切换账号'
   $switchButton.FontFamily='Microsoft YaHei UI';$switchButton.FontSize=11
   $switchButton.Margin='0,6,0,0';$switchButton.Padding='9,3';$switchButton.HorizontalAlignment='Left'
   $switchButton.Background=$Disc;$switchButton.Foreground=$White;$switchButton.BorderBrush=$Muted;$switchButton.BorderThickness=1
   $switchButton.Tag=@{Id=[string]$a.id;Name=[string]$shownName}
   $switchButton.Add_Click({param($sender,$eventArgs) $eventArgs.Handled=$true;Switch-WidgetAccount ([string]$sender.Tag.Id) ([string]$sender.Tag.Name)})
   $content.Children.Add($switchButton)|Out-Null
   $script:SwitchableCardsBuilt++
   $script:SwitchGestureCardsBuilt++
   $script:SwitchButtonCardsBuilt++
  }
  $stack.Children.Add($card)|Out-Null
 }
 $d.Add_Closed({$script:Detail=$null;$script:DetailClosedAt=[DateTime]::UtcNow})
 $stack.Measure([Windows.Size]::new(402,[double]::PositiveInfinity))
 $total=$stack.DesiredSize.Height+18
 $d.Height=[Math]::Max(80,$total)
 $work=Get-WidgetMonitorWorkArea;$left=$Window.Left+(($Window.ActualWidth-$d.Width)/2);$left=[Math]::Max($work.Left+4,[Math]::Min($left,$work.Right-$d.Width-4));$below=$Window.Top+$Window.ActualHeight+6;$top=if(($below+$d.Height)-le$work.Bottom){$below}else{$Window.Top-$d.Height-6};$d.Left=$left;$d.Top=[Math]::Max($work.Top+4,[Math]::Min($top,$work.Bottom-$d.Height-4));if(-not$SelfTest){$d.Show()}
}
if($SelfTest){
 $Error.Clear()
 $Window.Opacity=0;$Window.Show();$Window.UpdateLayout()
 $testHandle=(New-Object Windows.Interop.WindowInteropHelper($Window)).Handle
 [CompanionMouse]::SetWindowPos($testHandle,[IntPtr]::new(-2),0,0,0,0,0x13)|Out-Null
 $foregroundBefore=[CompanionMouse]::GetForegroundWindow()
 Ensure-WidgetTopmost
 $topmostRestored=([CompanionMouse]::GetWindowLong($testHandle,-20)-band 8)-ne 0
 $noFocusSteal=$foregroundBefore-eq[CompanionMouse]::GetForegroundWindow()
 Update-Widget
 Show-Detail
 $stackForTest=$script:Detail.Content.Child
 foreach($testCard in @($stackForTest.Children)){
  foreach($testChild in @($testCard.Child.Children)){
   if($testChild -is [Windows.Controls.Button] -and [string]$testChild.Content -eq '切换账号'){
    $testChild.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent,$testChild))
   }
  }
 }
 [pscustomobject]@{AccountsFromApi=@($script:Status.accounts).Count;CardsBuilt=@($stackForTest.Children).Count;LoginExpiredCards=$script:LoginExpiredCardsBuilt;SwitchableCards=$script:SwitchableCardsBuilt;SwitchGestureCards=$script:SwitchGestureCardsBuilt;SwitchButtonCards=$script:SwitchButtonCardsBuilt;SwitchButtonInvocations=$script:SwitchButtonInvocations;PanelHeight=[Math]::Round($script:Detail.Height,1);TopmostRestored=$topmostRestored;NoFocusSteal=$noFocusSteal;RuntimeErrors=$Error.Count;Errors=@($Error|ForEach-Object{$_.InvocationInfo.PositionMessage+' :: '+$_.Exception.Message})}|ConvertTo-Json -Compress -Depth 3
 Close-Detail
 $Window.Close()
 try{$script:Mutex.ReleaseMutex()}catch{}
 exit
}
$TopmostTimer=New-Object Windows.Threading.DispatcherTimer
$TopmostTimer.Interval=[TimeSpan]::FromSeconds(2)
$TopmostTimer.Add_Tick({Ensure-WidgetTopmost})
$TopmostTimer.Start()
$Window.Add_Closed({$TopmostTimer.Stop()})
$Window.Add_ContentRendered({Ensure-WidgetTopmost})
$Window.Add_MouseLeftButtonDown({$hadDetail=$null-ne$script:Detail;if($hadDetail){Close-Detail};$start=[System.Windows.Forms.Cursor]::Position;try{$Window.DragMove()}catch{};$end=[System.Windows.Forms.Cursor]::Position;$distance=[Math]::Abs($end.X-$start.X)+[Math]::Abs($end.Y-$start.Y);if($distance-le 3-and-not$hadDetail){Show-Detail}})
$Menu=New-Object Windows.Controls.ContextMenu;$Refresh=New-Object Windows.Controls.MenuItem;$Refresh.Header='立即刷新额度';$Refresh.Add_Click({Update-Widget});$Menu.Items.Add($Refresh)|Out-Null;$WarmCurrent=New-Object Windows.Controls.MenuItem;$WarmCurrent.Header='预热当前账号';$WarmCurrent.Add_Click({$script:Status=Get-Status;$active=@($script:Status.accounts|Where-Object{$_.is_active})|Select-Object -First 1;if($null-ne$active){$shown=if([string]::IsNullOrWhiteSpace([string]$active.display_name)){[string]$active.name}else{[string]$active.display_name};Warmup-WidgetAccount ([string]$active.id) $shown}else{[Windows.MessageBox]::Show('没有找到当前账号。','Codex Companion','OK','Warning')|Out-Null}});$Menu.Items.Add($WarmCurrent)|Out-Null;$Open=New-Object Windows.Controls.MenuItem;$Open.Header='打开完整页面';$Open.Add_Click({Start-Process "http://127.0.0.1:$script:Port/"});$Menu.Items.Add($Open)|Out-Null;$Version=New-Object Windows.Controls.MenuItem;$Version.Header="Codex Companion v$script:AppVersion";$Version.IsEnabled=$false;$Menu.Items.Add((New-Object Windows.Controls.Separator))|Out-Null;$Menu.Items.Add($Version)|Out-Null;$Exit=New-Object Windows.Controls.MenuItem;$Exit.Header='退出浮窗';$Exit.Add_Click({$Window.Close()});$Menu.Items.Add($Exit)|Out-Null;$Window.ContextMenu=$Menu
$OutsideTimer=New-Object Windows.Threading.DispatcherTimer;$OutsideTimer.Interval=[TimeSpan]::FromMilliseconds(60);$script:MouseWasDown=$false;$OutsideTimer.Add_Tick({$isDown=(([CompanionMouse]::GetAsyncKeyState(1)-band 0x8000)-ne 0);if($isDown-and-not$script:MouseWasDown-and$null-ne$script:Detail){$cursor=[System.Windows.Forms.Cursor]::Position;$mainOrigin=$Window.PointToScreen([Windows.Point]::new(0,0));$detailOrigin=$script:Detail.PointToScreen([Windows.Point]::new(0,0));$insideMain=$cursor.X-ge$mainOrigin.X-and$cursor.X-le($mainOrigin.X+$Window.ActualWidth)-and$cursor.Y-ge$mainOrigin.Y-and$cursor.Y-le($mainOrigin.Y+$Window.ActualHeight);$insideDetail=$cursor.X-ge$detailOrigin.X-and$cursor.X-le($detailOrigin.X+$script:Detail.ActualWidth)-and$cursor.Y-ge$detailOrigin.Y-and$cursor.Y-le($detailOrigin.Y+$script:Detail.ActualHeight);if(-not$insideMain-and-not$insideDetail){Close-Detail}};$script:MouseWasDown=$isDown});$OutsideTimer.Start()
$Timer=New-Object Windows.Threading.DispatcherTimer;$Timer.Interval=[TimeSpan]::FromSeconds(60);$Timer.Add_Tick({Update-Widget});$Timer.Start();$Warm=New-Object Windows.Threading.DispatcherTimer;$Warm.Interval=[TimeSpan]::FromMilliseconds(800);$script:WarmCount=0;$Warm.Add_Tick({$script:WarmCount++;Update-Widget;if(@($script:Status.accounts).Count-gt 0-or$script:WarmCount-ge 25){$Warm.Stop()}});$Warm.Start();$Window.Add_Closed({Close-Detail;$Timer.Stop();$Warm.Stop();$OutsideTimer.Stop();try{$script:Mutex.ReleaseMutex()}catch{};[Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown('Normal')});Update-Widget;$Window.Show();[Windows.Threading.Dispatcher]::Run()
