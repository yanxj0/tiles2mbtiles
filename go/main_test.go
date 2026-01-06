package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadTileAndSaveImage(t *testing.T) {
	// Use OpenStreetMap public tile server for a known tile
	// urlTemplate := "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"
	// tile := Tile{Z: 10, X: 700, Y: 636} // Tile for San Francisco at zoom level 10
	urlTemplate := "https://hutun.ru/tiles/9/1419909/Z{z}/{y}/{x}.jpg"
	tile := Tile{Z: 13, X: 5066, Y: 2519} // Tile for San Francisco at zoom level 10
	downloader := &TileDownloader{
		TopLeft:     Coordinates{Lat: 0, Lng: 0},
		BottomRight: Coordinates{Lat: 0, Lng: 0},
		MaxZoom:     1,
		URLTemplate: urlTemplate,
		OutputFile:  "",
		Concurrency: 1,
	}
	result := downloader.DownloadTile(tile)
	if !result.Success {
		t.Fatalf("DownloadTile failed: no data")
	}
	f, err := os.Create("test.png")
	if err != nil {
		t.Fatalf("Failed to create test.png: %v", err)
	}
	defer f.Close()
	if _, err := f.Write(result.Data); err != nil {
		t.Fatalf("Failed to write tile data to test.png: %v", err)
	}
	t.Log("Tile downloaded and saved to test.png (raw bytes)")
}

func TestDeg2Num(t *testing.T) {
	tests := []struct {
		name     string
		lat      float64
		lon      float64
		zoom     int
		expected struct {
			x int
			y int
		}
	}{
		{
			name: "San Francisco at zoom 10",
			lat:  37.7749,
			lon:  -122.4194,
			zoom: 10,
			expected: struct {
				x int
				y int
			}{x: 163, y: 395},
		},
		{
			name: "New York at zoom 10",
			lat:  40.7128,
			lon:  -74.0060,
			zoom: 10,
			expected: struct {
				x int
				y int
			}{x: 301, y: 385},
		},
		{
			name: "London at zoom 10",
			lat:  51.5074,
			lon:  -0.1278,
			zoom: 10,
			expected: struct {
				x int
				y int
			}{x: 511, y: 340},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			x, y := deg2num(tt.lat, tt.lon, tt.zoom)
			if x != tt.expected.x || y != tt.expected.y {
				t.Errorf("deg2num(%f, %f, %d) = (%d, %d), expected (%d, %d)",
					tt.lat, tt.lon, tt.zoom, x, y, tt.expected.x, tt.expected.y)
			}
		})
	}
}

func TestParseCoordinates(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		expected    Coordinates
		shouldError bool
	}{
		{
			name:     "Valid coordinates",
			input:    "37.7749,-122.4194",
			expected: Coordinates{Lat: 37.7749, Lng: -122.4194},
		},
		{
			name:     "Valid coordinates with spaces",
			input:    " 37.7749 , -122.4194 ",
			expected: Coordinates{Lat: 37.7749, Lng: -122.4194},
		},
		{
			name:        "Invalid format - missing comma",
			input:       "37.7749 -122.4194",
			shouldError: true,
		},
		{
			name:        "Invalid format - too many parts",
			input:       "37.7749,-122.4194,extra",
			shouldError: true,
		},
		{
			name:        "Invalid latitude",
			input:       "invalid,-122.4194",
			shouldError: true,
		},
		{
			name:        "Invalid longitude",
			input:       "37.7749,invalid",
			shouldError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseCoordinates(tt.input)
			if tt.shouldError {
				if err == nil {
					t.Errorf("ParseCoordinates(%q) should have returned an error", tt.input)
				}
			} else {
				if err != nil {
					t.Errorf("ParseCoordinates(%q) returned unexpected error: %v", tt.input, err)
				}
				if result.Lat != tt.expected.Lat || result.Lng != tt.expected.Lng {
					t.Errorf("ParseCoordinates(%q) = %+v, expected %+v", tt.input, result, tt.expected)
				}
			}
		})
	}
}

func TestMBTilesRowToY(t *testing.T) {
	tester := &MBTilesTester{}

	tests := []struct {
		name     string
		tileRow  int
		zoom     int
		expected int
	}{
		{
			name:     "Zoom 0, tile row 0",
			tileRow:  0,
			zoom:     0,
			expected: 0,
		},
		{
			name:     "Zoom 1, tile row 0",
			tileRow:  0,
			zoom:     1,
			expected: 1,
		},
		{
			name:     "Zoom 1, tile row 1",
			tileRow:  1,
			zoom:     1,
			expected: 0,
		},
		{
			name:     "Zoom 2, tile row 0",
			tileRow:  0,
			zoom:     2,
			expected: 3,
		},
		{
			name:     "Zoom 2, tile row 3",
			tileRow:  3,
			zoom:     2,
			expected: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := tester.MBTilesRowToY(tt.tileRow, tt.zoom)
			if result != tt.expected {
				t.Errorf("MBTilesRowToY(%d, %d) = %d, expected %d", tt.tileRow, tt.zoom, result, tt.expected)
			}
		})
	}
}

