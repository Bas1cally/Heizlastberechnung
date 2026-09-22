# Screenshot of the primary screen as JPEG, scaled to -Width. Used by pnpm tft when ffmpeg is not installed.
# Reads the screen like a screen recorder; nothing else.
param([Parameter(Mandatory=$true)][string]$OutPath, [int]$Width = 1600, [int]$Quality = 85)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$src = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$h = [int]($b.Height * $Width / $b.Width)
$dst = New-Object System.Drawing.Bitmap $Width, $h
$g2 = [System.Drawing.Graphics]::FromImage($dst)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($src, 0, 0, $Width, $h)
$g2.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), $Quality
$dst.Save($OutPath, $codec, $ep)
$src.Dispose(); $dst.Dispose()
