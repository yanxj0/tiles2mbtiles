# 2maps-loader (Go Version)

A Go implementation of the 2maps-loader CLI tool for downloading raster map tiles to MBTiles format.

## Features

- **Download map tiles** from any tile server to MBTiles format
- **Render images** from MBTiles databases
- **Generate preview images** (512x512) from MBTiles files
- **Concurrent downloading** with configurable concurrency
- **Cross-platform** support (Linux, macOS, Windows)
- **Coordinate conversion** from latitude/longitude to tile coordinates
- **MBTiles specification** compliant database creation

## Installation

### From Source

```bash
git clone https://github.com/your-username/2maps-loader.git
cd 2maps-loader/go
go build -o 2maps-loader main.go
```

### From Releases

Download the pre-built binary for your platform from the [Releases page](https://github.com/your-username/2maps-loader/releases).

## Usage


### Download Map Tiles

```bash
./2maps-loader download \
  --corner1 "37.8,-122.5" \
  --corner2 "37.7,-122.4" \
  --max-zoom 10 \
  --zoom 10 \
  --referer "https://retromap.ru/" \
  --url-template "https://tile.openstreetmap.org/{z}/{x}/{y}.png" \
  --output map.mbtiles \
  --concurrency 5
```

**Parameters:**
- `--corner1`, `--corner2`: Two corner coordinates in "lat,lng" format
- `--max-zoom`: Maximum zoom level to download (0-20+)
- `--zoom`: (Optional) Download only this zoom level
- `--referer`: (Optional) Referer header to send with tile requests
- `--url-template`: URL template with {z}, {x}, {y} placeholders
- `--output`: Output MBTiles file path
- `--concurrency`: Number of concurrent downloads (default: 5)

### Render Image from MBTiles

```bash
./2maps-loader test \
  --input map.mbtiles \
  --output map.png
```

**Parameters:**
- `--input`: Input MBTiles file path
- `--output`: Output image file path (supports .png, .jpg, .jpeg)

### Generate Preview Image from MBTiles

```bash
./2maps-loader preview \
  --input map.mbtiles \
  --output preview.png
```

**Parameters:**
- `--input`: Input MBTiles file path
- `--output`: Output preview image file path (supports .png, .jpg, .jpeg)
- `--width`: Preview image width in pixels (default: 512)
- `--height`: Preview image height in pixels (default: 512)

## Supported Tile Servers

The tool works with any tile server that follows the standard {z}/{x}/{y} URL pattern:

- **OpenStreetMap**: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- **Stamen Terrain**: `https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.png`
- **CartoDB**: `https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`
- **Custom servers**: Any server with compatible URL pattern

## Examples

### Download San Francisco Area

```bash
./2maps-loader download \
  --corner1 "37.8,-122.5" \
  --corner2 "37.7,-122.4" \
  --max-zoom 14 \
  --url-template "https://tile.openstreetmap.org/{z}/{x}/{y}.png" \
  --output sf.mbtiles
```

### Render High-Resolution Image

```bash
./2maps-loader test \
  --input sf.mbtiles \
  --output sf-highres.jpg
```

## Development

### Building from Source

```bash
cd go
go build -o 2maps-loader main.go
```

### Running Tests

```bash
cd go
go test -v ./...
```

### Code Structure

- `main.go`: Main application with CLI interface
- `main_test.go`: Unit tests
- `go.mod`: Go module dependencies

### Key Components

- **TileDownloader**: Handles downloading tiles and creating MBTiles databases
- **MBTilesTester**: Handles rendering images from MBTiles databases
- **Coordinates**: Geographic coordinate parsing and conversion
- **Concurrent downloading**: Worker pool pattern for efficient tile downloads

## MBTiles Format

The tool creates MBTiles databases that follow the [MBTiles specification](https://github.com/mapbox/mbtiles-spec):

- **metadata table**: Contains map metadata (name, type, version, bounds, etc.)
- **tiles table**: Stores tile data with zoom_level, tile_column, tile_row, and tile_data

## Performance

- **Concurrent downloads**: Configurable number of concurrent HTTP requests
- **Memory efficient**: Streams tile data directly to database
- **Progress tracking**: Real-time progress indicators during download and rendering

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Comparison with Node.js Version

This Go implementation provides:
- **Better performance** due to Go's concurrency model
- **Smaller binaries** with no runtime dependencies
- **Cross-platform compilation** without additional tooling
- **Static linking** for easier deployment
