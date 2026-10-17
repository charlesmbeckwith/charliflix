$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Rebuild the macOS icon from Channel Room's own 64-unit TV artwork.
# Every representation is drawn at its actual pixel size; no font, downloaded
# image, iconutil installation, or other build dependency is required.
$assetDirectory = Join-Path $PSScriptRoot 'assets'
[System.IO.Directory]::CreateDirectory($assetDirectory) | Out-Null
$iconPath = Join-Path $assetDirectory 'channel-room.icns'
$previewPath = Join-Path $assetDirectory 'channel-room.png'
$sizes = @(16, 32, 64, 128, 256, 512, 1024)
$representations = @(
    @{ Type = 'icp4'; Size = 16 },
    @{ Type = 'icp5'; Size = 32 },
    @{ Type = 'icp6'; Size = 64 },
    @{ Type = 'ic07'; Size = 128 },
    @{ Type = 'ic08'; Size = 256 },
    @{ Type = 'ic09'; Size = 512 },
    @{ Type = 'ic10'; Size = 1024 },
    @{ Type = 'ic11'; Size = 32 },   # 16 points at 2x
    @{ Type = 'ic12'; Size = 64 },   # 32 points at 2x
    @{ Type = 'ic13'; Size = 256 },  # 128 points at 2x
    @{ Type = 'ic14'; Size = 512 }   # 256 points at 2x
)

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

function New-ChannelRoomPng {
    param([int]$Size)
    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#0c0f14'))
    $mint = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#b4f0ca'))
    $outline = [System.Drawing.Pen]::new($mint, 3.8)
    $outline.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $outline.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $backgroundPath = New-RoundedRectanglePath 0.6 0.6 62.8 62.8 14.5
    $televisionPath = New-RoundedRectanglePath 10.5 17 43 35 8
    $stream = [System.IO.MemoryStream]::new()
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.ScaleTransform(($Size / 64.0), ($Size / 64.0))
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
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    }
    finally {
        $stream.Dispose()
        $backgroundPath.Dispose()
        $televisionPath.Dispose()
        $outline.Dispose()
        $mint.Dispose()
        $background.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Write-BigEndianUInt32 {
    param([System.IO.BinaryWriter]$Writer, [uint32]$Value)
    $bytes = [System.BitConverter]::GetBytes($Value)
    if ([System.BitConverter]::IsLittleEndian) { [System.Array]::Reverse($bytes) }
    $Writer.Write($bytes)
}

function Read-BigEndianUInt32 {
    param([byte[]]$Bytes, [int]$Offset)
    $value = [byte[]]::new(4)
    [System.Array]::Copy($Bytes, $Offset, $value, 0, 4)
    if ([System.BitConverter]::IsLittleEndian) { [System.Array]::Reverse($value) }
    return [System.BitConverter]::ToUInt32($value, 0)
}

$images = @{}
foreach ($size in $sizes) { $images[$size] = New-ChannelRoomPng $size }
[System.IO.File]::WriteAllBytes($previewPath, $images[1024])

[uint32]$totalLength = 8
foreach ($representation in $representations) { $totalLength += 8 + $images[$representation.Size].Length }
$iconStream = [System.IO.File]::Create($iconPath)
$writer = [System.IO.BinaryWriter]::new($iconStream)
try {
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('icns'))
    Write-BigEndianUInt32 $writer $totalLength
    foreach ($representation in $representations) {
        $png = $images[$representation.Size]
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes($representation.Type))
        Write-BigEndianUInt32 $writer (8 + $png.Length)
        $writer.Write($png)
    }
}
finally {
    $writer.Dispose()
    $iconStream.Dispose()
}

# Independently parse the written container so a malformed length or mismatched
# Retina representation fails the build before the asset is packaged.
$iconBytes = [System.IO.File]::ReadAllBytes($iconPath)
if ([System.Text.Encoding]::ASCII.GetString($iconBytes, 0, 4) -ne 'icns' -or
    (Read-BigEndianUInt32 $iconBytes 4) -ne $iconBytes.Length) {
    throw 'Invalid ICNS container header or total length.'
}
$offset = 8
$pngSignature = [byte[]]@(137, 80, 78, 71, 13, 10, 26, 10)
foreach ($representation in $representations) {
    if (($offset + 32) -gt $iconBytes.Length) { throw 'Truncated ICNS element.' }
    $type = [System.Text.Encoding]::ASCII.GetString($iconBytes, $offset, 4)
    $length = Read-BigEndianUInt32 $iconBytes ($offset + 4)
    if ($type -ne $representation.Type -or $length -lt 32 -or ($offset + $length) -gt $iconBytes.Length) {
        throw "Invalid ICNS element $type."
    }
    for ($index = 0; $index -lt $pngSignature.Length; $index++) {
        if ($iconBytes[$offset + 8 + $index] -ne $pngSignature[$index]) { throw "Non-PNG ICNS element $type." }
    }
    if ([System.Text.Encoding]::ASCII.GetString($iconBytes, ($offset + 20), 4) -ne 'IHDR') {
        throw "Missing PNG dimensions for $type."
    }
    $width = Read-BigEndianUInt32 $iconBytes ($offset + 24)
    $height = Read-BigEndianUInt32 $iconBytes ($offset + 28)
    if ($width -ne $representation.Size -or $height -ne $representation.Size) {
        throw "Unexpected PNG dimensions for $type`: ${width}x${height}."
    }
    $offset += $length
}
if ($offset -ne $iconBytes.Length) { throw 'Unexpected trailing ICNS data.' }

Write-Output "Created and validated $iconPath ($($representations.Length) PNG representations)"
Write-Output "Created $previewPath (1024 x 1024 pixels)"
