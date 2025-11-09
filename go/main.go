package main

import (
	"database/sql"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/urfave/cli/v2"
)

// TileDownloader handles downloading map tiles to MBTiles format
type TileDownloader struct {
	TopLeft     Coordinates
	BottomRight Coordinates
	MaxZoom     int
	Zoom        *int // Optional: if set, download only this zoom level
	URLTemplate string
	OutputFile  string
	Concurrency int
	Referer     *string // Optional: if set, add to request header
}

// Coordinates represents latitude and longitude
type Coordinates struct {
	Lat float64
	Lng float64
}

// Tile represents a map tile with coordinates and data
type Tile struct {
	Z int
	X int
	Y int
}

// DownloadedTile represents a downloaded tile with its data
type DownloadedTile struct {
	Tile
	Data    []byte
	Success bool
}

// MBTilesTester handles rendering images from MBTiles databases
type MBTilesTester struct {
	InputFile  string
	OutputFile string
}

// MBTilesPreview handles generating preview images from MBTiles databases
type MBTilesPreview struct {
	InputFile  string
	OutputFile string
	Width      int
	Height     int
}

// deg2num converts latitude/longitude to tile coordinates
func deg2num(latDeg, lonDeg float64, zoom int) (int, int) {
	latRad := latDeg * math.Pi / 180
	n := math.Pow(2, float64(zoom))
	xtile := int(math.Floor(((lonDeg + 180) / 360) * n))
	ytile := int(math.Floor(((1 - math.Log(math.Tan(latRad)+1/math.Cos(latRad))/math.Pi) / 2) * n))
	return xtile, ytile
}

// GetTileCoordinates returns all tile coordinates for the given bounding box and zoom levels
func (td *TileDownloader) GetTileCoordinates() []Tile {
	var tiles []Tile

	if td.Zoom != nil {
		zoom := *td.Zoom
		topLeftX, topLeftY := deg2num(td.TopLeft.Lat, td.TopLeft.Lng, zoom)
		bottomRightX, bottomRightY := deg2num(td.BottomRight.Lat, td.BottomRight.Lng, zoom)
		for x := topLeftX; x <= bottomRightX; x++ {
			for y := topLeftY; y <= bottomRightY; y++ {
				tiles = append(tiles, Tile{Z: zoom, X: x, Y: y})
			}
		}
	} else {
		for zoom := 0; zoom <= td.MaxZoom; zoom++ {
			topLeftX, topLeftY := deg2num(td.TopLeft.Lat, td.TopLeft.Lng, zoom)
			bottomRightX, bottomRightY := deg2num(td.BottomRight.Lat, td.BottomRight.Lng, zoom)
			for x := topLeftX; x <= bottomRightX; x++ {
				for y := topLeftY; y <= bottomRightY; y++ {
					tiles = append(tiles, Tile{Z: zoom, X: x, Y: y})
				}
			}
		}
	}

	return tiles
}

// DownloadTile downloads a single tile
func (td *TileDownloader) DownloadTile(tile Tile) DownloadedTile {
	url := strings.ReplaceAll(td.URLTemplate, "{z}", strconv.Itoa(tile.Z))
	url = strings.ReplaceAll(url, "{x}", strconv.Itoa(tile.X))
	url = strings.ReplaceAll(url, "{y}", strconv.Itoa(tile.Y))

	client := &http.Client{
		Timeout: 30 * time.Second,
	}

	log.Printf("download tile: %v", url)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		// handle error
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
	if td.Referer != nil {
		req.Header.Set("referer", *td.Referer)
	}

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Failed to download tile %d/%d/%d: %v", tile.Z, tile.X, tile.Y, err)
		return DownloadedTile{Tile: tile, Data: nil, Success: false}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Failed to download tile %d/%d/%d: HTTP %d", tile.Z, tile.X, tile.Y, resp.StatusCode)
		return DownloadedTile{Tile: tile, Data: nil, Success: false}
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read tile data %d/%d/%d: %v", tile.Z, tile.X, tile.Y, err)
		return DownloadedTile{Tile: tile, Data: nil, Success: false}
	}

	return DownloadedTile{Tile: tile, Data: data, Success: true}
}

