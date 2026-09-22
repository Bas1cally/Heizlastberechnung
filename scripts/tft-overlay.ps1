# TFT overlay: a small always-on-top window that shows the advisor's three lines.
# Polls http://127.0.0.1:8788/api/advice every 2 seconds. Drag it with the mouse, close with Esc.
#   powershell -ExecutionPolicy Bypass -File scripts\tft-overlay.ps1
param([string]$Url = "http://127.0.0.1:8788/api/advice")
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = "TFT-Berater"; $form.FormBorderStyle = "None"; $form.TopMost = $true; $form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 24); $form.Opacity = 0.88
$form.Size = New-Object System.Drawing.Size(440, 96)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.StartPosition = "Manual"; $form.Location = New-Object System.Drawing.Point(($screen.Width - 460), 20)
$labels = @()
foreach ($i in 0..2) {
  $l = New-Object System.Windows.Forms.Label
  $l.AutoSize = $false; $l.Width = 424; $l.Height = 26; $l.Left = 8; $l.Top = 6 + $i * 28
  $l.ForeColor = if ($i -eq 0) { [System.Drawing.Color]::FromArgb(255, 220, 120) } elseif ($i -eq 1) { [System.Drawing.Color]::White } else { [System.Drawing.Color]::FromArgb(170, 170, 180) }
  $l.Font = New-Object System.Drawing.Font("Segoe UI", $(if ($i -eq 0) { 14 } elseif ($i -eq 1) { 12 } else { 9 }), $(if ($i -eq 0) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }))
  $l.Text = if ($i -eq 0) { "TFT-Berater" } elseif ($i -eq 1) { "warte auf $Url" } else { "" }
  $form.Controls.Add($l); $labels += $l
}
$drag = $null
$down = { param($s, $e) $script:drag = New-Object System.Drawing.Point($e.X, $e.Y) }
$move = { param($s, $e) if ($script:drag) { $form.Location = New-Object System.Drawing.Point(($form.Left + $e.X - $script:drag.X), ($form.Top + $e.Y - $script:drag.Y)) } }
$up = { $script:drag = $null }
foreach ($c in @($form) + $labels) { $c.Add_MouseDown($down); $c.Add_MouseMove($move); $c.Add_MouseUp($up) }
$form.KeyPreview = $true; $form.Add_KeyDown({ param($s, $e) if ($e.KeyCode -eq "Escape") { $form.Close() } })
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 2000
$timer.Add_Tick({
  try { $j = Invoke-RestMethod -Uri $Url -TimeoutSec 2; $labels[0].Text = $j.line1; $labels[1].Text = $j.line2; $labels[2].Text = $j.line3 }
  catch { $labels[2].Text = "kein Kontakt zu pnpm tft" }
})
$timer.Start()
[void]$form.ShowDialog()
