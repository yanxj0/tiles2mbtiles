#!/usr/bin/env node

const { program } = require('commander');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');

class TileDownloader {
  constructor(options) {
    this.topLeft = options.topLeft;
    this.bottomRight = options.bottomRight;
    this.maxZoom = options.maxZoom;
    this.urlTemplate = options.urlTemplate;
    this.outputFile = options.outputFile;
    this.concurrency = options.concurrency || 5;
  }

  // Convert latitude/longitude to tile coordinates
  deg2num(lat_deg, lon_deg, zoom) {
    const lat_rad = (lat_deg * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    const xtile = Math.floor(((lon_deg + 180) / 360) * n);
    const ytile = Math.floor(
      ((1 - Math.log(Math.tan(lat_rad) + 1 / Math.cos(lat_rad)) / Math.PI) / 2) * n
    );
    return { x: xtile, y: ytile };
  }

  // Get all tile coordinates for the given bounding box and zoom levels
  getTileCoordinates() {
    const tiles = [];
    
    for (let zoom = 0; zoom <= this.maxZoom; zoom++) {
      const topLeftTile = this.deg2num(this.topLeft.lat, this.topLeft.lng, zoom);
      const bottomRightTile = this.deg2num(this.bottomRight.lat, this.bottomRight.lng, zoom);
      
      for (let x = topLeftTile.x; x <= bottomRightTile.x; x++) {
        for (let y = topLeftTile.y; y <= bottomRightTile.y; y++) {
          tiles.push({ z: zoom, x, y });
        }
      }
    }
    
    return tiles;
  }

  // Download a single tile
  async downloadTile(tile) {
    const url = this.urlTemplate
      .replace('{z}', tile.z)
      .replace('{x}', tile.x)
      .replace('{y}', tile.y);
    
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      
      return {
        ...tile,
        data: response.data,
        success: true
      };
    } catch (error) {
      console.error(`Failed to download tile ${tile.z}/${tile.x}/${tile.y}: ${error.message}`);
      return {
        ...tile,
        data: null,
        success: false
      };
    }
  }

  // Download tiles with concurrency control
  async downloadTiles(tiles) {
    const results = [];
    const queue = [...tiles];
    
    const worker = async () => {
      while (queue.length > 0) {
        const tile = queue.shift();
        if (tile) {
          const result = await this.downloadTile(tile);
          results.push(result);
          
          // Progress indicator
          const progress = Math.round(((results.length / tiles.length) * 100));
          process.stdout.write(`\rProgress: ${progress}% (${results.length}/${tiles.length})`);
        }
      }
    };
    
    // Start workers
    const workers = Array(this.concurrency).fill().map(() => worker());
    await Promise.all(workers);
    
    process.stdout.write('\n');
    return results.filter(result => result.success);
  }

  // Create MBTiles database
  createMBTilesDatabase() {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.outputFile);
      