// DownloadTiles downloads tiles with concurrency control
func (td *TileDownloader) DownloadTiles(tiles []Tile) []DownloadedTile {
	var results []DownloadedTile
	var mu sync.Mutex
	var wg sync.WaitGroup

	tileChan := make(chan Tile, len(tiles))
	resultChan := make(chan DownloadedTile, len(tiles))

	// Fill the tile channel
	for _, tile := range tiles {
		tileChan <- tile
	}
	close(tileChan)

	// Start workers
	for i := 0; i < td.Concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for tile := range tileChan {
				result := td.DownloadTile(tile)
				resultChan <- result
			}
		}()
	}

	// Collect results
	go func() {
		wg.Wait()
		close(resultChan)
	}()

	// Process results with progress indicator
	total := len(tiles)
	count := 0
	for result := range resultChan {
		mu.Lock()
		results = append(results, result)
		count++
		progress := int(float64(count) / float64(total) * 100)
		fmt.Printf("\rProgress: %d%% (%d/%d)", progress, count, total)
		mu.Unlock()
	}

	fmt.Println()
	return results
}

// CreateMBTilesDatabase creates an MBTiles database
func (td *TileDownloader) CreateMBTilesDatabase() (*sql.DB, error) {
	db, err := sql.Open("sqlite3", td.OutputFile)
	if err != nil {
		return nil, err
	}

	// Create metadata table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS metadata (
			name TEXT PRIMARY KEY,
			value TEXT
		)
	`)
	if err != nil {
		db.Close()
		return nil, err
	}

	// Create tiles table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS tiles (
			zoom_level INTEGER,
			tile_column INTEGER,
			tile_row INTEGER,
			tile_data BLOB,
			PRIMARY KEY (zoom_level, tile_column, tile_row)
		)
	`)
	if err != nil {
		db.Close()
		return nil, err
	}

	// Insert metadata
	metadata := map[string]string{
		"name":        "Map Tiles",
		"type":        "baselayer",
		"version":     "1.0",
		"description": "Downloaded map tiles",
		"format":      "png",
		"bounds":      fmt.Sprintf("%f,%f,%f,%f", td.TopLeft.Lng, td.BottomRight.Lat, td.BottomRight.Lng, td.TopLeft.Lat),
	}

	stmt, err := db.Prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)")
	if err != nil {
		db.Close()
		return nil, err
	}
	defer stmt.Close()

	for name, value := range metadata {
		_, err = stmt.Exec(name, value)
		if err != nil {
			db.Close()
			return nil, err
		}
	}

	return db, nil
}

