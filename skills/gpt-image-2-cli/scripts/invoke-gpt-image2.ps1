[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Prompt,

  [string]$Out,

  [string]$Size = '1536x1024',

  [ValidateSet('low', 'medium', 'high', 'auto')]
  [string]$Quality = 'high',

  [string]$Model = 'gpt-image-2',

  [string]$CodexHome,

  [string]$ImageGenCli,

  [string]$BaseUrl,

  [string]$Python,

  [switch]$Force,

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Resolve-ExecutableCandidate {
  param([string]$Candidate)

  if (-not $Candidate) {
    return $null
  }

  $trimmed = $Candidate.Trim().Trim('"')
  if (-not $trimmed) {
    return $null
  }

  if (Test-Path -LiteralPath $trimmed -PathType Leaf) {
    return (Resolve-Path -LiteralPath $trimmed).Path
  }

  $commands = @(Get-Command $trimmed -CommandType Application -ErrorAction SilentlyContinue)
  if ($commands.Count -gt 0) {
    return $commands[0].Source
  }

  return $null
}

function Resolve-PythonCommand {
  param([string]$ExplicitCommand)

  if ($ExplicitCommand) {
    $resolved = Resolve-ExecutableCandidate -Candidate $ExplicitCommand
    if ($resolved) {
      return $resolved
    }

    throw "Python interpreter was not found: $ExplicitCommand"
  }

  if ($env:PYTHON) {
    $resolved = Resolve-ExecutableCandidate -Candidate $env:PYTHON
    if ($resolved) {
      return $resolved
    }
  }

  foreach ($candidate in @('python3', 'python', 'py')) {
    $resolved = Resolve-ExecutableCandidate -Candidate $candidate
    if ($resolved) {
      return $resolved
    }
  }

  throw 'Could not find Python. Install Python 3 or pass -Python with the interpreter path.'
}

$helper = Join-Path $PSScriptRoot 'invoke_gpt_image2.py'
if (-not (Test-Path -LiteralPath $helper)) {
  throw "Portable helper was not found: $helper"
}

$pythonCommand = Resolve-PythonCommand -ExplicitCommand $Python

$cliArgs = @(
  $helper,
  '--prompt', $Prompt,
  '--size', $Size,
  '--quality', $Quality,
  '--model', $Model
)

if ($Out) {
  $cliArgs += @('--out', $Out)
}

if ($CodexHome) {
  $cliArgs += @('--codex-home', $CodexHome)
}

if ($ImageGenCli) {
  $cliArgs += @('--imagegen-cli', $ImageGenCli)
}

if ($BaseUrl) {
  $cliArgs += @('--base-url', $BaseUrl)
}

if ($Force) {
  $cliArgs += '--force'
}

if ($DryRun) {
  $cliArgs += '--dry-run'
}

& $pythonCommand @cliArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
