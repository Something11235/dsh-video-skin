# install.ps1 -- link this plugin into a DSH profile (see README.zh.md section 2).
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 decodes a BOM-less file with the
# system ANSI code page, which mangles CJK bytes badly enough to break string terminators.
#
# NOTE: the parameter is `-DshHome`, NOT `-Home`. `$HOME` is a read-only automatic variable in
# PowerShell and assigning to it aborts the script ("Cannot overwrite variable Home").
# All logic lives in scripts/profile-link.mjs (Node); this is only a launcher.
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir 'profile-link.mjs'

function Resolve-Node {
  $candidates = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  if ($env:DSH_HOME) {
    $candidates += (Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  }
  $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw 'node not found. Install Node.js or point PATH at it.'
}

$node = Resolve-Node
$arguments = @($runner, 'install', '--profile', $Profile)
if ($DshHome -ne '') { $arguments += @('--home', $DshHome) }

& $node @arguments
exit $LASTEXITCODE
