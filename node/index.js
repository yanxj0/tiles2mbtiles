#!/usr/bin/env node

const { program } = require("commander");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const Jimp = require("jimp");
const { spawn } = require("child_process");
const turf = require("@turf/turf");

class TileDownloader {
  constructor(options) {
    this.geoJson = options.geoJson || this.loadDefaultGeoJson();
    this.targetGeometry = null;
    this.geoBBox = null;
    this.totalTilesToProcess = 0; // 全局总数统计

    if (this.geoJson) {
      console.log(`[Info] 正在预处理 GeoJSON 边界数据...`);
      const combined = turf.combine(this.geoJson);
      this.targetGeometry = combined.features[0];
      this.geoBBox = turf.bbox(this.geoJson);

      // 预估总瓦片数（基于 BBox 矩形范围，作为进度分母）
      for (
        let z = parseInt(options.minZoom) || 0;
        z <= parseInt(options.maxZoom);
        z++
      ) {
        const tl = this.deg2num(this.geoBBox[3], this.geoBBox[0], z);
        const br = this.deg2num(this.geoBBox[1], this.geoBBox[2], z);
        this.totalTilesToProcess +=
          (Math.abs(br.x - tl.x) + 1) * (Math.abs(br.y - tl.y) + 1);
      }
    }

    this.outputFile = options.outputFile; // 确保为字符串
    this.minZoom = parseInt(options.minZoom) || 0;
    this.maxZoom = parseInt(options.maxZoom);
    this.urlTemplate = options.urlTemplate;
    this.concurrency = parseInt(options.concurrency) || 10;
    this.batchSize = parseInt(options.batchSize) || 500;
    this.convertToPMTiles = options.convertToPMTiles || false;
  }

  loadDefaultGeoJson() {
    const defaultPath = path.join(__dirname, "china.geojson");
    if (fs.existsSync(defaultPath)) {
      try {
        console.log(`[Info] 自动加载默认边界文件: ${defaultPath}`);
        return JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
      } catch (e) {
        console.warn(`[Warn] 默认 GeoJSON 解析失败: ${e.message}`);
      }
    }
    return null;
  }

