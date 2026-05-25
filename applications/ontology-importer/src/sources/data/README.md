<!-- @format -->

# Committed registry exports

These JSON files are committed snapshots used by the cloud "file" sources. No
source hits a live API at runtime — refresh them manually and commit the result.

## `gcp-services.json` (GcpServiceUsageSource)

A trimmed export of the GCP Service Usage catalogue. Each entry is
`{ "config": { "name": "<svc>.googleapis.com", "title": "<Title> API" } }`.

Refresh:

```sh
gcloud services list --available --format=json \
  | jq '{ services: [ .[] | { config: { name: .config.name, title: .config.title } } ] }' \
  > gcp-services.json
```

(Or pull from `gcloud services list --available` and reshape to the above.)

## `azure-services.json` (AzureRestSpecsSource)

The list of top-level service directories under `specification/` in the
[`Azure/azure-rest-api-specs`](https://github.com/Azure/azure-rest-api-specs)
repository.

Refresh:

```sh
ls specification/ | jq -R . | jq -s '{ services: . }' > azure-services.json
```
