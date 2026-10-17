$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Draw from a 64-unit vector canvas. Supersampling keeps the small taskbar
# versions crisp; no installed font, downloaded artwork, or image tool is used.
$assetDirectory = Join-Path $PSScriptRoot 'assets'
[System.IO.Directory]::CreateDirectory($assetDirectory) | Out-Null
$iconPath = Join-Path $assetDirectory 'channel-room.ico'
$previewPath = Join-Path $assetDirectory 'channel-room.png'
$sizes = @(16, 24, 32, 48, 64, 128, 256)

function New-RoundedRectanglePath {
    param([single]$X, [single]$Y, [single]$Width, [single]$Height, [single]$Radius)
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    [single]$diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-ChannelRoomBitmap {
    param([int]$Size)
    $sampleSize = $Size * 4
    $canvas = [System.Drawing.Bitmap]::new($sampleSize, $sampleSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#0c0f14'))
    $mint = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#b4f0ca'))
    $outline = [System.Drawing.Pen]::new($mint, 3.8)
    $outline.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $outline.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $backgroundPath = New-RoundedRectanglePath 0.6 0.6 62.8 62.8 14.5
    $televisionPath = New-RoundedRectanglePath 10.5 17 43 35 8
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.ScaleTransform(($sampleSize / 64.0), ($sampleSize / 64.0))
        $graphics.FillPath($background, $backgroundPath)
        $graphics.DrawLines($outline, [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(23, 8.5),
            [System.Drawing.PointF]::new(32, 17),
            [System.Drawing.PointF]::new(41, 8.5)
        ))
        $graphics.DrawPath($outline, $televisionPath)
        $graphics.FillPolygon($mint, [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(27.5, 25.5),
            [System.Drawing.PointF]::new(41.5, 34.5),
            [System.Drawing.PointF]::new(27.5, 43.5)
        ))

        $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $resampler = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $resampler.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $resampler.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $resampler.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $resampler.DrawImage($canvas, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))
        }
        finally { $resampler.Dispose() }
        return $bitmap
    }
    finally {
        $backgroundPath.Dispose()
        $televisionPath.Dispose()
        $outline.Dispose()
        $mint.Dispose()
        $background.Dispose()
        $graphics.Dispose()
        $canvas.Dispose()
    }
}

function ConvertTo-IconDib {
    param([System.Drawing.Bitmap]$Bitmap)
    $size = $Bitmap.Width
    $maskStride = [int]([Math]::Ceiling($size / 32.0) * 4)
    $mask = [byte[]]::new($maskStride * $size)
    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        # ICO DIBs contain bottom-up BGRA pixels followed by a one-bit AND mask.
        $writer.Write([uint32]40)
        $writer.Write([int32]$size)
        $writer.Write([int32]($size * 2))
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]0)
        $writer.Write([uint32](($size * $size * 4) + $mask.Length))
        $writer.Write([int32]0)
        $writer.Write([int32]0)
        $writer.Write([uint32]0)
        $writer.Write([uint32]0)
        for ($row = 0; $row -lt $size; $row++) {
            for ($x = 0; $x -lt $size; $x++) {
                $pixel = $Bitmap.GetPixel($x, ($size - 1 - $row))
                $writer.Write([byte]$pixel.B)
                $writer.Write([byte]$pixel.G)
                $writer.Write([byte]$pixel.R)
                $writer.Write([byte]$pixel.A)
                if ($pixel.A -eq 0) {
                    $offset = ($row * $maskStride) + [int][Math]::Floor($x / 8.0)
                    $mask[$offset] = $mask[$offset] -bor (0x80 -shr ($x % 8))
                }
            }
        }
        $writer.Write($mask)
        $writer.Flush()
        return ,$stream.ToArray()
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

$images = [System.Collections.Generic.List[byte[]]]::new()
foreach ($size in $sizes) {
    $bitmap = New-ChannelRoomBitmap $size
    try {
        if ($size -eq 256) {
            # Windows uses a PNG entry for the largest Explorer icon. Smaller
            # entries remain classic DIBs for broad Win32 resource support.
            $bitmap.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
            $images.Add([System.IO.File]::ReadAllBytes($previewPath))
        }
        else { $images.Add((ConvertTo-IconDib $bitmap)) }
    }
    finally { $bitmap.Dispose() }
}

$iconStream = [System.IO.File]::Create($iconPath)
$iconWriter = [System.IO.BinaryWriter]::new($iconStream)
try {
    $iconWriter.Write([uint16]0)
    $iconWriter.Write([uint16]1)
    $iconWriter.Write([uint16]$sizes.Length)
    $offset = 6 + (16 * $sizes.Length)
    for ($index = 0; $index -lt $sizes.Length; $index++) {
        $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
        $iconWriter.Write([byte]$dimension)
        $iconWriter.Write([byte]$dimension)
        $iconWriter.Write([byte]0)
        $iconWriter.Write([byte]0)
        $iconWriter.Write([uint16]1)
        $iconWriter.Write([uint16]32)
        $iconWriter.Write([uint32]$images[$index].Length)
        $iconWriter.Write([uint32]$offset)
        $offset += $images[$index].Length
    }
    foreach ($image in $images) { $iconWriter.Write($image) }
}
finally {
    $iconWriter.Dispose()
    $iconStream.Dispose()
}

Write-Output "Created $iconPath ($($sizes -join ', ') pixels)"
Write-Output "Created $previewPath"
