#!/usr/bin/env node

const { program } = require("commander");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const Jimp = require("jimp");
const { spawn } = require("child_process");

class TileDownloader {
  constructor(options) {
    this.topLeft = options.topLeft;
    this.bottomRight = options.bottomRight;
    this.maxZoom = options.maxZoom;
    this.urlTemplate = options.urlTemplate;
    this.outputFile = options.outputFile;
    this.concurrency = options.concurrency || 5;
    this.batchSize = options.batchSize || 1000;
    this.retryLimit = 3; // 每个瓦片最多重试几次
    this.progressInterval = 50; // 每下载多少个更新一次进度条
    this.convertToPMTiles = options.convertToPMTiles || false;
    this.pmtilesPath = options.pmtilesPath || path.join(__dirname, "pmtiles");
  }

  deg2num(lat_deg, lon_deg, zoom) {
    const lat_rad = (lat_deg * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    const xtile = Math.floor(((lon_deg + 180) / 360) * n);
    const ytile = Math.floor(
      ((1 - Math.log(Math.tan(lat_rad) + 1 / Math.cos(lat_rad)) / Math.PI) /
        2) *
        n,
    );
    return { x: xtile, y: ytile };
  }

  async downloadTile(tile) {
    const url = this.urlTemplate
      .replace("{z}", tile.z)
      .replace("{x}", tile.x)
      .replace("{y}", tile.y);

    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 30000,
      });
      return { ...tile, data: response.data, success: true };
    } catch (error) {
      console.error(
        `Failed to download tile ${tile.z}/${tile.x}/${tile.y}: ${error.message}`,
      );
      return { ...tile, data: null, success: false };
    }
  }

  async downloadTiles(tiles, batchIndex, batchTotal) {
    const successful = [];
    const failed = [];
    let completed = 0;

    const queue = [...tiles];
    const total = tiles.length;

    // 用于控制进度更新的频率
    let lastPrinted = 0;

    const updateProgress = () => {
      const percent = Math.round((completed / total) * 100);
      process.stdout.write(
        `\r  Batch ${batchIndex}/${batchTotal} progress: ${percent}% (${completed}/${total})   `,
      );
      lastPrinted = completed;
    };

    const worker = async () => {
      while (queue.length > 0) {
        const tile = queue.shift();
        if (!tile) continue;

        const result = await this.downloadTile(tile);
        completed++;

        if (result.success) {
          successful.push(result);
        } else {
          failed.push(tile); // 只保留坐标，稍后重试
        }

        // 控制刷新频率，避免太频繁
        if (
          completed - lastPrinted >= this.progressInterval ||
          completed === total
        ) {
          updateProgress();
        }
      }
    };

    const workers = Array(this.concurrency)
      .fill()
      .map(() => worker());
    await Promise.all(workers);

    // 最终确保显示 100%
    updateProgress();
    process.stdout.write("\n");

    return { successful, failed };
  }
  // ────────────────────────────────────────────────
  // 新增：重试一批失败的瓦片
  // ────────────────────────────────────────────────
  async retryFailedTiles(failedTiles, currentRetryCount = 1) {
    if (failedTiles.length === 0 || currentRetryCount > this.retryLimit) {
      if (failedTiles.length > 0) {
        console.warn(
          `  → ${failedTiles.length} tiles still failed after ${this.retryLimit} retries`,
        );
      }
      return { successful: [], stillFailed: failedTiles };
    }

    console.log(
      `  Retrying ${failedTiles.length} failed tiles (attempt ${currentRetryCount}/${this.retryLimit})...`,
    );

    const { successful, failed } = await this.downloadTiles(
      failedTiles,
      "retry",
      "retry", // 临时标记，不影响显示
    );

    if (failed.length > 0) {
      return await this.retryFailedTiles(failed, currentRetryCount + 1);
    }

    return { successful, stillFailed: [] };
  }

  createMBTilesDatabase() {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.outputFile);

      db.serialize(() => {
        db.run(
          `CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)`,
        );
        db.run(`CREATE TABLE IF NOT EXISTS tiles (
          zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
          PRIMARY KEY (zoom_level, tile_column, tile_row)
        )`);

        const metadata = [
          ["name", "Map Tiles"],
          ["type", "baselayer"],
          ["version", "1.0"],
          ["description", "Downloaded map tiles"],
          ["format", "png"],
          [
            "bounds",
            `${this.topLeft.lng},${this.bottomRight.lat},${this.bottomRight.lng},${this.topLeft.lat}`,
          ],
        ];

        const stmt = db.prepare(
          "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)",
        );
        metadata.forEach(([n, v]) => stmt.run(n, v));
        stmt.finalize();

        resolve(db);
      });
    });
  }

  async insertTilesBatch(db, tiles) {
    if (!tiles.length) return 0;

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        const stmt = db.prepare(
          "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
        );

        let inserted = 0;
        let hasError = false;

        tiles.forEach((tile) => {
          const tile_row = Math.pow(2, tile.z) - 1 - tile.y;
          stmt.run(tile.z, tile.x, tile_row, tile.data, (err) => {
            if (err) {
              console.error(err.message);
              hasError = true;
            } else {
              inserted++;
            }
          });
        });

        stmt.finalize(() => {
          if (hasError) {
            db.run("ROLLBACK", () => reject(new Error("Batch insert failed")));
          } else {
            db.run("COMMIT", () => resolve(inserted));
          }
        });
      });
    });
  }

  getMemoryUsage() {
    const used = process.memoryUsage();
    return {
      rssMB: (used.rss / 1024 / 1024).toFixed(1),
      heapUsedMB: (used.heapUsed / 1024 / 1024).toFixed(1),
      heapTotalMB: (used.heapTotal / 1024 / 1024).toFixed(1),
    };
  }

  async getMissingTilesBatch(db, tiles) {
    if (tiles.length === 0) return [];

    // 准备 (z,x,y_mb) 元组列表，y_mb 是 MBTiles 的 tile_row
    const conditions = tiles.map(
      (t) => `(${t.z}, ${t.x}, ${Math.pow(2, t.z) - 1 - t.y})`,
    );
    const sql = `
    SELECT zoom_level, tile_column, tile_row
    FROM tiles
    WHERE (zoom_level, tile_column, tile_row) IN (${conditions.join(",")})
  `;

    return new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => {
        if (err) return reject(err);

        const existingSet = new Set(
          rows.map((r) => `${r.zoom_level},${r.tile_column},${r.tile_row}`),
        );

        const missing = tiles.filter((t) => {
          const key = `${t.z},${t.x},${Math.pow(2, t.z) - 1 - t.y}`;
          return !existingSet.has(key);
        });

        resolve(missing);
      });
    });
  }

  async download() {
    console.log("Starting memory-friendly tile download...");
    console.log(
      `Batch size: ${this.batchSize}  |  Concurrency: ${this.concurrency}\n`,
    );

    const db = await this.createMBTilesDatabase();
    let grandTotalTiles = 0;
    let grandTotalSuccess = 0;

    for (let zoom = 0; zoom <= this.maxZoom; zoom++) {
      console.log(
        `\n┌── Zoom ${zoom.toString().padStart(2)} ───────────────────────────────`,
      );

      const tl = this.deg2num(this.topLeft.lat, this.topLeft.lng, zoom);
      const br = this.deg2num(this.bottomRight.lat, this.bottomRight.lng, zoom);

      const minX = Math.min(tl.x, br.x),
        maxX = Math.max(tl.x, br.x);
      const minY = Math.min(tl.y, br.y),
        maxY = Math.max(tl.y, br.y);

      const tilesThisZoom = [];
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          tilesThisZoom.push({ z: zoom, x, y });
        }
      }

      let remainingFailed = []; // 该 zoom 层累计失败的（跨批次）

      for (let i = 0; i < tilesThisZoom.length; i += this.batchSize) {
        const batchStartTime = Date.now();

        const batchIndex = Math.floor(i / this.batchSize) + 1;
        const batchTotal = Math.ceil(tilesThisZoom.length / this.batchSize);
        const batch = tilesThisZoom.slice(i, i + this.batchSize);

        console.log(
          `│  Batch ${batchIndex}/${batchTotal} checking (${batch.length} tiles)`,
        );

        // ───── 新增：只保留真正缺失的 ─────
        const toDownload = await this.getMissingTilesBatch(db, batch);

        if (toDownload.length === 0) {
          console.log(`│    All tiles already exist → skipped`);
          continue;
        }

        console.log(
          `│    Need to download ${toDownload.length}/${batch.length} missing tiles`,
        );

        // 然后正常下载、插入
        const { successful, failed } = await this.downloadTiles(
          toDownload,
          batchIndex,
          batchTotal,
        );

        // 立即把本批失败的加入层级失败队列
        remainingFailed.push(...failed);

        // 本批下载的数据量统计（不变）
        let downloadedBytes = successful.reduce(
          (sum, r) => sum + (r.data?.length || 0),
          0,
        );
        const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(2);

        // 插入成功的
        let inserted = 0;
        if (successful.length > 0) {
          inserted = await this.insertTilesBatch(db, successful);
          // 立即释放 Buffer，降低峰值内存
          successful.forEach((t) => {
            t.data = null;
          });
          successful.length = 0; // 可选，进一步帮助 GC
        }
        // ─────────────── 立即重试本批失败的 ───────────────
        let retrySuccess = 0;
        if (failed.length > 0) {
          const retryResult = await this.retryFailedTiles(failed);
          if (retryResult.successful.length > 0) {
            retrySuccess = await this.insertTilesBatch(
              db,
              retryResult.successful,
            );
            retryResult.successful.forEach((t) => {
              t.data = null;
            });
            retryResult.successful.length = 0;
            console.log(
              `  Retry success: ${retrySuccess}/${retryResult.successful.length}`,
            );
          }
          // 更新 remainingFailed，只保留最终仍失败的
          remainingFailed = remainingFailed.filter(
            (t) =>
              !retryResult.successful.some(
                (s) => s.x === t.x && s.y === t.y && s.z === t.z,
              ),
          );
        }

        // 时间、内存统计（不变）
        const durationSec = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        const memAfter = this.getMemoryUsage();

        console.log(
          `│    ↓  ${inserted + retrySuccess}/${batch.length} saved  |  ${downloadedMB} MB`,
        );
        console.log(
          `│    Time: ${durationSec}s  |  Memory: ${memAfter.heapUsedMB} MB`,
        );

        grandTotalSuccess += inserted + retrySuccess;
      }

      // ─────────────── zoom 层结束时，最后检查仍有失败的 ───────────────
      if (remainingFailed.length > 0) {
        console.log(
          `\nZoom ${zoom} final retry for ${remainingFailed.length} persistent failures...`,
        );
        const finalRetry = await this.retryFailedTiles(remainingFailed);
        if (finalRetry.successful.length > 0) {
          const extraInserted = await this.insertTilesBatch(
            db,
            finalRetry.successful,
          );
          finalRetry.successful.forEach((t) => {
            t.data = null;
          });
          grandTotalSuccess += extraInserted;
          console.log(`  Final retry saved: ${extraInserted}`);
        }
      }

      console.log("└───────────────────────────────────────────────");
    }

    db.close();

    const memAfterAll = this.getMemoryUsage();
    console.log("\nDownload completed.");
    console.log(`Total tiles processed : ${grandTotalTiles.toLocaleString()}`);
    console.log(
      `Successfully saved    : ${grandTotalSuccess.toLocaleString()}`,
    );
    console.log(
      `Final memory usage    : ${memAfterAll.heapUsedMB} MB (RSS: ${memAfterAll.rssMB} MB)`,
    );
    console.log(`Output → ${this.outputFile}`);

    // ──────────────── 自动转换为 PMTiles（可选） ────────────────
    if (this.convertToPMTiles) {
      await this.tryConvertToPMTiles();
    } else {
      console.log("\nTip: You can convert to PMTiles later using:");
      console.log(
        `  pmtiles convert "${this.outputFile}" "${this.outputFile.replace(/\.mbtiles$/i, ".pmtiles")}"`,
      );
    }
  }
  // 转换成PMTiles
  async tryConvertToPMTiles() {
    const outputPmtiles = this.outputFile.replace(/\.mbtiles$/i, ".pmtiles");
    let pmtilesExecutable = this.pmtilesPath;
    if (!fs.existsSync(pmtilesExecutable)) {
      pmtilesExecutable = "pmtiles";
    }

    return new Promise((resolve, reject) => {
      console.log(`\nStarting stream conversion: ${outputPmtiles}`);

      // 使用 spawn 替代 exec，不占用 Node.js 内存 Buffer
      const child = spawn(pmtilesExecutable, [
        "convert",
        this.outputFile,
        outputPmtiles,
      ]);

      child.stdout.on("data", (data) =>
        process.stdout.write(`pmtiles: ${data}`),
      );
      child.stderr.on("data", (data) =>
        process.stderr.write(`pmtiles_err: ${data}`),
      );

      child.on("close", (code) => {
        if (code === 0) {
          console.log("\nConversion successful!");
          resolve();
        } else {
          reject(new Error(`pmtiles process exited with code ${code}`));
        }
      });

      child.on("error", (err) => reject(err));
    });
  }
}

