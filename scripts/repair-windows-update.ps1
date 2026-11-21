param(
    [string]$ProjectDir = "."
)

$ErrorActionPreference = "Stop"
$tag = "v0.1.44"
$repository = "ghcr.io/koupent"
$utf8 = New-Object System.Text.UTF8Encoding($false)

Push-Location -LiteralPath $ProjectDir
try {
    $root = (Get-Location).Path
    $composeFile = Join-Path $root "docker-compose.yml"
    $startFile = Join-Path $root "start.bat"
    $versionFile = Join-Path $root "VERSION"
    $compose = [IO.File]::ReadAllText($composeFile)
    $start = [IO.File]::ReadAllText($startFile)
    if (Test-Path -LiteralPath $versionFile) {
        $installed = [IO.File]::ReadAllText($versionFile).Trim().TrimStart("v")
        if ([version]$installed -gt [version]$tag.TrimStart("v")) {
            throw "This repair targets $tag. The installation records a newer release."
        }
    }
    if ($env:COMPOSE_FILE -or (Get-ChildItem -Name -File -Filter '*compose.override.*')) {
        throw "This installation uses a Compose override. Its image and port settings need to be checked first."
    }

    foreach ($image in @("trailmate-mc", "trailmate-dashboard")) {
        $pattern = '(?m)^(    image: ' + [regex]::Escape("$repository/${image}:") + ')[^\s#]+'
        if ([regex]::Matches($compose, $pattern).Count -ne 1) {
            throw "Could not identify the stock image entry for $image."
        }
        $compose = [regex]::Replace($compose, $pattern, '${1}' + $tag)
    }
    if ($compose -notmatch '(?m)^      DASHBOARD_BIND:') {
        $compose = $compose -creplace '(?m)^(      DASHBOARD_PORT: 8787)(\r?\n)', '$1$2      DASHBOARD_BIND: 0.0.0.0$2'
    }
    $compose = $compose -creplace '(?m)^(      - )"?(?:0\.0\.0\.0:)?(\d+):8787"?[ \t]*(?=\r?$)', '$1"127.0.0.1:$2:8787"'
    if ($compose -notmatch '(?m)^      DASHBOARD_BIND: 0\.0\.0\.0\s*$' -or
        $compose -notmatch '(?m)^      - "127\.0\.0\.1:\d+:8787"\s*$') {
        throw "Could not confirm the dashboard's localhost port mapping."
    }

    # Old restart.bat delegates to start.bat. Keep its startup steps and replace the two builds.
    if ($start -notmatch 'docker compose up -d --no-build dashboard') {
        foreach ($service in @("trailmate", "dashboard")) {
            $pattern = '(?m)^docker compose up -d --build ' + $service + '(?=\r?$)'
            if ([regex]::Matches($start, $pattern).Count -ne 1) {
                throw "Could not identify the stock start.bat command for $service."
            }
            $start = [regex]::Replace($start, $pattern, "docker compose pull $service`r`nif errorlevel 1 exit /b 1`r`ndocker compose up -d --no-build $service")
        }
    }

    foreach ($image in @("trailmate-mc", "trailmate-dashboard")) {
        docker pull "$repository/${image}:$tag"
        if ($LASTEXITCODE -ne 0) { throw "Failed to pull $image at $tag." }
    }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    Copy-Item -LiteralPath $composeFile -Destination "$composeFile.before-repair-$stamp"
    Copy-Item -LiteralPath $startFile -Destination "$startFile.before-repair-$stamp"
    [IO.File]::WriteAllText($composeFile, $compose, $utf8)
    [IO.File]::WriteAllText($startFile, $start, $utf8)

    docker compose up -d --no-build --wait trailmate dashboard
    if ($LASTEXITCODE -ne 0) { throw "Compose failed to start the release containers." }

    $port = docker compose port dashboard 8787
    if ($LASTEXITCODE -ne 0 -or $port -notmatch '^127\.0\.0\.1:\d+$') {
        throw "Could not locate the dashboard's localhost port."
    }
    $running = docker compose exec -T dashboard node -p process.env.DASHBOARD_VERSION
    if ($LASTEXITCODE -ne 0 -or $running -ne $tag) { throw "The running dashboard did not report $tag." }
    $url = "http://$port"
    $page = Invoke-WebRequest -Uri "$url/" -UseBasicParsing -TimeoutSec 15
    if ($page.Content -notmatch 'play-auth-tab') { throw "The updated dashboard UI could not be confirmed at $url." }
    [IO.File]::WriteAllText($versionFile, "$tag`n", $utf8)
    Write-Host "Dashboard $tag verified at $url"
}
finally {
    Pop-Location
}