      db.serialize(() => {
        // Create metadata table
        db.run(`CREATE TABLE IF NOT EXISTS metadata (
          name TEXT PRIMARY KEY,
          value TEXT
        )`);
        
        // Create tiles table
        db.run(`CREATE TABLE IF NOT EXISTS tiles (
          zoom_level INTEGER,
          tile_column INTEGER,
          tile_row INTEGER,
          tile_data BLOB,
          PRIMARY KEY (zoom_level, tile_column, tile_row)
        )`);
        
        // Insert metadata
        const metadata = [
          ['name', 'Map Tiles'],
          ['type', 'baselayer'],
          ['version', '1.0'],
          ['description', 'Downloaded map tiles'],
          ['format', 'png'],
          ['bounds', `${this.topLeft.lng},${this.bottomRight.lat},${this.bottomRight.lng},${this.topLeft.lat}`]
        ];
        
        const stmt = db.prepare('INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)');
        metadata.forEach(([name, value]) => stmt.run(name, value));
        stmt.finalize();
        
        resolve(db);
      });
    });
  }

  // Insert tiles into MBTiles database
  insertTilesIntoDatabase(db, tiles) {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data)
        VALUES (?, ?, ?, ?)
      `);
      
      let inserted = 0;
      const total = tiles.length;
      
      tiles.forEach((tile, index) => {
        // In MBTiles, tile_row is calculated as (2^zoom - 1 - y)
        const tile_row = Math.pow(2, tile.z) - 1 - tile.y;
        
        stmt.run(tile.z, tile.x, tile_row, tile.data, (err) => {
          if (err) {
            console.error(`Failed to insert tile ${tile.z}/${tile.x}/${tile.y}: ${err.message}`);
          } else {
            inserted++;
          }
          
          if (inserted === total) {
            stmt.finalize();
            db.close();
            resolve(inserted);
          }
        });
      });
      
      if (tiles.length === 0) {
        db.close();
        resolve(0);
      }
    });
  }

  // Main download process
  async download() {
    console.log('Calculating tile coordinates...');
    const tiles = this.getTileCoordinates();
    console.log(`Found ${tiles.length} tiles to download`);
    
    console.log('Creating MBTiles database...');
    const db = await this.createMBTilesDatabase();
    
    console.log(`Downloading tiles with ${this.concurrency} concurrent threads...`);
    const downloadedTiles = await this.downloadTiles(tiles);
    
    console.log(`Successfully downloaded ${downloadedTiles.length} tiles`);
    
    console.log('Inserting tiles into database...');
    const insertedCount = await this.insertTilesIntoDatabase(db, downloadedTiles);
    
    console.log(`Successfully inserted ${insertedCount} tiles into ${this.outputFile}`);
  }
}

class MBTilesTester {
  constructor(inputFile, outputFile) {
    this.inputFile = inputFile;
    this.outputFile = outputFile;
  }

  // Get the maximum zoom level from the database
  async getMaxZoomLevel() {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.inputFile);
      
      db.get('SELECT MAX(zoom_level) as max_zoom FROM tiles', (err, row) => {
        db.close();
        if (err) {
          reject(err);
        } else {
          resolve(row.max_zoom || 0);
        }
      });
    });
  }

  // Get all tiles for a specific zoom level
  async getTilesForZoom(zoomLevel) {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.inputFile);
      
      db.all(`
        SELECT zoom_level, tile_column, tile_row, tile_data 
        FROM tiles 
        WHERE zoom_level = ? 
        ORDER BY tile_column, tile_row
      `, [zoomLevel], (err, rows) => {
        db.close();
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // Convert MBTiles row to standard tile y coordinate
  mbtilesRowToY(tile_row, zoomLevel) {
    return Math.pow(2, zoomLevel) - 1 - tile_row;
  }

  // Render image from tiles
  async renderImage() {
    console.log(`Reading MBTiles database: ${this.inputFile}`);
    
    // Get the maximum zoom level
    const maxZoom = await this.getMaxZoomLevel();
    console.log(`Maximum zoom level found: ${maxZoom}`);
    
    if (maxZoom === 0) {
      throw new Error('No tiles found in the database');
    }

    // Get tiles for the maximum zoom level
    const tiles = await this.getTilesForZoom(maxZoom);
    console.log(`Found ${tiles.length} tiles at zoom level ${maxZoom}`);
    
    if (tiles.length === 0) {
      throw new Error(`No tiles found at zoom level ${maxZoom}`);
    }

    // Calculate image dimensions
    const tileSize = 256; // Standard tile size
    const minX = Math.min(...tiles.map(t => t.tile_column));
    const maxX = Math.max(...tiles.map(t => t.tile_column));
    const minY = Math.min(...tiles.map(t => this.mbtilesRowToY(t.tile_row, maxZoom)));
    const maxY = Math.max(...tiles.map(t => this.mbtilesRowToY(t.tile_row, maxZoom)));
    
    const imageWidth = (maxX - minX + 1) * tileSize;
    const imageHeight = (maxY - minY + 1) * tileSize;
    
    console.log(`Image dimensions: ${imageWidth}x${imageHeight}`);
    console.log(`Tile range: X[${minX}-${maxX}], Y[${minY}-${maxY}]`);

    // Create base image with gray background
    const baseImage = new Jimp(imageWidth, imageHeight, 0xf0f0f0ff);

    // Draw each tile
    let drawnTiles = 0;
    
    for (const tile of tiles) {
      const x = (tile.tile_column - minX) * tileSize;
      const y = (this.mbtilesRowToY(tile.tile_row, maxZoom) - minY) * tileSize;
      
      try {
        // Load tile image from blob data
        const tileImage = await Jimp.read(Buffer.from(tile.tile_data));
        
        // Composite the tile onto the base image
        baseImage.composite(tileImage, x, y);
        drawnTiles++;
        
        // Progress indicator
        process.stdout.write(`\rDrawing tiles: ${drawnTiles}/${tiles.length}`);
      } catch (error) {
        console.error(`\nFailed to draw tile ${tile.tile_column}/${tile.tile_row}: ${error.message}`);
      }
    }
    
    process.stdout.write('\n');

    // Save the image
    const outputPath = path.resolve(this.outputFile);
    const outputDir = path.dirname(outputPath);
    
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Determine output format from file extension
    const ext = path.extname(this.outputFile).toLowerCase();
    
    if (ext === '.png') {
      await baseImage.writeAsync(outputPath);
    } else if (ext === '.jpg' || ext === '.jpeg') {
      await baseImage.quality(90).writeAsync(outputPath);
    } else {
      // Default to PNG
      await baseImage.writeAsync(outputPath);
    }

    console.log(`Image saved to: ${outputPath}`);
    console.log(`Successfully drew ${drawnTiles} tiles`);
  }
}

// CLI setup
program
  .name('2maps-loader')
  .description('CLI tool for downloading raster map tiles to MBTiles format')
  .version('1.0.0');

// Test command to render image from MBTiles
program
  .command('test')
  .description('Render an image from MBTiles database')
  .requiredOption('--input <file>', 'Input MBTiles file path')
  .requiredOption('--output <file>', 'Output image file path')
  .action(async (options) => {
    try {
      const tester = new MBTilesTester(options.input, options.output);
      await tester.renderImage();
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// Download command
program
  .command('download')
  .description('Download map tiles to MBTiles format (supports any 2 box corners)')
  .requiredOption('--corner1 <coords>', 'First corner coordinates in format "lat,lng"')
  .requiredOption('--corner2 <coords>', 'Second corner coordinates in format "lat,lng"')
  .requiredOption('--max-zoom <number>', 'Maximum zoom level', parseInt)
  .requiredOption('--url-template <template>', 'URL template for tiles (use {z}, {x}, {y} placeholders)')
  .requiredOption('--output <file>', 'Output MBTiles file path')
  .option('--concurrency <number>', 'Number of concurrent downloads (default: 5)', parseInt, 5)
  .action(async (options) => {
    try {
      // Parse two corners
      const corners = [
        parseCoordinates(options.corner1),
        parseCoordinates(options.corner2)
      ];

      // Calculate bounding box
      const lats = corners.map(c => c.lat);
      const lngs = corners.map(c => c.lng);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);

      // Use min/max for bounding box
      const topLeft = { lat: maxLat, lng: minLng };
      const bottomRight = { lat: minLat, lng: maxLng };

      const downloader = new TileDownloader({
        topLeft,
        bottomRight,
        maxZoom: options.maxZoom,
        urlTemplate: options.urlTemplate,
        outputFile: options.output,
        concurrency: options.concurrency
      });

      await downloader.download();
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program.parse();

// Parse coordinates
function parseCoordinates(coordsStr) {
  const [lat, lng] = coordsStr.split(',').map(Number);
  if (isNaN(lat) || isNaN(lng)) {
    throw new Error(`Invalid coordinates format: ${coordsStr}. Expected "lat,lng"`);
  }
  return { lat, lng };
}