// ────────────────────────────────────────────────
// MBTiles → Image 渲染部分（保持不变，略微精简格式）
// ────────────────────────────────────────────────

class MBTilesTester {
  constructor(inputFile, outputFile) {
    this.inputFile = inputFile;
    this.outputFile = outputFile;
  }

  async getMaxZoomLevel() {
    return new Promise((r, e) => {
      const db = new sqlite3.Database(this.inputFile);
      db.get("SELECT MAX(zoom_level) as mz FROM tiles", (err, row) => {
        db.close();
        err ? e(err) : r(row?.mz || 0);
      });
    });
  }

  async getTilesForZoom(z) {
    return new Promise((r, e) => {
      const db = new sqlite3.Database(this.inputFile);
      db.all(
        "SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level = ? ORDER BY tile_column, tile_row",
        [z],
        (err, rows) => {
          db.close();
          err ? e(err) : r(rows);
        },
      );
    });
  }

  mbRowToY(row, zoom) {
    return Math.pow(2, zoom) - 1 - row;
  }

  async renderImage() {
    console.log(`Reading ${this.inputFile}`);

    const maxZ = await this.getMaxZoomLevel();
    if (maxZ === 0) throw new Error("No tiles found");

    const tiles = await this.getTilesForZoom(maxZ);
    if (tiles.length === 0) throw new Error(`No tiles at zoom ${maxZ}`);

    const ts = 256;
    const xs = tiles.map((t) => t.tile_column);
    const ys = tiles.map((t) => this.mbRowToY(t.tile_row, maxZ));
    const w = (Math.max(...xs) - Math.min(...xs) + 1) * ts;
    const h = (Math.max(...ys) - Math.min(...ys) + 1) * ts;

    console.log(`Rendering z${maxZ} → ${w}×${h}  (${tiles.length} tiles)`);

    const img = new Jimp(w, h, 0xf0f0f0ff);
    let drawn = 0;

    for (const t of tiles) {
      const x = (t.tile_column - Math.min(...xs)) * ts;
      const y = (this.mbRowToY(t.tile_row, maxZ) - Math.min(...ys)) * ts;
      try {
        const tileImg = await Jimp.read(Buffer.from(t.tile_data));
        img.composite(tileImg, x, y);
        drawn++;
        process.stdout.write(`\rDrawn ${drawn}/${tiles.length}`);
      } catch {}
    }
    process.stdout.write("\n");

    const out = path.resolve(this.outputFile);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const ext = path.extname(out).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg")
      await img.quality(85).writeAsync(out);
    else await img.writeAsync(out);

    console.log(`Saved → ${out}`);
  }
}

