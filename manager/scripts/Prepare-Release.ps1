[CmdletBinding()]
param(
    [string]$TransportProxySource = (Join-Path $PSScriptRoot '..\..\src\MCPStdioProxy.mjs'),
    [string]$TunnelClientVersion = '0.0.14',
    [string]$DesktopCommanderVersion = '0.2.50',
    [string]$NodeVersion = '22.16.0'
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $project 'src-tauri\resources\runtime'
$proxy = Join-Path $project 'src-tauri\resources\proxy'
$stage = Join-Path $env:TEMP ('commander-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $runtime, $proxy, $stage | Out-Null

function Get-VerifiedArchive([string]$url, [string]$archive, [string]$checksumUrl) {
    $archivePath = Join-Path $stage $archive
    $sumsPath = Join-Path $stage ($archive + '.checksums')
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archivePath
    Invoke-WebRequest -UseBasicParsing -Uri $checksumUrl -OutFile $sumsPath
    $line = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($archive) + '$') } | Select-Object -First 1
    if (-not $line) { throw "Missing SHA256 checksum for $archive" }
    $expected = (($line.Trim() -split '\s+')[0]).ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "SHA256 check failed for $archive" }
    return $archivePath
}

try {
    if (-not (Test-Path -LiteralPath $TransportProxySource -PathType Leaf)) {
        throw "MCPStdioProxy.mjs not found at $TransportProxySource. Place this manager/ directory under desktop-commander-mcp-tunnel/source/ or supply -TransportProxySource."
    }
    Copy-Item -LiteralPath $TransportProxySource -Destination (Join-Path $proxy 'MCPStdioProxy.mjs') -Force

    $tunnelArchive = "tunnel-client-v$TunnelClientVersion-windows-amd64.zip"
    $tunnelBase = "https://github.com/openai/tunnel-client/releases/download/v$TunnelClientVersion"
    $tunnelZip = Get-VerifiedArchive "$tunnelBase/$tunnelArchive" $tunnelArchive "$tunnelBase/SHA256SUMS.txt"
    $tunnelExtract = Join-Path $stage 'tunnel-client'
    Expand-Archive -LiteralPath $tunnelZip -DestinationPath $tunnelExtract -Force
    $tunnelExe = Get-ChildItem -LiteralPath $tunnelExtract -Filter 'tunnel-client.exe' -Recurse -File | Select-Object -First 1
    if (-not $tunnelExe) { throw 'Missing tunnel-client.exe in verified archive.' }
    Copy-Item -LiteralPath $tunnelExe.FullName -Destination (Join-Path $runtime 'tunnel-client.exe') -Force
    $licenses = Join-Path $runtime 'licenses'
    New-Item -ItemType Directory -Path $licenses -Force | Out-Null
    foreach ($licenseFile in @('LICENSE', 'NOTICE')) {
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/openai/tunnel-client/v$TunnelClientVersion/$licenseFile" -OutFile (Join-Path $licenses "tunnel-client-$licenseFile")
    }

    $nodeArchive = "node-v$NodeVersion-win-x64.zip"
    $nodeUrlBase = "https://nodejs.org/dist/v$NodeVersion"
    $nodeZip = Get-VerifiedArchive "$nodeUrlBase/$nodeArchive" $nodeArchive "$nodeUrlBase/SHASUMS256.txt"
    $nodeExtract = Join-Path $stage 'node'
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
    $nodeExe = Get-ChildItem -LiteralPath $nodeExtract -Filter 'node.exe' -Recurse -File | Select-Object -First 1
    if (-not $nodeExe) { throw 'Missing node.exe in verified archive.' }
    Copy-Item -LiteralPath $nodeExe.FullName -Destination (Join-Path $runtime 'node.exe') -Force
    $nodeLicense = Get-ChildItem -LiteralPath $nodeExtract -Filter 'LICENSE' -Recurse -File | Select-Object -First 1
    if (-not $nodeLicense) { throw 'Node.js license file missing from the official archive.' }
    Copy-Item -LiteralPath $nodeLicense.FullName -Destination (Join-Path $licenses 'node-LICENSE') -Force

    & npm.cmd install --prefix $runtime --omit=dev --ignore-scripts --no-save --no-audit --no-fund "@wonderwhy-er/desktop-commander@$DesktopCommanderVersion"
    if ($LASTEXITCODE -ne 0) { throw 'Desktop Commander runtime install failed.' }
    $installedPkg = Join-Path $runtime 'node_modules\@wonderwhy-er\desktop-commander\package.json'
    if (-not (Test-Path $installedPkg)) { throw 'Desktop Commander package is missing.' }
    $installedVersion = [string]((Get-Content $installedPkg -Raw | ConvertFrom-Json).version)
    if ($installedVersion -ne $DesktopCommanderVersion) { throw "Unexpected Desktop Commander version: $installedVersion" }
    $dcLicense = Join-Path (Split-Path -Parent $installedPkg) 'LICENSE'
    if (-not (Test-Path -LiteralPath $dcLicense -PathType Leaf)) { throw 'Desktop Commander license file missing.' }
    Copy-Item -LiteralPath $dcLicense -Destination (Join-Path $licenses 'desktop-commander-LICENSE') -Force
    # Reapply the pinned upstream fix on every release build; never modify the user's live runtime.
    & node (Join-Path $PSScriptRoot 'Patch-DesktopCommander.mjs') $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Desktop Commander stream cleanup patch failed.' }
    Write-Output "Release resources ready: tunnel-client $TunnelClientVersion, Node $NodeVersion, Desktop Commander $DesktopCommanderVersion"
    Write-Output 'No personal credentials were copied or bundled.'
}
finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
