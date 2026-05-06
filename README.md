# Precinct Mapper

A dependency-free browser application for uploading yearly precinct CSV files, persisting them locally, comparing any numeric data points across years, and rendering generated precinct boundaries as a heat-map style SVG map.

## CSV expectations

- Each CSV represents one year of data.
- Multiple CSV files can be uploaded for the same year; their rows are appended.
- Every CSV must contain a `precinct` column.
- Address matching looks for `address`, `street_address`, `street address`, `location`, `full_address`, or `full address`.
- If latitude/longitude columns are present, those values are used directly. Otherwise the app geocodes addresses with OpenStreetMap Nominatim and caches results in browser storage.
- Any numeric column can be selected as a metric.

## Comparison behavior

Users can select the comparison year, choose a baseline mode (previous year, average prior years, best prior year, or specific year), select one or more metrics, and weight those metrics. The results table shows absolute and percentage deltas, while the map colors generated precinct hulls by behind score.

## Development

```bash
npm run dev
npm run build
```

`npm run dev` serves the static app with Python's built-in HTTP server. `npm run build` performs a JavaScript syntax check without installing dependencies.
