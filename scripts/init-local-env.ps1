$ErrorActionPreference = "Stop"
$envPath = Join-Path (Get-Location) ".env"
if (Test-Path -LiteralPath $envPath) {
  throw ".env already exists. Keep the current local values or remove the file yourself before generating a new one."
}

function New-LocalValue {
  [guid]::NewGuid().ToString("N")
}

$values = @(
  "POSTGRES_PASSWORD=$(New-LocalValue)"
  "AEGIS_DEMO_ASTER_TOKEN=$(New-LocalValue)"
  "AEGIS_DEMO_JUNIPER_TOKEN=$(New-LocalValue)"
  "AEGIS_DEMO_BUDGET_TOKEN=$(New-LocalValue)"
  "AEGIS_METRICS_TOKEN=$(New-LocalValue)"
  "GRAFANA_ADMIN_USER=admin"
  "GRAFANA_ADMIN_PASSWORD=$(New-LocalValue)"
)

[System.IO.File]::WriteAllLines($envPath, $values, [System.Text.Encoding]::ASCII)
Write-Output "Created a local .env with randomly generated values. The values were not displayed."