// InsertTilesIntoDatabase inserts tiles into the MBTiles database
func (td *TileDownloader) InsertTilesIntoDatabase(db *sql.DB, tiles []DownloadedTile) (int, error) {
	stmt, err := db.Prepare(`
		INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data)
		VALUES (?, ?, ?, ?)
	`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()

	inserted := 0
	for _, tile := range tiles {
		if !tile.Success {
			continue
		}

		// In MBTiles, tile_row is calculated as (2^zoom - 1 - y)
		tileRow := int(math.Pow(2, float64(tile.Z))) - 1 - tile.Y

		_, err := stmt.Exec(tile.Z, tile.X, tileRow, tile.Data)
		if err != nil {
			log.Printf("Failed to insert tile %d/%d/%d: %v", tile.Z, tile.X, tile.Y, err)
		} else {
			inserted++
		}
	}

	return inserted, nil
}

// Download performs the main download process
func (td *TileDownloader) Download() error {
	fmt.Println("Calculating tile coordinates...")
	tiles := td.GetTileCoordinates()
	fmt.Printf("Found %d tiles to download\n", len(tiles))

	fmt.Println("Creating MBTiles database...")
	db, err := td.CreateMBTilesDatabase()
	if err != nil {
		return err
	}
	defer db.Close()

	fmt.Printf("Downloading tiles with %d concurrent threads...\n", td.Concurrency)
	downloadedTiles := td.DownloadTiles(tiles)

	fmt.Printf("Successfully downloaded %d tiles\n", len(downloadedTiles))

	fmt.Println("Inserting tiles into database...")
	insertedCount, err := td.InsertTilesIntoDatabase(db, downloadedTiles)
	if err != nil {
		return err
	}

	fmt.Printf("Successfully inserted %d tiles into %s\n", insertedCount, td.OutputFile)
	return nil
}

// GetMaxZoomLevel gets the maximum zoom level from the database
func (mt *MBTilesTester) GetMaxZoomLevel() (int, error) {
	db, err := sql.Open("sqlite3", mt.InputFile)
	if err != nil {
		return 0, err
	}
	defer db.Close()

	var maxZoom int
	err = db.QueryRow("SELECT MAX(zoom_level) as max_zoom FROM tiles").Scan(&maxZoom)
	if err != nil {
		return 0, err
	}

	return maxZoom, nil
}

// GetTilesForZoom gets all tiles for a specific zoom level
func (mt *MBTilesTester) GetTilesForZoom(zoomLevel int) ([]struct {
	ZoomLevel  int
	TileColumn int
	TileRow    int
	TileData   []byte
}, error) {
	db, err := sql.Open("sqlite3", mt.InputFile)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT zoom_level, tile_column, tile_row, tile_data 
		FROM tiles 
		WHERE zoom_level = ? 
		ORDER BY tile_column, tile_row
	`, zoomLevel)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tiles []struct {
		ZoomLevel  int
		TileColumn int
		TileRow    int
		TileData   []byte
	}

	for rows.Next() {
		var tile struct {
			ZoomLevel  int
			TileColumn int
			TileRow    int
			TileData   []byte
		}
		err := rows.Scan(&tile.ZoomLevel, &tile.TileColumn, &tile.TileRow, &tile.TileData)
		if err != nil {
			return nil, err
		}
		tiles = append(tiles, tile)
	}

	return tiles, nil
}

// MBTilesRowToY converts MBTiles row to standard tile y coordinate
func (mt *MBTilesTester) MBTilesRowToY(tileRow, zoomLevel int) int {
	return int(math.Pow(2, float64(zoomLevel))) - 1 - tileRow
}

// GetMetadata retrieves metadata from MBTiles database
func (mp *MBTilesPreview) GetMetadata() (map[string]string, error) {
	db, err := sql.Open("sqlite3", mp.InputFile)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query("SELECT name, value FROM metadata")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	metadata := make(map[string]string)
	for rows.Next() {
		var name, value string
		err := rows.Scan(&name, &value)
		if err != nil {
			return nil, err
		}
		metadata[name] = value
	}

	return metadata, nil
}

// GetCenterTile finds the center tile for preview generation
func (mp *MBTilesPreview) GetCenterTile(maxZoom int) (int, int, error) {
	db, err := sql.Open("sqlite3", mp.InputFile)
	if err != nil {
		return 0, 0, err
	}
	defer db.Close()

	// Get all tiles at max zoom level
	rows, err := db.Query(`
		SELECT tile_column, tile_row 
		FROM tiles 
		WHERE zoom_level = ? 
		ORDER BY tile_column, tile_row
	`, maxZoom)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	var tiles []struct {
		X int
		Y int
	}

	for rows.Next() {
		var x, y int
		err := rows.Scan(&x, &y)
		if err != nil {
			return 0, 0, err
		}
		tiles = append(tiles, struct {
			X int
			Y int
		}{X: x, Y: y})
	}

	if len(tiles) == 0 {
		return 0, 0, fmt.Errorf("no tiles found at zoom level %d", maxZoom)
	}

	// Find the center tile
	centerIndex := len(tiles) / 2
	return tiles[centerIndex].X, tiles[centerIndex].Y, nil
}

// MBTilesRowToY converts MBTiles row to standard tile y coordinate
func (mp *MBTilesPreview) MBTilesRowToY(tileRow, zoomLevel int) int {
	return int(math.Pow(2, float64(zoomLevel))) - 1 - tileRow
}

// GeneratePreview generates a 512x512 preview image from MBTiles database
func (mp *MBTilesPreview) GeneratePreview() error {
	fmt.Printf("Generating preview from MBTiles database: %s\n", mp.InputFile)

	// Get metadata to understand the map
	metadata, err := mp.GetMetadata()
	if err != nil {
		return err
	}

	fmt.Printf("Map metadata: %+v\n", metadata)

	// Get max zoom level
	maxZoom, err := mp.GetMaxZoomLevel()
	if err != nil {
		return err
	}
	fmt.Printf("Maximum zoom level: %d\n", maxZoom)

	// Find center tile for preview
	centerX, centerY, err := mp.GetCenterTile(maxZoom)
	if err != nil {
		return err
	}
	fmt.Printf("Center tile coordinates: X=%d, Y=%d\n", centerX, centerY)

	// Calculate how many tiles we need for 512x512 preview
	tileSize := 256
	tilesPerSide := mp.Width / tileSize
	if tilesPerSide < 1 {
		tilesPerSide = 1
	}

	// Create base image
	baseImage := image.NewRGBA(image.Rect(0, 0, mp.Width, mp.Height))
	gray := color.RGBA{0xf0, 0xf0, 0xf0, 0xff}
	draw.Draw(baseImage, baseImage.Bounds(), &image.Uniform{gray}, image.Point{}, draw.Src)

	// Calculate tile range - convert MBTiles row to standard tile Y coordinate
	startX := centerX - tilesPerSide/2
	startY := mp.MBTilesRowToY(centerY, maxZoom) - tilesPerSide/2

	// Load and draw tiles
	db, err := sql.Open("sqlite3", mp.InputFile)
	if err != nil {
		return err
	}
	defer db.Close()

	drawnTiles := 0
	for xOffset := 0; xOffset < tilesPerSide; xOffset++ {
		for yOffset := 0; yOffset < tilesPerSide; yOffset++ {
			tileX := startX + xOffset
			tileY := startY + yOffset

			// Convert standard tile Y back to MBTiles row for query
			mbtilesRow := mp.MBTilesRowToY(tileY, maxZoom)

			// Get tile data
			var tileData []byte
			err := db.QueryRow(`
				SELECT tile_data 
				FROM tiles 
				WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?
			`, maxZoom, tileX, mbtilesRow).Scan(&tileData)

			if err != nil {
				// Skip missing tiles
				continue
			}

			// Decode tile image
			tileImage, _, err := image.Decode(strings.NewReader(string(tileData)))
			if err != nil {
				fmt.Printf("Failed to decode tile %d/%d: %v\n", tileX, tileY, err)
				continue
			}

			// Calculate position in preview image
			posX := xOffset * tileSize
			posY := yOffset * tileSize

			// Draw the tile
			draw.Draw(baseImage, image.Rect(posX, posY, posX+tileSize, posY+tileSize), tileImage, image.Point{}, draw.Over)
			drawnTiles++

			fmt.Printf("\rDrawing tiles: %d", drawnTiles)
		}
	}

	fmt.Println()

	// Ensure output directory exists
	outputDir := filepath.Dir(mp.OutputFile)
	err = os.MkdirAll(outputDir, 0755)
	if err != nil {
		return err
	}

	// Create output file
	outputFile, err := os.Create(mp.OutputFile)
	if err != nil {
		return err
	}
	defer outputFile.Close()

	// Determine output format from file extension
	ext := strings.ToLower(filepath.Ext(mp.OutputFile))
	switch ext {
	case ".jpg", ".jpeg":
		err = jpeg.Encode(outputFile, baseImage, &jpeg.Options{Quality: 90})
	case ".png":
		err = png.Encode(outputFile, baseImage)
	default:
		// Default to PNG
		err = png.Encode(outputFile, baseImage)
	}

	if err != nil {
		return err
	}

	fmt.Printf("Preview image saved to: %s\n", mp.OutputFile)
	fmt.Printf("Successfully drew %d tiles\n", drawnTiles)
	fmt.Printf("Preview dimensions: %dx%d\n", mp.Width, mp.Height)
	return nil
}

// GetMaxZoomLevel gets the maximum zoom level from the database
func (mp *MBTilesPreview) GetMaxZoomLevel() (int, error) {
	db, err := sql.Open("sqlite3", mp.InputFile)
	if err != nil {
		return 0, err
	}
	defer db.Close()

	var maxZoom int
	err = db.QueryRow("SELECT MAX(zoom_level) as max_zoom FROM tiles").Scan(&maxZoom)
	if err != nil {
		return 0, err
	}

	return maxZoom, nil
}

// RenderImage renders an image from MBTiles database
func (mt *MBTilesTester) RenderImage() error {
	fmt.Printf("Reading MBTiles database: %s\n", mt.InputFile)

	// Get the maximum zoom level
	maxZoom, err := mt.GetMaxZoomLevel()
	if err != nil {
		return err
	}
	fmt.Printf("Maximum zoom level found: %d\n", maxZoom)

	if maxZoom == 0 {
		return fmt.Errorf("no tiles found in the database")
	}

	// Get tiles for the maximum zoom level
	tiles, err := mt.GetTilesForZoom(maxZoom)
	if err != nil {
		return err
	}
	fmt.Printf("Found %d tiles at zoom level %d\n", len(tiles), maxZoom)

	if len(tiles) == 0 {
		return fmt.Errorf("no tiles found at zoom level %d", maxZoom)
	}

	// Calculate image dimensions
	tileSize := 256 // Standard tile size
	minX := tiles[0].TileColumn
	maxX := tiles[0].TileColumn
	minY := mt.MBTilesRowToY(tiles[0].TileRow, maxZoom)
	maxY := mt.MBTilesRowToY(tiles[0].TileRow, maxZoom)

	for _, tile := range tiles {
		if tile.TileColumn < minX {
			minX = tile.TileColumn
		}
		if tile.TileColumn > maxX {
			maxX = tile.TileColumn
		}
		y := mt.MBTilesRowToY(tile.TileRow, maxZoom)
		if y < minY {
			minY = y
		}
		if y > maxY {
			maxY = y
		}
	}

	imageWidth := (maxX - minX + 1) * tileSize
	imageHeight := (maxY - minY + 1) * tileSize

	fmt.Printf("Image dimensions: %dx%d\n", imageWidth, imageHeight)
	fmt.Printf("Tile range: X[%d-%d], Y[%d-%d]\n", minX, maxX, minY, maxY)

	// Create base image with gray background
	baseImage := image.NewRGBA(image.Rect(0, 0, imageWidth, imageHeight))
	gray := color.RGBA{0xf0, 0xf0, 0xf0, 0xff}
	draw.Draw(baseImage, baseImage.Bounds(), &image.Uniform{gray}, image.Point{}, draw.Src)

	// Draw each tile
	drawnTiles := 0
	for _, tile := range tiles {
		x := (tile.TileColumn - minX) * tileSize
		y := (mt.MBTilesRowToY(tile.TileRow, maxZoom) - minY) * tileSize

		// Decode tile image
		tileImage, _, err := image.Decode(strings.NewReader(string(tile.TileData)))
		if err != nil {
			fmt.Printf("\nFailed to decode tile %d/%d: %v\n", tile.TileColumn, tile.TileRow, err)
			continue
		}

		// Draw the tile onto the base image
		draw.Draw(baseImage, image.Rect(x, y, x+tileSize, y+tileSize), tileImage, image.Point{}, draw.Over)
		drawnTiles++

		// Progress indicator
		fmt.Printf("\rDrawing tiles: %d/%d", drawnTiles, len(tiles))
	}

	fmt.Println()

	// Ensure output directory exists
	outputDir := filepath.Dir(mt.OutputFile)
	err = os.MkdirAll(outputDir, 0755)
	if err != nil {
		return err
	}

	// Create output file
	outputFile, err := os.Create(mt.OutputFile)
	if err != nil {
		return err
	}
	defer outputFile.Close()

	// Determine output format from file extension
	ext := strings.ToLower(filepath.Ext(mt.OutputFile))
	switch ext {
	case ".jpg", ".jpeg":
		err = jpeg.Encode(outputFile, baseImage, &jpeg.Options{Quality: 90})
	case ".png":
		err = png.Encode(outputFile, baseImage)
	default:
		// Default to PNG
		err = png.Encode(outputFile, baseImage)
	}

	if err != nil {
		return err
	}

	fmt.Printf("Image saved to: %s\n", mt.OutputFile)
	fmt.Printf("Successfully drew %d tiles\n", drawnTiles)
	return nil
}

// ParseCoordinates parses coordinates from string format "lat,lng"
func ParseCoordinates(coordsStr string) (Coordinates, error) {
	parts := strings.Split(coordsStr, ",")
	if len(parts) != 2 {
		return Coordinates{}, fmt.Errorf("invalid coordinates format: %s. Expected 'lat,lng'", coordsStr)
	}

	lat, err := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	if err != nil {
		return Coordinates{}, fmt.Errorf("invalid latitude: %v", err)
	}

	lng, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err != nil {
		return Coordinates{}, fmt.Errorf("invalid longitude: %v", err)
	}

	return Coordinates{Lat: lat, Lng: lng}, nil
}

func main() {
	app := &cli.App{
		Name:        "2maps-loader",
		Usage:       "CLI tool for downloading raster map tiles to MBTiles format",
		Description: "Download map tiles and render images from MBTiles databases",
		Version:     "1.0.0",
		Commands: []*cli.Command{
			{
				Name:  "test",
				Usage: "Render an image from MBTiles database",
				Flags: []cli.Flag{
					&cli.StringFlag{
						Name:     "input",
						Usage:    "Input MBTiles file path",
						Required: true,
					},
					&cli.StringFlag{
						Name:     "output",
						Usage:    "Output image file path",
						Required: true,
					},
				},
				Action: func(c *cli.Context) error {
					tester := &MBTilesTester{
						InputFile:  c.String("input"),
						OutputFile: c.String("output"),
					}
					return tester.RenderImage()
				},
			},
			{
				Name:  "download",
				Usage: "Download map tiles to MBTiles format (supports any 2 box corners)",
				Flags: []cli.Flag{
					&cli.StringFlag{
						Name:     "corner1",
						Usage:    "First corner coordinates in format \"lat,lng\"",
						Required: true,
					},
					&cli.StringFlag{
						Name:     "corner2",
						Usage:    "Second corner coordinates in format \"lat,lng\"",
						Required: true,
					},
					&cli.IntFlag{
						Name:     "max-zoom",
						Usage:    "Maximum zoom level",
						Required: true,
					},
					&cli.IntFlag{
						Name:     "zoom",
						Usage:    "Download only this zoom level (optional)",
						Required: false,
					},
					&cli.StringFlag{
						Name:     "url-template",
						Usage:    "URL template for tiles (use {z}, {x}, {y} placeholders)",
						Required: true,
					},
					&cli.StringFlag{
						Name:     "output",
						Usage:    "Output MBTiles file path",
						Required: true,
					},
					&cli.IntFlag{
						Name:  "concurrency",
						Usage: "Number of concurrent downloads (default: 5)",
						Value: 5,
					},
					&cli.StringFlag{
						Name:     "referer",
						Usage:    "Optional referer header for tile requests",
						Required: false,
					},
				},
				Action: func(c *cli.Context) error {
					// Parse two corners
					corner1, err := ParseCoordinates(c.String("corner1"))
					if err != nil {
						return err
					}

					corner2, err := ParseCoordinates(c.String("corner2"))
					if err != nil {
						return err
					}

					// Calculate bounding box
					lats := []float64{corner1.Lat, corner2.Lat}
					lngs := []float64{corner1.Lng, corner2.Lng}
					minLat := math.Min(lats[0], lats[1])
					maxLat := math.Max(lats[0], lats[1])
					minLng := math.Min(lngs[0], lngs[1])
					maxLng := math.Max(lngs[0], lngs[1])

					// Use min/max for bounding box
					topLeft := Coordinates{Lat: maxLat, Lng: minLng}
					bottomRight := Coordinates{Lat: minLat, Lng: maxLng}

					var zoomPtr *int
					if c.IsSet("zoom") {
						z := c.Int("zoom")
						zoomPtr = &z
					}

					var refererPtr *string
					if c.IsSet("referer") {
						r := c.String("referer")
						refererPtr = &r
					}

					downloader := &TileDownloader{
						TopLeft:     topLeft,
						BottomRight: bottomRight,
						MaxZoom:     c.Int("max-zoom"),
						Zoom:        zoomPtr,
						URLTemplate: c.String("url-template"),
						OutputFile:  c.String("output"),
						Concurrency: c.Int("concurrency"),
						Referer:     refererPtr,
					}

					return downloader.Download()
				},
			},
			{
				Name:  "preview",
				Usage: "Generate a 512x512 preview image from MBTiles database",
				Flags: []cli.Flag{
					&cli.StringFlag{
						Name:     "input",
						Usage:    "Input MBTiles file path",
						Required: true,
					},
					&cli.StringFlag{
						Name:     "output",
						Usage:    "Output preview image file path",
						Required: true,
					},
					&cli.IntFlag{
						Name:  "width",
						Usage: "Preview image width (default: 512)",
						Value: 512,
					},
					&cli.IntFlag{
						Name:  "height",
						Usage: "Preview image height (default: 512)",
						Value: 512,
					},
				},
				Action: func(c *cli.Context) error {
					preview := &MBTilesPreview{
						InputFile:  c.String("input"),
						OutputFile: c.String("output"),
						Width:      c.Int("width"),
						Height:     c.Int("height"),
					}
					return preview.GeneratePreview()
				},
			},
		},
	}

	err := app.Run(os.Args)
	if err != nil {
		log.Fatal(err)
	}
}
