# 2maps-loader

CLI tool for downloading raster map tiles to MBTiles format.

## Features

- Download map tiles from any tile server
- Support for multiple zoom levels
- Parallel downloading with configurable concurrency
- Output in MBTiles format (SQLite database)
- Progress tracking

## Use with docker

Modify the docker-compose.yml file and run 

```bash
docker-compose up -d

# expor
docker save tiles2mbtiles:latest | xz -z > ./tiles2mbtiles.tar.xz
```

## Installation

```bash
npm install
```

## Usage


### Download Command

Download map tiles to MBTiles format using any two box corners:

```bash
node index.js download --corner1 "55.7558,37.6173" \
                       --corner2 "55.7510,37.6250" \
                       --max-zoom 13 \
                       --url-template "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png" \
                       --output "moscow.mbtiles" \
                       --concurrency 5
```

#### Download Parameters

- `--corner1`: First corner coordinates in format "lat,lng"
- `--corner2`: Second corner coordinates in format "lat,lng"  
- `--max-zoom`: Maximum zoom level (0-20+)
- `--url-template`: URL template for tiles with {z}, {x}, {y} placeholders
- `--output`: Output MBTiles file path
- `--concurrency`: Number of concurrent downloads (default: 5)
- `--batch-size`: Single batch downloads count (default: 1000)
- `--convert-pmtiles`: Automatically convert output to PMTiles format after download
- `--pmtiles-path <path>`: Path to pmtiles executable (default: same directory)

### Test Command

Render an image from MBTiles database to verify downloaded tiles:

```bash
node index.js test --input "moscow.mbtiles" --output "preview.png"
```

#### Test Parameters

- `--input`: Input MBTiles file path
- `--output`: Output image file path (supports .png, .jpg, .jpeg)

### Example URL Templates

- OpenStreetMap: `https://a.tile.openstreetmap.org/{z}/{x}/{y}.png`
- CartoDB: `https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`
- ESRI: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`

## MBTiles Format

The tool creates a SQLite database with the following structure:

- `metadata` table: Contains map metadata
- `tiles` table: Contains tile data with columns (zoom_level, tile_column, tile_row, tile_data)

## License

MIT