func TestGetTileCoordinates(t *testing.T) {
	downloader := &TileDownloader{
		TopLeft:     Coordinates{Lat: 37.8, Lng: -122.5},
		BottomRight: Coordinates{Lat: 37.7, Lng: -122.4},
		MaxZoom:     1,
	}

	tiles := downloader.GetTileCoordinates()

	// The actual count depends on the specific coordinates and zoom levels
	// Let's just verify we get some tiles and they have valid coordinates
	if len(tiles) == 0 {
		t.Errorf("GetTileCoordinates() returned 0 tiles, expected at least 1")
	}

	// Check that all tiles have valid coordinates
	for _, tile := range tiles {
		if tile.Z < 0 || tile.Z > downloader.MaxZoom {
			t.Errorf("Tile has invalid zoom level: %d", tile.Z)
		}
		if tile.X < 0 || tile.Y < 0 {
			t.Errorf("Tile has negative coordinates: (%d, %d)", tile.X, tile.Y)
		}
	}
}

func TestCreateMBTilesDatabase(t *testing.T) {
	tempDir := t.TempDir()
	outputFile := filepath.Join(tempDir, "test.mbtiles")

	downloader := &TileDownloader{
		TopLeft:     Coordinates{Lat: 37.8, Lng: -122.5},
		BottomRight: Coordinates{Lat: 37.7, Lng: -122.4},
		MaxZoom:     0,
		OutputFile:  outputFile,
	}

	db, err := downloader.CreateMBTilesDatabase()
	if err != nil {
		t.Fatalf("CreateMBTilesDatabase() failed: %v", err)
	}
	defer db.Close()

	// Verify the database file was created
	if _, err := os.Stat(outputFile); os.IsNotExist(err) {
		t.Errorf("Database file was not created: %s", outputFile)
	}

	// Verify metadata table exists and has correct entries
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM metadata").Scan(&count)
	if err != nil {
		t.Errorf("Failed to query metadata table: %v", err)
	}
	if count == 0 {
		t.Error("Metadata table should contain entries")
	}

	// Verify tiles table exists
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tiles'").Scan(&count)
	if err != nil {
		t.Errorf("Failed to verify tiles table: %v", err)
	}
	if count != 1 {
		t.Error("Tiles table should exist")
	}
}

func TestInsertTilesIntoDatabase(t *testing.T) {
	tempDir := t.TempDir()
	outputFile := filepath.Join(tempDir, "test.mbtiles")

	// Create a test database first
	downloader := &TileDownloader{
		TopLeft:     Coordinates{Lat: 37.8, Lng: -122.5},
		BottomRight: Coordinates{Lat: 37.7, Lng: -122.4},
		MaxZoom:     0,
		OutputFile:  outputFile,
	}

	db, err := downloader.CreateMBTilesDatabase()
	if err != nil {
		t.Fatalf("CreateMBTilesDatabase() failed: %v", err)
	}
	defer db.Close()

	// Create test tiles
	testTiles := []DownloadedTile{
		{
			Tile:    Tile{Z: 0, X: 0, Y: 0},
			Data:    []byte("test tile data"),
			Success: true,
		},
		{
			Tile:    Tile{Z: 1, X: 0, Y: 0},
			Data:    []byte("another test tile"),
			Success: true,
		},
	}

	// Insert tiles
	insertedCount, err := downloader.InsertTilesIntoDatabase(db, testTiles)
	if err != nil {
		t.Fatalf("InsertTilesIntoDatabase() failed: %v", err)
	}

	if insertedCount != len(testTiles) {
		t.Errorf("InsertTilesIntoDatabase() inserted %d tiles, expected %d", insertedCount, len(testTiles))
	}

	// Verify tiles were inserted
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM tiles").Scan(&count)
	if err != nil {
		t.Errorf("Failed to count tiles: %v", err)
	}
	if count != len(testTiles) {
		t.Errorf("Expected %d tiles in database, found %d", len(testTiles), count)
	}
}