  deg2num(lat, lon, zoom) {
    const lat_rad = (lat * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    return {
      x: Math.floor(((lon + 180) / 360) * n),
      y: Math.floor(
        ((1 - Math.log(Math.tan(lat_rad) + 1 / Math.cos(lat_rad)) / Math.PI) /
          2) *
          n,
      ),
    };
  }

  num2deg(x, y, z) {
    const n = Math.pow(2, z);
    const lon = (x / n) * 360 - 180;
    const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    return [lon, (lat_rad * 180) / Math.PI];
  }

  *tileGenerator(zoom) {
    let xMin, xMax, yMin, yMax;

    // 使用预处理好的数据
    if (this.targetGeometry && this.geoBBox) {
      const tl = this.deg2num(this.geoBBox[3], this.geoBBox[0], zoom);
      const br = this.deg2num(this.geoBBox[1], this.geoBBox[2], zoom);
      xMin = Math.min(tl.x, br.x);
      xMax = Math.max(tl.x, br.x);
      yMin = Math.min(tl.y, br.y);
      yMax = Math.max(tl.y, br.y);
    } else if (this.topLeft && this.bottomRight) {
      const tl = this.deg2num(this.topLeft.lat, this.topLeft.lng, zoom);
      const br = this.deg2num(this.bottomRight.lat, this.bottomRight.lng, zoom);
      xMin = Math.min(tl.x, br.x);
      xMax = Math.max(tl.x, br.x);
      yMin = Math.min(tl.y, br.y);
      yMax = Math.max(tl.y, br.y);
    } else {
      throw new Error("未检测到有效的 GeoJSON 或坐标范围");
    }

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        if (this.targetGeometry) {
          // 仅进行点在面内的布尔运算，不再进行复杂的 combine 操作
          const pt = turf.point(this.num2deg(x + 0.5, y + 0.5, zoom));
          if (!turf.booleanPointInPolygon(pt, this.targetGeometry)) continue;
        }
        yield { z: zoom, x, y };
      }
    }
  }

  async downloadTileWithRetry(tile, attempt = 1) {
    const url = this.urlTemplate
      .replace("{z}", tile.z)
      .replace("{x}", tile.x)
      .replace("{y}", tile.y);
    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 15000,
      });
      return { ...tile, data: response.data, success: true };
    } catch (error) {
      if (attempt < this.retryLimit) {
        await new Promise((r) => setTimeout(r, attempt * 500));
        return this.downloadTileWithRetry(tile, attempt + 1);
      }
      return { ...tile, success: false };
    }
  }

  async createMBTilesDatabase() {
    return new Promise((resolve, reject) => {
      try {
        const db = new sqlite3.Database(this.outputFile);
        db.serialize(() => {
          db.run("PRAGMA journal_mode = WAL");
          db.run("PRAGMA synchronous = OFF");
          db.run(
            `CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row))`,
          );
          resolve(db);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async insertTilesBatch(db, tiles) {
    if (!tiles || tiles.length === 0) return 0;
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const stmt = db.prepare(
          "INSERT OR IGNORE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
        );
        tiles.forEach((t) => {
          const row = Math.pow(2, t.z) - 1 - t.y;
          stmt.run(t.z, t.x, row, t.data);
          t.data = null;
        });
        stmt.finalize(() => {
          db.run("COMMIT", (err) =>
            err ? reject(err) : resolve(tiles.length),
          );
        });
      });
    });
  }

  async download() {
    const mode = this.geoJson ? "GeoJSON 模式" : "矩形模式";
    console.log(
      `\n🚀 任务启动 | ${mode} | Zoom ${this.minZoom}-${this.maxZoom}`,
    );
    const db = await this.createMBTilesDatabase();

    let totalSavedGlobal = 0;
    const globalStartTime = Date.now();

    for (let zoom = this.minZoom; zoom <= this.maxZoom; zoom++) {
      console.log(`\n── Zoom ${zoom} ──`);

      // 1. 【优化】改用 BBox 快速估算该层总数，不再使用 countGen 扫描
      let estimatedTilesInZoom = 0;
      if (this.geoBBox) {
        const tl = this.deg2num(this.geoBBox[3], this.geoBBox[0], zoom);
        const br = this.deg2num(this.geoBBox[1], this.geoBBox[2], zoom);
        estimatedTilesInZoom =
          (Math.abs(br.x - tl.x) + 1) * (Math.abs(br.y - tl.y) + 1);
      } else if (this.topLeft && this.bottomRight) {
        const tl = this.deg2num(this.topLeft.lat, this.topLeft.lng, zoom);
        const br = this.deg2num(
          this.bottomRight.lat,
          this.bottomRight.lng,
          zoom,
        );
        estimatedTilesInZoom =
          (Math.abs(br.x - tl.x) + 1) * (Math.abs(br.y - tl.y) + 1);
      }

      const totalBatches =
        Math.ceil(estimatedTilesInZoom / this.batchSize) || 1;
      const gen = this.tileGenerator(zoom);
      let processedInZoom = 0;
      let currentBatchIdx = 0;
      let finished = false;

      while (!finished) {
        let batch = [];
        for (let i = 0; i < this.batchSize; i++) {
          const { value, done } = gen.next();
          if (done) {
            finished = true;
            break;
          }
          batch.push(value);
        }

        if (batch.length > 0) {
          currentBatchIdx++;
          const successful = [];
          const currentBatchSize = batch.length;

          const workers = Array(this.concurrency)
            .fill()
            .map(async () => {
              while (batch.length > 0) {
                const tile = batch.shift();
                if (!tile) break;
                const res = await this.downloadTileWithRetry(tile);
                if (res.success) successful.push(res);
              }
            });
          await Promise.all(workers);

          const savedInBatch = await this.insertTilesBatch(db, successful);
          totalSavedGlobal += savedInBatch;
          processedInZoom += currentBatchSize;

          // 2. 日志输出：使用估算总数
          const percent = (
            (processedInZoom / estimatedTilesInZoom) *
            100
          ).toFixed(2);
          const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
          const elapsed = (Date.now() - globalStartTime) / 1000;
          const avgSpeed = (totalSavedGlobal / elapsed).toFixed(1);

          console.log(
            `[Zoom ${zoom}] 进度: ~${percent}% | ` +
              `已处理: ${processedInZoom}/${estimatedTilesInZoom} | ` +
              `批次: ${currentBatchIdx}/${totalBatches} | ` +
              `均速: ${avgSpeed} t/s | 内存: ${mem}MB`,
          );

          if (global.gc) global.gc();
          await new Promise((r) => setImmediate(r));
        }
      }
    }

    db.close(async () => {
      console.log(
        `\n✅ 任务完成！总计保存: ${totalSavedGlobal.toLocaleString()}`,
      );
      if (this.convertToPMTiles) await this.tryConvertToPMTiles();
    });
  }

  async tryConvertToPMTiles() {
    const outputPmtiles = this.outputFile.replace(/\.mbtiles$/i, ".pmtiles");
    const cmd = fs.existsSync(this.pmtilesPath) ? this.pmtilesPath : "pmtiles";
    return new Promise((resolve) => {
      console.log(`\n📦 格式转换中...`);
      const child = spawn(cmd, ["convert", this.outputFile, outputPmtiles]);
      child.stdout.on("data", (data) =>
        process.stdout.write(`[pmtiles] ${data}`),
      );
      child.on("close", resolve);
    });
  }
}

// ───── 保留您原有的测试渲染逻辑 ─────
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
        "SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level = ? LIMIT 100",
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
    const maxZ = await this.getMaxZoomLevel();
    const tiles = await this.getTilesForZoom(maxZ);
    if (!tiles || tiles.length === 0) {
      console.log("No tiles found for testing.");
      return;
    }
    const ts = 256;
    const xs = tiles.map((t) => t.tile_column);
    const ys = tiles.map((t) => this.mbRowToY(t.tile_row, maxZ));
    const w = (Math.max(...xs) - Math.min(...xs) + 1) * ts;
    const h = (Math.max(...ys) - Math.min(...ys) + 1) * ts;

    console.log(`Rendering test image: ${w}x${h}...`);
    const img = new Jimp(w, h, 0xf0f0f0ff);
    for (const t of tiles) {
      const x = (t.tile_column - Math.min(...xs)) * ts;
      const y = (this.mbRowToY(t.tile_row, maxZ) - Math.min(...ys)) * ts;
      try {
        const tileImg = await Jimp.read(Buffer.from(t.tile_data));
        img.composite(tileImg, x, y);
      } catch (err) {
        console.error("Tile render error:", err.message);
      }
    }
    await img.writeAsync(this.outputFile);
    console.log(`Test image saved to -> ${this.outputFile}`);
  }
}

