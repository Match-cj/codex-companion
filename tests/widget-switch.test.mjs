import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
test('widget and webpage use the same account-switch action after confirmation', () => {
  const action = widget.slice(widget.indexOf('function Switch-WidgetAccount('), widget.indexOf('function Warmup-WidgetAccount('));
  assert.match(action, /api\/codex\/status/);
  assert.match(action, /MessageBoxResult\]::Yes/);
  assert.match(action, /closeCodex=\$true/);
  assert.match(action, /api\/accounts\/switch/);
  assert.doesNotMatch(action, /validateOnly/);
  assert.match(action, /activeAccountId/);
  assert.match(dashboard, /function switchAccount\(id\).*closeCodex:true/);
});
test('explicit switch button invokes the action, with dialog and status refresh', () => {
  assert.match(widget, /\$switchButton\.Content='切换账号'/);
  assert.match(widget, /\$switchButton\.Add_Click\(\{param\(\$sender,\$eventArgs\).*Switch-WidgetAccount/);
  assert.match(widget, /\$testChild\.RaiseEvent/);
  assert.match(widget, /SwitchButtonInvocations/);
});