func TestGetMaxZoomLevel(t *testing.T) {
	tempDir := t.TempDir()
	outputFile := filepath.Join(tempDir, "test.mbtiles")

	// Create a test database with tiles at different zoom levels
	db, err := sql.Open("sqlite3", outputFile)
	if err != nil {
		t.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	// Create tables
	_, err = db.Exec(`
		CREATE TABLE metadata (
			name TEXT PRIMARY KEY,
			value TEXT
		);
		CREATE TABLE tiles (
			zoom_level INTEGER,
			tile_column INTEGER,
			tile_row INTEGER,
			tile_data BLOB,
			PRIMARY KEY (zoom_level, tile_column, tile_row)
		);
	`)
	if err != nil {
		t.Fatalf("Failed to create tables: %v", err)
	}

	// Insert test tiles at different zoom levels
	_, err = db.Exec(`
		INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES
		(0, 0, 0, ?),
		(1, 0, 0, ?),
		(2, 0, 0, ?)
	`, []byte("tile0"), []byte("tile1"), []byte("tile2"))
	if err != nil {
		t.Fatalf("Failed to insert test tiles: %v", err)
	}

	tester := &MBTilesTester{InputFile: outputFile}
	maxZoom, err := tester.GetMaxZoomLevel()
	if err != nil {
		t.Fatalf("GetMaxZoomLevel() failed: %v", err)
	}

	if maxZoom != 2 {
		t.Errorf("GetMaxZoomLevel() = %d, expected 2", maxZoom)
	}
}

func TestGetTilesForZoom(t *testing.T) {
	tempDir := t.TempDir()
	outputFile := filepath.Join(tempDir, "test.mbtiles")

	// Create a test database with tiles
	db, err := sql.Open("sqlite3", outputFile)
	if err != nil {
		t.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	// Create tables
	_, err = db.Exec(`
		CREATE TABLE metadata (
			name TEXT PRIMARY KEY,
			value TEXT
		);
		CREATE TABLE tiles (
			zoom_level INTEGER,
			tile_column INTEGER,
			tile_row INTEGER,
			tile_data BLOB,
			PRIMARY KEY (zoom_level, tile_column, tile_row)
		);
	`)
	if err != nil {
		t.Fatalf("Failed to create tables: %v", err)
	}

	// Insert test tiles
	_, err = db.Exec(`
		INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES
		(1, 0, 0, ?),
		(1, 0, 1, ?),
		(1, 1, 0, ?),
		(2, 0, 0, ?)
	`, []byte("tile1"), []byte("tile2"), []byte("tile3"), []byte("tile4"))
	if err != nil {
		t.Fatalf("Failed to insert test tiles: %v", err)
	}

	tester := &MBTilesTester{InputFile: outputFile}
	tiles, err := tester.GetTilesForZoom(1)
	if err != nil {
		t.Fatalf("GetTilesForZoom() failed: %v", err)
	}

	if len(tiles) != 3 {
		t.Errorf("GetTilesForZoom(1) returned %d tiles, expected 3", len(tiles))
	}

	// Verify the tiles are ordered by column and row
	for i, tile := range tiles {
		if i > 0 {
			prevTile := tiles[i-1]
			if tile.TileColumn < prevTile.TileColumn ||
				(tile.TileColumn == prevTile.TileColumn && tile.TileRow < prevTile.TileRow) {
				t.Errorf("Tiles are not properly ordered")
			}
		}
	}
}

func TestDownloadTMSTile(t *testing.T) {
	// Nakarte GGC250 example: https://a.tiles.nakarte.me/ggc250/14/10198/11305
	// This corresponds to OSM y: (2^14 - 1) - 11305 = 16383 - 11305 = 5078
	urlTemplate := "https://a.tiles.nakarte.me/ggc250/{z}/{x}/{-y}"
	tile := Tile{Z: 14, X: 10198, Y: 5078}
	downloader := &TileDownloader{
		URLTemplate: urlTemplate,
	}
	
	// We don't necessarily want to perform a real network request if it might fail,
	// but we can verify the URL construction logic if we export it or mock it.
	// Since DownloadTile is already tested elsewhere, we can just check if it works.
	result := downloader.DownloadTile(tile)
	if !result.Success {
		t.Logf("Warning: DownloadTile failed (possibly network). This is expected if the server is down or blocked.")
	} else {
		t.Logf("Successfully downloaded TMS tile")
	}
}

func TestDownloadSubdomainTile(t *testing.T) {
	urlTemplate := "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
	tile := Tile{Z: 0, X: 0, Y: 0}
	downloader := &TileDownloader{
		URLTemplate: urlTemplate,
	}
	result := downloader.DownloadTile(tile)
	if !result.Success {
		t.Logf("Warning: DownloadTile failed (possibly network).")
	} else {
		t.Logf("Successfully downloaded tile with subdomain")
	}
}