// ───── CLI 命令定义 ─────
program.name("2maps-loader").version("1.8.2");
program
  .command("download")
  .option("--geojson <path>", "GeoJSON 路径")
  .option("--corner1 <lat,lng>", "左上角")
  .option("--corner2 <lat,lng>", "右下角")
  .option("--min-zoom <number>", "最小层级", "0")
  .requiredOption("--max-zoom <number>", "最大层级")
  .requiredOption("--url-template <url>")
  .requiredOption("--output <file>")
  .option("--concurrency <n>", "并发数", "10")
  .option("--batch-size <n>", "批次大小", "1000")
  .option("--convert-pmtiles", "自动转换")
  .action(async (opts) => {
    let geoJson = null,
      tl = null,
      br = null;

    // --- 增加防御性代码：去除可能存在的换行符或空格 ---
    const output = opts.output ? opts.output.trim() : null;
    const urlTemplate = opts.urlTemplate ? opts.urlTemplate.trim() : null;

    // 手动解析 GeoJSON
    if (opts.geojson && fs.existsSync(opts.geojson)) {
      geoJson = JSON.parse(fs.readFileSync(opts.geojson, "utf-8"));
    }

    // 解析坐标
    if (opts.corner1 && opts.corner2) {
      const c1 = opts.corner1.split(",").map(Number);
      const c2 = opts.corner2.split(",").map(Number);
      tl = { lat: Math.max(c1[0], c2[0]), lng: Math.min(c1[1], c2[1]) };
      br = { lat: Math.min(c1[0], c2[0]), lng: Math.max(c1[1], c2[1]) };
    }

    const downloader = new TileDownloader({
      geoJson,
      topLeft: tl,
      bottomRight: br,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      urlTemplate: urlTemplate, // 使用处理后的 urlTemplate
      outputFile: output, // 使用处理后的 output
      concurrency: opts.concurrency,
      batchSize: opts.batchSize,
      convertToPMTiles: opts.convertPmtiles,
    });

    await downloader.download();
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
      console.error("Test Error:", e.message);
    }
  });

program.parse();