// ────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────

program
  .name("2maps-loader")
  .description("Download raster tiles → MBTiles (with batch stats)")
  .version("1.2.0");

program
  .command("download")
  .requiredOption("--corner1 <lat,lng>")
  .requiredOption("--corner2 <lat,lng>")
  .requiredOption("--max-zoom <number>", "Max zoom", Number)
  .requiredOption("--url-template <url>")
  .requiredOption("--output <file>")
  .option("--concurrency <n>", Number, 5)
  .option("--batch-size <n>", Number, 1000)
  .option(
    "--convert-pmtiles",
    "Automatically convert output to PMTiles format after download",
  )
  .option(
    "--pmtiles-path <path>",
    "Path to pmtiles executable (default: same directory)",
    path.join(__dirname, "pmtiles"),
  )
  .action(async (opts) => {
    try {
      const c1 = parseCoords(opts.corner1);
      const c2 = parseCoords(opts.corner2);

      const downloader = new TileDownloader({
        topLeft: {
          lat: Math.max(c1.lat, c2.lat),
          lng: Math.min(c1.lng, c2.lng),
        },
        bottomRight: {
          lat: Math.min(c1.lat, c2.lat),
          lng: Math.max(c1.lng, c2.lng),
        },
        maxZoom: opts.maxZoom,
        urlTemplate: opts.urlTemplate,
        outputFile: opts.output,
        concurrency: opts.concurrency,
        batchSize: opts.batchSize,
        convertToPMTiles: opts.convertPmtiles,
        pmtilesPath: opts.pmtilesPath,
      });

      await downloader.download();
    } catch (e) {
      console.error("Error:", e.message);
      process.exit(1);
    }
  });

program
  .command("test")
  .requiredOption("--input <file>")
  .requiredOption("--output <file>")
  .action(async (opts) => {
    try {
      const tester = new MBTilesTester(opts.input, opts.output);
      await tester.renderImage();
    } catch (e) {
      console.error("Error:", e.message);
      process.exit(1);
    }
  });

program.parse();

function parseCoords(s) {
  const [lat, lng] = s.split(",").map(Number);
  if (isNaN(lat) || isNaN(lng)) throw new Error(`Invalid: ${s}`);
  return { lat, lng };
}
